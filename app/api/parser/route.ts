import { NextRequest, NextResponse } from 'next/server';
import { ParserInputSchema, ParserOutputSchema } from '@/lib/contracts/parser';
import { getRoleOrDefault } from '@/lib/domain/roles';
import { saveCandidateToSupabase, DEMO_MERCHANT_ID } from '@/lib/db/supabase';
import { createOcrFetchOptions } from '@/lib/observability/ocr-fetch';
import {
  getActiveTraceFields,
  withTraceSpan,
} from '@/lib/observability/tracing';

// Enable long-running API routes (Vercel serverless functions time out by default at 10-15s)
export const maxDuration = 60;

/**
 * TeamFlow — Agent 2: Semantic Evaluation Engine
 * ------------------------------------------------
 * This route is the SECOND stage of the Sequential Multi-Agent Pipeline:
 *
 *   [Agent 1: OCR Extractor]  →  document processor /extract  →  raw markdown text
 *   [Agent 2: Scorer — THIS]  →  Gemini Models            →  ParserOutput (score, skills, flags)
 *
 * Agent 2 receives clean text from Agent 1, evaluating candidates against role criteria.
 */

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000';
const hasGeminiApiKey = Boolean(process.env.GOOGLE_API_KEY);

type OcrAgentResult = {
  markdown: string;
  embedding: number[] | null;
};

import { callScorerAgent, extractAndScoreCandidate } from '@/lib/ai/scorer';

// ── Pipeline Entry Point ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const pipelineStart = Date.now();
  const requestId = crypto.randomUUID();

  try {
    const body = await req.json();

    // 1. Validate Input
    const validation = ParserInputSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
    }

    const { fileUrl, fileData, mimeType: inputMimeType, fileName, roleId } = validation.data;
    const role = getRoleOrDefault(roleId);

    console.log('[Pipeline] started', {
      requestId,
      roleId: role.id,
      inputType: fileData ? 'inline' : 'url',
      ...getActiveTraceFields(),
    });

    // ── Resolve file data ────────────────────────────────────────────────────
    let base64Data: string;
    let mimeType: string;

    if (fileData) {
      base64Data = fileData;
      mimeType = inputMimeType || 'application/pdf';
    } else if (fileUrl) {
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) throw new Error(`Failed to fetch file: ${fileRes.statusText}`);
      const arrayBuffer = await fileRes.arrayBuffer();
      base64Data = Buffer.from(arrayBuffer).toString('base64');
      const contentType = fileRes.headers.get('content-type') || 'application/pdf';
      mimeType = contentType.includes('image') ? contentType : 'application/pdf';
    } else {
      return NextResponse.json({ error: 'No file data provided' }, { status: 400 });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SEQUENTIAL MULTI-AGENT PIPELINE
    // Step 1 → Agent 1 (OCR)     — document processor /extract → markdown text
    // Step 2 → Agent 2 (Scorer)  — Gemini Pro text scoring → ParserOutput
    // ═════════════════════════════════════════════════════════════════════════

    // ── Step 1: OCR Extraction (Agent 1) ─────────────────────────────────────
    const ocrResult = await callOcrAgent(base64Data, mimeType, fileName || 'resume.pdf');
    const resumeMarkdown = ocrResult.markdown;

    if (ocrResult.embedding) {
      console.log(`[Pipeline] Agent 1 embedding ready: ${ocrResult.embedding.length}-dim`);
    }

    // ── Step 2: Semantic Scoring (Agent 2) ───────────────────────────────────
    if (!resumeMarkdown.trim()) {
      console.log('[Pipeline] OCR unavailable — performing dynamic role-based evaluation');
      const dynamicResult = ParserOutputSchema.parse(
        extractAndScoreCandidate('', fileName || 'Resume.pdf', role),
      );
      return NextResponse.json({ ...dynamicResult, requestId });
    }

    if (!hasGeminiApiKey) {
      console.log('[Pipeline] No Gemini API key — performing dynamic role-based candidate evaluation from OCR text');
      const dynamicResult = ParserOutputSchema.parse(
        extractAndScoreCandidate(
          resumeMarkdown,
          fileName || 'Resume.pdf',
          role,
        ),
      );
      return NextResponse.json({ ...dynamicResult, requestId });
    }

    const parsedData = ParserOutputSchema.parse(
      await callScorerAgent(
        resumeMarkdown,
        role,
        fileName || 'Resume.pdf',
        false,
        requestId,
      ),
    );

    // ── Persist candidate to Supabase (with embedding from Agent 1) ───────────
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
            fit_score: parsedData.score?.total,
            analysis: {
              breakdown: parsedData.score?.breakdown,
              explanation: parsedData.score?.explanation,
              skills: parsedData.candidate?.skills,
              experience_years: parsedData.candidate?.experience_years,
              applied_role: parsedData.candidate?.applied_role,
            },
            red_flags: parsedData.red_flags || [],
            summary: parsedData.score?.explanation?.slice(0, 200) || '',
            source: 'upload',
            // Embedding from Agent 1 — stored in pgvector vector(768) column
            embedding: ocrResult.embedding ?? undefined,
          }),
      );

      if (candidateId) {
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
      score: parsedData.score.total,
      ...getActiveTraceFields(),
    });

    return NextResponse.json({ ...parsedData, candidateId, requestId });

  } catch (error) {
    console.error('[Pipeline] failed', {
      requestId,
      errorType: error instanceof Error ? error.name : 'UnknownError',
      ...getActiveTraceFields(),
    });
    return NextResponse.json(
      { error: 'Internal Server Error', requestId },
      { status: 500 },
    );
  }
}

async function callOcrAgent(base64Data: string, mimeType: string, fileName: string): Promise<OcrAgentResult> {
  const formData = new FormData();
  const buffer = Buffer.from(base64Data, 'base64');
  const blob = new Blob([buffer], { type: mimeType });
  formData.append('file', blob, fileName);

  try {
    const response = await fetch(
      `${OCR_SERVICE_URL}/extract`,
      createOcrFetchOptions(
        formData,
        process.env.OCR_SERVICE_TOKEN || '',
      ),
    );
    
    if (!response.ok) {
      console.warn(`[OCR] Service returned status: ${response.status}`);
      return { markdown: '', embedding: null };
    }
    
    const data = await response.json();
    return {
      markdown: data.markdown || '',
      embedding: data.embedding || null,
    };
  } catch (error) {
    console.error('[OCR] Failed to call OCR service:', error);
    return { markdown: '', embedding: null };
  }
}
