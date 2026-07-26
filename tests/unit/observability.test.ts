import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOcrFetchOptions,
  OCR_FETCH_TELEMETRY,
} from '../../lib/observability/ocr-fetch.ts';
import {
  getActiveTraceFields,
  withTraceSpan,
} from '../../lib/observability/tracing.ts';

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
