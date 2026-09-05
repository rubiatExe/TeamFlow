import {
  FinishReason,
  GoogleGenerativeAI,
  type GenerateContentResult,
} from '@google/generative-ai';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { CafeRole } from '../domain/roles';
import {
  PARSER_OUTPUT_RESPONSE_SCHEMA,
  type ParserOutput,
} from '../contracts/parser';
import {
  isScorerResponseError,
  runScorerWithFallback,
} from './scorer-runner';

const DEFAULT_SCORER_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

let genAIClient: GoogleGenerativeAI | null | undefined;

function getGenAIClient(): GoogleGenerativeAI | null {
  if (genAIClient !== undefined) {
    return genAIClient;
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  genAIClient = apiKey ? new GoogleGenerativeAI(apiKey) : null;
  return genAIClient;
}

function getScorerModels(): string[] {
  const primary = process.env.SCORER_MODEL || DEFAULT_SCORER_MODEL;
  const fallback = process.env.SCORER_FALLBACK_MODEL || primary;
  return [primary, fallback];
}

function getMaxAttempts(): number {
  const configured = Number.parseInt(
    process.env.SCORER_MAX_ATTEMPTS || '',
    10,
  );

  if (!Number.isFinite(configured)) {
    return DEFAULT_MAX_ATTEMPTS;
  }

  return Math.max(1, Math.min(configured, DEFAULT_MAX_ATTEMPTS));
}

function getMaxOutputTokens(): number {
  const configured = Number.parseInt(
    process.env.SCORER_MAX_OUTPUT_TOKENS || '',
    10,
  );

  if (!Number.isFinite(configured)) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }

  return Math.max(512, Math.min(configured, 4_096));
}

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
};

async function withScorerSpan(
  attributes: Record<string, string | number | boolean>,
  operation: () => Promise<GenerateContentResult>
): Promise<GenerateContentResult> {
  const start = Date.now();
  const tracer = trace.getTracer('teamflow.semantic_scorer', '1.0.0');

  return tracer.startActiveSpan('score_resume', async (span: Span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }

      const result = await operation();
      const usage = result.response.usageMetadata;

      span.setAttribute('gen_ai.usage.input_tokens', usage?.promptTokenCount ?? 0);
      span.setAttribute('gen_ai.usage.output_tokens', usage?.candidatesTokenCount ?? 0);
      span.setAttribute('teamflow.duration_ms', Date.now() - start);
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      span.setAttribute(
        'error.type',
        error instanceof Error ? error.name : 'UnknownError',
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

function recordScorerUsage(
  usage: GeminiUsageMetadata | undefined,
  requestId: string,
  attempt: number,
) {
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  console.log('[Scorer] token_usage', {
    requestId,
    attempt,
    inputTokens,
    outputTokens,
  });
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
  const city = cityMatch ? cityMatch[1].trim() : '';

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

  // 6. Conservative role-based fallback scoring.
  // This path only uses explicit evidence and always asks for manual review.
  const essentialCount = role.essentialSkills.length || 1;
  const matchedEssentialCount = role.essentialSkills.filter(s => {
    const cleanLabel = s.label.replace(/^[^\w]+/, '').trim().toLowerCase();
    return textLower.includes(cleanLabel) || textLower.includes(s.id.replace('_', ' '));
  }).length;

  const constraintsScore = 0;
  const experienceRatio = Math.min(
    1,
    matchedEssentialCount / essentialCount,
  );
  const experienceScore = Math.round(experienceRatio * 30);
  const logisticsScore = city ? 10 : 0;
  const totalScore = constraintsScore + experienceScore + logisticsScore;

  const expYearsMatch = resumeMarkdown.match(/(\d+)\+?\s*years?/i);
  const experienceYears = expYearsMatch ? parseInt(expYearsMatch[1], 10) : 0;

  return {
    candidate: {
      name,
      email,
      phone,
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
      explanation: `AI scoring was unavailable. This provisional ${role.title} score uses only explicit resume matches and requires manual review.`,
    },
    red_flags: ['AI scoring unavailable; manual review required'],
  };
}

function createEmergencyFallback(
  fileName: string,
  role: CafeRole,
): ParserOutput {
  const candidateName =
    fileName
      .replace(/\.[^/.]+$/, '')
      .replace(/[_|-]?resume/gi, '')
      .replace(/[_|-]/g, ' ')
      .trim() || 'Candidate';

  return {
    candidate: {
      name: candidateName,
      email: '',
      phone: '',
      city: '',
      skills: [],
      experience_years: 0,
      applied_role: role.id,
    },
    score: {
      total: 0,
      breakdown: {
        constraints: 0,
        experience: 0,
        logistics: 0,
      },
      explanation:
        'Automated scoring was unavailable. Manual review is required.',
    },
    red_flags: ['Automated scoring unavailable; manual review required'],
  };
}

function getErrorStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  ) {
    return error.status;
  }

  return undefined;
}

function shouldRetryScorerError(error: unknown): boolean {
  if (isScorerResponseError(error)) {
    return true;
  }

  const status = getErrorStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('timeout') ||
    message.includes('temporar') ||
    message.includes('rate limit')
  );
}

