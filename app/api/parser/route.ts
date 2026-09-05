import { NextRequest, NextResponse } from 'next/server';
import { ParserInputSchema, ParserOutputSchema } from '@/lib/contracts/parser';
import { getRoleOrDefault } from '@/lib/domain/roles';
import { saveCandidateToSupabase, DEMO_MERCHANT_ID } from '@/lib/db/supabase';
import {
  linkResumeDocumentToCandidate,
  saveResumeDocumentExtraction,
} from '@/lib/db/resume-review';
import {
  readBoundedJson,
  RequestBodyTooLargeError,
} from '@/lib/http/bounded-json';
import {
  DocumentProcessorError,
  requestDocumentExtraction,
} from '@/lib/ai/document-processor-client';
import {
  getActiveTraceFields,
  withTraceSpan,
} from '@/lib/observability/tracing';
import { guardLegacyDemoRoute } from '@/lib/http/legacy-demo-route';

// Enable long-running API routes (Vercel serverless functions time out by default at 10-15s)
export const maxDuration = 60;

/**
 * TeamFlow — Deterministic Resume Processing Pipeline
 * ------------------------------------------------
 * This route orchestrates two bounded pipeline stages:
 *
 *   [Document processor]  →  /extract       →  raw markdown text + embedding
 *   [Structured scorer]   →  Gemini Models  →  ParserOutput (score, skills, flags)
 *
 * The separate LangGraph hiring workflow lives behind /api/parser/agent and is not part
 * of this reliability-sensitive upload path.
 */

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000';
const hasGeminiApiKey = Boolean(process.env.GOOGLE_API_KEY);
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
// 10 MiB decoded input expands to at most ~13.99 MiB of Base64 plus bounded JSON fields.
const MAX_PARSER_REQUEST_BYTES = 14_100_000;

