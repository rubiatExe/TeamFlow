import { randomUUID } from 'node:crypto';

import {
  authorizeHiringAgentRoute,
  type HiringAgentAccessFailure,
} from '../ai/hiring-agent-access.ts';
import {
  HiringAgentServiceError,
  runLangGraphHiringAgent,
} from '../ai/hiring-agent-client.ts';
import {
  HiringAgentRequestSchema,
  HiringAgentResponseSchema,
  HiringAgentServiceRequestSchema,
  type HiringAgentServiceRequest,
} from '../contracts/hiring-agent.ts';
import {
  createDeadlineSignal,
  type DeadlineSignal,
  readBoundedJson,
  RequestBodyDeadlineError,
  RequestBodyTooLargeError,
} from './bounded-json.ts';

const MAX_HIRING_AGENT_REQUEST_BYTES = 65_536;
const MAX_BODY_READ_MILLISECONDS = 5_000;
const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

type HiringAgentRouteDependencies = {
  merchantId: string;
  authorize?: (headers: Headers) => HiringAgentAccessFailure | null;
  bodyDeadlineMs?: number;
  logError?: (message: string) => void;
  requestIdFactory?: () => string;
  run?: (request: HiringAgentServiceRequest) => Promise<unknown>;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: RESPONSE_HEADERS });
}

function requestContentLengthFailure(request: Request, requestId: string): Response | null {
  const raw = request.headers.get('content-length');
  if (raw === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    return json({ error: 'Invalid Content-Length', requestId }, 400);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_HIRING_AGENT_REQUEST_BYTES) {
    return json({ error: 'Request body is too large', requestId }, 413);
  }
  return null;
}

function hasCanonicalJsonContentType(request: Request): boolean {
  return request.headers.get('content-type') === 'application/json';
}

function bodyReadDeadline(
  request: Request,
  deadlineMs: number,
): DeadlineSignal | null {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_BODY_READ_MILLISECONDS
  ) {
    return null;
  }
  return createDeadlineSignal(deadlineMs, request.signal);
}

export async function handleHiringAgentRequest(
  request: Request,
  dependencies: HiringAgentRouteDependencies,
): Promise<Response> {
  const requestId = (dependencies.requestIdFactory ?? randomUUID)();
  const logError = dependencies.logError ?? ((message: string) => console.error(message));
  const accessFailure = (dependencies.authorize ?? authorizeHiringAgentRoute)(
    request.headers,
  );
  if (accessFailure) {
    return json({ error: accessFailure.error, requestId }, accessFailure.status);
  }

  if (!hasCanonicalJsonContentType(request)) {
    return json({ error: 'Content-Type must be application/json', requestId }, 415);
  }
  const contentLengthFailure = requestContentLengthFailure(request, requestId);
  if (contentLengthFailure) return contentLengthFailure;

  const deadline = bodyReadDeadline(
    request,
    dependencies.bodyDeadlineMs ?? MAX_BODY_READ_MILLISECONDS,
  );
  if (deadline === null) {
    return json({ error: 'Hiring-agent server configuration is invalid', requestId }, 503);
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_HIRING_AGENT_REQUEST_BYTES, {
      signal: deadline.signal,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: 'Request body is too large', requestId }, 413);
    }
    if (error instanceof RequestBodyDeadlineError) {
      return json({ error: 'Request body deadline exceeded', requestId }, 408);
    }
    return json({ error: 'Invalid JSON request', requestId }, 400);
  } finally {
    deadline.dispose();
  }

  const parsedRequest = HiringAgentRequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return json({ error: 'Invalid hiring-agent request', requestId }, 400);
  }

  const serviceRequest = HiringAgentServiceRequestSchema.safeParse({
    ...parsedRequest.data,
    merchantId: dependencies.merchantId,
    requestId,
  });
  if (!serviceRequest.success) {
    logError('[Hiring Agent] Invalid server-side configuration');
    return json({ error: 'Hiring-agent server configuration is invalid', requestId }, 503);
  }

  try {
    const result = await (dependencies.run ?? runLangGraphHiringAgent)(
      serviceRequest.data,
    );
    const parsedResponse = HiringAgentResponseSchema.safeParse(result);
    if (
      !parsedResponse.success ||
      parsedResponse.data.request_id !== requestId
    ) {
      logError('[Hiring Agent] Invalid backend response');
      return json({ error: 'Hiring-agent response failed validation', requestId }, 502);
    }
    return json(parsedResponse.data);
  } catch (error) {
    logError('[Hiring Agent] Request failed');
    let upstreamStatus = 502;
    if (error instanceof HiringAgentServiceError) {
      if (error.status === 422) upstreamStatus = 400;
      else if ([429, 503, 504].includes(error.status)) {
        upstreamStatus = error.status;
      }
    }
    return json({ error: 'Hiring-agent request failed', requestId }, upstreamStatus);
  }
}
