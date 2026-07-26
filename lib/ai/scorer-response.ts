import {
  ParserOutputSchema,
  type ParserOutput,
} from '../contracts/parser.ts';

export type ScorerResponseErrorKind =
  | 'empty_output'
  | 'incomplete_finish'
  | 'invalid_json'
  | 'invalid_schema';

interface ScorerResponseErrorOptions {
  finishReason?: string;
  responseLength?: number;
  validationPaths?: string[];
  cause?: unknown;
}

export class ScorerResponseError extends Error {
  readonly kind: ScorerResponseErrorKind;
  readonly finishReason?: string;
  readonly responseLength: number;
  readonly validationPaths: string[];

  constructor(
    kind: ScorerResponseErrorKind,
    message: string,
    options: ScorerResponseErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ScorerResponseError';
    this.kind = kind;
    this.finishReason = options.finishReason;
    this.responseLength = options.responseLength ?? 0;
    this.validationPaths = options.validationPaths ?? [];
  }
}

function removeMarkdownFence(responseText: string): string {
  const trimmed = responseText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseAndValidateScorerResponse(
  responseText: string,
  finishReason?: string,
): ParserOutput {
  const cleanedText = removeMarkdownFence(responseText);

  if (!cleanedText) {
    throw new ScorerResponseError('empty_output', 'Gemini returned an empty response', {
      finishReason,
    });
  }

  if (finishReason && finishReason !== 'STOP') {
    throw new ScorerResponseError(
      'incomplete_finish',
      `Gemini response ended with finish reason ${finishReason}`,
      {
        finishReason,
        responseLength: cleanedText.length,
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedText);
  } catch (error) {
    throw new ScorerResponseError('invalid_json', 'Gemini returned malformed JSON', {
      finishReason,
      responseLength: cleanedText.length,
      cause: error,
    });
  }

  const validated = ParserOutputSchema.safeParse(parsed);
  if (!validated.success) {
    const validationPaths = Array.from(
      new Set(
        validated.error.issues.map((issue) =>
          issue.path.length > 0 ? issue.path.join('.') : '<root>',
        ),
      ),
    );

    throw new ScorerResponseError(
      'invalid_schema',
      'Gemini JSON did not match the parser output contract',
      {
        finishReason,
        responseLength: cleanedText.length,
        validationPaths,
      },
    );
  }

  return validated.data;
}
