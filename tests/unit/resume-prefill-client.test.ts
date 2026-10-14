import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { DocumentProcessorError } from '../../lib/ai/document-processor-client.ts';
import { requestResumePrefillExtraction } from '../../lib/ai/resume-prefill-client.ts';

const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const request = {
  bytes,
  mimeType: 'application/pdf',
  fileName: 'synthetic-resume.pdf',
  serviceUrl: 'http://document-processor.test',
  token: 'test-token',
};

function v1Response(contentSha256 = digest) {
  const markdown = 'Jordan Rivera';
  const blockDigest = createHash('sha256')
    .update(`1|1|${markdown}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return {
    schema_version: '1.0',
    document_id: `doc-${contentSha256}`,
    status: 'degraded',
    markdown,
    text: markdown,
    source_blocks: [{
      source_block_id: `src-${contentSha256.slice(0, 12)}-p0001-b0001-${blockDigest}`,
      page_number: 1,
      ordinal: 1,
      text: markdown,
    }],
    embedding: null,
    extraction_method: 'pdf_text',
    model_id: 'pypdf-6.16.2',
    embedding_model_id: null,
    content_sha256: contentSha256,
    mock: false,
    warnings: ['embedding_failed'],
    quality: {
      assessment: 'usable',
      character_count: Array.from(markdown).length,
      block_count: 1,
      page_count: 1,
      reason_codes: [],
    },
  };
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return async () => Response.json(body, { status });
}

test('prefill client accepts a valid v1 response with matching uploaded-byte hash', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await requestResumePrefillExtraction({
    ...request,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json(v1Response());
    },
  });

  assert.deepEqual(result, { markdown: 'Jordan Rivera' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://document-processor.test/extract');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal((calls[0].init.headers as Record<string, string>)['X-OCR-Token'], request.token);
});

test('prefill client accepts legacy OCR markdown solely as an editable suggestion', async () => {
  const result = await requestResumePrefillExtraction({
    ...request,
    fetchImpl: fetchReturning({
      markdown: 'Jordan Rivera\nExperience: Barista',
      embedding: null,
      mock: false,
    }),
  });
  assert.deepEqual(result, { markdown: 'Jordan Rivera\nExperience: Barista' });
});

test('prefill client rejects mock and malformed responses', async () => {
  for (const [payload, code] of [
    [{ markdown: 'invented', embedding: null, mock: true }, 'document_not_scoreable'],
    [{ markdown: 'invented', embedding: null }, 'document_not_scoreable'],
    [{ markdown: 42, mock: false }, 'invalid_document_processor_response'],
    [{ markdown: 'A'.repeat(100_001), mock: false }, 'invalid_document_processor_response'],
    [{ schema_version: '1.0', markdown: 'incomplete', mock: false }, 'invalid_document_processor_response'],
    [{ markdown: 'Jordan', mock: false, content_sha256: 'invalid' }, 'invalid_document_processor_response'],
  ] as const) {
    await assert.rejects(
      requestResumePrefillExtraction({ ...request, fetchImpl: fetchReturning(payload) }),
      (error: unknown) => error instanceof DocumentProcessorError && error.code === code,
    );
  }
});

test('prefill client rejects hash mismatch in v1 and hash-bearing legacy responses', async () => {
  const differentHash = 'b'.repeat(64);
  for (const payload of [
    v1Response(differentHash),
    { markdown: 'Jordan', mock: false, content_sha256: differentHash },
  ]) {
    await assert.rejects(
      requestResumePrefillExtraction({ ...request, fetchImpl: fetchReturning(payload) }),
      (error: unknown) => error instanceof DocumentProcessorError
        && error.code === 'document_content_hash_mismatch',
    );
  }
});

test('prefill client rejects untrusted origins, redirects, and excessive deadlines', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new TypeError('redirect blocked');
  };

  await assert.rejects(
    requestResumePrefillExtraction({
      ...request,
      serviceUrl: 'https://other.example',
      trustedOrigin: 'https://document-processor.example',
      fetchImpl,
    }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.code === 'document_processor_not_configured',
  );
  await assert.rejects(
    requestResumePrefillExtraction({ ...request, timeoutMs: 55_001, fetchImpl }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.code === 'document_processor_not_configured',
  );
  assert.equal(calls, 0);

  await assert.rejects(
    requestResumePrefillExtraction({ ...request, fetchImpl }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.code === 'document_processor_unavailable',
  );
  assert.equal(calls, 1);
});
