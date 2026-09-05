import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DocumentProcessorError,
  requestDocumentExtraction,
} from '../../lib/ai/document-processor-client.ts';

const request = {
  bytes: Buffer.from('%PDF-1.4\n%%EOF\n'),
  mimeType: 'application/pdf',
  fileName: 'synthetic-resume.pdf',
  serviceUrl: 'http://document-processor.test',
  token: 'test-token',
};
const CONTENT_SHA256 = createHash('sha256').update(request.bytes).digest('hex');

function mockExtraction() {
  return {
    schema_version: '1.0',
    document_id: `doc-${CONTENT_SHA256}`,
    status: 'mock',
    markdown: '',
    text: '',
    source_blocks: [],
    embedding: null,
    extraction_method: 'mock',
    model_id: null,
    embedding_model_id: null,
    content_sha256: CONTENT_SHA256,
    mock: true,
    warnings: ['mock_mode_enabled'],
    quality: {
      assessment: 'unusable',
      character_count: 0,
      block_count: 0,
      page_count: 0,
      reason_codes: ['mock_result'],
    },
  };
}

function degradedExtraction() {
  const text = 'Jordan Rivera\n\nNorthstar Cafe 2022-2025';
  const firstDigest = createHash('sha256')
    .update('1|1|Jordan Rivera', 'utf8')
    .digest('hex')
    .slice(0, 12);
  const secondDigest = createHash('sha256')
    .update('1|2|Northstar Cafe 2022-2025', 'utf8')
    .digest('hex')
    .slice(0, 12);
  return {
    schema_version: '1.0',
    document_id: `doc-${CONTENT_SHA256}`,
    status: 'degraded',
    markdown: text,
    text,
    source_blocks: [
      {
        source_block_id: `src-${CONTENT_SHA256.slice(0, 12)}-p0001-b0001-${firstDigest}`,
        page_number: 1,
        ordinal: 1,
        text: 'Jordan Rivera',
      },
      {
        source_block_id: `src-${CONTENT_SHA256.slice(0, 12)}-p0001-b0002-${secondDigest}`,
        page_number: 1,
        ordinal: 2,
        text: 'Northstar Cafe 2022-2025',
      },
    ],
    embedding: null,
    extraction_method: 'pdf_text',
    model_id: 'pypdf-6.16.2',
    embedding_model_id: null,
    content_sha256: CONTENT_SHA256,
    mock: false,
    warnings: ['embedding_failed'],
    quality: {
      assessment: 'usable',
      character_count: Array.from(text).length,
      block_count: 2,
      page_count: 1,
      reason_codes: [],
    },
  };
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return async () => Response.json(body, { status });
}

test('document client rejects typed mock extraction before scoring', async () => {
  await assert.rejects(
    requestDocumentExtraction({
      ...request,
      fetchImpl: fetchReturning(mockExtraction(), 503),
    }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.status === 503
      && error.code === 'document_not_scoreable',
  );
});

test('document client rejects malformed legacy payload instead of inventing provenance', async () => {
  await assert.rejects(
    requestDocumentExtraction({
      ...request,
      fetchImpl: fetchReturning({
        markdown: '# fabricated legacy resume',
        embedding: null,
      }),
    }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.status === 502
      && error.code === 'invalid_document_processor_response',
  );
});

test('document client permits usable extraction when only embedding is degraded', async () => {
  const result = await requestDocumentExtraction({
    ...request,
    fetchImpl: fetchReturning(degradedExtraction()),
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.embedding, null);
  assert.equal(result.document_id, `doc-${CONTENT_SHA256}`);
});

test('document client rejects a valid response for different uploaded bytes', async () => {
  const response = degradedExtraction();
  response.content_sha256 = 'b'.repeat(64);
  response.document_id = `doc-${response.content_sha256}`;
  response.source_blocks = response.source_blocks.map(block => ({
    ...block,
    source_block_id: block.source_block_id.replace(
      CONTENT_SHA256.slice(0, 12),
      response.content_sha256.slice(0, 12),
    ),
  }));

  await assert.rejects(
    requestDocumentExtraction({
      ...request,
      fetchImpl: fetchReturning(response),
    }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.status === 502
      && error.code === 'document_content_hash_mismatch',
  );
});

test('document client preserves safe processor rejection without manufacturing empty OCR', async () => {
  await assert.rejects(
    requestDocumentExtraction({
      ...request,
      fetchImpl: fetchReturning(
        { detail: { code: 'mime_signature_mismatch' } },
        415,
      ),
    }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.status === 415
      && error.code === 'document_processor_rejected',
  );
});

test('document client fails closed on invalid JSON and timeout', async () => {
  await assert.rejects(
    requestDocumentExtraction({
      ...request,
      fetchImpl: async () => new Response('not json'),
    }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.code === 'invalid_document_processor_response',
  );

  await assert.rejects(
    requestDocumentExtraction({
      ...request,
      timeoutMs: 1,
      fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.status === 504
      && error.code === 'document_processor_timeout',
  );

  await assert.rejects(
    requestDocumentExtraction({
      ...request,
      timeoutMs: 1,
      fetchImpl: async (_input, init) => new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    }),
    (error: unknown) => error instanceof DocumentProcessorError
      && error.status === 504
      && error.code === 'document_processor_timeout',
  );
});
