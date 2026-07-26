import {
  ParserOutputSchema,
  type ParserOutput,
} from '../contracts/parser.ts';
import {
  parseAndValidateScorerResponse,
  type ScorerResponseError,
} from './scorer-response.ts';

export type ScoringMode = 'ai' | 'retry' | 'fallback';

export interface GeneratedScorerResponse {
  text: string;
  finishReason?: string;
}

interface ScorerAttemptFailure {
  attempt: number;
  model: string;
  error: unknown;
}

interface RunScorerWithFallbackOptions {
  models: string[];
  maxAttempts: number;
  generate: (
    model: string,
    attempt: number,
  ) => Promise<GeneratedScorerResponse>;
  fallback: () => ParserOutput;
  emergencyFallback: () => ParserOutput;
  shouldRetry?: (error: unknown) => boolean;
  onAttemptFailure?: (failure: ScorerAttemptFailure) => void;
}

export interface ScorerRunResult {
  data: ParserOutput;
  mode: ScoringMode;
  attemptsUsed: number;
  model?: string;
}

function validateFallback(
  fallback: () => ParserOutput,
  emergencyFallback: () => ParserOutput,
): ParserOutput {
  const primaryFallback = ParserOutputSchema.safeParse(fallback());
  if (primaryFallback.success) {
    return primaryFallback.data;
  }

  return ParserOutputSchema.parse(emergencyFallback());
}

export async function runScorerWithFallback({
  models,
  maxAttempts,
  generate,
  fallback,
  emergencyFallback,
  shouldRetry = () => true,
  onAttemptFailure,
}: RunScorerWithFallbackOptions): Promise<ScorerRunResult> {
  const attempts = Math.max(1, Math.min(maxAttempts, models.length));
  let attemptsUsed = 0;

  for (let index = 0; index < attempts; index += 1) {
    const attempt = index + 1;
    const model = models[index];
    attemptsUsed = attempt;

    try {
      const generated = await generate(model, attempt);
      const data = parseAndValidateScorerResponse(
        generated.text,
        generated.finishReason,
      );

      return {
        data,
        mode: attempt === 1 ? 'ai' : 'retry',
        attemptsUsed: attempt,
        model,
      };
    } catch (error) {
      onAttemptFailure?.({ attempt, model, error });

      if (!shouldRetry(error)) {
        break;
      }
    }
  }

  return {
    data: validateFallback(fallback, emergencyFallback),
    mode: 'fallback',
    attemptsUsed,
  };
}

export function isScorerResponseError(
  error: unknown,
): error is ScorerResponseError {
  return (
    error instanceof Error &&
    error.name === 'ScorerResponseError' &&
    'kind' in error
  );
}
