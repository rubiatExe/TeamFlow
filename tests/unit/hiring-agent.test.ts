import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeHiringAgentRoute } from '../../lib/ai/hiring-agent-access.ts';
import {
  HiringAgentServiceError,
  runLangGraphHiringAgent,
} from '../../lib/ai/hiring-agent-client.ts';
import {
  HiringAgentRequestSchema,
  HiringAgentResponseSchema,
} from '../../lib/contracts/hiring-agent.ts';
import { handleHiringAgentRequest } from '../../lib/http/hiring-agent-route.ts';

const MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const CANDIDATE_ID = '00000000-0000-0000-0000-000000000002';
const ROLE_ID = '00000000-0000-0000-0000-000000000003';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

function validResponse(requestId = REQUEST_ID) {
  return {
    summary: 'Candidate reviewed',
    recommendation: 'Invite for a structured interview.',
    fit_score: 84,
    analysis: {
      evidence: ['Relevant experience'],
      gaps: [],
      limitations: [],
      confidence: 'medium' as const,
    },
    status: 'complete' as const,
    write_status: 'not_requested' as const,
    warnings: [],
    request_id: requestId,
    tool_calls: ['get_candidate'] as const,
  };
}

function jsonRequest(
  body: unknown,
  headers: HeadersInit = {},
  signal?: AbortSignal,
): Request {
  return new Request('http://teamflow.test/api/parser/agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify(body),
    signal,
  });
}

const authorized = () => null;

test('public contract is read-only and tenant scope remains server-owned', () => {
  const parsed = HiringAgentRequestSchema.parse({
    candidateId: CANDIDATE_ID,
    roleId: ROLE_ID,
    instructions: 'Review job-relevant experience',
  });
  assert.equal(parsed.operation, 'review_candidate');

  const retiredFields = {
    merchantId: MERCHANT_ID,
    score: 84,
    analysis: { explanation: 'forged' },
    summary: 'forged',
    redFlags: ['forged'],
  };
  for (const [field, value] of Object.entries(retiredFields)) {
    assert.equal(
      HiringAgentRequestSchema.safeParse({ [field]: value }).success,
      false,
      field,
    );
  }
});

test('response contract is semantically bounded and read-only', () => {
  assert.equal(HiringAgentResponseSchema.safeParse(validResponse()).success, true);
  assert.equal(
    HiringAgentResponseSchema.safeParse({
      ...validResponse(),
      summary: 'x'.repeat(501),
    }).success,
    false,
  );
  assert.equal(
    HiringAgentResponseSchema.safeParse({
      ...validResponse(),
      write_status: 'succeeded',
    }).success,
    false,
  );
  assert.equal(
    HiringAgentResponseSchema.safeParse({
      ...validResponse(),
      tool_calls: ['update_fit_score'],
    }).success,
    false,
  );
});

