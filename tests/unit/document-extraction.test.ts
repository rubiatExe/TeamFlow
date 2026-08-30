import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DocumentExtractionResultSchema,
  SourceBlockSchema,
  assertDocumentScoreable,
  deriveDocumentScoreability,
} from '../../lib/contracts/document-extraction.ts';

const CONTENT_SHA256 = 'a'.repeat(64);

function blockId(page: number, ordinal: number, text: string): string {
  const digest = createHash('sha256')
    .update(`${page}|${ordinal}|${text}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `src-${CONTENT_SHA256.slice(0, 12)}-p${page.toString().padStart(4, '0')}-b${ordinal.toString().padStart(4, '0')}-${digest}`;
}

test('validates the canonical v1 extraction fixture', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('../fixtures/document-extraction-v1.json', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(DocumentExtractionResultSchema.parse(fixture), fixture);
  assert.equal(deriveDocumentScoreability(fixture).scoreable, true);
});

function completeResult() {
  return {
    schema_version: '1.0' as const,
    document_id: `doc-${CONTENT_SHA256}`,
    status: 'complete' as const,
    markdown: 'Jordan Rivera\n\nNorthstar Cafe',
    text: 'Jordan Rivera\n\nNorthstar Cafe',
    source_blocks: [
      {
        source_block_id: blockId(1, 1, 'Jordan Rivera'),
        page_number: 1,
        ordinal: 1,
        text: 'Jordan Rivera',
      },
      {
        source_block_id: blockId(1, 2, 'Northstar Cafe'),
        page_number: 1,
        ordinal: 2,
        text: 'Northstar Cafe',
      },
    ],
    embedding: Array.from({ length: 768 }, () => 0.01),
    extraction_method: 'pdf_text' as const,
    model_id: 'pypdf-6.16.2',
    embedding_model_id: 'models/gemini-embedding-001',
    content_sha256: CONTENT_SHA256,
    mock: false,
    warnings: [] as string[],
    quality: {
      assessment: 'usable' as const,
      character_count: 29,
      block_count: 2,
      page_count: 1,
      reason_codes: [] as string[],
    },
  };
}

function mockResult() {
  return {
    schema_version: '1.0' as const,
    document_id: `doc-${CONTENT_SHA256}`,
    status: 'mock' as const,
    markdown: '',
    text: '',
    source_blocks: [],
    embedding: null,
    extraction_method: 'mock' as const,
    model_id: null,
    embedding_model_id: null,
    content_sha256: CONTENT_SHA256,
    mock: true,
    warnings: ['mock_mode_enabled'] as string[],
    quality: {
      assessment: 'unusable' as const,
      character_count: 0,
      block_count: 0,
      page_count: 0,
      reason_codes: ['mock_result'] as string[],
    },
  };
}

test('accepts complete and embedding-degraded v1 extraction results', () => {
  const complete = DocumentExtractionResultSchema.parse(completeResult());
  assert.equal(deriveDocumentScoreability(complete).scoreable, true);
  assert.deepEqual(assertDocumentScoreable(complete), complete);

  const degraded = {
    ...completeResult(),
    status: 'degraded',
    extraction_method: 'gemini_vision',
    model_id: 'gemini-test-vision',
    embedding: null,
    embedding_model_id: null,
    warnings: ['ocr_required', 'embedding_failed'],
  };
  const parsedDegraded = DocumentExtractionResultSchema.parse(degraded);
  assert.deepEqual(deriveDocumentScoreability(parsedDegraded), {
    scoreable: true,
    reason_codes: [],
  });
});

test('keeps standalone source-block coordinates, digest and Unicode strict', () => {
  const valid = completeResult().source_blocks[0];
  assert.deepEqual(SourceBlockSchema.parse(valid), valid);

  for (const invalid of [
    {
      ...valid,
      source_block_id: valid.source_block_id.replace(/-[0-9a-f]{12}$/u, '-deadbeefdead'),
    },
    {
      ...valid,
      ordinal: 2,
    },
    {
      ...valid,
      text: `${valid.text}\uD800`,
    },
  ]) {
    assert.equal(SourceBlockSchema.safeParse(invalid).success, false);
  }
});

test('matches JSON integer semantics without accepting booleans or fractions', () => {
  const integral = completeResult();
  integral.source_blocks[0].page_number = 1.0;
  integral.source_blocks[0].ordinal = 1e0;
  integral.quality.character_count = 29.0;
  integral.quality.block_count = 2e0;
  integral.quality.page_count = 1.0;
  assert.equal(DocumentExtractionResultSchema.safeParse(integral).success, true);

  for (const value of [true, '1', 1.5]) {
    assert.equal(DocumentExtractionResultSchema.safeParse({
      ...completeResult(),
      quality: {
        ...completeResult().quality,
        page_count: value,
      },
    }).success, false);
  }
});

test('keeps mock and failed extraction results valid but never scoreable', () => {
  const mock = DocumentExtractionResultSchema.parse(mockResult());
  assert.deepEqual(deriveDocumentScoreability(mock), {
    scoreable: false,
    reason_codes: ['status_not_scoreable', 'mock_result', 'quality_unusable',
      'blank_markdown', 'blank_text', 'no_source_blocks'],
  });
  assert.throws(() => assertDocumentScoreable(mock), /not scoreable/);

  const failed = {
    ...mockResult(),
    status: 'failed',
    extraction_method: 'none',
    mock: false,
    warnings: ['ocr_provider_failed'],
    quality: {
      ...mockResult().quality,
      reason_codes: ['empty_text', 'no_source_blocks'],
    },
  };
  assert.doesNotThrow(() => DocumentExtractionResultSchema.parse(failed));
  assert.equal(deriveDocumentScoreability(failed).scoreable, false);
});

test('rejects blank success, malformed roots and inconsistent status combinations', () => {
  const complete = completeResult();
  const blank = {
    ...complete,
    markdown: ' \u200B\uFEFF',
    text: '\u0085\u200B',
    source_blocks: [],
    embedding: null,
    embedding_model_id: null,
    quality: {
      assessment: 'unusable',
      character_count: 2,
      block_count: 0,
      page_count: 1,
      reason_codes: ['empty_text', 'no_source_blocks'],
    },
  };
  assert.equal(DocumentExtractionResultSchema.safeParse(blank).success, false);
  assert.deepEqual(deriveDocumentScoreability(blank), {
    scoreable: false,
    reason_codes: ['invalid_contract'],
  });

  assert.equal(DocumentExtractionResultSchema.safeParse({
    ...complete,
    scoreable: true,
  }).success, false);
  assert.equal(DocumentExtractionResultSchema.safeParse({
    ...complete,
    status: 'mock',
    mock: true,
    extraction_method: 'mock',
  }).success, false);
  assert.equal(DocumentExtractionResultSchema.safeParse({
    ...mockResult(),
    status: 'failed',
  }).success, false);
});

test('rejects tampered hashes, source blocks, order and counts', () => {
  const complete = completeResult();
  const invalidResults = [
    {
      ...complete,
      document_id: `doc-${'b'.repeat(64)}`,
    },
    {
      ...complete,
      source_blocks: complete.source_blocks.map((block, index) => index === 0
        ? { ...block, text: 'Invented employer' }
        : block),
    },
    {
      ...complete,
      source_blocks: complete.source_blocks.map((block, index) => index === 0
        ? { ...block, source_block_id: block.source_block_id.replace(/-[0-9a-f]{12}$/u, '-deadbeefdead') }
        : block),
    },
    {
      ...complete,
      source_blocks: complete.source_blocks.map((block, index) => index === 1
        ? { ...block, ordinal: 3 }
        : block),
    },
    {
      ...complete,
      source_blocks: complete.source_blocks.map((block, index) => index === 1
        ? { ...block, source_block_id: complete.source_blocks[0].source_block_id }
        : block),
    },
    {
      ...complete,
      source_blocks: complete.source_blocks.map((block, index) => index === 0
        ? { ...block, page_number: null }
        : block),
    },
    {
      ...complete,
      quality: { ...complete.quality, character_count: 31 },
    },
    {
      ...complete,
      quality: { ...complete.quality, block_count: 1 },
    },
    {
      ...complete,
      quality: { ...complete.quality, page_count: 0 },
    },
    {
      ...complete,
      source_blocks: complete.source_blocks.map((block, index) => index === 1
        ? {
          ...block,
          page_number: 2,
          source_block_id: blockId(2, 2, block.text),
        }
        : block),
    },
    {
      ...complete,
      text: `${complete.text}\n\nuncovered text`,
      markdown: `${complete.markdown}\n\nuncovered text`,
      quality: {
        ...complete.quality,
        character_count: Array.from(`${complete.text}\n\nuncovered text`).length,
      },
    },
    {
      ...complete,
      markdown: `${complete.markdown}\nmodel-added text`,
    },
    {
      ...complete,
      warnings: ['ocr_required', 'ocr_required'],
    },
    {
      ...complete,
      warnings: ['mock_mode_enabled'],
    },
    {
      ...complete,
      warnings: ['ocr_response_incomplete'],
    },
  ];

  for (const invalid of invalidResults) {
    assert.equal(
      DocumentExtractionResultSchema.safeParse(invalid).success,
      false,
    );
    assert.equal(deriveDocumentScoreability(invalid).scoreable, false);
  }
});

test('rejects malformed or non-finite 768-dimensional embeddings', () => {
  const complete = completeResult();
  for (const embedding of [
    [],
    Array.from({ length: 767 }, () => 0.1),
    [...Array.from({ length: 767 }, () => 0.1), Number.NaN],
    [...Array.from({ length: 767 }, () => 0.1), Number.POSITIVE_INFINITY],
    Array.from({ length: 768 }, () => 0),
    Array.from({ length: 768 }, () => 1e308),
  ]) {
    assert.equal(DocumentExtractionResultSchema.safeParse({
      ...complete,
      embedding,
    }).success, false);
  }
});
