import {
  ResumeReviewResponseSchema,
  type ResumeReviewResponse,
  type ResumeReviewServiceRequest,
} from '../contracts/resume-review-api.ts';
import {
  createDeadlineSignal,
  readBoundedJsonResponse,
  RequestBodyDeadlineError,
} from '../http/bounded-json.ts';
import {
  resolveTrustedServiceBaseUrl,
  ServiceUrlConfigurationError,
} from '../http/trusted-service-url.ts';
import { isValidServiceToken } from '../http/service-token.ts';

const MAX_RESUME_REVIEW_RESPONSE_BYTES = 1_048_576;

type TraceableRequestInit = RequestInit & {
  opentelemetry?: {
    propagateContext?: boolean;
    spanName?: string;
  };
};

export class ResumeReviewServiceError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Résumé-review service returned ${status}`);
    this.name = 'ResumeReviewServiceError';
    this.status = status;
  }
}

export async function runResumeReview(
  body: ResumeReviewServiceRequest,
): Promise<ResumeReviewResponse> {
  const serviceUrl = process.env.HIRING_AGENT_URL;
  let baseUrl: string;
  try {
    baseUrl = resolveTrustedServiceBaseUrl(
      serviceUrl,
      process.env.HIRING_AGENT_TRUSTED_ORIGIN,
    );
  } catch (error) {
    if (error instanceof ServiceUrlConfigurationError) {
      throw new ResumeReviewServiceError(503);
    }
    throw error;
  }
  const serviceToken = process.env.HIRING_AGENT_TOKEN;
  if (!isValidServiceToken(serviceToken)) {
    throw new ResumeReviewServiceError(503);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Agent-Token': serviceToken,
  };
  const requestBody = JSON.stringify(body);
  const deadline = createDeadlineSignal(50_000);
  const options: TraceableRequestInit = {
    method: 'POST',
    headers,
    body: requestBody,
    cache: 'no-store',
    redirect: 'error',
    signal: deadline.signal,
    opentelemetry: {
      propagateContext: true,
      spanName: 'resume_review.run',
    },
  };
  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(
      `${baseUrl}/v1/resume-reviews`,
      options,
    );
    payload = await readBoundedJsonResponse(
      response,
      MAX_RESUME_REVIEW_RESPONSE_BYTES,
      { signal: deadline.signal },
    );
  } catch (error) {
    if (error instanceof ResumeReviewServiceError) throw error;
    if (
      error instanceof RequestBodyDeadlineError ||
      (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    ) {
      throw new ResumeReviewServiceError(504);
    }
    throw new ResumeReviewServiceError(502);
  } finally {
    deadline.dispose();
  }
  if (!response.ok) {
    throw new ResumeReviewServiceError(response.status);
  }
  const parsedResult = ResumeReviewResponseSchema.safeParse(payload);
  if (!parsedResult.success) throw new ResumeReviewServiceError(502);
  const parsed = parsedResult.data;
  if (
    parsed.request_id !== body.request_id ||
    parsed.document_id !== body.document_id
  ) {
    throw new ResumeReviewServiceError(502);
  }
  return parsed;
}
