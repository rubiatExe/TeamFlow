import { NextRequest, NextResponse } from 'next/server.js';

import {
  DocumentProcessorError,
  requestDocumentExtraction,
  type DocumentExtractionRequest,
} from '../../../../lib/ai/document-processor-client.ts';
import { ParserInputSchema } from '../../../../lib/contracts/parser.ts';
import { extractResumePrefill } from '../../../../lib/domain/resume-prefill.ts';
import { getRoleById } from '../../../../lib/domain/roles.ts';
import {
  createDeadlineSignal,
  InvalidRequestFramingError,
  readBoundedJson,
  RequestBodyDeadlineError,
  RequestBodyTooLargeError,
  UnsupportedJsonMediaTypeError,
  validateBoundedJsonRequestHeaders,
} from '../../../../lib/http/bounded-json.ts';
import { guardLegacyDemoRoute } from '../../../../lib/http/legacy-demo-route.ts';

// A 10 MiB document becomes at most 13.99 MiB of canonical Base64 in JSON.
const MAX_PREVIEW_REQUEST_BYTES = 14_100_000;
const MAX_BODY_READ_MILLISECONDS = 8_000;
const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

type PreviewDependencies = Readonly<{
  extract: (request: DocumentExtractionRequest) => Promise<{ markdown: string }>;
}>;

const defaultDependencies: PreviewDependencies = {
  extract: requestDocumentExtraction,
};

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function failure(code: string, message: string, status: number): NextResponse {
  return json({ success: false, error: { code, message } }, status);
}

export function createResumePreviewPost(
  dependencies: PreviewDependencies = defaultDependencies,
) {
  return async function resumePreviewPost(req: NextRequest): Promise<NextResponse> {
    const blocked = guardLegacyDemoRoute();
    if (blocked) return blocked as NextResponse;

    let body: unknown;
    const deadline = createDeadlineSignal(MAX_BODY_READ_MILLISECONDS, req.signal);
    try {
      validateBoundedJsonRequestHeaders(req, MAX_PREVIEW_REQUEST_BYTES);
      body = await readBoundedJson(req, MAX_PREVIEW_REQUEST_BYTES, {
        signal: deadline.signal,
        maxFrames: 2048,
      });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return failure('REQUEST_TOO_LARGE', 'Choose a resume smaller than 10 MB.', 413);
      }
      if (error instanceof RequestBodyDeadlineError) {
        return failure('REQUEST_TIMEOUT', 'The resume took too long to upload. Please try again.', 408);
      }
      if (error instanceof UnsupportedJsonMediaTypeError) {
        return failure('INVALID_REQUEST', 'The resume request must be JSON.', 415);
      }
      if (error instanceof InvalidRequestFramingError) {
        return failure('INVALID_REQUEST', 'The resume request is invalid.', 400);
      }
      return failure('INVALID_REQUEST', 'The resume request is invalid.', 400);
    } finally {
      deadline.dispose();
    }

    const parsed = ParserInputSchema.safeParse(body);
    const role = parsed.success ? getRoleById(parsed.data.roleId ?? '') : undefined;
    if (!parsed.success || !role) {
      return failure('INVALID_REQUEST', 'Choose a supported role and resume file.', 400);
    }

    try {
      const extraction = await dependencies.extract({
        bytes: Buffer.from(parsed.data.fileData, 'base64'),
        mimeType: parsed.data.mimeType,
        fileName: parsed.data.fileName,
        serviceUrl: process.env.OCR_SERVICE_URL || 'http://localhost:8000',
        token: process.env.OCR_SERVICE_TOKEN || '',
      });
      return json({
        success: true,
        prefill: extractResumePrefill(extraction.markdown, role),
      });
    } catch (error) {
      if (error instanceof DocumentProcessorError) {
        const status = error.status === 401 ? 502 : error.status;
        return failure(
          'EXTRACTION_UNAVAILABLE',
          'We could not read this resume. You can still fill in the form yourself.',
          status,
        );
      }
      console.error('[Resume Preview] Extraction failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return failure(
        'EXTRACTION_UNAVAILABLE',
        'We could not read this resume. You can still fill in the form yourself.',
        502,
      );
    }
  };
}
