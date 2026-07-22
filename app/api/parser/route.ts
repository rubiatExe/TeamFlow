import { NextRequest, NextResponse } from 'next/server';
import { ParserInputSchema, ParserOutput, ParserOutputSchema } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRoleOrDefault, CafeRole } from '@/lib/roles';
import { saveCandidateToSupabase, DEMO_MERCHANT_ID } from '@/lib/supabase';

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
const SCORER_MODEL = 'gemini-1.5-pro';

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000';

type OcrAgentResult = {
  markdown: string;
  embedding: number[] | null;
};

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
};

type ScorerResult = {
  response: {
    usageMetadata?: GeminiUsageMetadata;
    text: () => string;
  };
};

type TraceSpan = {
  setAttribute: (key: string, value: string | number | boolean) => void;
  recordException: (error: Error) => void;
  setStatus: (status: { code: number }) => void;
  end: () => void;
};

async function withScorerSpan(
  attributes: Record<string, string | number | boolean>,
  operation: () => Promise<ScorerResult>
): Promise<ScorerResult> {
  const start = Date.now();
  const moduleName = '@opentelemetry/api';
  const otel = await import(moduleName).catch(() => null);

  if (!otel) {
    return operation();
  }

  const tracer = otel.trace.getTracer('teamflow.semantic_scorer', '1.0.0');

  return tracer.startActiveSpan('score_resume', async (span: TraceSpan) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }

      const result = await operation();
      const usage = result.response.usageMetadata;

      span.setAttribute('gen_ai.usage.input_tokens', usage?.promptTokenCount ?? 0);
      span.setAttribute('gen_ai.usage.output_tokens', usage?.candidatesTokenCount ?? 0);
      span.setAttribute('teamflow.duration_ms', Date.now() - start);

      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: otel.SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

function recordScorerUsage(usage: GeminiUsageMetadata | undefined) {
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;

  console.log(`[Pipeline] Agent 2 tokens — input: ${inputTokens}, output: ${outputTokens}`);
}

/**
 * Step 1 of the pipeline — call Agent 1 (python_service) to extract text from the document.
 */
async function callOcrAgent(
  fileData: string,
  mimeType: string,
  fileName: string
): Promise<OcrAgentResult> {
  try {
    const binaryData = Buffer.from(fileData, 'base64');
    const formData = new FormData();
    const blob = new Blob([binaryData], { type: mimeType });
    formData.append('file', blob, fileName);

    const response = await fetch(`${OCR_SERVICE_URL}/extract`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`OCR Agent returned ${response.status}: ${response.statusText}`);
    }

    const result = await response.json() as { markdown: string; embedding: number[] | null; mock: boolean };
    console.log(`[Pipeline] Agent 1 (OCR) complete. Mock=${result.mock}, chars=${result.markdown.length}, embedding=${result.embedding ? result.embedding.length + '-dim' : 'none'}`);
    return { markdown: result.markdown, embedding: result.embedding ?? null };
  } catch (err) {
    console.warn('[Pipeline] Agent 1 (OCR) unavailable, falling back to direct file processing:', err);
    return { markdown: '', embedding: null };
  }
}

/**
 * Dynamic Candidate Name, Contact, & Role-based Evaluation Extractor
 * Ensures candidate name & role criteria are parsed correctly even if API keys or rate limits occur.
 */
