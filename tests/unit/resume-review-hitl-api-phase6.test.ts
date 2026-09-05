import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createResumeReviewHitlClient,
  type PendingResumeReviewQueueClientResult,
  ResumeReviewHitlClientError,
  type ResumeReviewHitlClient,
  type ResumeReviewHitlClientResult,
} from '../../lib/ai/resume-review-hitl-client.ts';
import {
  PendingResumeReviewQueueResponseSchema,
  ResumeReviewDecisionRequestSchema,
  ResumeReviewRunDetailResponseSchema,
  ResumeReviewRunResponseSchema,
  StartResumeReviewRunRequestSchema,
  type ResumeReviewDecisionRequest,
  type ResumeReviewRunDetailResponse,
  type ResumeReviewRunResponse,
  type StartResumeReviewRunRequest,
} from '../../lib/contracts/resume-review-hitl.ts';
import {
  handleDecideResumeReviewRun,
  handleInspectResumeReviewRun,
  handleListPendingResumeReviews,
  handleStartResumeReviewRun,
} from '../../lib/http/resume-review-hitl-proxy.ts';

type HitlFixture = {
  start_request: unknown;
  run_responses: unknown[];
  decisions: unknown[];
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/resume-review-hitl-v2.json', import.meta.url),
  'utf8',
)) as HitlFixture;
const reviewerFixture = JSON.parse(readFileSync(
  new URL('../fixtures/resume-review-reviewer-v2.json', import.meta.url),
  'utf8',
)) as { detail_response: unknown; queue_response: unknown };
const startRequest = StartResumeReviewRunRequestSchema.parse(fixture.start_request);
const pendingResponse = ResumeReviewRunResponseSchema.parse(fixture.run_responses[1]);
const completeResponse = ResumeReviewRunResponseSchema.parse(fixture.run_responses[2]);
const approveDecision = ResumeReviewDecisionRequestSchema.parse(fixture.decisions[0]);
const detailResponse = ResumeReviewRunDetailResponseSchema.parse(
  reviewerFixture.detail_response,
);
const queueResponse = PendingResumeReviewQueueResponseSchema.parse(
  reviewerFixture.queue_response,
);
const RUN_ID = pendingResponse.run_id;
const IDEMPOTENCY_KEY = startRequest.request_id;
const OTHER_IDEMPOTENCY_KEY = '69999999-9999-4999-8999-999999999999';
const AUTHORIZATION = 'Bearer private.user-access_token';

const publicStartRequest = {
  schema_version: startRequest.schema_version,
  document_id: startRequest.document_id,
  candidate_id: startRequest.candidate_id,
};

