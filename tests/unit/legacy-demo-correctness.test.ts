import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { NextRequest } from 'next/server.js';

import { createApplicationPost } from '../../app/api/application/handler.ts';
import { createInvitePost } from '../../app/api/invite/handler.ts';
import { getRoleOrDefault, isRoleQuestionFailure } from '../../lib/domain/roles.ts';
import type { DocumentExtractionResult } from '../../lib/contracts/document-extraction.ts';

const validApplication = {
  candidateId: 'candidate-1',
  roleId: 'barista',
  basicInfo: {
    fullName: 'Synthetic Candidate',
    email: 'candidate@example.test',
    phone: '(201) 555-0123',
    city: 'Brooklyn',
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
  resume: {
    fileData: Buffer.from('%PDF-1.4\nsynthetic resume\n').toString('base64'),
    mimeType: 'application/pdf',
    fileName: 'candidate-resume.pdf',
  },
};

const offlineResumeServices = {
  uploadResume: async (_file: File | Blob, path: string) => path,
  deleteResume: async () => true,
  applicationExists: async () => false,
  extractResume: async (): Promise<never> => { throw new Error('synthetic OCR unavailable'); },
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

test('application requires a valid résumé before storage or database writes', async t => {
  enableLocalDemo(t);
  let writes = 0;
  const handler = createApplicationPost({
    uploadResume: async () => { writes += 1; return null; },
    saveApplication: async () => { writes += 1; return null; },
    saveCandidate: async () => { writes += 1; return null; },
  });
  const withoutResume: Record<string, unknown> = { ...validApplication };
  delete withoutResume.resume;
  for (const application of [
    withoutResume,
    { ...validApplication, resume: { ...validApplication.resume, fileData: '' } },
    { ...validApplication, resume: { ...validApplication.resume, fileName: 'candidate.png' } },
    { ...validApplication, resume: { ...validApplication.resume, fileData: Buffer.from('not a PDF').toString('base64') } },
  ]) {
    const response = await handler(jsonRequest('/api/application', application));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  }
  assert.equal(writes, 0);
});

test('application cannot succeed when the required résumé upload fails', async t => {
  enableLocalDemo(t);
  let applicationSaves = 0;
  const handler = createApplicationPost({
    uploadResume: async () => null,
    saveApplication: async () => { applicationSaves += 1; return null; },
  });
  const response = await handler(jsonRequest('/api/application', validApplication));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.error.retryable, true);
  assert.equal(applicationSaves, 0);
});

test('application does not report success when the submission was not persisted', async t => {
  enableLocalDemo(t);
  let candidateSaveCalls = 0;
  let removedPath: string | undefined;
  const handler = createApplicationPost({
    ...offlineResumeServices,
    deleteResume: async path => { removedPath = path; return true; },
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
  assert.match(removedPath ?? '', /^webform_[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/);
});

test('application completion requires its candidate review record to be saved', async t => {
  enableLocalDemo(t);
  let deleteCalls = 0;
  const handler = createApplicationPost({
    ...offlineResumeServices,
    deleteResume: async () => { deleteCalls += 1; return true; },
    saveApplication: async (_submission, id) => id ?? null,
    saveCandidate: async () => null,
  });

  const response = await handler(jsonRequest('/api/application', validApplication));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.error.retryable, false);
  assert.equal(body.applicationId, undefined);
  assert.equal(deleteCalls, 0);
});

test('application does not recommend a blind retry after a partial persistence exception', async t => {
  enableLocalDemo(t);
  let deleteCalls = 0;
  const handler = createApplicationPost({
    ...offlineResumeServices,
    deleteResume: async () => { deleteCalls += 1; return true; },
    saveApplication: async (_submission, id) => id ?? null,
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
  assert.equal(deleteCalls, 0);
});

test('application keeps an uploaded résumé when a failed write may have left a row', async t => {
  enableLocalDemo(t);
  let deleteCalls = 0;
  const handler = createApplicationPost({
    ...offlineResumeServices,
    saveApplication: async () => null,
    applicationExists: async () => null,
    deleteResume: async () => { deleteCalls += 1; return true; },
  });
  const response = await handler(jsonRequest('/api/application', validApplication));
  assert.equal(response.status, 503);
  assert.equal(deleteCalls, 0);
});

test('application cleans up an unreferenced résumé after an application insert exception', async t => {
  enableLocalDemo(t);
  let deleteCalls = 0;
  const handler = createApplicationPost({
    ...offlineResumeServices,
    saveApplication: async () => { throw new Error('synthetic database failure'); },
    deleteResume: async () => { deleteCalls += 1; return true; },
  });
  const response = await handler(jsonRequest('/api/application', validApplication));
  assert.equal(response.status, 500);
  assert.equal(deleteCalls, 1);
});

test('application returns a receipt only after all required records are saved', async t => {
  enableLocalDemo(t);
  let savedPath: string | undefined;
  let savedApplicationId: string | undefined;
  let savedCandidatePath: string | undefined;
  let savedCandidateCity: string | undefined;
  const handler = createApplicationPost({
    ...offlineResumeServices,
    uploadResume: async (file, path) => {
      assert.equal(file.type, 'application/pdf');
      assert.equal(file.size, Buffer.from(validApplication.resume.fileData, 'base64').length);
      savedPath = path;
      return path;
    },
    saveApplication: async (submission, id) => {
      savedApplicationId = id;
      assert.equal(submission.resume?.storage_path, savedPath);
      assert.equal(submission.resume?.file_name, 'candidate-resume.pdf');
      assert.equal(submission.resume?.mime_type, 'application/pdf');
      assert.match(submission.resume?.content_sha256 ?? '', /^[0-9a-f]{64}$/);
      assert.equal(submission.basic_info.city, 'Brooklyn');
      assert.equal(submission.candidate_id, undefined);
      return id ?? null;
    },
    saveCandidate: async candidate => {
      savedCandidatePath = candidate.resume_url;
      savedCandidateCity = candidate.city;
      assert.match(candidate.resume_text ?? '', /Synthetic Candidate/);
      assert.match(candidate.resume_text ?? '', /Location:\*\* Brooklyn/);
      return 'candidate-row';
    },
  });

  const response = await handler(jsonRequest('/api/application', validApplication));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.passed, true);
  assert.deepEqual(body.failedKnockouts, []);
  assert.equal(body.message, 'Application received.');
  assert.equal(body.applicationId, savedApplicationId);
  assert.match(body.applicationId, /^[0-9a-f-]{36}$/);
  assert.match(savedPath ?? '', new RegExp(`^webform_${body.applicationId}/[0-9a-f-]{36}\\.pdf$`));
  assert.equal(savedCandidatePath, savedPath);
  assert.equal(savedCandidateCity, 'Brooklyn');
});

test('application keeps applicant corrections alongside extracted résumé text', async t => {
  enableLocalDemo(t);
  let candidateText = '';
  const handler = createApplicationPost({
    ...offlineResumeServices,
    extractResume: async () => ({ markdown: '# Resume says a different name' } as DocumentExtractionResult),
    saveApplication: async (_submission, id) => id ?? null,
    saveCandidate: async candidate => {
      candidateText = candidate.resume_text ?? '';
      return 'candidate-row';
    },
  });
  const response = await handler(jsonRequest('/api/application', validApplication));
  assert.equal(response.status, 201);
  assert.match(candidateText, /Source résumé extraction[\s\S]*Resume says a different name/);
  assert.match(candidateText, /Applicant-reviewed form answers[\s\S]*Synthetic Candidate/);
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
    ...offlineResumeServices,
    saveApplication: async (_submission, id) => id ?? null,
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