test('private route is fail-closed and hashes tokens before comparison', t => {
  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousEnabled = process.env.HIRING_AGENT_ENABLED;
  const previousToken = process.env.HIRING_AGENT_ROUTE_TOKEN;
  t.after(() => {
    if (previousNodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previousNodeEnv;
    if (previousEnabled === undefined) delete process.env.HIRING_AGENT_ENABLED;
    else process.env.HIRING_AGENT_ENABLED = previousEnabled;
    if (previousToken === undefined) delete process.env.HIRING_AGENT_ROUTE_TOKEN;
    else process.env.HIRING_AGENT_ROUTE_TOKEN = previousToken;
  });

  environment.NODE_ENV = 'test';
  delete process.env.HIRING_AGENT_ENABLED;
  assert.equal(authorizeHiringAgentRoute(new Headers())?.status, 503);

  process.env.HIRING_AGENT_ENABLED = 'true';
  process.env.HIRING_AGENT_ROUTE_TOKEN = 'route-secret';
  for (const token of ['', 'short', 'route-secret-extra', 'route-secret, route-secret']) {
    assert.equal(
      authorizeHiringAgentRoute(new Headers({
        'X-Hiring-Agent-Access-Token': token,
      }))?.status,
      401,
    );
  }
  assert.equal(
    authorizeHiringAgentRoute(new Headers({
      'X-Hiring-Agent-Access-Token': 'route-secret',
    })),
    null,
  );

  environment.NODE_ENV = 'production';
  assert.equal(
    authorizeHiringAgentRoute(new Headers({
      'X-Hiring-Agent-Access-Token': 'route-secret',
    }))?.status,
    503,
  );
});

test('authorization and canonical header checks happen before body reads', async () => {
  let bodyAccessed = false;
  const unreadRequest = {
    headers: new Headers(),
    signal: new AbortController().signal,
    get body() {
      bodyAccessed = true;
      throw new Error('body must not be read');
    },
  } as unknown as Request;

  const unauthorized = await handleHiringAgentRequest(unreadRequest, {
    merchantId: MERCHANT_ID,
    authorize: () => ({ error: 'Unauthorized', status: 401 }),
    requestIdFactory: () => REQUEST_ID,
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(bodyAccessed, false);

  const malformedHeaders = new Headers([
    ['Content-Type', 'application/json'],
    ['Content-Type', 'application/json'],
    ['Content-Length', '2'],
    ['Content-Length', '2'],
  ]);
  const invalidSingletons = {
    headers: malformedHeaders,
    signal: new AbortController().signal,
    get body() {
      bodyAccessed = true;
      throw new Error('body must not be read');
    },
  } as unknown as Request;
  const invalid = await handleHiringAgentRequest(invalidSingletons, {
    merchantId: MERCHANT_ID,
    authorize: authorized,
    requestIdFactory: () => REQUEST_ID,
  });
  assert.equal(invalid.status, 415);
  assert.equal(bodyAccessed, false);
});

test('Content-Length must be one canonical decimal value before body read', async () => {
  for (const value of ['', ' 2', '+2', '02', '2e0', '0x2', '2, 2']) {
    let bodyAccessed = false;
    const request = {
      headers: {
        get(name: string) {
          if (name.toLowerCase() === 'content-type') return 'application/json';
          if (name.toLowerCase() === 'content-length') return value;
          return null;
        },
      } as Headers,
      signal: new AbortController().signal,
      get body() {
        bodyAccessed = true;
        throw new Error('body must not be read');
      },
    } as unknown as Request;
    const response = await handleHiringAgentRequest(request, {
      merchantId: MERCHANT_ID,
      authorize: authorized,
      requestIdFactory: () => REQUEST_ID,
    });
    assert.equal(response.status, 400, value);
    assert.equal(bodyAccessed, false, value);
  }
});

test('body deadline and caller abort return 408 without invoking upstream', async () => {
  let upstreamCalls = 0;
  const run = async () => {
    upstreamCalls += 1;
    return validResponse();
  };
  const stalledBody = () => new ReadableStream<Uint8Array>({ pull() {} });

  const timedOutRequest = new Request('http://teamflow.test/api/parser/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stalledBody(),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const timedOut = await handleHiringAgentRequest(timedOutRequest, {
    merchantId: MERCHANT_ID,
    authorize: authorized,
    bodyDeadlineMs: 5,
    requestIdFactory: () => REQUEST_ID,
    run,
  });
  assert.equal(timedOut.status, 408);

  const controller = new AbortController();
  const abortedRequest = new Request('http://teamflow.test/api/parser/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stalledBody(),
    duplex: 'half',
    signal: controller.signal,
  } as RequestInit & { duplex: 'half' });
  const pending = handleHiringAgentRequest(abortedRequest, {
    merchantId: MERCHANT_ID,
    authorize: authorized,
    requestIdFactory: () => REQUEST_ID,
    run,
  });
  controller.abort();
  assert.equal((await pending).status, 408);
  assert.equal(upstreamCalls, 0);
});

test('handler injects tenant scope and rejects mismatched response correlation', async () => {
  let capturedMerchant = '';
  const success = await handleHiringAgentRequest(
    jsonRequest({ candidateId: CANDIDATE_ID }),
    {
      merchantId: MERCHANT_ID,
      authorize: authorized,
      requestIdFactory: () => REQUEST_ID,
      run: async request => {
        capturedMerchant = request.merchantId;
        return validResponse(request.requestId);
      },
    },
  );
  assert.equal(success.status, 200);
  assert.equal(capturedMerchant, MERCHANT_ID);

  const mismatch = await handleHiringAgentRequest(
    jsonRequest({ candidateId: CANDIDATE_ID }),
    {
      merchantId: MERCHANT_ID,
      authorize: authorized,
      logError: () => undefined,
      requestIdFactory: () => REQUEST_ID,
      run: async () => validResponse('55555555-5555-4555-8555-555555555555'),
    },
  );
  assert.equal(mismatch.status, 502);
  assert.deepEqual(await mismatch.json(), {
    error: 'Hiring-agent response failed validation',
    requestId: REQUEST_ID,
  });
});

test('client sends bounded direct JSON and correlates the response', async t => {
  const previousUrl = process.env.HIRING_AGENT_URL;
  const previousToken = process.env.HIRING_AGENT_TOKEN;
  const previousTrustedOrigin = process.env.HIRING_AGENT_TRUSTED_ORIGIN;
  process.env.HIRING_AGENT_URL = 'http://hiring-agent.test/';
  process.env.HIRING_AGENT_TOKEN = 'service-token';
  delete process.env.HIRING_AGENT_TRUSTED_ORIGIN;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.HIRING_AGENT_URL;
    else process.env.HIRING_AGENT_URL = previousUrl;
    if (previousToken === undefined) delete process.env.HIRING_AGENT_TOKEN;
    else process.env.HIRING_AGENT_TOKEN = previousToken;
    if (previousTrustedOrigin === undefined) {
      delete process.env.HIRING_AGENT_TRUSTED_ORIGIN;
    } else {
      process.env.HIRING_AGENT_TRUSTED_ORIGIN = previousTrustedOrigin;
    }
  });

  let capturedUrl = '';
  let capturedOptions: RequestInit | undefined;
  const result = await runLangGraphHiringAgent({
    candidateId: CANDIDATE_ID,
    merchantId: MERCHANT_ID,
    requestId: REQUEST_ID,
    operation: 'review_candidate',
    instructions: 'Review this candidate',
  }, {
    fetchImpl: async (url, options) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return Response.json(validResponse());
    },
  });

  assert.equal(result.request_id, REQUEST_ID);
  assert.equal(capturedUrl, 'http://hiring-agent.test/invoke');
  assert.deepEqual(JSON.parse(String(capturedOptions?.body)), {
    candidateId: CANDIDATE_ID,
    merchantId: MERCHANT_ID,
    requestId: REQUEST_ID,
    operation: 'review_candidate',
    instructions: 'Review this candidate',
  });
  assert.equal(capturedOptions?.redirect, 'error');
  assert.equal(
    (capturedOptions as TraceableRequestInit | undefined)?.opentelemetry
      ?.propagateContext,
    false,
  );
  assert.equal(
    new Headers(capturedOptions?.headers).get('X-Agent-Token'),
    'service-token',
  );
});

