import { NextRequest, NextResponse } from 'next/server';
import { ParserInputSchema, ParserOutput, ParserOutputSchema } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRoleOrDefault, CafeRole } from '@/lib/roles';
import { saveCandidateToSupabase, DEMO_MERCHANT_ID } from '@/lib/supabase';

// Enable long-running API routes (Vercel serverless functions time out by default at 10-15s)
export const maxDuration = 60;

/**
 * TeamFlow — Agent 2: Semantic Evaluation Engine
 * ------------------------------------------------
 * This route is the SECOND stage of the Sequential Multi-Agent Pipeline:
 *
 *   [Agent 1: OCR Extractor]  →  python_service /extract  →  raw markdown text
 *   [Agent 2: Scorer — THIS]  →  Gemini Models            →  ParserOutput (score, skills, flags)
 *
 * Agent 2 receives clean text from Agent 1, evaluating candidates against role criteria.
 */

const apiKey = process.env.GOOGLE_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const SCORER_MODEL = 'gemini-3.1-pro-preview';

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000';

type OcrAgentResult = {
  markdown: string;
  embedding: number[] | null;
};

import { callScorerAgent } from '@/lib/scorer';

// ── Pipeline Entry Point ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const pipelineStart = Date.now();

  try {
    const body = await req.json();

    // 1. Validate Input
    const validation = ParserInputSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
    }

    const { fileUrl, fileData, mimeType: inputMimeType, fileName, roleId } = validation.data;
    const role = getRoleOrDefault(roleId);

    console.log(`[Pipeline] START — file: ${fileName || fileUrl || 'unknown'}, role: ${role.title}`);

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
    // Step 1 → Agent 1 (OCR)     — python_service /extract → markdown text  (local/deployed service)
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
      const dynamicResult = extractAndScoreCandidate('', fileName || 'Resume.pdf', role);
      return NextResponse.json(dynamicResult);
    }

    if (!apiKey) {
      console.log('[Pipeline] No Gemini API key — performing dynamic role-based candidate evaluation from OCR text');
      const dynamicResult = extractAndScoreCandidate(resumeMarkdown, fileName || 'Resume.pdf', role);
      return NextResponse.json(dynamicResult);
    }

    const parsedData = await callScorerAgent(resumeMarkdown, role, fileName || 'Resume.pdf');

    // ── Persist candidate to Supabase (with embedding from Agent 1) ───────────
    let candidateId: string | null = null;
    try {
      candidateId = await saveCandidateToSupabase({
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
      });

      if (candidateId) {
        console.log(`[Pipeline] Candidate saved to Supabase: ${candidateId} (embedding: ${ocrResult.embedding ? ocrResult.embedding.length + '-dim' : 'none'})`);
      } else {
        console.log('[Pipeline] Supabase not configured — candidate not persisted');
      }
    } catch (saveErr) {
      // Non-fatal: log and continue — the API still returns the parsed result
      console.warn('[Pipeline] Failed to persist candidate to Supabase:', saveErr);
    }

    // ── Validate and return ───────────────────────────────────────────────────
    const validated = ParserOutputSchema.safeParse(parsedData);
    const finalData = validated.success ? validated.data : parsedData;

    const elapsed = Date.now() - pipelineStart;
    console.log(`[Pipeline] COMPLETE — ${elapsed}ms | candidate: ${finalData.candidate?.name} | score: ${finalData.score?.total}`);

    return NextResponse.json({ ...finalData, candidateId });

  } catch (error) {
    console.error('[Pipeline] Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
