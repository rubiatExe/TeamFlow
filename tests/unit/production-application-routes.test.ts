import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NextRequest } from 'next/server.js';

import {
  createProductionApplicationPost,
  createProductionResumePreviewPost,
  createProductionResumeUploadPost,
  createProductionSessionGet,
} from '../../app/api/application/production-handler.ts';
import { createProductionReceiptGet } from '../../app/api/application/receipt/route.ts';
import type {
  ProductionInvitation,
  ProductionUploadGrant,
} from '../../lib/db/production-application.ts';
import { getRoleById } from '../../lib/domain/roles.ts';

const token = 'A'.repeat(43);
const invitation: ProductionInvitation = {
  id: 'b5b82a01-84e4-4b23-b8c3-f9d955cffc1a',
  merchantId: '291665a3-864d-4dcf-a665-789be9194d65',
  merchantName: 'Test Bakery',
  roleId: 'barista',
  jobId: null,
  candidateName: 'Alex Applicant',
  expiresAt: '2099-01-01T00:00:00.000Z',
  uploadCount: 0,
};
const upload: ProductionUploadGrant = {
  id: '47dcf4e3-4f6c-4a0f-a38b-7cdfa0bd87cf',
  invitationId: invitation.id,
  storagePath: `candidate-invitations/${invitation.id}/834e54b6-7e85-4d36-844f-9f7fbf8761e0.pdf`,
  fileName: 'resume.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 0,
  previewCount: 0,
};
const pdf = Uint8Array.from(Buffer.from('%PDF-1.7\nSynthetic resume\n'));
upload.sizeBytes = pdf.byteLength;

function request(path: string, body?: unknown, bearer = token): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('production session exposes only a verified invitation scope', async () => {
  const calls: string[] = [];
  const handler = createProductionSessionGet({
    verifyInvitation: async value => { calls.push(value); return value === token ? invitation : null; },
  });
  const missing = await handler(request('/api/application/session'));
  assert.equal(missing.status, 401);
  assert.deepEqual(calls, []);

  const accepted = await handler(request(`/api/application/session?token=${token}`));
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).session, {
    candidateName: 'Alex Applicant', merchantName: 'Test Bakery', roleId: 'barista',
  });
  assert.deepEqual(calls, [token]);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
});

test('receipt confirms only the submitted upload after a lost response', async () => {
  const receipt = createProductionReceiptGet(async (value, uploadId) =>
    value === token && uploadId === upload.id
      ? { applicationId: 'fbb0fd2f-a934-4f92-bfdf-b246d899f36d', passed: false }
      : null);
  const accepted = await receipt(request(`/api/application/receipt?uploadId=${upload.id}`));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    success: true,
    applicationId: 'fbb0fd2f-a934-4f92-bfdf-b246d899f36d',
    passed: false,
    failedKnockouts: [],
  });
  const otherUpload = await receipt(request('/api/application/receipt?uploadId=7a74fb9a-a1cc-49c7-9bdc-1adf076ca339'));
  assert.equal(otherUpload.status, 404);
});

test('upload rejects missing invitation before reading the body or minting a capability', async () => {
  let minted = false;
  const handler = createProductionResumeUploadPost({
    verifyInvitation: async () => { throw new Error('should not query without bearer'); },
    createSignedUpload: async () => { minted = true; return 'signed'; },
  });
  const response = await handler(request('/api/application/resume-upload', { junk: true }, ''));
  assert.equal(response.status, 401);
  assert.equal(minted, false);
});

test('upload grant is scoped to the verified invitation and the server chooses the path', async () => {
  let registeredPath = '';
  const handler = createProductionResumeUploadPost({
    verifyInvitation: async () => invitation,
    registerUploadGrant: async (invitationId, metadata) => {
      assert.equal(invitationId, invitation.id);
      assert.equal(metadata.fileName, 'resume.jpeg');
      assert.equal(metadata.mimeType, 'image/jpeg');
      registeredPath = metadata.storagePath;
      return { status: 'created', grant: { ...upload, storagePath: metadata.storagePath } };
    },
    createSignedUpload: async path => {
      assert.equal(path, registeredPath);
      return 'signed-upload-token';
    },
  });
  const response = await handler(request('/api/application/resume-upload', {
    fileName: 'resume.jpeg', mimeType: 'image/jpeg', size: 1_000,
  }));
  assert.equal(response.status, 200);
  assert.match(registeredPath, new RegExp(`^candidate-invitations/${invitation.id}/[0-9a-f-]+\\.jpg$`, 'u'));
  assert.equal((await response.json()).upload.signedToken, 'signed-upload-token');
});

