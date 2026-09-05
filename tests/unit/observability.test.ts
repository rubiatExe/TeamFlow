import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { TEAMFLOW_OTEL_PROPAGATORS } from '../../instrumentation.ts';
import {
  createOcrFetchOptions,
  OCR_FETCH_TELEMETRY,
} from '../../lib/observability/ocr-fetch.ts';
import {
  getActiveTraceFields,
  withTraceSpan,
} from '../../lib/observability/tracing.ts';

test('propagates W3C trace context without ambient baggage', () => {
  assert.deepEqual([...TEAMFLOW_OTEL_PROPAGATORS], ['tracecontext']);
  assert.equal(
    (TEAMFLOW_OTEL_PROPAGATORS as readonly string[]).includes('baggage'),
    false,
  );
});

test('opts the OCR boundary into W3C context propagation', () => {
  const formData = new FormData();
  formData.append('file', new Blob(['synthetic']), 'candidate.txt');

  const options = createOcrFetchOptions(formData, 'test-token');

  assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, { 'X-OCR-Token': 'test-token' });
  assert.equal(options.body, formData);
  assert.deepEqual(options.opentelemetry, OCR_FETCH_TELEMETRY);
  assert.equal(options.opentelemetry?.propagateContext, true);
});

test('trace helpers remain safe when the SDK is disabled', async () => {
  assert.deepEqual(getActiveTraceFields(), {});

  const result = await withTraceSpan(
    'test.operation',
    { 'teamflow.pipeline.stage': 'test' },
    async () => 'completed',
  );

  assert.equal(result, 'completed');
});

test('semantic scorer tracing is statically bundled and cannot silently disappear', () => {
  const source = readFileSync(
    new URL('../../lib/ai/scorer.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /from '@opentelemetry\/api'/u);
  assert.doesNotMatch(source, /import\(moduleName\)/u);
  assert.doesNotMatch(source, /\.catch\(\(\) => null\)/u);
});