test('client sanitizes redirect, MIME, size, correlation, and stall failures', async t => {
  const previousUrl = process.env.HIRING_AGENT_URL;
  const previousToken = process.env.HIRING_AGENT_TOKEN;
  const previousTrustedOrigin = process.env.HIRING_AGENT_TRUSTED_ORIGIN;
  const secret = 'service-token-canary-do-not-log';
  process.env.HIRING_AGENT_URL = 'http://hiring-agent.test';
  process.env.HIRING_AGENT_TOKEN = secret;
  delete process.env.HIRING_AGENT_TRUSTED_ORIGIN;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.HIRING_AGENT_URL;
    else process.env.HIRING_AGENT_URL = previousUrl;
    if (previousToken === undefined) delete process.env.HIRING_AGENT_TOKEN;
    else process.env.HIRING_AGENT_TOKEN = previousToken;
    if (previousTrustedOrigin === undefined) {
      delete process.env.HIRING_AGENT_TRUSTED_ORIGIN;
    } else {
      process.env.HIRING_AGENT_TRUSTED_ORIGIN = previousTrustedOrigin;
    }
  });

  const request = {
    merchantId: MERCHANT_ID,
    requestId: REQUEST_ID,
    operation: 'review_candidate' as const,
  };
  const cases: Array<[string, typeof fetch, number]> = [
    ['redirect', async () => Response.json(validResponse(), { status: 302 }), 502],
    ['MIME', async () => new Response('{}', {
      headers: { 'Content-Type': 'text/plain' },
    }), 502],
    ['size', async () => new Response('{}', {
      headers: {
        'Content-Length': '1048577',
        'Content-Type': 'application/json',
      },
    }), 502],
    ['correlation', async () => Response.json(
      validResponse('55555555-5555-4555-8555-555555555555'),
    ), 502],
  ];
  for (const [name, fetchImpl, status] of cases) {
    await assert.rejects(
      runLangGraphHiringAgent(request, { fetchImpl }),
      (error: unknown) => {
        assert.equal(String(error).includes(secret), false, name);
        return error instanceof HiringAgentServiceError && error.status === status;
      },
      name,
    );
  }

  await assert.rejects(
    runLangGraphHiringAgent(request, {
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      }), { headers: { 'Content-Type': 'application/json' } }),
    }),
    (error: unknown) => error instanceof HiringAgentServiceError && error.status === 504,
  );
});

type TraceableRequestInit = RequestInit & {
  opentelemetry?: { propagateContext?: boolean };
};

test('fixed error logging never includes request bodies, tokens, or exception text', async () => {
  const canary = 'resume-marker-and-token-canary';
  const capturedLogs: string[] = [];

  const response = await handleHiringAgentRequest(
    jsonRequest({ instructions: canary }),
    {
      merchantId: MERCHANT_ID,
      authorize: authorized,
      logError: message => capturedLogs.push(message),
      requestIdFactory: () => REQUEST_ID,
      run: async () => {
        throw new Error(canary);
      },
    },
  );
  assert.equal(response.status, 502);
  assert.equal(JSON.stringify(await response.json()).includes(canary), false);
  assert.equal(capturedLogs.join('\n').includes(canary), false);
});