function jsonRequest(
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://teamflow.test${path}`, {
    method,
    headers: {
      Authorization: AUTHORIZATION,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function serviceResponse(
  body: ResumeReviewRunResponse,
  status: 200 | 202,
): Response {
  const pending = status === 202 || body.status === 'pending_review';
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (pending) headers.set('Retry-After', '2');
  if (status === 202) {
    headers.set('Location', `/v2/resume-review-runs/${body.run_id}`);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

class RecordingClient implements ResumeReviewHitlClient {
  readonly starts: Array<{ body: StartResumeReviewRunRequest; authorization: string }> = [];
  readonly inspections: Array<{ runId: string; authorization: string }> = [];
  readonly pendingLists: Array<{
    query: { limit: number; cursor: string | null };
    authorization: string;
  }> = [];
  readonly decisions: Array<{
    runId: string;
    body: ResumeReviewDecisionRequest;
    authorization: string;
  }> = [];

  async start(
    body: StartResumeReviewRunRequest,
    authorization: string,
  ): Promise<ResumeReviewHitlClientResult> {
    this.starts.push({ body, authorization });
    return {
      data: {
        ...pendingResponse,
        request_id: body.request_id,
        document_id: body.document_id,
      },
      status: 202,
      retryAfterSeconds: 2,
    };
  }

  async inspect(
    runId: string,
    authorization: string,
  ): Promise<ResumeReviewHitlClientResult<ResumeReviewRunDetailResponse>> {
    this.inspections.push({ runId, authorization });
    return { data: detailResponse, status: 200, retryAfterSeconds: 2 };
  }

  async listPending(
    query: { limit: number; cursor: string | null },
    authorization: string,
  ): Promise<PendingResumeReviewQueueClientResult> {
    this.pendingLists.push({ query, authorization });
    return { data: queueResponse, status: 200, retryAfterSeconds: null };
  }

  async decide(
    runId: string,
    body: ResumeReviewDecisionRequest,
    authorization: string,
  ): Promise<ResumeReviewHitlClientResult> {
    this.decisions.push({ runId, body, authorization });
    return { data: completeResponse, status: 200, retryAfterSeconds: null };
  }
}

test('requires a strict bearer credential before reading identifiers or bodies', async () => {
  const client = new RecordingClient();
  const invalidAuthorizations = [
    null,
    'Basic private-token',
    'Bearer',
    'Bearer token with spaces',
    'Bearer first, Bearer second',
    `Bearer ${'a'.repeat(8_193)}`,
  ];

  for (const authorization of invalidAuthorizations) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': IDEMPOTENCY_KEY,
    };
    if (authorization !== null) headers.Authorization = authorization;
    const response = await handleStartResumeReviewRun(new Request(
      'http://teamflow.test/api/resume-review-runs',
      { method: 'POST', headers, body: '{"merchant_id":"private"}' },
    ), { client });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: 'Unauthorized',
      code: 'unauthorized',
    });
  }
  assert.equal(client.starts.length, 0);

  const inspect = await handleInspectResumeReviewRun(new Request(
    `http://teamflow.test/api/resume-review-runs/${RUN_ID}`,
  ), RUN_ID, { client });
  assert.equal(inspect.status, 401);
  assert.equal(client.inspections.length, 0);

  const pending = await handleListPendingResumeReviews(new Request(
    'http://teamflow.test/api/resume-review-runs?status=pending_review',
  ), { client });
  assert.equal(pending.status, 401);
  assert.equal(client.pendingLists.length, 0);
});

test('validates exact JSON media type and canonical framing before body reads', async () => {
  const client = new RecordingClient();
  const cases: Array<{
    headers: Record<string, string>;
    status: number;
  }> = [
    { headers: {}, status: 415 },
    { headers: { 'Content-Type': 'application/json; charset=utf-8' }, status: 415 },
    { headers: { 'Content-Type': 'text/plain' }, status: 415 },
    {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '01' },
      status: 400,
    },
    {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1, 1' },
      status: 400,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '1',
        'Transfer-Encoding': 'chunked',
      },
      status: 400,
    },
    {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '8193' },
      status: 413,
    },
  ];

  for (const testCase of cases) {
    let bodyAccessed = false;
    const request = {
      headers: new Headers({
        Authorization: AUTHORIZATION,
        'Idempotency-Key': IDEMPOTENCY_KEY,
        ...testCase.headers,
      }),
      get body() {
        bodyAccessed = true;
        throw new Error('invalid framing must be rejected before body read');
      },
    } as unknown as Request;

    const response = await handleStartResumeReviewRun(request, { client });
    assert.equal(response.status, testCase.status, JSON.stringify(testCase.headers));
    assert.equal(bodyAccessed, false, JSON.stringify(testCase.headers));
  }
  assert.equal(client.starts.length, 0);
});

test('lists only the authenticated pending queue with strict bounded query input', async () => {
  const client = new RecordingClient();
  const response = await handleListPendingResumeReviews(new Request(
    'http://teamflow.test/api/resume-review-runs?status=pending_review&limit=25',
    { headers: { Authorization: AUTHORIZATION } },
  ), { client });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('retry-after'), null);
  assert.deepEqual(await response.json(), queueResponse);
  assert.deepEqual(client.pendingLists, [{
    query: { limit: 25, cursor: null },
    authorization: AUTHORIZATION,
  }]);

  const invalidQueries = [
    '',
    '?status=completed',
    '?status=pending_review&merchant_id=69999999-9999-4999-8999-999999999999',
    '?status=pending_review&status=pending_review',
    '?status=pending_review&limit=0',
    '?status=pending_review&limit=01',
    '?status=pending_review&limit=51',
    '?status=pending_review&cursor=not-valid',
  ];
  for (const query of invalidQueries) {
    const invalid = await handleListPendingResumeReviews(new Request(
      `http://teamflow.test/api/resume-review-runs${query}`,
      { headers: { Authorization: AUTHORIZATION } },
    ), { client });
    assert.equal(invalid.status, 400, query);
  }
  assert.equal(client.pendingLists.length, 1);
});

