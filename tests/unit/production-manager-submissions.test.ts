import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';

import { createManagerResumeGet } from '../../app/api/application/manager-resume/route.ts';
import { createManagerSubmissionsGet } from '../../app/api/application/manager-submissions/route.ts';
import { mapManagerSubmission } from '../../lib/db/production-manager-submissions.ts';

const token = 'A'.repeat(43);
const userId = 'efec108a-a55b-4d7e-9af9-d9cf6f0dfcbf';
const merchantId = 'c9e8c52d-3ccb-4944-950e-688d68e4cacf';
const otherMerchantId = '56823ff2-91e8-4b64-94fc-f09195c54da2';
const applicationId = '87237c83-0f82-4b10-a3f5-2e9e62617a92';
const candidateId = '2a9ef596-a4ed-4e0e-9458-85cab32ca756';
const invitationId = '71e74e10-40db-4a76-b394-84ec450a79cd';
const uploadId = '1d5f014b-fd88-40f7-b3a7-d54c9408cb61';
const path = `candidate-invitations/${invitationId}/50892b58-86e9-463d-871f-6ef8a11abf84.pdf`;

function request(pathname: string, bearer = token): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

const invitation = {
  id: invitationId,
  merchant_id: merchantId,
  role_id: 'barista',
  submitted_at: '2026-10-14T08:00:00.000Z',
  submitted_application_id: applicationId,
  submitted_upload_id: uploadId,
};
const application = {
  id: applicationId,
  candidate_id: candidateId,
  role_id: 'barista',
  data: {
    basic_info: { full_name: 'Alex Applicant', email: 'alex@example.test', phone: '2015550101', city: 'Jersey City' },
    knockout_answers: { bk_auth: true },
    profile: {
      preferred_shifts: ['Mornings'], days_available: ['Monday'], start_date: 'Soon',
      transportation: 'Transit', contact_preference: 'Email',
    },
    skills: { years_experience: '3', skills: ['Espresso'], certifications: [], languages: ['English'] },
    motivation: { why_work_here: 'Great café', superpower: 'Patience', above_and_beyond: '', skill_answers: {} },
    resume: { file_name: 'alex.pdf', mime_type: 'application/pdf', storage_path: path },
  },
};
const candidate = {
  id: candidateId,
  merchant_id: merchantId,
  name: 'Alex Applicant',
  email: 'alex@example.test',
  phone: '2015550101',
  city: 'Jersey City',
  resume_url: path,
};
const upload = {
  id: uploadId,
  invitation_id: invitationId,
  storage_path: path,
  file_name: 'alex.pdf',
  mime_type: 'application/pdf',
  revoked_at: null,
};

test('manager submission mapping binds invitation, candidate tenant, and registered résumé path', () => {
  const mapped = mapManagerSubmission(merchantId, invitation, application, candidate, upload);
  assert.equal(mapped?.name, 'Alex Applicant');
  assert.equal(mapped?.resumeFileName, 'alex.pdf');
  assert.equal('storage_path' in (mapped?.answers ?? {}), false);
  assert.equal(JSON.stringify(mapped).includes(path), false);

  assert.equal(mapManagerSubmission(merchantId, invitation, application,
    { ...candidate, merchant_id: otherMerchantId }, upload), null);
  assert.equal(mapManagerSubmission(merchantId, invitation, application,
    { ...candidate, resume_url: 'legacy/demo.pdf' }, upload), null);
  assert.equal(mapManagerSubmission(merchantId, invitation, application, candidate,
    { ...upload, invitation_id: 'f3e10b4c-478e-4af9-8cb0-b8e1757038a8' }), null);
  assert.equal(mapManagerSubmission(merchantId, invitation,
    { ...application, data: { ...application.data, resume: { ...application.data.resume, storage_path: 'other.pdf' } } },
    candidate, upload), null);
});

test('manager application list validates identity and workspace before returning private data', async () => {
  let listed = 0;
  const GET = createManagerSubmissionsGet({
    verifyUser: async () => userId,
    listSubmissions: async (actorId, selectedMerchantId, page) => {
      listed += 1;
      assert.equal(actorId, userId);
      assert.equal(selectedMerchantId, merchantId);
      assert.equal(page, 0);
      return { submissions: [], nextPage: null };
    },
  });
  assert.equal((await GET(request(`/api/application/manager-submissions?merchantId=${merchantId}`, ''))).status, 401);
  assert.equal((await GET(request('/api/application/manager-submissions?merchantId=invalid'))).status, 400);
  assert.equal(listed, 0);
  const response = await GET(request(`/api/application/manager-submissions?merchantId=${merchantId}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(await response.json(), { submissions: [], nextPage: null });
  assert.equal(listed, 1);
});

test('manager résumé route only signs a scoped saved application and does not cache the capability', async () => {
  let signed = 0;
  const GET = createManagerResumeGet({
    verifyUser: async () => userId,
    createResumeUrl: async (actorId, selectedMerchantId, selectedApplicationId) => {
      signed += 1;
      assert.equal(actorId, userId);
      assert.equal(selectedMerchantId, merchantId);
      assert.equal(selectedApplicationId, applicationId);
      return signed === 1 ? null : 'https://db.example.test/storage/v1/object/sign/resumes/resume.pdf?token=short';
    },
  });
  assert.equal((await GET(request(`/api/application/manager-resume?merchantId=${merchantId}&applicationId=${applicationId}`, ''))).status, 401);
  assert.equal((await GET(request(`/api/application/manager-resume?merchantId=${merchantId}&applicationId=invalid`))).status, 400);
  assert.equal(signed, 0);
  const missing = await GET(request(`/api/application/manager-resume?merchantId=${merchantId}&applicationId=${applicationId}`));
  assert.equal(missing.status, 404);
  const response = await GET(request(`/api/application/manager-resume?merchantId=${merchantId}&applicationId=${applicationId}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await response.json()).expiresInSeconds, 60);
});