function logScorerFailure(
  requestId: string,
  attempt: number,
  model: string,
  error: unknown,
) {
  if (isScorerResponseError(error)) {
    console.warn('[Scorer] invalid_response', {
      requestId,
      attempt,
      model,
      kind: error.kind,
      finishReason: error.finishReason,
      responseLength: error.responseLength,
      validationPaths: error.validationPaths,
    });
    return;
  }

  console.warn('[Scorer] request_failed', {
    requestId,
    attempt,
    model,
    status: getErrorStatus(error),
    errorType: error instanceof Error ? error.name : 'UnknownError',
  });
}

/**
 * Structured scoring stage — score a candidate against a role with Gemini.
 * Accepts only markdown text. Raw files stay inside the OCR layer.
 */
export async function callScorerAgent(
  resumeMarkdown: string,
  role: CafeRole,
  fileName: string = 'Resume.pdf',
  isWebForm: boolean = false,
  requestId: string = crypto.randomUUID(),
): Promise<ParserOutput> {
  const genAI = getGenAIClient();
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

  const prompt = `You are TeamFlow's structured scoring engine for specialty cafes and restaurants.
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

  const models = getScorerModels();

  const scorerRun = await runScorerWithFallback({
    models,
    maxAttempts: getMaxAttempts(),
    generate: async (modelName, attempt) => {
      const model = genAI.getGenerativeModel({ model: modelName });
      const retryInstruction =
        attempt > 1
          ? '\nRETRY REQUIREMENT: Return one complete JSON object. Do not repeat or append any content after the closing brace.'
          : '';

      const result = await withScorerSpan(
        {
          'gen_ai.system': 'google_gemini',
          'gen_ai.operation.name': 'score_resume',
          'gen_ai.model.name': modelName,
          'teamflow.role_id': role.id,
          'teamflow.request_id': requestId,
          'teamflow.attempt': attempt,
          'teamflow.pipeline.stage': 'scoring',
        },
        () =>
          model.generateContent({
            contents: [
              {
                role: 'user',
                parts: [{ text: `${prompt}${retryInstruction}` }],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: PARSER_OUTPUT_RESPONSE_SCHEMA,
              temperature: 0,
              maxOutputTokens: getMaxOutputTokens(),
            },
          }),
      );

      recordScorerUsage(
        result.response.usageMetadata,
        requestId,
        attempt,
      );

      return {
        text: result.response.text(),
        finishReason:
          result.response.candidates?.[0]?.finishReason ??
          FinishReason.FINISH_REASON_UNSPECIFIED,
      };
    },
    fallback: () => extractAndScoreCandidate(resumeMarkdown, fileName, role),
    emergencyFallback: () => createEmergencyFallback(fileName, role),
    shouldRetry: shouldRetryScorerError,
    onAttemptFailure: ({ attempt, model, error }) => {
      logScorerFailure(requestId, attempt, model, error);
    },
  });

  console.log('[Scorer] completed', {
    requestId,
    mode: scorerRun.mode,
    attemptsUsed: scorerRun.attemptsUsed,
    model: scorerRun.model,
  });

  return scorerRun.data;
}