test('returns a strict reviewer detail that can be submitted unchanged as an edit', async () => {
  const client = new RecordingClient();
  const inspected = await handleInspectResumeReviewRun(new Request(
    `http://teamflow.test/api/resume-review-runs/${RUN_ID}`,
    { headers: { Authorization: AUTHORIZATION } },
  ), RUN_ID, { client });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.headers.get('cache-control'), 'no-store');
  const detail = ResumeReviewRunDetailResponseSchema.parse(await inspected.json());
  assert.equal(detail.proposal.confidence.policy_sha256, 'c'.repeat(64));
  assert.equal(detail.proposal.confidence.threshold_applied, false);
  assert.equal(detail.proposal.confidence.is_probability, false);
  const serialized = JSON.stringify(detail);
  for (const forbidden of [
    'merchant_id',
    'thread_id',
    'checkpoint',
    'document_snapshot',
    'source_blocks',
    'extraction_snapshot_sha256',
    'embedding',
  ]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
  }
  if (detail.review === null) throw new Error('detail fixture must include review');
  const decision = ResumeReviewDecisionRequestSchema.parse({
    schema_version: '2.0',
    decision_id: '67777777-7777-4777-8777-777777777777',
    review_id: detail.review.review_id,
    expected_review_version: detail.review.review_version,
    action: 'approve_with_edits',
    replacement_agent1_output: detail.proposal.editable_agent1_output,
    reason_code: 'reviewer-confirmed-evidence',
  });
  const decided = await handleDecideResumeReviewRun(jsonRequest(
    `/api/resume-review-runs/${RUN_ID}/decision`,
    'PUT',
    decision,
  ), RUN_ID, { client });
  assert.equal(decided.status, 200);
  assert.deepEqual(client.decisions[0]?.body, decision);
});

test('accepts a contract-valid edit above the former 64 KiB transport cap', async () => {
  const client = new RecordingClient();
  const replacement = {
    schema_version: '1.0',
    role_assessments: Array.from({ length: 5 }, (_, roleIndex) => ({
      role_id: `7000000${roleIndex}-0000-4000-8000-00000000000${roleIndex}`,
      criterion_assessments: Array.from({ length: 20 }, (_, criterionIndex) => {
        const criterionId = `criterion-${roleIndex}-${criterionIndex}`;
        return {
          criterion_id: criterionId,
          status: 'met',
          evidence: [{
            criterion_id: criterionId,
            exact_quote: `${roleIndex}-${criterionIndex}-` + 'x'.repeat(1_800),
            source_block_id: `source-${roleIndex}-${criterionIndex}`,
          }],
        };
      }),
    })),
    limitations: [],
  };
  const decision = {
    schema_version: '2.0',
    decision_id: '67777777-7777-4777-8777-777777777777',
    review_id: approveDecision.review_id,
    expected_review_version: approveDecision.expected_review_version,
    action: 'approve_with_edits',
    replacement_agent1_output: replacement,
    reason_code: 'reviewer-confirmed-evidence',
  };
  const size = new TextEncoder().encode(JSON.stringify(decision)).byteLength;
  assert.ok(size > 65_536 && size < 262_144, `unexpected edit size ${size}`);

  const response = await handleDecideResumeReviewRun(jsonRequest(
    `/api/resume-review-runs/${RUN_ID}/decision`,
    'PUT',
    decision,
  ), RUN_ID, { client });
  assert.equal(response.status, 200);
  assert.equal(client.decisions.length, 1);
});