test('signed-token failure releases the grant and database outages are retryable', async () => {
  let released = false;
  const failedMint = createProductionResumeUploadPost({
    verifyInvitation: async () => invitation,
    registerUploadGrant: async () => ({ status: 'created', grant: upload }),
    createSignedUpload: async () => null,
    releaseUploadGrant: async (invitationId, uploadId) => {
      assert.equal(invitationId, invitation.id);
      assert.equal(uploadId, upload.id);
      released = true;
      return true;
    },
  });
  const body = { fileName: 'resume.pdf', mimeType: 'application/pdf', size: upload.sizeBytes };
  const mintResponse = await failedMint(request('/api/application/resume-upload', body));
  assert.equal(mintResponse.status, 503);
  assert.equal(released, true);

  const unavailable = createProductionResumeUploadPost({
    verifyInvitation: async () => invitation,
    registerUploadGrant: async () => ({ status: 'unavailable' }),
  });
  const unavailableResponse = await unavailable(request('/api/application/resume-upload', body));
  assert.equal(unavailableResponse.status, 503);
  assert.equal((await unavailableResponse.json()).error.code, 'UPLOAD_UNAVAILABLE');
});

test('preview reads only a registered, validated private object and reserves OCR usage', async () => {
  let extractionCalls = 0;
  const handler = createProductionResumePreviewPost({
    verifyInvitation: async () => invitation,
    findUploadGrant: async (invitationId, uploadId) =>
      invitationId === invitation.id && uploadId === upload.id ? upload : null,
    downloadResume: async () => new Blob([pdf], { type: 'application/pdf' }),
    reservePreview: async () => true,
    extractResume: async () => {
      extractionCalls += 1;
      return { markdown: '# Alex Applicant\nEmail: alex@example.com' };
    },
  });
  const foreign = await handler(request('/api/application/resume-preview', {
    uploadId: '7a74fb9a-a1cc-49c7-9bdc-1adf076ca339',
  }));
  assert.equal(foreign.status, 400);
  assert.equal(extractionCalls, 0);

  const valid = await handler(request('/api/application/resume-preview', { uploadId: upload.id }));
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).prefill.email, 'alex@example.com');
  assert.equal(extractionCalls, 1);
});

test('a mismatched stored object cannot reach OCR preview', async () => {
  let extracted = false;
  const preview = createProductionResumePreviewPost({
    verifyInvitation: async () => invitation,
    findUploadGrant: async () => upload,
    downloadResume: async () => new Blob([pdf], { type: 'image/png' }),
    reservePreview: async () => true,
    extractResume: async () => { extracted = true; return { markdown: '' }; },
  });
  const response = await preview(request('/api/application/resume-preview', { uploadId: upload.id }));
  assert.equal(response.status, 400);
  assert.equal(extracted, false);
});

test('final submission uses a verified file and server-bound invitation ID', async () => {
  const role = getRoleById('barista');
  assert.ok(role);
  const knockoutAnswers = Object.fromEntries(role.questions.knockout.map(question => [question.id, true]));
  const body = {
    roleId: 'barista', uploadId: upload.id,
    basicInfo: { fullName: 'Corrected Name', email: 'alex@example.com', phone: '5551234567', city: 'Brooklyn' },
    knockoutAnswers,
    profile: { preferredShifts: [], daysAvailable: [], startDate: '', transportation: '', contactPreference: '' },
    skills: { yearsExperience: '2', skills: [], certifications: [], languages: [] },
    motivation: { whyWorkHere: '', superpower: '', aboveAndBeyond: '', skillAnswers: {} },
  };
  let finalized = false;
  let finalExtractionCalls = 0;
  const handler = createProductionApplicationPost({
    verifyInvitation: async () => invitation,
    findUploadGrant: async () => upload,
    downloadResume: async () => new Blob([pdf], { type: 'application/pdf' }),
    extractResume: async () => { finalExtractionCalls += 1; throw new Error('OCR unavailable'); },
    finalizeApplication: async (invitationId, uploadId, submission, resumeText, sha256, passed) => {
      finalized = true;
      assert.equal(invitationId, invitation.id);
      assert.equal(uploadId, upload.id);
      assert.equal(submission.role_id, invitation.roleId);
      assert.equal(submission.basic_info.full_name, 'Corrected Name');
      assert.equal(submission.candidate_id, undefined);
      assert.equal(submission.resume, undefined);
      assert.match(resumeText, /Corrected Name/u);
      assert.equal(sha256, createHash('sha256').update(pdf).digest('hex'));
      assert.equal(typeof passed, 'boolean');
      return { candidateId: '50e26027-3a2c-42cb-a91b-60bc4c94a48e', applicationId: 'fbb0fd2f-a934-4f92-bfdf-b246d899f36d' };
    },
  });
  const wrongRole = await handler(request('/api/application', { ...body, roleId: 'cashier' }));
  assert.equal(wrongRole.status, 400);
  assert.equal(finalized, false);

  const invalidFileHandler = createProductionApplicationPost({
    verifyInvitation: async () => invitation,
    findUploadGrant: async () => upload,
    downloadResume: async () => new Blob([Uint8Array.from(Buffer.from('not-a-pdf'))], { type: 'application/pdf' }),
    finalizeApplication: async () => { finalized = true; return null; },
  });
  const invalidFile = await invalidFileHandler(request('/api/application', body));
  assert.equal(invalidFile.status, 400);
  assert.equal(finalized, false);

  const accepted = await handler(request('/api/application', body));
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).success, true);
  assert.equal(finalized, true);
  assert.equal(finalExtractionCalls, 0);
});