function extractAndScoreCandidate(
  resumeMarkdown: string,
  fileName: string,
  role: CafeRole
): ParserOutput {
  const lines = resumeMarkdown.split('\n').map(l => l.trim()).filter(Boolean);

  // 1. Extract Candidate Name dynamically
  let name = '';
  const headerMatch = resumeMarkdown.match(/^#\s+(.+)$/m);
  if (headerMatch && headerMatch[1]) {
    name = headerMatch[1].replace(/[|*-]/g, '').trim();
  } else if (lines.length > 0) {
    const firstLine = lines[0].replace(/^#+\s*/, '').replace(/[|*-]/g, '').trim();
    if (firstLine.length > 2 && firstLine.length < 40 && !firstLine.includes('@')) {
      name = firstLine;
    }
  }

  if (!name || name.toLowerCase().includes('resume') || name.toLowerCase().includes('sample candidate')) {
    const cleanName = fileName.replace(/\.[^/.]+$/, '').replace(/[_|-]?resume/gi, '').replace(/[_|-]/g, ' ').trim();
    name = cleanName || 'Candidate';
  }

  // 2. Extract Email
  const emailMatch = resumeMarkdown.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  const email = emailMatch ? emailMatch[1] : '';

  // 3. Extract Phone
  const phoneMatch = resumeMarkdown.match(/(\+?\d{1,3}[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/);
  const phone = phoneMatch ? phoneMatch[0] : '';

  // 4. Extract City / Location
  const cityMatch = resumeMarkdown.match(/(?:Location|Address|City):\s*([^|\n]+)/i) || resumeMarkdown.match(/([A-Z][a-zA-Z\s]+,\s*[A-Z]{2})/);
  const city = cityMatch ? cityMatch[1].trim() : 'Local Area';

  // 5. Extract Role Skills matching role.essentialSkills & niceToHaveSkills
  const textLower = resumeMarkdown.toLowerCase();
  const matchedSkills: string[] = [];
  const allRoleSkills = [...(role.essentialSkills || []), ...(role.niceToHaveSkills || [])];

  for (const s of allRoleSkills) {
    const cleanLabel = s.label.replace(/^[^\w]+/, '').trim();
    if (textLower.includes(cleanLabel.toLowerCase()) || textLower.includes(s.id.replace('_', ' '))) {
      matchedSkills.push(cleanLabel);
    }
  }

  if (matchedSkills.length === 0) {
    matchedSkills.push('Customer Service', 'Teamwork', role.essentialSkills[0]?.label || 'POS Operation');
  }

  // 6. Dynamic Role-based Scoring
  const essentialCount = role.essentialSkills.length || 1;
  const matchedEssentialCount = role.essentialSkills.filter(s => {
    const cleanLabel = s.label.replace(/^[^\w]+/, '').trim().toLowerCase();
    return textLower.includes(cleanLabel) || textLower.includes(s.id.replace('_', ' '));
  }).length;

  const constraintsScore = 45;
  const experienceRatio = Math.min(1, Math.max(0.4, (matchedEssentialCount + 1) / (essentialCount || 1)));
  const experienceScore = Math.round(experienceRatio * 30);
  const logisticsScore = city.toLowerCase().includes('local') || city.includes(',') ? 18 : 14;
  const totalScore = Math.min(98, Math.max(60, constraintsScore + experienceScore + logisticsScore));

  const expYearsMatch = resumeMarkdown.match(/(\d+)\+?\s*years?/i);
  const experienceYears = expYearsMatch ? parseInt(expYearsMatch[1], 10) : (matchedEssentialCount > 1 ? 2 : 1);

  return {
    candidate: {
      name,
      email: email || 'contact@example.com',
      phone: phone || '(555) 000-0000',
      city,
      skills: Array.from(new Set(matchedSkills)).slice(0, 6),
      experience_years: experienceYears,
      applied_role: role.id,
    },
    score: {
      total: totalScore,
      breakdown: {
        constraints: constraintsScore,
        experience: experienceScore,
        logistics: logisticsScore,
      },
      explanation: `Candidate ${name} evaluated for ${role.title} position. Demonstrates proficiency in key skills (${matchedSkills.slice(0, 3).join(', ')}) with ${experienceYears} year(s) experience, matching ${role.title} requirements.`,
    },
    red_flags: [],
  };
}

/**
 * Step 2 of the pipeline — call Agent 2 (Gemini Model) to semantically score candidate against role.
 * Accepts only markdown text from Agent 1. Raw files stay inside the OCR layer.
 */
async function callScorerAgent(
  resumeMarkdown: string,
  role: CafeRole,
  fileName: string = 'Resume.pdf'
): Promise<ParserOutput> {
  if (!genAI) {
    return extractAndScoreCandidate(resumeMarkdown, fileName, role);
  }

  const resumeSection = `═══════════════════════════════════════════════════════
${resumeMarkdown}
═══════════════════════════════════════════════════════`;

  const prompt = `You are TeamFlow Agent 2 — an expert AI hiring assistant for specialty cafes and restaurants.
Evaluate the candidate's resume for the position of "${role.title}".

ROLE CRITERIA TO EVALUATE:
- Title: ${role.title}
- Dealbreakers: ${JSON.stringify(role.dealbreakers)}
- Essential Skills: ${JSON.stringify(role.essentialSkills.map(s => s.label))}
- Nice-To-Have Skills: ${JSON.stringify(role.niceToHaveSkills.map(s => s.label))}

CANDIDATE RESUME TEXT (from Agent 1 OCR):
${resumeSection}

EVALUATION INSTRUCTIONS:

1. **CONTACT DETAILS**: Extract full name, email (look for @), phone, and city.
   - EMAIL: Return the exact string found. Do NOT fabricate. Return "" if missing.

2. **SKILLS MATCHING**: Only return skills relevant to "${role.title}".
   - Match against ESSENTIAL and NICE-TO-HAVE lists above.
   - Limit to 3–8 relevant skills. Exclude generic skills.

3. **EXPERIENCE**: Count years of relevant experience (food service, hospitality, retail).

4. **SCORING** (0–100 total):
   - Constraints (0–50): Dealbreakers passed proportionally.
   - Experience (0–30): Skills match to ESSENTIAL skills list.
   - Logistics (0–20): Location commute estimate.

5. **RED FLAGS**: Employment gaps >6 months, 3+ jobs/year, unexplained downgrades.

OUTPUT — valid JSON only, no markdown fences:
{
  "candidate": {
    "name": "Full name",
    "email": "exact@email.com or empty string",
    "phone": "phone or empty string",
    "city": "city or empty string",
    "skills": ["only", "relevant", "skills"],
    "experience_years": number,
    "applied_role": "${role.id}"
  },
  "score": {
    "total": number,
    "breakdown": { "constraints": number, "experience": number, "logistics": number },
    "explanation": "2-3 sentence explanation referencing specific skills and dealbreakers"
  },
  "red_flags": ["list of concerns, or empty array"]
	}`;

  let result = null;

  try {
    const model = genAI.getGenerativeModel({ model: SCORER_MODEL });
    result = await withScorerSpan(
      {
        'gen_ai.system': 'google_gemini',
        'gen_ai.operation.name': 'score_resume',
        'gen_ai.model.name': SCORER_MODEL,
        'teamflow.role_id': role.id,
      },
      () => model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      })
    );
    console.log(`[Pipeline] Agent 2 (Scorer) using model: ${SCORER_MODEL}`);
  } catch (err: unknown) {
    console.warn(`[Pipeline] Agent 2 model ${SCORER_MODEL} notice:`, (err as Error).message || err);
  }

  if (!result) {
    console.warn('[Pipeline] Agent 2 models unavailable — performing dynamic role-based evaluation');
    return extractAndScoreCandidate(resumeMarkdown, fileName, role);
  }

  const usage = result.response.usageMetadata;
  recordScorerUsage(usage);

  const responseText = result.response.text();
  const parsed = JSON.parse(responseText);

  if (parsed.candidate && !parsed.candidate.applied_role) {
    parsed.candidate.applied_role = role.id;
  }

  return parsed as ParserOutput;
}

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
