import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { authorizeHiringAgentRoute } from '@/lib/ai/hiring-agent-access';
import {
  ResumeReviewServiceError,
  runResumeReview,
} from '@/lib/ai/resume-review-client';
import {
  ResumeReviewPublicRequestSchema,
  ResumeReviewResponseSchema,
  ResumeReviewServiceRequestSchema,
} from '@/lib/contracts/resume-review-api';
import { DEMO_MERCHANT_ID } from '@/lib/db/supabase';
import {
  InvalidRequestFramingError,
  readBoundedJson,
  RequestBodyDeadlineError,
  RequestBodyTooLargeError,
  UnsupportedJsonMediaTypeError,
  validateBoundedJsonRequestHeaders,
} from '@/lib/http/bounded-json';

export const maxDuration = 60;

const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;
const MAX_REVIEW_REQUEST_BYTES = 8_192;
const MAX_BODY_READ_MILLISECONDS = 5_000;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const accessFailure = authorizeHiringAgentRoute(req.headers);
  if (accessFailure) {
    return json({ error: accessFailure.error, requestId }, accessFailure.status);
  }

  let body: unknown;
  try {
    validateBoundedJsonRequestHeaders(req, MAX_REVIEW_REQUEST_BYTES);
    body = await readBoundedJson(req, MAX_REVIEW_REQUEST_BYTES, {
      signal: AbortSignal.any([
        req.signal,
        AbortSignal.timeout(MAX_BODY_READ_MILLISECONDS),
      ]),
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: 'Request body is too large', requestId }, 413);
    }
    if (error instanceof RequestBodyDeadlineError) {
      return json({ error: 'Request body deadline exceeded', requestId }, 408);
    }
    if (error instanceof UnsupportedJsonMediaTypeError) {
      return json({ error: 'Content-Type must be application/json', requestId }, 415);
    }
    if (error instanceof InvalidRequestFramingError) {
      return json({ error: 'Invalid request framing', requestId }, 400);
    }
    return json({ error: 'Invalid JSON request', requestId }, 400);
  }
  const parsed = ResumeReviewPublicRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'Invalid résumé-review request', requestId }, 400);
  }

  const serviceRequest = ResumeReviewServiceRequestSchema.safeParse({
    schema_version: '1.0',
    request_id: requestId,
    merchant_id: DEMO_MERCHANT_ID,
    document_id: parsed.data.documentId,
    candidate_id: parsed.data.candidateId ?? null,
    persist: process.env.RESUME_REVIEW_PERSIST_RESULTS === 'true',
  });
  if (!serviceRequest.success) {
    return json({ error: 'Résumé-review server configuration is invalid', requestId }, 503);
  }

  try {
    const result = ResumeReviewResponseSchema.parse(
      await runResumeReview(serviceRequest.data),
    );
    return json(result);
  } catch (error) {
    console.error('[Resume Review] Request failed', {
      requestId,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    const status = error instanceof ResumeReviewServiceError &&
      [429, 503, 504].includes(error.status)
      ? error.status
      : 502;
    return json({ error: 'Résumé-review request failed', requestId }, status);
  }
}
