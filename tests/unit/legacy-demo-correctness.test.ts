import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { NextRequest } from 'next/server.js';

import { createApplicationPost } from '../../app/api/application/handler.ts';
import { createInvitePost } from '../../app/api/invite/handler.ts';
import { getRoleOrDefault, isRoleQuestionFailure } from '../../lib/domain/roles.ts';

const validApplication = {
  candidateId: 'candidate-1',
  roleId: 'barista',
  basicInfo: {
    fullName: 'Synthetic Candidate',
    email: 'candidate@example.test',
    phone: '(201) 555-0123',
  },
  knockoutAnswers: {
    bk_auth: true,
    bk_weekend: true,
  },
  profile: {
    preferredShifts: ['morning'],
    daysAvailable: ['Monday'],
    startDate: '2026-09-01',
    transportation: 'public',
    contactPreference: 'text',
  },
  skills: {
    yearsExperience: '1-3',
    skills: ['customer-service'],
    certifications: [],
    languages: ['english'],
  },
  motivation: {
    whyWorkHere: 'I enjoy helping customers and contributing to a reliable team.',
    superpower: 'calm',
    aboveAndBeyond: '',
    skillAnswers: {},
  },
};

function enableLocalDemo(t: TestContext): void {
  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnv = environment.NODE_ENV;
  const previousFlag = environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
  environment.NODE_ENV = 'test';
  environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = 'true';
  t.after(() => {
    if (previousNodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES;
    else environment.TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES = previousFlag;
  });
}

function jsonRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('application does not report success when the submission was not persisted', async t => {
  enableLocalDemo(t);
  let candidateSaveCalls = 0;
  const handler = createApplicationPost({
    saveApplication: async () => null,
    saveCandidate: async () => {
      candidateSaveCalls += 1;
      return 'candidate-row';
    },
  });

  const response = await handler(jsonRequest('/api/application', validApplication));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.deepEqual(body.error, {
    code: 'PERSISTENCE_UNAVAILABLE',
    message: 'Your application was not saved. Your answers are still here; please try again.',
    retryable: true,
  });
  assert.equal(candidateSaveCalls, 0);
});

test('application completion requires its candidate review record to be saved', async t => {
  enableLocalDemo(t);
  const handler = createApplicationPost({
    saveApplication: async () => 'application-row',
    saveCandidate: async () => null,
  });

  const response = await handler(jsonRequest('/api/application', validApplication));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.error.retryable, false);
  assert.equal(body.applicationId, undefined);
});

test('application does not recommend a blind retry after a partial persistence exception', async t => {
  enableLocalDemo(t);
  const handler = createApplicationPost({
    saveApplication: async () => 'application-row',
    saveCandidate: async () => {
      throw new Error('database disconnected');
    },
  });

  const response = await handler(jsonRequest('/api/application', validApplication));
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.retryable, false);
});

test('application returns a receipt only after all required records are saved', async t => {
  enableLocalDemo(t);
  const handler = createApplicationPost({
    saveApplication: async () => 'application-row',
    saveCandidate: async () => 'candidate-row',
  });

  const response = await handler(jsonRequest('/api/application', validApplication));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body, {
    success: true,
    passed: true,
    applicationId: 'application-row',
    failedKnockouts: [],
    message: 'Application received.',
  });
});

test('boolean No is recorded for human review and still creates a candidate row', async t => {
  enableLocalDemo(t);
  const question = getRoleOrDefault('barista').questions.knockout.find(
    item => item.id === 'bk_weekend',
  );
  assert.ok(question);
  assert.equal(isRoleQuestionFailure(question, false), true);
  assert.equal(isRoleQuestionFailure(question, true), false);

  let candidateSaveCalls = 0;
  const savedCandidates: Array<{ summary?: string }> = [];
  const handler = createApplicationPost({
    saveApplication: async () => 'application-row',
    saveCandidate: async candidate => {
      candidateSaveCalls += 1;
      savedCandidates.push(candidate);
      return 'candidate-row';
    },
  });
  const response = await handler(jsonRequest('/api/application', {
    ...validApplication,
    knockoutAnswers: { ...validApplication.knockoutAnswers, bk_weekend: false },
  }));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.passed, false);
  assert.deepEqual(body.failedKnockouts, ['bk_weekend']);
  assert.equal(candidateSaveCalls, 1);
  assert.equal(
    savedCandidates[0]?.summary,
    'Required responses flagged for authorized human review',
  );
});

const validInvite = {
  candidateId: 'candidate-1',
  candidateName: 'Synthetic Candidate',
  candidatePhone: '(201) 555-0123',
  storeName: 'Demo Store',
};

test('invite does not change status when delivery fails', async t => {
  enableLocalDemo(t);
  let statusCalls = 0;
  const handler = createInvitePost({
    generateLink: () => 'http://localhost/apply?token=redacted',
    sendSms: async () => ({ success: false, error: 'provider failure' }),
    updateStatus: async () => {
      statusCalls += 1;
      return true;
    },
  });

  const response = await handler(jsonRequest('/api/invite', validInvite));
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'DELIVERY_FAILED');
  assert.equal(body.error.retryable, true);
  assert.equal(statusCalls, 0);
});

test('invite does not report invited when delivery succeeded but status persistence failed', async t => {
  enableLocalDemo(t);
  const handler = createInvitePost({
    generateLink: () => 'http://localhost/apply?token=redacted',
    sendSms: async () => ({ success: true, messageId: 'message-1' }),
    updateStatus: async () => false,
  });

  const response = await handler(jsonRequest('/api/invite', validInvite));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'PERSISTENCE_UNAVAILABLE');
  assert.equal(body.error.retryable, false);
});

test('invite does not recommend a blind retry when status persistence throws after delivery', async t => {
  enableLocalDemo(t);
  const handler = createInvitePost({
    generateLink: () => 'http://localhost/apply?token=redacted',
    sendSms: async () => ({ success: true, messageId: 'message-1' }),
    updateStatus: async () => {
      throw new Error('database disconnected');
    },
  });

  const response = await handler(jsonRequest('/api/invite', validInvite));
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.retryable, false);
});

test('successful demo invite is explicit about simulated delivery and does not expose its bearer link', async t => {
  enableLocalDemo(t);
  const handler = createInvitePost({
    generateLink: () => 'http://localhost/apply?token=secret-token',
    sendSms: async () => ({ success: true, messageId: 'mock-1', mock: true }),
    updateStatus: async () => true,
  });

  const response = await handler(jsonRequest('/api/invite', validInvite));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    success: true,
    delivery: 'simulated',
    message: 'Invitation simulated in the local demo.',
  });
  assert.equal(JSON.stringify(body).includes('secret-token'), false);
});
