import { createHash } from 'node:crypto';

import {
  DocumentExtractionResultSchema,
} from '../contracts/document-extraction.ts';
import {
  MAX_DOCUMENT_BYTES,
  SUPPORTED_DOCUMENT_MIME_TYPES,
} from '../contracts/parser.ts';
import { readBoundedJsonResponse } from '../http/bounded-json.ts';
import {
  resolveTrustedServiceBaseUrl,
  ServiceUrlConfigurationError,
} from '../http/trusted-service-url.ts';
import { isValidServiceToken } from '../http/service-token.ts';
import { createOcrFetchOptions } from '../observability/ocr-fetch.ts';
import {
  DocumentProcessorError,
  type DocumentExtractionRequest,
} from './document-processor-client.ts';

const DEFAULT_TIMEOUT_MS = 50_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_MARKDOWN_CODE_POINTS = 100_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function validMarkdown(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_MARKDOWN_CODE_POINTS * 2
    && !UNPAIRED_SURROGATE.test(value)
    && Array.from(value).length <= MAX_MARKDOWN_CODE_POINTS;
}

/**
 * Extract only text that a candidate may review and edit before submitting.
 * Legacy OCR responses have no content hash, so their markdown must never be
 * used as a verified résumé record or as evidence for candidate scoring.
 */
function prefillMarkdown(payload: unknown, uploadedSha256: string): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DocumentProcessorError('invalid_document_processor_response', 502);
  }
  const record = payload as Record<string, unknown>;
  if (record.mock !== false || record.status === 'mock' || record.extraction_method === 'mock') {
    throw new DocumentProcessorError('document_not_scoreable', 422);
  }

  if (record.schema_version !== undefined) {
    const parsed = DocumentExtractionResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DocumentProcessorError('invalid_document_processor_response', 502);
    }
    if (parsed.data.content_sha256 !== uploadedSha256) {
      throw new DocumentProcessorError('document_content_hash_mismatch', 502);
    }
    return parsed.data.markdown;
  }

  if (!validMarkdown(record.markdown)) {
    throw new DocumentProcessorError('invalid_document_processor_response', 502);
  }
  if (record.content_sha256 !== undefined) {
    if (typeof record.content_sha256 !== 'string' || !SHA256.test(record.content_sha256)) {
      throw new DocumentProcessorError('invalid_document_processor_response', 502);
    }
    if (record.content_sha256 !== uploadedSha256) {
      throw new DocumentProcessorError('document_content_hash_mismatch', 502);
    }
  }
  return record.markdown;
}

/** Call the trusted OCR service for candidate-editable résumé prefill only. */
export async function requestResumePrefillExtraction(
  request: DocumentExtractionRequest,
): Promise<{ markdown: string }> {
  if (request.bytes.byteLength === 0) {
    throw new DocumentProcessorError('empty_document', 400);
  }
  if (request.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentProcessorError('document_too_large', 413);
  }
  if (!(SUPPORTED_DOCUMENT_MIME_TYPES as readonly string[]).includes(request.mimeType)) {
    throw new DocumentProcessorError('unsupported_mime', 415);
  }
  if (!isValidServiceToken(request.token)) {
    throw new DocumentProcessorError('document_processor_not_configured', 503);
  }

  let baseUrl: string;
  try {
    baseUrl = resolveTrustedServiceBaseUrl(
      request.serviceUrl,
      request.trustedOrigin ?? process.env.OCR_SERVICE_TRUSTED_ORIGIN,
    );
  } catch (error) {
    if (error instanceof ServiceUrlConfigurationError) {
      throw new DocumentProcessorError('document_processor_not_configured', 503);
    }
    throw error;
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000) {
    throw new DocumentProcessorError('document_processor_not_configured', 503);
  }

  const ownedBytes = Uint8Array.from(request.bytes);
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([ownedBytes], { type: request.mimeType }),
    request.fileName,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response | undefined;
  let payload: unknown;
  try {
    response = await fetchImpl(`${baseUrl}/extract`, {
      ...createOcrFetchOptions(formData, request.token),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    payload = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, {
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted
      || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new DocumentProcessorError('document_processor_timeout', 504);
    }
    if (response === undefined) {
      throw new DocumentProcessorError('document_processor_unavailable', 502);
    }
    throw new DocumentProcessorError('invalid_document_processor_response', 502);
  } finally {
    clearTimeout(timeout);
  }

  if (response === undefined) {
    throw new DocumentProcessorError('document_processor_unavailable', 502);
  }
  if (!response.ok) {
    throw new DocumentProcessorError('document_processor_rejected', response.status);
  }

  const uploadedSha256 = createHash('sha256').update(ownedBytes).digest('hex');
  return { markdown: prefillMarkdown(payload, uploadedSha256) };
}
