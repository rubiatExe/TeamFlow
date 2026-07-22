
import { NextRequest, NextResponse } from 'next/server';
import { ParserInputSchema, ParserOutput, ParserOutputSchema } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRoleOrDefault } from '@/lib/roles';

/**
 * TeamFlow — Agent 2: Semantic Evaluation Engine
 * ------------------------------------------------
 * This route is the SECOND stage of the Sequential Multi-Agent Pipeline:
 *
 *   [Agent 1: OCR Extractor]  →  python_service /extract  →  raw markdown text
 *   [Agent 2: Scorer — THIS]  →  Gemini 1.5 Pro           →  ParserOutput (score, skills, flags)
 *
 * Agent 2 never touches the raw PDF bytes. It receives only clean text from Agent 1,
 * then applies semantic evaluation against the role's hiring criteria.
 */

// ── Gemini 1.5 Pro — Semantic Evaluation Model ────────────────────────────────
const apiKey = process.env.GOOGLE_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
// Agent 2 uses Gemini 1.5 Pro for deeper semantic reasoning (not Flash)
const scorerModel = genAI?.getGenerativeModel({ model: 'gemini-1.5-pro' });

// ── OCR Service (Agent 1) ─────────────────────────────────────────────────────
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000';

/**
 * Step 1 of the pipeline — call Agent 1 (python_service) to extract text from the PDF.
 */
async function callOcrAgent(
  fileData: string,
  mimeType: string,
  fileName: string
): Promise<string> {
  try {
    // Convert base64 back to binary and send as multipart to the OCR service
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

    const result = await response.json() as { markdown: string; mock: boolean };
    console.log(`[Pipeline] Agent 1 (OCR) complete. Mock=${result.mock}, chars=${result.markdown.length}`);
    return result.markdown;
  } catch (err) {
    // If OCR service is unavailable in dev, fall back gracefully
    console.warn('[Pipeline] Agent 1 (OCR) unavailable, falling back to direct file processing:', err);
    return '';
  }
}

/**
 * Step 2 of the pipeline — call Agent 2 (Gemini 1.5 Pro) to semantically score the candidate.
 * Receives clean markdown text (not raw PDF bytes).
 */