test('rejects caller authority and request-id injection before the service', async () => {
  const client = new RecordingClient();
  for (const [field, value] of Object.entries({
    request_id: OTHER_IDEMPOTENCY_KEY,
    merchant_id: OTHER_IDEMPOTENCY_KEY,
    actor_id: OTHER_IDEMPOTENCY_KEY,
    reviewer_id: OTHER_IDEMPOTENCY_KEY,
    thread_id: 'caller-owned-thread',
    score: 100,
  })) {
    const response = await handleStartResumeReviewRun(jsonRequest(
      '/api/resume-review-runs',
      'POST',
      { ...publicStartRequest, [field]: value },
      { 'Idempotency-Key': IDEMPOTENCY_KEY },
    ), { client });

    assert.equal(response.status, 400, field);
    assert.equal(JSON.stringify(await response.json()).includes(String(value)), false);
  }
  assert.equal(client.starts.length, 0);

  const injectedDecision = await handleDecideResumeReviewRun(jsonRequest(
    `/api/resume-review-runs/${RUN_ID}/decision`,
    'PUT',
    { ...approveDecision, actor_id: OTHER_IDEMPOTENCY_KEY },
  ), RUN_ID, { client });
  assert.equal(injectedDecision.status, 400);
  assert.equal(client.decisions.length, 0);
});

test('uses the canonical Idempotency-Key as the stable server-owned replay ID', async () => {
  const client = new RecordingClient();
  for (const idempotencyKey of [
    IDEMPOTENCY_KEY,
    IDEMPOTENCY_KEY,
    OTHER_IDEMPOTENCY_KEY,
  ]) {
    const response = await handleStartResumeReviewRun(jsonRequest(
      '/api/resume-review-runs',
      'POST',
      publicStartRequest,
      { 'Idempotency-Key': idempotencyKey },
    ), { client });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(
      response.headers.get('location'),
      `/api/resume-review-runs/${RUN_ID}`,
    );
    assert.equal((await response.json()).request_id, idempotencyKey);
  }

  assert.deepEqual(
    client.starts.map(call => call.body.request_id),
    [IDEMPOTENCY_KEY, IDEMPOTENCY_KEY, OTHER_IDEMPOTENCY_KEY],
  );
  assert.ok(client.starts.every(call => call.authorization === AUTHORIZATION));

  const uppercaseKey = '6AAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const invalid = await handleStartResumeReviewRun(jsonRequest(
    '/api/resume-review-runs',
    'POST',
    publicStartRequest,
    { 'Idempotency-Key': uppercaseKey },
  ), { client });
  assert.equal(invalid.status, 400);
  assert.equal(client.starts.length, 3);
});

test('uses only the configured service token and forwards no authority fields', async () => {
  let upstreamUrl = '';
  let upstreamOptions: RequestInit | undefined;
  const serviceClient = createResumeReviewHitlClient({
    serviceUrl: 'http://hiring-agent.test/',
    serviceToken: 'server-only-agent-token',
    fetchImpl: async (input, options) => {
      upstreamUrl = String(input);
      upstreamOptions = options;
      return serviceResponse(pendingResponse, 202);
    },
  });
  const response = await handleStartResumeReviewRun(jsonRequest(
    '/api/resume-review-runs',
    'POST',
    publicStartRequest,
    {
      'Idempotency-Key': IDEMPOTENCY_KEY,
      'X-Agent-Token': 'caller-injected-agent-token',
    },
  ), { client: serviceClient });

  assert.equal(response.status, 202);
  assert.equal(upstreamUrl, 'http://hiring-agent.test/v2/resume-review-runs');
  const headers = new Headers(upstreamOptions?.headers);
  assert.equal(headers.get('authorization'), AUTHORIZATION);
  assert.equal(headers.get('x-agent-token'), 'server-only-agent-token');
  assert.equal(headers.get('idempotency-key'), IDEMPOTENCY_KEY);
  const upstreamBody = JSON.parse(String(upstreamOptions?.body));
  assert.deepEqual(upstreamBody, startRequest);
  for (const forbidden of ['merchant_id', 'actor_id', 'reviewer_id', 'thread_id']) {
    assert.equal(forbidden in upstreamBody, false);
  }
});

