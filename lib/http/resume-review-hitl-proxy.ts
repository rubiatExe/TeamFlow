import {
  createResumeReviewHitlClient,
  parseStrictBearerAuthorization,
  ResumeReviewHitlClientError,
  type ResumeReviewHitlClient,
  type ResumeReviewHitlClientResult,
} from '../ai/resume-review-hitl-client.ts';
import {
  PendingResumeReviewQueueQuerySchema,
  ResumeReviewDecisionRequestSchema,
  ResumeReviewIdempotencyKeySchema,
  ResumeReviewRunIdSchema,
  StartResumeReviewRunPublicRequestSchema,
  type ResumeReviewHitlErrorCode,
} from '../contracts/resume-review-hitl-api.ts';
import { StartResumeReviewRunRequestSchema } from '../contracts/resume-review-hitl.ts';
import {
  InvalidRequestFramingError,
  readBoundedJson,
  RequestBodyDeadlineError,
  RequestBodyTooLargeError,
  UnsupportedJsonMediaTypeError,
  validateBoundedJsonRequestHeaders,
} from './bounded-json.ts';

const MAX_START_REQUEST_BYTES = 8_192;
const MAX_DECISION_REQUEST_BYTES = 524_288;
const MAX_BODY_READ_MILLISECONDS = 5_000;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

type BoundaryDependencies = {
  client?: ResumeReviewHitlClient;
  bodyDeadlineMs?: number;
};

function pendingQueueQuery(
  request: Request,
): { limit: number; cursor: string | null } | null {
  const pairs = [...new URL(request.url).searchParams.entries()];
  const allowed = new Set(['status', 'limit', 'cursor']);
  const keys = pairs.map(([key]) => key);
  if (
    keys.some(key => !allowed.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    return null;
  }
  const values = new Map(pairs);
  if (values.get('status') !== 'pending_review') return null;
  const rawLimit = values.get('limit') ?? '25';
  if (!/^[1-9][0-9]*$/.test(rawLimit)) return null;
  const parsed = PendingResumeReviewQueueQuerySchema.safeParse({
    status: 'pending_review',
    limit: Number(rawLimit),
    cursor: values.get('cursor') ?? null,
  });
  if (!parsed.success || String(parsed.data.limit) !== rawLimit) return null;
  return { limit: parsed.data.limit, cursor: parsed.data.cursor };
}

const ERROR_MESSAGES: Record<ResumeReviewHitlErrorCode, string> = {
  unauthorized: 'Unauthorized',
  forbidden: 'Forbidden',
  not_found: 'Résumé-review run was not found',
  idempotency_conflict: 'Request conflicts with an existing idempotency key',
  stale_decision: 'Review decision is stale',
  review_already_decided: 'Review already has a decision',
  invalid_edit: 'Edited review output is invalid',
  invalid_request: 'Invalid résumé-review request',
  service_unavailable: 'Résumé-review service is unavailable',
  workflow_failed: 'Résumé-review request failed',
};

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { ...SECURITY_HEADERS, ...Object.fromEntries(new Headers(headers)) },
  });
}

function unauthorized(): Response {
  return json(
    { error: ERROR_MESSAGES.unauthorized, code: 'unauthorized' },
    401,
    { 'WWW-Authenticate': 'Bearer' },
  );
}

function invalidRequest(status = 400): Response {
  return json(
    { error: ERROR_MESSAGES.invalid_request, code: 'invalid_request' },
    status,
  );
}

async function boundedBody(
  request: Request,
  maxBytes: number,
  deadlineMs: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5_000) {
    return { ok: false, response: invalidRequest() };
  }
  const signal = AbortSignal.timeout(deadlineMs);
  try {
    validateBoundedJsonRequestHeaders(request, maxBytes);
    return { ok: true, value: await readBoundedJson(request, maxBytes, { signal }) };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return {
        ok: false,
        response: json(
          { error: 'Request body is too large', code: 'invalid_request' },
          413,
        ),
      };
    }
    if (error instanceof RequestBodyDeadlineError) {
      return {
        ok: false,
        response: json(
          { error: 'Request body deadline exceeded', code: 'invalid_request' },
          408,
        ),
      };
    }
    if (error instanceof UnsupportedJsonMediaTypeError) {
      return {
        ok: false,
        response: json(
          { error: 'Content-Type must be application/json', code: 'invalid_request' },
          415,
        ),
      };
    }
    if (error instanceof InvalidRequestFramingError) {
      return { ok: false, response: invalidRequest() };
    }
    return { ok: false, response: invalidRequest() };
  }
}

