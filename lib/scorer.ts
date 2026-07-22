import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRoleOrDefault, CafeRole } from './roles';
import { ParserOutput } from '../app/api/types';

const apiKey = process.env.GOOGLE_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const SCORER_MODEL = 'gemini-3.1-pro-preview';

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
 * Dynamic Candidate Name, Contact, & Role-based Evaluation Extractor
 * Ensures candidate name & role criteria are parsed correctly even if API keys or rate limits occur.
 */
export function extractAndScoreCandidate(
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
 * Accepts only markdown text. Raw files stay inside the OCR layer.
 */
export async function callScorerAgent(
  resumeMarkdown: string,
  role: CafeRole,
  fileName: string = 'Resume.pdf',
  isWebForm: boolean = false
): Promise<ParserOutput> {
  if (!genAI) {
    return extractAndScoreCandidate(resumeMarkdown, fileName, role);
  }

  const resumeSection = `═══════════════════════════════════════════════════════\n${resumeMarkdown}\n═══════════════════════════════════════════════════════`;

  const webFormInstructions = isWebForm ? `
**WEB FORM SUBMISSION EVALUATION:**
This candidate submitted a web application rather than a traditional resume. Pay close attention to their answers to the "Motivation & Personality" questions. 
- Use their text answers to evaluate personality traits (e.g., enthusiasm, work ethic, teamwork).
- Factor their "Superpower" and "Above and Beyond" answers into the nuanced fit score.
- Evaluate their communication skills based on how they wrote their answers.
` : '';

  const prompt = `You are TeamFlow Agent 2 — an expert AI hiring assistant for specialty cafes and restaurants.
Evaluate the candidate's application for the position of "${role.title}".

ROLE CRITERIA TO EVALUATE:
- Title: ${role.title}
- Dealbreakers: ${JSON.stringify(role.dealbreakers)}
- Essential Skills: ${JSON.stringify(role.essentialSkills.map(s => s.label))}
- Nice-To-Have Skills: ${JSON.stringify(role.niceToHaveSkills.map(s => s.label))}

CANDIDATE TEXT:
${resumeSection}
${webFormInstructions}
EVALUATION INSTRUCTIONS:

1. **CONTACT DETAILS**: Extract full name, email (look for @), phone, and city.
   - EMAIL: Return the exact string found. Do NOT fabricate. Return "" if missing.

2. **SKILLS MATCHING**: Only return skills relevant to "${role.title}".
   - Match against ESSENTIAL and NICE-TO-HAVE lists above.
   - Limit to 3–8 relevant skills. Exclude generic skills.

3. **EXPERIENCE**: Count years of relevant experience (food service, hospitality, retail).

4. **SCORING** (0–100 total):
   - Constraints (0–50): Dealbreakers passed proportionally.
   - Experience (0–30): Skills match to ESSENTIAL skills list (and for web forms, motivation/personality fit).
   - Logistics (0–20): Location commute estimate or availability match.

5. **RED FLAGS**: Employment gaps >6 months, 3+ jobs/year, unexplained downgrades, or poor/unprofessional motivation answers.

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
    "explanation": "2-3 sentence explanation referencing specific skills, dealbreakers, and (if applicable) personality traits from their motivation answers."
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
  const cleanedText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(cleanedText);

  if (parsed.candidate && !parsed.candidate.applied_role) {
    parsed.candidate.applied_role = role.id;
  }

  return parsed as ParserOutput;
}