test('proxies the pending queue as a credentialed no-store GET', async () => {
  let upstreamUrl = '';
  let upstreamOptions: RequestInit | undefined;
  const serviceClient = createResumeReviewHitlClient({
    serviceUrl: 'http://hiring-agent.test/',
    serviceToken: 'server-only-agent-token',
    fetchImpl: async (input, options) => {
      upstreamUrl = String(input);
      upstreamOptions = options;
      return Response.json(queueResponse);
    },
  });
  const response = await handleListPendingResumeReviews(new Request(
    'http://teamflow.test/api/resume-review-runs?status=pending_review&limit=50',
    { headers: { Authorization: AUTHORIZATION } },
  ), { client: serviceClient });

  assert.equal(response.status, 200);
  assert.equal(
    upstreamUrl,
    'http://hiring-agent.test/v2/resume-review-runs?status=pending_review&limit=50',
  );
  assert.equal(upstreamOptions?.method, 'GET');
  assert.equal(upstreamOptions?.cache, 'no-store');
  const headers = new Headers(upstreamOptions?.headers);
  assert.equal(headers.get('authorization'), AUTHORIZATION);
  assert.equal(headers.get('x-agent-token'), 'server-only-agent-token');
  assert.equal(headers.get('content-type'), null);
});

test('fails closed when the server-side service token is absent', () => {
  assert.throws(
    () => createResumeReviewHitlClient({
      serviceUrl: 'http://hiring-agent.test',
      serviceToken: '',
    }),
    (error: unknown) => (
      error instanceof ResumeReviewHitlClientError &&
      error.status === 503 &&
      error.code === 'service_unavailable'
    ),
  );
});

test('rejects uncorrelated start, inspect, and decision responses', async t => {
  await t.test('start request and document', async () => {
    const client = createResumeReviewHitlClient({
      serviceUrl: 'http://hiring-agent.test',
      serviceToken: 'server-token',
      fetchImpl: async () => serviceResponse({
        ...pendingResponse,
        request_id: OTHER_IDEMPOTENCY_KEY,
      }, 202),
    });
    const response = await handleStartResumeReviewRun(jsonRequest(
      '/api/resume-review-runs',
      'POST',
      publicStartRequest,
      { 'Idempotency-Key': IDEMPOTENCY_KEY },
    ), { client });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: 'Résumé-review request failed',
      code: 'workflow_failed',
    });
  });

  await t.test('inspected run', async () => {
    const client = createResumeReviewHitlClient({
      serviceUrl: 'http://hiring-agent.test',
      serviceToken: 'server-token',
      fetchImpl: async () => serviceResponse({
        ...pendingResponse,
        run_id: OTHER_IDEMPOTENCY_KEY,
      }, 200),
    });
    const response = await handleInspectResumeReviewRun(new Request(
      `http://teamflow.test/api/resume-review-runs/${RUN_ID}`,
      { headers: { Authorization: AUTHORIZATION } },
    ), RUN_ID, { client });
    assert.equal(response.status, 502);
  });

  await t.test('decision review', async () => {
    const client = createResumeReviewHitlClient({
      serviceUrl: 'http://hiring-agent.test',
      serviceToken: 'server-token',
      fetchImpl: async () => serviceResponse({
        ...completeResponse,
        review: {
          ...completeResponse.review!,
          review_id: OTHER_IDEMPOTENCY_KEY,
        },
      }, 200),
    });
    const response = await handleDecideResumeReviewRun(jsonRequest(
      `/api/resume-review-runs/${RUN_ID}/decision`,
      'PUT',
      approveDecision,
    ), RUN_ID, { client });
    assert.equal(response.status, 502);
  });
});

test('maps allowlisted domain errors without leaking upstream details', async () => {
  const client = createResumeReviewHitlClient({
    serviceUrl: 'http://hiring-agent.test',
    serviceToken: 'server-token',
    fetchImpl: async () => Response.json({
      error: 'private database and tenant detail',
      code: 'stale_decision',
    }, { status: 409 }),
  });
  const response = await handleDecideResumeReviewRun(jsonRequest(
    `/api/resume-review-runs/${RUN_ID}/decision`,
    'PUT',
    approveDecision,
  ), RUN_ID, { client });

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: 'Review decision is stale',
    code: 'stale_decision',
  });
});