function jsonNoStore(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

import { callScorerAgent, extractAndScoreCandidate } from '@/lib/ai/scorer';

// ── Pipeline Entry Point ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const blocked = guardLegacyDemoRoute();
  if (blocked) return blocked;

  const pipelineStart = Date.now();
  const requestId = crypto.randomUUID();

  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isSafeInteger(contentLength) || contentLength < 0 ||
      contentLength > MAX_PARSER_REQUEST_BYTES
    ) {
      return jsonNoStore({ error: 'Request body is too large' }, 413);
    }
  }
  let body: unknown;
  try {
    body = await readBoundedJson(req, MAX_PARSER_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonNoStore({ error: 'Request body is too large' }, 413);
    }
    return jsonNoStore({ error: 'Invalid JSON request' }, 400);
  }

  try {
    // 1. Validate Input
    const validation = ParserInputSchema.safeParse(body);
    if (!validation.success) {
      return jsonNoStore({ error: validation.error.flatten() }, 400);
    }

    const { fileData, mimeType, fileName, roleId } = validation.data;
    const role = getRoleOrDefault(roleId);

    console.log('[Pipeline] started', {
      requestId,
      roleId: role.id,
      inputType: 'inline',
      ...getActiveTraceFields(),
    });

    const documentBytes = Buffer.from(fileData, 'base64');

    // ═════════════════════════════════════════════════════════════════════════
    // SEQUENTIAL MULTI-AGENT PIPELINE
    // Step 1 → Document processing — /extract → markdown text + embedding
    // Step 2 → Structured scoring  — Gemini → validated ParserOutput
    // ═════════════════════════════════════════════════════════════════════════

    // ── Step 1: Document processing ──────────────────────────────────────────
    const ocrResult = await requestDocumentExtraction({
      bytes: documentBytes,
      mimeType,
      fileName,
      serviceUrl: OCR_SERVICE_URL,
      token: process.env.OCR_SERVICE_TOKEN || '',
    });
    const resumeMarkdown = ocrResult.markdown;

    // Persist the validated, tenant-scoped source snapshot for the separate Phase 4
    // document-ID-only review endpoint. Raw bytes and embeddings are not copied here.
    let reviewReady = false;
    if (process.env.RESUME_REVIEW_STORE_DOCUMENTS === 'true') {
      try {
        reviewReady = await saveResumeDocumentExtraction(DEMO_MERCHANT_ID, ocrResult);
      } catch (snapshotError) {
        console.warn('[Pipeline] Resume-review snapshot was not persisted', {
          requestId,
          errorType: snapshotError instanceof Error
            ? snapshotError.name
            : 'UnknownError',
        });
      }
    }

    if (ocrResult.embedding) {
      console.log(`[Pipeline] Document embedding ready: ${ocrResult.embedding.length}-dim`);
    }

    // ── Step 2: Structured semantic scoring ──────────────────────────────────
    if (!hasGeminiApiKey) {
      console.log('[Pipeline] No Gemini API key — performing dynamic role-based candidate evaluation from OCR text');
      const dynamicResult = ParserOutputSchema.parse(
        extractAndScoreCandidate(
          resumeMarkdown,
          fileName,
          role,
        ),
      );
      return jsonNoStore({
        ...dynamicResult,
        requestId,
        documentId: ocrResult.document_id,
        extractionStatus: ocrResult.status,
        extractionWarnings: ocrResult.warnings,
        reviewReady,
      });
    }

    const parsedData = ParserOutputSchema.parse(
      await callScorerAgent(
        resumeMarkdown,
        role,
        fileName,
        false,
        requestId,
      ),
    );

    // ── Persist candidate to Supabase (with document embedding) ───────────────
    let candidateId: string | null = null;
    try {
      candidateId = await withTraceSpan(
        'supabase.persist_candidate',
        {
          'teamflow.pipeline.stage': 'persistence',
          'db.system.name': 'postgresql',
        },
        () =>
          saveCandidateToSupabase({
            merchant_id: DEMO_MERCHANT_ID,
            name: parsedData.candidate?.name || 'Unknown',
            email: parsedData.candidate?.email || undefined,
            phone: parsedData.candidate?.phone || undefined,
            city: parsedData.candidate?.city || undefined,
            status: 'new',
            resume_url: 'uploaded',          // placeholder — real Storage upload would provide this
            resume_text: resumeMarkdown.slice(0, 50_000),
            // The legacy scorer remains a non-authoritative preview. Durable candidate
            // scores and analyses are written only by an approved Phase 6 decision.
            summary: 'Awaiting authorized human review',
            source: 'upload',
            // Document embedding — stored in pgvector vector(768) column
            embedding: ocrResult.embedding ?? undefined,
          }),
      );

      if (candidateId) {
        if (reviewReady) {
          reviewReady = await linkResumeDocumentToCandidate(
            DEMO_MERCHANT_ID,
            candidateId,
            ocrResult.document_id,
          );
        }
        console.log('[Pipeline] Candidate saved to Supabase', {
          requestId,
          candidateId,
          embeddingDimensions: ocrResult.embedding?.length ?? 0,
        });
      } else {
        console.log('[Pipeline] Supabase not configured — candidate not persisted', {
          requestId,
        });
      }
    } catch (saveErr) {
      // Non-fatal: log and continue — the API still returns the parsed result
      console.warn('[Pipeline] Failed to persist candidate to Supabase', {
        requestId,
        errorType: saveErr instanceof Error ? saveErr.name : 'UnknownError',
      });
    }

    const elapsed = Date.now() - pipelineStart;
    console.log('[Pipeline] completed', {
      requestId,
      elapsedMs: elapsed,
          previewScore: parsedData.score.total,
      ...getActiveTraceFields(),
    });

    return jsonNoStore({
      ...parsedData,
      candidateId,
      requestId,
      documentId: ocrResult.document_id,
      extractionStatus: ocrResult.status,
      extractionWarnings: ocrResult.warnings,
      reviewReady,
    });

  } catch (error) {
    if (error instanceof DocumentProcessorError) {
      const responseStatus = error.status === 401 ? 502 : error.status;
      console.warn('[Pipeline] document extraction rejected', {
        requestId,
        code: error.code,
        status: responseStatus,
        ...getActiveTraceFields(),
      });
      return jsonNoStore(
        {
          error: 'Document extraction failed',
          code: error.code,
          requestId,
        },
        responseStatus,
      );
    }
    console.error('[Pipeline] failed', {
      requestId,
      errorType: error instanceof Error ? error.name : 'UnknownError',
      ...getActiveTraceFields(),
    });
    return jsonNoStore(
      { error: 'Internal Server Error', requestId },
      500,
    );
  }
}
