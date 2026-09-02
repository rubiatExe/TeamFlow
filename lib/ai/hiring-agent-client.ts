import {
  HiringAgentResponseSchema,
  type HiringAgentServiceRequest,
  type HiringAgentResponse,
} from '../contracts/hiring-agent.ts';
import {
  readBoundedJsonResponse,
  RequestBodyDeadlineError,
} from '../http/bounded-json.ts';
import {
  resolveTrustedServiceBaseUrl,
  ServiceUrlConfigurationError,
} from '../http/trusted-service-url.ts';
import { isValidServiceToken } from '../http/service-token.ts';

const MAX_HIRING_AGENT_RESPONSE_BYTES = 1_048_576;
const MAX_HIRING_AGENT_TIMEOUT_MS = 50_000;

type TraceableRequestInit = RequestInit & {
  opentelemetry?: {
    propagateContext?: boolean;
    spanName?: string;
  };
};

type HiringAgentClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class HiringAgentServiceError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`LangGraph hiring service returned ${status}`);
    this.name = 'HiringAgentServiceError';
    this.status = status;
  }
}

export async function runLangGraphHiringAgent(
  body: HiringAgentServiceRequest,
  dependencies: HiringAgentClientOptions = {},
): Promise<HiringAgentResponse> {
  const serviceUrl = process.env.HIRING_AGENT_URL;
  let baseUrl: string;
  try {
    baseUrl = resolveTrustedServiceBaseUrl(
      serviceUrl,
      process.env.HIRING_AGENT_TRUSTED_ORIGIN,
    );
  } catch (error) {
    if (error instanceof ServiceUrlConfigurationError) {
      throw new HiringAgentServiceError(503);
    }
    throw error;
  }

  const serviceToken = process.env.HIRING_AGENT_TOKEN;
  if (!isValidServiceToken(serviceToken)) {
    throw new HiringAgentServiceError(503);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Agent-Token': serviceToken,
  };
  const timeoutMs = dependencies.timeoutMs ?? MAX_HIRING_AGENT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_HIRING_AGENT_TIMEOUT_MS
  ) {
    throw new HiringAgentServiceError(503);
  }
  const signal = AbortSignal.timeout(timeoutMs);

  const requestOptions: TraceableRequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error',
    signal,
    opentelemetry: {
      // Current instrumentation still registers baggage propagation. Keep this
      // private adapter isolated until tracecontext-only propagation is committed.
      propagateContext: false,
      spanName: 'hiring_agent.run',
    },
  };

  let response: Response;
  let payload: unknown;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(
      `${baseUrl}/invoke`,
      requestOptions,
    );
    payload = await readBoundedJsonResponse(
      response,
      MAX_HIRING_AGENT_RESPONSE_BYTES,
      { signal },
    );
  } catch (error) {
    if (error instanceof HiringAgentServiceError) throw error;
    if (
      error instanceof RequestBodyDeadlineError ||
      (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    ) {
      throw new HiringAgentServiceError(504);
    }
    throw new HiringAgentServiceError(502);
  }

  if (!response.ok) {
    const status = [422, 429, 503, 504].includes(response.status)
      ? response.status
      : 502;
    throw new HiringAgentServiceError(status);
  }

  const parsed = HiringAgentResponseSchema.safeParse(payload);
  if (!parsed.success) throw new HiringAgentServiceError(502);
  if (parsed.data.request_id !== body.requestId) {
    throw new HiringAgentServiceError(502);
  }
  return parsed.data;
}