test('rejects malformed, oversized, and lifecycle-inconsistent service responses', async t => {
  const cases: Array<() => Response> = [
    () => new Response('not json', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }),
    () => new Response(JSON.stringify({
      ...pendingResponse,
      checkpoint_state: { resume_text: 'private resume' },
    }), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        Location: `/v2/resume-review-runs/${RUN_ID}`,
        'Retry-After': '2',
      },
    }),
    () => new Response(JSON.stringify(pendingResponse), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '3000000',
        Location: `/v2/resume-review-runs/${RUN_ID}`,
        'Retry-After': '2',
      },
    }),
    () => new Response(JSON.stringify(pendingResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Location: `/v2/resume-review-runs/${RUN_ID}`,
        'Retry-After': '2',
      },
    }),
    () => new Response(JSON.stringify(pendingResponse), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        Location: `/v2/resume-review-runs/${OTHER_IDEMPOTENCY_KEY}`,
        'Retry-After': '2',
      },
    }),
    () => new Response(JSON.stringify(pendingResponse), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '01',
        Location: `/v2/resume-review-runs/${RUN_ID}`,
        'Retry-After': '2',
      },
    }),
    () => new Response(JSON.stringify(pendingResponse), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        Location: `/v2/resume-review-runs/${RUN_ID}`,
        'Retry-After': '01',
      },
    }),
    () => new Response(JSON.stringify(pendingResponse), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        Location: `/v2/resume-review-runs/${RUN_ID}`,
        'Retry-After': 'tomorrow',
      },
    }),
  ];

  for (const responseFactory of cases) {
    await t.test('invalid service response', async () => {
      const client = createResumeReviewHitlClient({
        serviceUrl: 'http://hiring-agent.test',
        serviceToken: 'server-token',
        fetchImpl: async () => responseFactory(),
      });
      const response = await handleStartResumeReviewRun(jsonRequest(
        '/api/resume-review-runs',
        'POST',
        publicStartRequest,
        { 'Idempotency-Key': IDEMPOTENCY_KEY },
      ), { client });
      assert.equal(response.status, 502);
      assert.equal(JSON.stringify(await response.json()).includes('private resume'), false);
    });
  }
});

test('enforces the streamed request-body cap without Content-Length', async () => {
  const client = new RecordingClient();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(9_000)));
      controller.close();
    },
  });
  const request = new Request('http://teamflow.test/api/resume-review-runs', {
    method: 'POST',
    headers: {
      Authorization: AUTHORIZATION,
      'Idempotency-Key': IDEMPOTENCY_KEY,
      'Content-Type': 'application/json',
    },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const response = await handleStartResumeReviewRun(request, { client });
  assert.equal(response.status, 413);
  assert.equal(client.starts.length, 0);
});

test('bounds slow request bodies before contacting the authenticated service', async () => {
  const client = new RecordingClient();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
  });
  const request = new Request('http://teamflow.test/api/resume-review-runs', {
    method: 'POST',
    headers: {
      Authorization: AUTHORIZATION,
      'Idempotency-Key': IDEMPOTENCY_KEY,
      'Content-Type': 'application/json',
    },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const response = await handleStartResumeReviewRun(request, {
    client,
    bodyDeadlineMs: 5,
  });

  assert.equal(response.status, 408);
  assert.equal(client.starts.length, 0);
  assert.deepEqual(await response.json(), {
    error: 'Request body deadline exceeded',
    code: 'invalid_request',
  });
});

test('keeps the deadline active while consuming the service response body', async () => {
  const neverEndingBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
  });
  const client = createResumeReviewHitlClient({
    serviceUrl: 'http://hiring-agent.test',
    serviceToken: 'server-token',
    deadlineMs: 5,
    fetchImpl: async () => new Response(neverEndingBody, {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        Location: `/v2/resume-review-runs/${RUN_ID}`,
        'Retry-After': '2',
      },
    }),
  });

  await assert.rejects(
    client.start(startRequest, AUTHORIZATION),
    (error: unknown) => (
      error instanceof ResumeReviewHitlClientError &&
      error.status === 504 &&
      error.code === 'service_unavailable'
    ),
  );
});
