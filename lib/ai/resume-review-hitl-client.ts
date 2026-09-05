import {
  PendingResumeReviewQueueQuerySchema,
  PendingResumeReviewQueueResponseSchema,
  ResumeReviewHitlServiceErrorSchema,
  ResumeReviewRunDetailResponseSchema,
  ResumeReviewRunResponseSchema,
  type ResumeReviewHitlErrorCode,
} from '../contracts/resume-review-hitl-api.ts';
import {
  type PendingResumeReviewQueueResponse,
  type ResumeReviewDecisionRequest,
  type ResumeReviewRunDetailResponse,
  type ResumeReviewRunResponse,
  type StartResumeReviewRunRequest,
} from '../contracts/resume-review-hitl.ts';
import {
  readBoundedJson,
  RequestBodyTooLargeError,
} from '../http/bounded-json.ts';
import {
  resolveTrustedServiceBaseUrl,
  ServiceUrlConfigurationError,
} from '../http/trusted-service-url.ts';
import { isValidServiceToken } from '../http/service-token.ts';

const MAX_SERVICE_RESPONSE_BYTES = 2_097_152;
const DEFAULT_DEADLINE_MS = 50_000;
const CANONICAL_CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)$/u;
const CANONICAL_RETRY_AFTER = /^[1-9][0-9]*$/u;
const PENDING_STATUSES = new Set([
  'running',
  'pending_review',
  'decision_recorded',
  'applying',
]);

type TraceableRequestInit = RequestInit & {
  opentelemetry?: {
    propagateContext?: boolean;
    spanName?: string;
  };
};

export type ResumeReviewHitlClientResult<
  Data extends ResumeReviewRunResponse = ResumeReviewRunResponse,
> = {
  data: Data;
  status: 200 | 202;
  retryAfterSeconds: number | null;
};

export type PendingResumeReviewQueueClientResult = {
  data: PendingResumeReviewQueueResponse;
  status: 200;
  retryAfterSeconds: null;
};

export interface ResumeReviewHitlClient {
  start(
    body: StartResumeReviewRunRequest,
    authorization: string,
  ): Promise<ResumeReviewHitlClientResult>;
  inspect(
    runId: string,
    authorization: string,
  ): Promise<ResumeReviewHitlClientResult<ResumeReviewRunDetailResponse>>;
  listPending(
    query: { limit: number; cursor: string | null },
    authorization: string,
  ): Promise<PendingResumeReviewQueueClientResult>;
  decide(
    runId: string,
    body: ResumeReviewDecisionRequest,
    authorization: string,
  ): Promise<ResumeReviewHitlClientResult>;
}

export class ResumeReviewHitlClientError extends Error {
  readonly status: number;
  readonly code: ResumeReviewHitlErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: ResumeReviewHitlErrorCode,
    retryAfterSeconds: number | null = null,
  ) {
    super(`Durable resume-review service failed with ${status}`);
    this.name = 'ResumeReviewHitlClientError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type ClientConfiguration = {
  serviceUrl?: string;
  trustedOrigin?: string;
  serviceToken?: string;
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
};

type ServiceCall =
  | {
    operation: 'start';
    path: '/v2/resume-review-runs';
    body: StartResumeReviewRunRequest;
  }
  | {
    operation: 'inspect';
    path: string;
    runId: string;
  }
  | {
    operation: 'list_pending';
    path: string;
  }
  | {
    operation: 'decide';
    path: string;
    runId: string;
    body: ResumeReviewDecisionRequest;
  };

class ServiceDeadlineError extends Error {
  constructor() {
    super('Durable resume-review service deadline exceeded');
    this.name = 'ServiceDeadlineError';
  }
}

/** Validate the Authorization header as an RFC 6750 bearer token, without decoding it. */
export function parseStrictBearerAuthorization(
  headers: Pick<Headers, 'get'>,
): string | null {
  const raw = headers.get('authorization');
  if (raw === null || raw.length > 8_199) return null;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+={0,})$/i.exec(raw);
  if (!match || match[1].length > 8_192) return null;
  return `Bearer ${match[1]}`;
}

function resolveServiceToken(raw: string | undefined): string {
  if (!isValidServiceToken(raw)) {
    throw new ResumeReviewHitlClientError(503, 'service_unavailable');
  }
  return raw;
}

