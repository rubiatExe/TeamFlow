import { createHash, randomUUID } from 'node:crypto';

import {
  DemoSemanticSearchErrorSchema,
  DemoSemanticSearchRequestSchema,
  DemoSemanticSearchResponseSchema,
  type DemoSemanticSearchResponse,
} from '../contracts/demo-semantic-search.ts';
import {
  DemoSearchValidationError,
  searchSyntheticCandidates,
} from '../demo/semantic-search.ts';
import {
  createDeadlineSignal,
  InvalidRequestFramingError,
  readBoundedJson,
  RequestBodyDeadlineError,
  RequestBodyTooLargeError,
  UnsupportedJsonMediaTypeError,
  validateBoundedJsonRequestHeaders,
  type DeadlineSignal,
} from './bounded-json.ts';

const MAX_REQUEST_BYTES = 2_048;
const BODY_DEADLINE_MS = 3_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 20;
const MAX_RATE_BUCKETS = 1_000;

const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type SearchRouteDependencies = {
  requestIdFactory?: () => string;
  search?: (query: string, requestId: string) => Promise<DemoSemanticSearchResponse>;
  rateLimit?: (request: Request) => RateLimitDecision;
  bodyDeadlineMs?: number;
  logError?: (message: string) => void;
};

type RateBucket = {
  count: number;
  resetAt: number;
};

function requestComesFromSameOriginPage(request: Request): boolean {
  try {
    const expectedOrigin = new URL(request.url).origin;
    const fetchSite = request.headers.get('sec-fetch-site');
    return request.headers.get('origin') === expectedOrigin
      || fetchSite === 'same-origin';
  } catch {
    return false;
  }
}

function clientBucketKey(request: Request): string {
  const forwarded = request.headers.get('x-vercel-forwarded-for')
    ?? request.headers.get('x-forwarded-for')
    ?? 'anonymous';
  const firstAddress = forwarded.split(',', 1)[0].trim().slice(0, 128) || 'anonymous';
  return createHash('sha256').update(firstAddress, 'utf8').digest('hex');
}

export function createDemoSearchRateLimiter(options: {
  now?: () => number;
  requestLimit?: number;
  windowMs?: number;
} = {}): (request: Request) => RateLimitDecision {
  const buckets = new Map<string, RateBucket>();
  const now = options.now ?? Date.now;
  const requestLimit = options.requestLimit ?? RATE_LIMIT_REQUESTS;
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;

  return (request: Request) => {
    const timestamp = now();
    if (buckets.size >= MAX_RATE_BUCKETS) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= timestamp) buckets.delete(key);
      }
      if (buckets.size >= MAX_RATE_BUCKETS) {
        const oldestKey = buckets.keys().next().value as string | undefined;
        if (oldestKey) buckets.delete(oldestKey);
      }
    }

    const key = clientBucketKey(request);
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= timestamp) {
      buckets.set(key, { count: 1, resetAt: timestamp + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (existing.count >= requestLimit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - timestamp) / 1_000)),
      };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

const defaultRateLimit = createDemoSearchRateLimiter();

function errorResponse(
  requestId: string,
  status: number,
  code: 'invalid_request' | 'unsafe_query' | 'rate_limited' | 'search_unavailable',
  message: string,
  extraHeaders: HeadersInit = {},
): Response {
  const payload = DemoSemanticSearchErrorSchema.parse({
    request_id: requestId,
    error: { code, message },
  });
  return Response.json(payload, {
    status,
    headers: { ...RESPONSE_HEADERS, ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}

export async function handleDemoSemanticSearchRequest(
  request: Request,
  dependencies: SearchRouteDependencies = {},
): Promise<Response> {
  const requestId = (dependencies.requestIdFactory ?? randomUUID)();
  const logError = dependencies.logError ?? ((message: string) => console.error(message));
  if (!requestComesFromSameOriginPage(request)) {
    return errorResponse(
      requestId,
      403,
      'invalid_request',
      'Search requests must originate from the TeamFlow demo page.',
    );
  }
  const rateLimit = (dependencies.rateLimit ?? defaultRateLimit)(request);
  if (!rateLimit.allowed) {
    return errorResponse(
      requestId,
      429,
      'rate_limited',
      'The public demo request limit was reached. Please wait briefly and try again.',
      { 'Retry-After': String(rateLimit.retryAfterSeconds) },
    );
  }

  try {
    validateBoundedJsonRequestHeaders(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof UnsupportedJsonMediaTypeError) {
      return errorResponse(requestId, 415, 'invalid_request', 'Content-Type must be application/json.');
    }
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(requestId, 413, 'invalid_request', 'The search request is too large.');
    }
    if (error instanceof InvalidRequestFramingError) {
      return errorResponse(requestId, 400, 'invalid_request', 'The request framing is invalid.');
    }
    throw error;
  }

  const deadlineMs = dependencies.bodyDeadlineMs ?? BODY_DEADLINE_MS;
  let deadline: DeadlineSignal;
  try {
    deadline = createDeadlineSignal(deadlineMs, request.signal);
  } catch {
    logError('[Demo Search] Invalid body deadline configuration');
    return errorResponse(requestId, 503, 'search_unavailable', 'Candidate search is temporarily unavailable.');
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_REQUEST_BYTES, { signal: deadline.signal });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(requestId, 413, 'invalid_request', 'The search request is too large.');
    }
    if (error instanceof RequestBodyDeadlineError) {
      return errorResponse(requestId, 408, 'invalid_request', 'The search request body timed out.');
    }
    return errorResponse(requestId, 400, 'invalid_request', 'The request body must be valid JSON.');
  } finally {
    deadline.dispose();
  }

  const parsed = DemoSemanticSearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      requestId,
      400,
      'invalid_request',
      'Submit exactly one query between 3 and 280 characters.',
    );
  }

  try {
    const result = await (dependencies.search ?? searchSyntheticCandidates)(
      parsed.data.query,
      requestId,
    );
    const response = DemoSemanticSearchResponseSchema.safeParse(result);
    if (!response.success || response.data.request_id !== requestId) {
      logError('[Demo Search] Search response failed contract validation');
      return errorResponse(requestId, 502, 'search_unavailable', 'Candidate search returned an invalid response.');
    }
    return Response.json(response.data, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof DemoSearchValidationError) {
      return errorResponse(requestId, error.code === 'unsafe_query' ? 422 : 400, error.code, error.message);
    }
    logError('[Demo Search] Search execution failed');
    return errorResponse(requestId, 503, 'search_unavailable', 'Candidate search is temporarily unavailable.');
  }
}
