import { createHash } from 'node:crypto';

import type { DocumentExtractionResult } from './document-extraction.ts';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function buildStoredResumeDocumentSnapshot(
  merchantId: string,
  extraction: DocumentExtractionResult,
) {
  if (!extraction.model_id) {
    throw new Error('A scoreable extraction must have model provenance');
  }
  const snapshot = {
    schema_version: '1.0' as const,
    merchant_id: merchantId,
    document_id: extraction.document_id,
    content_sha256: extraction.content_sha256,
    status: extraction.status,
    text: extraction.text,
    source_blocks: extraction.source_blocks,
    extraction_method: extraction.extraction_method,
    model_id: extraction.model_id,
    embedding_available: extraction.embedding !== null,
    mock: false as const,
    warnings: extraction.warnings,
    quality: extraction.quality,
  };
  const snapshotSha256 = createHash('sha256')
    .update(JSON.stringify(canonicalize(snapshot)), 'utf8')
    .digest('hex');
  return { ...snapshot, snapshot_sha256: snapshotSha256 };
}
