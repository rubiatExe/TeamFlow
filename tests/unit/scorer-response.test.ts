import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PARSER_OUTPUT_RESPONSE_SCHEMA,
  ParserOutputSchema,
  type ParserOutput,
} from '../../lib/contracts/parser.ts';
import {
  parseAndValidateScorerResponse,
  ScorerResponseError,
  type ScorerResponseErrorKind,
} from '../../lib/ai/scorer-response.ts';
import { runScorerWithFallback } from '../../lib/ai/scorer-runner.ts';

const validOutput: ParserOutput = {
  candidate: {
    name: 'Alex Candidate',
    email: 'alex@example.com',
    phone: '',
    city: 'Jersey City, NJ',
    skills: ['Customer Service'],
    experience_years: 2,
    applied_role: 'barista',
  },
  score: {
    total: 70,
    breakdown: {
      constraints: 40,
      experience: 20,
      logistics: 10,
    },
    explanation: 'The candidate has relevant customer service experience.',
  },
  red_flags: [],
};

function expectScorerError(
  operation: () => unknown,
  expectedKind: ScorerResponseErrorKind,
) {
  assert.throws(operation, (error: unknown) => {
    return (
      error instanceof ScorerResponseError &&
      error.kind === expectedKind
    );
  });
}

test('accepts complete JSON that matches the parser contract', () => {
  const parsed = parseAndValidateScorerResponse(
    JSON.stringify(validOutput),
    'STOP',
  );

  assert.deepEqual(parsed, validOutput);
});

test('keeps the Gemini response schema aligned with required parser fields', () => {
  if (!('properties' in PARSER_OUTPUT_RESPONSE_SCHEMA)) {
    assert.fail('Gemini response schema must be an object schema');
  }

  const properties = PARSER_OUTPUT_RESPONSE_SCHEMA.properties;
  const required = PARSER_OUTPUT_RESPONSE_SCHEMA.required ?? [];

  assert.deepEqual(required, ['candidate', 'score', 'red_flags']);
  assert.ok(properties.candidate);
  assert.ok(properties.score);
  assert.ok(properties.red_flags);
  assert.equal(ParserOutputSchema.safeParse(validOutput).success, true);
});

test('accepts a complete JSON object inside a markdown fence', () => {
  const parsed = parseAndValidateScorerResponse(
    `\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``,
    'STOP',
  );

  assert.equal(parsed.candidate.name, validOutput.candidate.name);
});

test('rejects an empty model response', () => {
  expectScorerError(
    () => parseAndValidateScorerResponse('   ', 'STOP'),
    'empty_output',
  );
});

test('rejects the truncated JSON shape observed in production', () => {
  const truncated =
    '{"candidate":{"name":"Alex","skills":[]},"score":{"total":10';

  expectScorerError(
    () => parseAndValidateScorerResponse(truncated, 'STOP'),
    'invalid_json',
  );
});

test('rejects duplicated content after an otherwise valid JSON object', () => {
  const duplicated = `${JSON.stringify(validOutput)}\n}\n]\n}`;

  expectScorerError(
    () => parseAndValidateScorerResponse(duplicated, 'STOP'),
    'invalid_json',
  );
});

test('rejects output that stopped because of the token limit', () => {
  expectScorerError(
    () =>
      parseAndValidateScorerResponse(
        JSON.stringify(validOutput),
        'MAX_TOKENS',
      ),
    'incomplete_finish',
  );
});

test('rejects valid JSON with an inconsistent score total', () => {
  const inconsistent = {
    ...validOutput,
    score: {
      ...validOutput.score,
      total: 99,
    },
  };

  expectScorerError(
    () =>
      parseAndValidateScorerResponse(
        JSON.stringify(inconsistent),
        'STOP',
      ),
    'invalid_schema',
  );
});

test('retries once and returns the validated second response', async () => {
  let generateCalls = 0;

  const result = await runScorerWithFallback({
    models: ['primary-model', 'fallback-model'],
    maxAttempts: 2,
    generate: async () => {
      generateCalls += 1;
      return generateCalls === 1
        ? { text: '{"candidate":', finishReason: 'STOP' }
        : { text: JSON.stringify(validOutput), finishReason: 'STOP' };
    },
    fallback: () => validOutput,
    emergencyFallback: () => validOutput,
  });

  assert.equal(generateCalls, 2);
  assert.equal(result.mode, 'retry');
  assert.equal(result.attemptsUsed, 2);
  assert.deepEqual(result.data, validOutput);
});

test('uses a validated fallback after both model responses fail', async () => {
  let generateCalls = 0;

  const result = await runScorerWithFallback({
    models: ['primary-model', 'fallback-model'],
    maxAttempts: 2,
    generate: async () => {
      generateCalls += 1;
      return { text: '{"candidate":', finishReason: 'STOP' };
    },
    fallback: () => validOutput,
    emergencyFallback: () => validOutput,
  });

  assert.equal(generateCalls, 2);
  assert.equal(result.mode, 'fallback');
  assert.deepEqual(result.data, validOutput);
});

test('does not retry a non-retryable provider error', async () => {
  let generateCalls = 0;

  const result = await runScorerWithFallback({
    models: ['primary-model', 'fallback-model'],
    maxAttempts: 2,
    generate: async () => {
      generateCalls += 1;
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    },
    fallback: () => validOutput,
    emergencyFallback: () => validOutput,
    shouldRetry: () => false,
  });

  assert.equal(generateCalls, 1);
  assert.equal(result.mode, 'fallback');
  assert.equal(result.attemptsUsed, 1);
});

test('uses the emergency fallback when the primary fallback is invalid', async () => {
  const invalidFallback = {
    ...validOutput,
    score: {
      ...validOutput.score,
      total: 101,
    },
  } as ParserOutput;

  const result = await runScorerWithFallback({
    models: ['primary-model'],
    maxAttempts: 1,
    generate: async () => {
      throw new Error('Provider unavailable');
    },
    fallback: () => invalidFallback,
    emergencyFallback: () => validOutput,
    shouldRetry: () => false,
  });

  assert.equal(result.mode, 'fallback');
  assert.deepEqual(result.data, validOutput);
});
