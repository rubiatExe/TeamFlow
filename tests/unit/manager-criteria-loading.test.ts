import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, type TestContext } from 'node:test';
import { Agent1EvaluationSchema, RoleScoringPolicySchema } from '../../lib/contracts/resume-review.ts';
import { DocumentExtractionResultSchema } from '../../lib/contracts/document-extraction.ts';
import { buildStoredResumeDocumentSnapshot } from '../../lib/contracts/resume-review-storage.ts';
import { ManagerCriteriaError } from '../../lib/domain/manager-criteria.ts';

const oldEnvironment = { NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://criteria-loading.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'synthetic-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service';
const { loadConnectedCriteriaCandidates } = await import('../../lib/db/manager-criteria.ts');
after(() => { for (const [key, value] of Object.entries(oldEnvironment)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} });

const merchantId = '00000000-0000-4000-8000-000000000001';
const candidateId = '00000000-0000-4000-8000-000000000002';
const readFixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const fixture = readFixture('resume-review-contract-v1.json');
const analysis = Agent1EvaluationSchema.parse(fixture.agent1_evaluation);
const policies = RoleScoringPolicySchema.array().parse(fixture.role_scoring_policies);
const jobs = policies.map(policy => ({ id: policy.role_id, title: policy.role_title,
  scoring_policy_id: policy.policy_identity.policy_id, scoring_policy_version: policy.policy_identity.policy_version, scoring_criteria: policy.criteria }));
const candidate = { id: candidateId, name: 'Synthetic Applicant', job_id: analysis.ranked_roles[0].role_id,
  fit_score: analysis.ranked_roles[0].deterministic_score, analysis };
const document = buildStoredResumeDocumentSnapshot(merchantId, DocumentExtractionResultSchema.parse(readFixture('document-extraction-v1.json')));

function mockDatabase(context: TestContext, overrides: Record<string, unknown> = {}) {
  const requests: URL[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    assert.equal(url.origin, 'https://criteria-loading.invalid');
    assert.equal(url.searchParams.get('merchant_id'), `eq.${merchantId}`);
    assert.ok(!options?.method || options.method === 'GET', 'criteria cannot write database records');
    const table = url.pathname.split('/').at(-1)!;
    if (table === 'candidates') assert.equal(url.searchParams.get('id'), `in.(${candidateId})`);
    if (table === 'candidate_resume_documents') {
      assert.equal(url.searchParams.get('candidate_id'), `eq.${candidateId}`);
      assert.equal(url.searchParams.get('limit'), '2');
    }
    const defaults: Record<string, unknown> = { candidates: [candidate], jobs,
      candidate_resume_documents: [{ document_id: document.document_id }], resume_documents: [document] };
    return Response.json(table in overrides ? overrides[table] : defaults[table]);
  });
  return requests;
}

test('connected loader preserves a validated multi-role approved base and scopes every read by tenant', async context => {
  assert.ok(analysis.ranked_roles.length > 1, 'fixture must prove multi-role projection');
  const requests = mockDatabase(context);
  const [loaded] = await loadConnectedCriteriaCandidates(merchantId, candidate.job_id, [candidateId]);
  assert.equal(loaded.base_score, candidate.fit_score);
  assert.equal(loaded.document_id, document.document_id);
  assert.equal(loaded.snapshot_sha256, document.snapshot_sha256);
  assert.deepEqual(loaded.source_blocks.map(block => block.text), document.source_blocks.map(block => block.text));
  const jobQuery = requests.find(url => url.pathname.endsWith('/jobs'))!;
  for (const role of analysis.ranked_roles) assert.ok(jobQuery.searchParams.get('id')?.includes(role.role_id));
});

test('connected loader never derives an approved base from an unreviewed fit_score', async context => {
  mockDatabase(context, { candidates: [{ ...candidate, analysis: null, fit_score: 100 }] });
  const [loaded] = await loadConnectedCriteriaCandidates(merchantId, candidate.job_id, [candidateId]);
  assert.equal(loaded.base_score, null);
});

test('connected loader accepts Cloud Vision snapshots while rejecting forged provenance', async context => {
  const vision = buildStoredResumeDocumentSnapshot(merchantId, DocumentExtractionResultSchema.parse({
    ...readFixture('document-extraction-v1.json'),
    extraction_method: 'google_cloud_vision',
    model_id: 'google-cloud-vision-v1-document-text-detection',
  }));
  mockDatabase(context, { resume_documents: [vision] });
  const [loaded] = await loadConnectedCriteriaCandidates(merchantId, candidate.job_id, [candidateId]);
  assert.equal(loaded.snapshot_sha256, vision.snapshot_sha256);
  assert.equal(loaded.base_score, candidate.fit_score);
  context.mock.restoreAll();
  mockDatabase(context, { resume_documents: [{ ...document, extraction_method: 'google_cloud_vision' }] });
  await assert.rejects(loadConnectedCriteriaCandidates(merchantId, candidate.job_id, [candidateId]), ManagerCriteriaError);
});

test('connected loader never blends a top-ranked score from another assigned job', async context => {
  const otherRoleId = analysis.ranked_roles.find(role => role.role_id !== candidate.job_id)!.role_id;
  mockDatabase(context, { candidates: [{ ...candidate, job_id: otherRoleId }] });
  const [loaded] = await loadConnectedCriteriaCandidates(merchantId, otherRoleId, [candidateId]);
  assert.equal(loaded.base_score, null);
  assert.equal(loaded.role_id, otherRoleId);
});

test('connected loader refuses missing, ambiguous, or tampered canonical documents', async context => {
  for (const overrides of [
    { candidate_resume_documents: [] },
    { candidate_resume_documents: [{ document_id: document.document_id }, { document_id: `doc-${'b'.repeat(64)}` }] },
    { resume_documents: [{ ...document, text: 'Changed canonical text' }] },
    { resume_documents: [] },
  ]) {
    mockDatabase(context, overrides);
    await assert.rejects(loadConnectedCriteriaCandidates(merchantId, candidate.job_id, [candidateId]), ManagerCriteriaError);
    context.mock.restoreAll();
  }
});

test('connected loader rejects wrong role and invalid candidate scope', async context => {
  const requests = mockDatabase(context);
  await assert.rejects(loadConnectedCriteriaCandidates(merchantId, 'wrong_role', [candidateId]), ManagerCriteriaError);
  const before = requests.length;
  await assert.rejects(loadConnectedCriteriaCandidates(merchantId, candidate.job_id, ['SYN-CAND-002']), ManagerCriteriaError);
  assert.equal(requests.length, before);
});
