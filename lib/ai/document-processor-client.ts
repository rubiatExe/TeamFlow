import { createHash } from 'node:crypto';

import {
  DocumentExtractionResultSchema,
  deriveDocumentScoreability,
  type DocumentExtractionResult,
} from '../contracts/document-extraction.ts';
import {
  MAX_DOCUMENT_BYTES,
  SUPPORTED_DOCUMENT_MIME_TYPES,
} from '../contracts/parser.ts';
import {
  readBoundedJsonResponse,
} from '../http/bounded-json.ts';
import {
  resolveTrustedServiceBaseUrl,
  ServiceUrlConfigurationError,
} from '../http/trusted-service-url.ts';
import { isValidServiceToken } from '../http/service-token.ts';
import { createOcrFetchOptions } from '../observability/ocr-fetch.ts';

// Service stages are bounded at 8s PDF parse + 25s OCR + 10s embedding. Keep the
// caller below the 60s route budget while allowing those sequential stages to finish.
const DEFAULT_DOCUMENT_PROCESSOR_TIMEOUT_MS = 50_000;
const MAX_DOCUMENT_PROCESSOR_RESPONSE_BYTES = 1_048_576;

export class DocumentProcessorError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'DocumentProcessorError';
    this.code = code;
    this.status = status;
  }
}

export type DocumentExtractionRequest = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  serviceUrl: string;
  trustedOrigin?: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

export async function requestDocumentExtraction(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
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

  const formData = new FormData();
  const ownedBytes = Uint8Array.from(request.bytes);
  formData.append(
    'file',
    new Blob([ownedBytes], { type: request.mimeType }),
    request.fileName,
  );

  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? DEFAULT_DOCUMENT_PROCESSOR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000) {
    throw new DocumentProcessorError('document_processor_not_configured', 503);
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response | undefined;
  let payload: unknown;
  try {
    response = await fetchImpl(
      `${baseUrl}/extract`,
      {
        ...createOcrFetchOptions(formData, request.token),
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      },
    );
    payload = await readBoundedJsonResponse(
      response,
      MAX_DOCUMENT_PROCESSOR_RESPONSE_BYTES,
      { signal: controller.signal },
    );
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

  const parsed = DocumentExtractionResultSchema.safeParse(payload);
  if (!parsed.success) {
    if (!response.ok) {
      throw new DocumentProcessorError('document_processor_rejected', response.status);
    }
    throw new DocumentProcessorError('invalid_document_processor_response', 502);
  }

  const uploadedContentSha256 = createHash('sha256')
    .update(ownedBytes)
    .digest('hex');
  if (parsed.data.content_sha256 !== uploadedContentSha256) {
    throw new DocumentProcessorError('document_content_hash_mismatch', 502);
  }

  const scoreability = deriveDocumentScoreability(parsed.data);
  if (!response.ok || !scoreability.scoreable) {
    throw new DocumentProcessorError(
      'document_not_scoreable',
      response.ok ? 422 : response.status,
    );
  }
  return parsed.data;
}