function publicResult(result: ResumeReviewHitlClientResult): Response {
  const headers = new Headers();
  if (result.retryAfterSeconds !== null) {
    headers.set('Retry-After', String(result.retryAfterSeconds));
  }
  if (result.status === 202) {
    headers.set('Location', `/api/resume-review-runs/${result.data.run_id}`);
  }
  return json(result.data, result.status, headers);
}

function clientFailure(error: unknown): Response {
  if (!(error instanceof ResumeReviewHitlClientError)) {
    return json(
      { error: ERROR_MESSAGES.workflow_failed, code: 'workflow_failed' },
      502,
    );
  }
  const headers = new Headers();
  if (error.retryAfterSeconds !== null) {
    headers.set('Retry-After', String(error.retryAfterSeconds));
  }
  if (error.status === 401) headers.set('WWW-Authenticate', 'Bearer');
  return json(
    { error: ERROR_MESSAGES[error.code], code: error.code },
    error.status,
    headers,
  );
}

function client(dependencies: BoundaryDependencies): ResumeReviewHitlClient {
  return dependencies.client ?? createResumeReviewHitlClient();
}

export async function handleStartResumeReviewRun(
  request: Request,
  dependencies: BoundaryDependencies = {},
): Promise<Response> {
  const authorization = parseStrictBearerAuthorization(request.headers);
  if (authorization === null) return unauthorized();

  const idempotencyKey = ResumeReviewIdempotencyKeySchema.safeParse(
    request.headers.get('idempotency-key'),
  );
  if (!idempotencyKey.success) return invalidRequest();

  const body = await boundedBody(
    request,
    MAX_START_REQUEST_BYTES,
    dependencies.bodyDeadlineMs ?? MAX_BODY_READ_MILLISECONDS,
  );
  if (!body.ok) return body.response;
  const parsed = StartResumeReviewRunPublicRequestSchema.safeParse(body.value);
  if (!parsed.success) return invalidRequest();

  const serviceRequest = StartResumeReviewRunRequestSchema.parse({
    ...parsed.data,
    request_id: idempotencyKey.data,
  });
  try {
    return publicResult(await client(dependencies).start(serviceRequest, authorization));
  } catch (error) {
    return clientFailure(error);
  }
}

export async function handleListPendingResumeReviews(
  request: Request,
  dependencies: BoundaryDependencies = {},
): Promise<Response> {
  const authorization = parseStrictBearerAuthorization(request.headers);
  if (authorization === null) return unauthorized();
  const query = pendingQueueQuery(request);
  if (query === null) return invalidRequest();

  try {
    const result = await client(dependencies).listPending(query, authorization);
    return json(result.data, 200);
  } catch (error) {
    return clientFailure(error);
  }
}

export async function handleInspectResumeReviewRun(
  request: Request,
  runId: string,
  dependencies: BoundaryDependencies = {},
): Promise<Response> {
  const authorization = parseStrictBearerAuthorization(request.headers);
  if (authorization === null) return unauthorized();
  const parsedRunId = ResumeReviewRunIdSchema.safeParse(runId);
  if (!parsedRunId.success) return invalidRequest();

  try {
    return publicResult(
      await client(dependencies).inspect(parsedRunId.data, authorization),
    );
  } catch (error) {
    return clientFailure(error);
  }
}

export async function handleDecideResumeReviewRun(
  request: Request,
  runId: string,
  dependencies: BoundaryDependencies = {},
): Promise<Response> {
  const authorization = parseStrictBearerAuthorization(request.headers);
  if (authorization === null) return unauthorized();
  const parsedRunId = ResumeReviewRunIdSchema.safeParse(runId);
  if (!parsedRunId.success) return invalidRequest();

  const body = await boundedBody(
    request,
    MAX_DECISION_REQUEST_BYTES,
    dependencies.bodyDeadlineMs ?? MAX_BODY_READ_MILLISECONDS,
  );
  if (!body.ok) return body.response;
  const parsed = ResumeReviewDecisionRequestSchema.safeParse(body.value);
  if (!parsed.success) return invalidRequest();

  try {
    return publicResult(
      await client(dependencies).decide(
        parsedRunId.data,
        parsed.data,
        authorization,
      ),
    );
  } catch (error) {
    return clientFailure(error);
  }
}