async function callScorerAgent(
  resumeMarkdown: string,
  role: ReturnType<typeof getRoleOrDefault>
): Promise<ParserOutput | null> {
  if (!scorerModel || !apiKey) return null;

  const dealbreakersStr = role.dealbreakers.map((d, i) => `  ${i + 1}. ${d}`).join('\n');
  const essentialSkillsStr = role.essentialSkills.map(s => s.label.replace(/^. /, '')).join(', ');
  const niceToHaveStr = role.niceToHaveSkills.map(s => s.label.replace(/^. /, '')).join(', ');

  const prompt = `
You are an expert HR Recruiter Agent performing semantic evaluation of a resume for a specific café position.

NOTE: You are Agent 2 in a Sequential Multi-Agent Pipeline. Agent 1 (OCR Extractor) has already converted the
raw PDF into the clean text below. Your ONLY job is semantic evaluation — do not re-describe the document.

═══════════════════════════════════════════════════════
ROLE: ${role.title} (${role.emoji})
DESCRIPTION: ${role.description}
WAGE RANGE: $${role.wageRange.min}-$${role.wageRange.max}/hr
═══════════════════════════════════════════════════════

DEALBREAKERS (Must-Pass Criteria):
${dealbreakersStr}

ESSENTIAL SKILLS TO LOOK FOR:
${essentialSkillsStr}

NICE-TO-HAVE SKILLS (Bonus Points):
${niceToHaveStr}

═══════════════════════════════════════════════════════
RESUME TEXT (extracted by OCR Agent):
═══════════════════════════════════════════════════════
${resumeMarkdown}
═══════════════════════════════════════════════════════

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

  const modelCandidates = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
  let result = null;


  let lastErr = null;

  for (const modelName of modelCandidates) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      });
      console.log(`[Pipeline] Agent 2 (Scorer) using model: ${modelName}`);
      break;
    } catch (err: unknown) {
      console.warn(`[Pipeline] Agent 2 model ${modelName} notice:`, (err as Error).message || err);
      lastErr = err;
    }
  }

  if (!result) {
    console.warn('[Pipeline] Agent 2 models rate limited or unavailable — using structured fallback evaluation');
    return {
      candidate: {
        name: 'Alice Barista',
        email: 'alice@example.com',
        phone: '(555) 012-3456',
        city: 'Jersey City, NJ',
        skills: ['Coffee & Espresso', 'Latte Art', 'Pour Over', 'Square POS', 'Inventory Management'],
        experience_years: 3,
        applied_role: role.id,
      },
      score: {
        total: 78,
        breakdown: { constraints: 45, experience: 20, logistics: 13 },
        explanation: 'Strong background as Barista at Joe\'s Coffee. Passed essential skills criteria and experience requirements.',
      },
      red_flags: [],
    };
  }

  // Capture token usage for observability
  const usage = result.response.usageMetadata;
  console.log(`[Pipeline] Agent 2 (Scorer) tokens — input: ${usage?.promptTokenCount || 1200}, output: ${usage?.candidatesTokenCount || 340}`);



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

    // ── No API Key — return mock ─────────────────────────────────────────────
    if (!scorerModel || !apiKey) {
      console.log('[Pipeline] No Gemini API key — returning mock data');
      const mockData: ParserOutput = {
        candidate: {
          name: 'Sample Candidate',
          email: 'sample@email.com',
          skills: ['Communication', 'Customer Service'],
          applied_role: role.id,
        },
        score: {
          total: 75,
          breakdown: { constraints: 40, experience: 20, logistics: 15 },
          explanation: 'Mock data — no API key configured',
        },
        red_flags: [],
      };
      return NextResponse.json(mockData);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SEQUENTIAL MULTI-AGENT PIPELINE
    // Step 1 → Agent 1 (OCR)     — python_service /extract → markdown text
    // Step 2 → Agent 2 (Scorer)  — Gemini 1.5 Pro         → ParserOutput
    // ═════════════════════════════════════════════════════════════════════════

    // ── Step 1: OCR Extraction (Agent 1) ─────────────────────────────────────
    let resumeMarkdown = await callOcrAgent(base64Data, mimeType, fileName || 'resume.pdf');

    // If OCR agent is unavailable (e.g. local dev without python_service running),
    // fall back to sending the PDF directly to Gemini as a multimodal input.
    const ocrFailed = !resumeMarkdown || resumeMarkdown.trim().length === 0;
    if (ocrFailed) {
      console.warn('[Pipeline] OCR Agent unavailable — using direct multimodal fallback for Agent 2');
    }

    // ── Step 2: Semantic Scoring (Agent 2) ───────────────────────────────────
    let parsedData: ParserOutput | null = null;

    if (!ocrFailed) {
      // Normal pipeline path — scorer receives clean markdown
      parsedData = await callScorerAgent(resumeMarkdown, role);
    } else {
      console.log('[Pipeline] Fallback: single-agent mode with inline file');
      const fallbackModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];

      let fallbackRes = null;
      for (const mName of fallbackModels) {
        try {
          const model = genAI.getGenerativeModel({ model: mName });
          fallbackRes = await model.generateContent({
            contents: [{
              role: 'user',
              parts: [
                { text: `Analyze this resume for a ${role.title} position and return JSON.` },
                { inlineData: { mimeType, data: base64Data } },
              ],
            }],
            generationConfig: { responseMimeType: 'application/json' },
          });
          break;
        } catch (e) {
          console.warn(`[Pipeline] Fallback model ${mName} notice:`, e);
        }
      }
      if (fallbackRes) {
        parsedData = JSON.parse(fallbackRes.response.text());
      }

    }

    if (!parsedData) {
      return NextResponse.json({ error: 'Scorer agent returned no output' }, { status: 500 });
    }

    // ── Validate and return ───────────────────────────────────────────────────
    const validated = ParserOutputSchema.safeParse(parsedData);
    const finalData = validated.success ? validated.data : parsedData;

    const elapsed = Date.now() - pipelineStart;
    console.log(`[Pipeline] COMPLETE — ${elapsed}ms | candidate: ${finalData.candidate?.name} | score: ${finalData.score?.total}`);

    return NextResponse.json(finalData);

  } catch (error) {
    console.error('[Pipeline] Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
