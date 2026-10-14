import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

import type { ApplicationEvidenceRow } from '../../lib/contracts/application-completeness.ts';
import { summarizeApplicationCompleteness, unknownApplicationCompleteness } from '../../lib/domain/application-completeness.ts';
import { loadApplicationCompleteness } from '../../lib/db/application-completeness.ts';
import { rowToCandidate } from '../../lib/domain/candidate-presentation.ts';

const candidateId = '33333333-3333-4333-8333-333333333333';
const applicationId = '44444444-4444-4444-8444-444444444444';
const secondApplicationId = '55555555-5555-4555-8555-555555555555';
const completeAnswers = {
  basic_info: { full_name: 'Synthetic Applicant', email: 'applicant@example.invalid', phone: '2025550100' },
  knockout_answers: { bk_auth: false, bk_weekend: true },
  profile: { preferred_shifts: ['morning'], days_available: ['Saturday'], transportation: 'public', contact_preference: 'email' },
  skills: { years_experience: '0', skills: ['customer_service'], certifications: [], languages: [] },
  motivation: { why_work_here: 'I enjoy helping customers and preparing thoughtful drinks for a friendly local community.', superpower: 'friendly' },
};
const completeApplication: ApplicationEvidenceRow = {
  id: applicationId,
  candidate_id: candidateId,
  role_id: 'barista',
  submitted_at: '2026-10-12T10:00:00.000Z',
  data: completeAnswers,
};

test('application completeness checks required responses, not whether a candidate qualifies', () => {
  const summary = summarizeApplicationCompleteness([completeApplication]);
  assert.equal(summary.state, 'complete');
  assert.equal(summary.completed_sections, 5);
  assert.equal(summary.total_sections, 5);
  assert.deepEqual(summary.missing_fields, []);
  assert.equal('data' in summary, false);
  assert.equal(JSON.stringify(summary).includes('applicant@example.invalid'), false);
  // Negative eligibility answers, zero experience, and missing optional fields do not reduce completeness.
  assert.equal(summary.sections.find(section => section.id === 'role_questions')?.complete, true);
});

test('a submitted form with missing answers is distinct from a draft or no saved application', () => {
  const summary = summarizeApplicationCompleteness([{
    ...completeApplication,
    data: { ...completeAnswers, profile: {}, skills: { years_experience: '0', skills: [] } },
  }]);
  assert.equal(summary.state, 'submitted_incomplete');
  assert.equal(summary.completed_sections, 3);
  assert.ok(summary.missing_fields.includes('Preferred shifts'));
  assert.ok(summary.missing_fields.includes('Skills response'));
  assert.equal(summarizeApplicationCompleteness([{ ...completeApplication, submitted_at: null }]).state, 'in_progress');
  const empty = summarizeApplicationCompleteness([]);
  assert.equal(empty.state, 'not_submitted');
  assert.equal(empty.completed_sections, null);
  assert.match(empty.explanation, /Unsaved form progress is not tracked/);
  assert.equal(unknownApplicationCompleteness().state, 'unknown');
});

test('the latest submitted form controls completeness, not an older filled form', () => {
  const summary = summarizeApplicationCompleteness([
    completeApplication,
    { ...completeApplication, id: secondApplicationId, submitted_at: '2026-10-13T10:00:00.000Z', data: {} },
  ]);
  assert.equal(summary.application_id, secondApplicationId);
  assert.equal(summary.state, 'submitted_incomplete');
  assert.equal(summary.completed_sections, 0);
});

test('unsupported role requirements, corrupt answers, and invalid timestamps remain unknown', () => {
  for (const row of [
    { ...completeApplication, role_id: 'custom-job-role' },
    { ...completeApplication, data: null },
    { ...completeApplication, data: [] },
    { ...completeApplication, submitted_at: 'invalid-date' },
  ]) {
    const summary = summarizeApplicationCompleteness([row]);
    assert.equal(summary.state, 'unknown');
    assert.equal(summary.completed_sections, null);
    assert.equal(summary.application_id, applicationId);
  }
});

test('application completeness does not overwrite or add candidate score points', () => {
  const candidate = rowToCandidate({
    id: candidateId,
    merchant_id: 'merchant-test',
    name: 'Synthetic Applicant',
    status: 'new',
    resume_url: '',
    source: 'upload',
    fit_score: 70,
    application: summarizeApplicationCompleteness([completeApplication]),
  });
  assert.equal(candidate.data.score.total, 70);
  assert.equal(candidate.data.application?.state, 'complete');
});

test('application lookup uses exact candidate and webform IDs, never identity matching', async context => {
  const urls: URL[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url);
    assert.equal(url.origin, 'https://application-completeness.invalid');
    assert.equal(url.pathname, '/rest/v1/applications');
    assert.equal(url.searchParams.get('select'), 'id,candidate_id,role_id,data,submitted_at');
    assert.equal(url.searchParams.has('email'), false);
    assert.equal(url.searchParams.has('name'), false);
    if (url.searchParams.has('candidate_id')) {
      assert.equal(url.searchParams.get('candidate_id'), `in.(${candidateId})`);
      return Response.json([]);
    }
    assert.equal(url.searchParams.get('id'), `in.(${applicationId})`);
    return Response.json([{ ...completeApplication, candidate_id: null }]);
  });
  const db = createClient('https://application-completeness.invalid', 'synthetic-key');
  const result = await loadApplicationCompleteness(db, [{ id: candidateId, resume_url: `webform_${applicationId}` }]);
  assert.equal(urls.length, 2);
  assert.equal(result.get(candidateId)?.state, 'complete');
});

test('application lookup recognizes private résumé paths created by the application form', async context => {
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.has('candidate_id')) return Response.json([]);
    assert.equal(url.searchParams.get('id'), `in.(${applicationId})`);
    return Response.json([{ ...completeApplication, candidate_id: null }]);
  });
  const db = createClient('https://application-completeness.invalid', 'synthetic-key');
  const path = `webform_${applicationId}/57a63d6a-24d8-4fae-aea4-74168e00327c.pdf`;
  const result = await loadApplicationCompleteness(db, [{ id: candidateId, resume_url: path }]);
  assert.equal(result.get(candidateId)?.state, 'complete');
});

test('failed and missing referenced application lookups cannot become not-submitted', async context => {
  const db = createClient('https://application-completeness.invalid', 'synthetic-key');
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => Response.json({ code: '42501' }, { status: 403 }));
  const failed = await loadApplicationCompleteness(db, [{ id: candidateId, resume_url: 'private/resume.pdf' }]);
  assert.equal(failed.get(candidateId)?.state, 'unknown');
  fetchMock.mock.mockImplementation(async () => Response.json([]));
  const missing = await loadApplicationCompleteness(db, [{ id: candidateId, resume_url: `webform_${applicationId}` }]);
  assert.equal(missing.get(candidateId)?.state, 'unknown');
  const notSubmitted = await loadApplicationCompleteness(db, [{ id: candidateId, resume_url: 'private/resume.pdf' }]);
  assert.equal(notSubmitted.get(candidateId)?.state, 'not_submitted');
});

test('synthetic or malformed IDs do not trigger an unscoped applications lookup', async context => {
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => { requests += 1; return Response.json([]); });
  const db = createClient('https://application-completeness.invalid', 'synthetic-key');
  const result = await loadApplicationCompleteness(db, [{ id: 'demo_1', resume_url: 'webform_invalid' }]);
  assert.equal(requests, 0);
  assert.equal(result.size, 0);
});