function resolveDeadline(value: number | undefined): number {
  const deadline = value ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 55_000) {
    throw new ResumeReviewHitlClientError(503, 'service_unavailable');
  }
  return deadline;
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  if (!CANONICAL_RETRY_AFTER.test(raw)) {
    throw new ResumeReviewHitlClientError(502, 'workflow_failed');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 60) {
    throw new ResumeReviewHitlClientError(502, 'workflow_failed');
  }
  return value;
}

function expectedErrorStatus(
  status: number,
  code: ResumeReviewHitlErrorCode,
): boolean {
  const exactStatus: Partial<Record<ResumeReviewHitlErrorCode, number>> = {
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    idempotency_conflict: 409,
    stale_decision: 409,
    review_already_decided: 409,
    invalid_edit: 422,
    invalid_request: 422,
    service_unavailable: 503,
    workflow_failed: 502,
  };
  return exactStatus[code] === status;
}

async function readServicePayload(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!CANONICAL_CONTENT_LENGTH.test(contentLength)) {
      throw new ResumeReviewHitlClientError(502, 'workflow_failed');
    }
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_SERVICE_RESPONSE_BYTES
    ) {
      throw new ResumeReviewHitlClientError(502, 'workflow_failed');
    }
  }
  const mediaType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ResumeReviewHitlClientError(502, 'workflow_failed');
  }
  try {
    return await readBoundedJson(response, MAX_SERVICE_RESPONSE_BYTES, { signal });
  } catch (error) {
    if (error instanceof ResumeReviewHitlClientError) throw error;
    if (error instanceof RequestBodyTooLargeError) {
      throw new ResumeReviewHitlClientError(502, 'workflow_failed');
    }
    throw new ResumeReviewHitlClientError(502, 'workflow_failed');
  }
}

function validateHttpLifecycle(
  response: Response,
  data: ResumeReviewRunResponse,
  operation: 'start' | 'inspect' | 'decide',
): { status: 200 | 202; retryAfterSeconds: number | null } {
  const pending = PENDING_STATUSES.has(data.status);
  const expectedStatus = pending && operation !== 'inspect' ? 202 : 200;
  if (response.status !== expectedStatus) {
    throw new ResumeReviewHitlClientError(502, 'workflow_failed');
  }

  const retryAfterSeconds = parseRetryAfter(response.headers);
  if ((pending && retryAfterSeconds === null) || (!pending && retryAfterSeconds !== null)) {
    throw new ResumeReviewHitlClientError(502, 'workflow_failed');
  }

  const location = response.headers.get('location');
  const expectedLocation = `/v2/resume-review-runs/${data.run_id}`;
  if (
    (operation !== 'inspect' && pending && location !== expectedLocation) ||
    ((operation === 'inspect' || !pending) && location !== null)
  ) {
    throw new ResumeReviewHitlClientError(502, 'workflow_failed');
  }

  return { status: expectedStatus, retryAfterSeconds };
}

async function withDeadline<T>(
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadlineError = new ServiceDeadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(deadlineError);
      reject(deadlineError);
    }, deadlineMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createResumeReviewHitlClient(
  configuration: ClientConfiguration = {},
): ResumeReviewHitlClient {
  let baseUrl: string;
  try {
    baseUrl = resolveTrustedServiceBaseUrl(
      configuration.serviceUrl ?? process.env.HIRING_AGENT_URL,
      configuration.trustedOrigin ?? process.env.HIRING_AGENT_TRUSTED_ORIGIN,
    );
  } catch (error) {
    if (error instanceof ServiceUrlConfigurationError) {
      throw new ResumeReviewHitlClientError(503, 'service_unavailable');
    }
    throw error;
  }
  const serviceToken = resolveServiceToken(
    configuration.serviceToken ?? process.env.HIRING_AGENT_TOKEN,
  );
  const deadlineMs = resolveDeadline(configuration.deadlineMs);
  const fetchImpl = configuration.fetchImpl ?? fetch;

  async function call(
    request: ServiceCall,
    authorization: string,
  ): Promise<
    | ResumeReviewHitlClientResult
    | ResumeReviewHitlClientResult<ResumeReviewRunDetailResponse>
    | PendingResumeReviewQueueClientResult
  > {
    const parsedAuthorization = parseStrictBearerAuthorization(
      new Headers({ Authorization: authorization }),
    );
    if (parsedAuthorization === null) {
      throw new ResumeReviewHitlClientError(401, 'unauthorized');
    }

    try {
      return await withDeadline(deadlineMs, async signal => {
        const headers = new Headers({
          Accept: 'application/json',
          Authorization: parsedAuthorization,
          'X-Agent-Token': serviceToken,
        });
        if ('body' in request) headers.set('Content-Type', 'application/json');
        if (request.operation === 'start') {
          headers.set('Idempotency-Key', request.body.request_id);
        }
        const options: TraceableRequestInit = {
          method: request.operation === 'inspect' || request.operation === 'list_pending'
            ? 'GET'
            : request.operation === 'start' ? 'POST' : 'PUT',
          headers,
          body: 'body' in request ? JSON.stringify(request.body) : undefined,
          cache: 'no-store',
          redirect: 'error',
          signal,
          opentelemetry: {
            propagateContext: true,
            spanName: `resume_review.hitl.${request.operation}`,
          },
        };
        const response = await fetchImpl(`${baseUrl}${request.path}`, options);
        const payload = await readServicePayload(response, signal);

        if (!response.ok) {
          const parsedError = ResumeReviewHitlServiceErrorSchema.safeParse(payload);
          if (
            !parsedError.success ||
            !expectedErrorStatus(response.status, parsedError.data.code)
          ) {
            throw new ResumeReviewHitlClientError(502, 'workflow_failed');
          }
          throw new ResumeReviewHitlClientError(
            response.status,
            parsedError.data.code,
            parseRetryAfter(response.headers),
          );
        }

        if (request.operation === 'list_pending') {
          const parsedQueue = PendingResumeReviewQueueResponseSchema.safeParse(payload);
          if (
            !parsedQueue.success ||
            response.status !== 200 ||
            response.headers.get('retry-after') !== null ||
            response.headers.get('location') !== null
          ) {
            throw new ResumeReviewHitlClientError(502, 'workflow_failed');
          }
          return {
            data: parsedQueue.data,
            status: 200,
            retryAfterSeconds: null,
          };
        }

        const parsed = (
          request.operation === 'inspect'
            ? ResumeReviewRunDetailResponseSchema
            : ResumeReviewRunResponseSchema
        ).safeParse(payload);
        if (!parsed.success) {
          throw new ResumeReviewHitlClientError(502, 'workflow_failed');
        }
        const data = parsed.data;
        if (
          (request.operation === 'start' && (
            data.request_id !== request.body.request_id ||
            data.document_id !== request.body.document_id
          )) ||
          (request.operation !== 'start' && data.run_id !== request.runId) ||
          (request.operation === 'decide' && (
            data.review?.review_id !== request.body.review_id
          ))
        ) {
          throw new ResumeReviewHitlClientError(502, 'workflow_failed');
        }
        const lifecycle = validateHttpLifecycle(response, data, request.operation);
        return { data, ...lifecycle };
      });
    } catch (error) {
      if (error instanceof ResumeReviewHitlClientError) throw error;
      if (
        error instanceof ServiceDeadlineError ||
        (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
      ) {
        throw new ResumeReviewHitlClientError(504, 'service_unavailable', 2);
      }
      throw new ResumeReviewHitlClientError(502, 'workflow_failed');
    }
  }

  return {
    start: async (body, authorization) => {
      const result = await call(
        { operation: 'start', path: '/v2/resume-review-runs', body },
        authorization,
      );
      return result as ResumeReviewHitlClientResult;
    },
    inspect: async (runId, authorization) => {
      const result = await call({
        operation: 'inspect',
        path: `/v2/resume-review-runs/${runId}`,
        runId,
      }, authorization);
      return result as ResumeReviewHitlClientResult<ResumeReviewRunDetailResponse>;
    },
    listPending: async (query, authorization) => {
      const parsed = PendingResumeReviewQueueQuerySchema.parse({
        status: 'pending_review',
        limit: query.limit,
        cursor: query.cursor,
      });
      const params = new URLSearchParams({
        status: parsed.status,
        limit: String(parsed.limit),
      });
      if (parsed.cursor !== null) params.set('cursor', parsed.cursor);
      const result = await call({
        operation: 'list_pending',
        path: `/v2/resume-review-runs?${params.toString()}`,
      }, authorization);
      return result as PendingResumeReviewQueueClientResult;
    },
    decide: async (runId, body, authorization) => {
      const result = await call({
        operation: 'decide',
        path: `/v2/resume-review-runs/${runId}/decision`,
        runId,
        body,
      }, authorization);
      return result as ResumeReviewHitlClientResult;
    },
  };
}
