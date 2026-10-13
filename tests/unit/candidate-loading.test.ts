import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, type TestContext } from 'node:test';

import {
  Agent1EvaluationSchema,
  RoleScoringPolicySchema,
} from '../../lib/contracts/resume-review.ts';

const originalEnvironment = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://candidate-loading.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'synthetic-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-key';

const { CandidateLoadError, loadCandidatesFromSupabase } = await import('../../lib/db/supabase.ts');

after(() => {
  for (const [key, value] of [
    ['NEXT_PUBLIC_SUPABASE_URL', originalEnvironment.url],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', originalEnvironment.anonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', originalEnvironment.serviceKey],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/resume-review-contract-v1.json', import.meta.url),
  'utf8',
)) as { role_scoring_policies: unknown; agent1_evaluation: unknown };
const policies = RoleScoringPolicySchema.array().parse(fixture.role_scoring_policies);
const evaluation = Agent1EvaluationSchema.parse(fixture.agent1_evaluation);
const merchantId = '00000000-0000-4000-8000-000000000001';
const topRole = evaluation.ranked_roles[0];
const jobRows = policies.map(policy => ({
  id: policy.role_id,
  title: policy.role_title,
  scoring_policy_id: policy.policy_identity.policy_id,
  scoring_policy_version: policy.policy_identity.policy_version,
  scoring_criteria: policy.criteria,
}));
const candidate = {
  id: '33333333-3333-4333-8333-333333333333',
  merchant_id: merchantId,
  job_id: topRole.role_id,
  name: 'Synthetic Reviewed Applicant',
  status: 'new',
  resume_url: 'private/synthetic.pdf',
  source: 'upload',
  fit_score: topRole.deterministic_score,
  analysis: evaluation,
};

function mockDatabase(
  context: TestContext,
  respond: (url: URL) => Response,
): URL[] {
  const requests: URL[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://candidate-loading.invalid');
    if (url.pathname === '/rest/v1/applications') {
      assert.equal(url.searchParams.get('candidate_id'), `in.(${candidate.id})`);
      requests.push(url);
      return Response.json([]);
    }
    assert.equal(url.searchParams.get('merchant_id'), `eq.${merchantId}`);
    requests.push(url);
    return respond(url);
  });
  return requests;
}

test('candidate database failure is distinguishable from an empty applicant list', async context => {
  const requests = mockDatabase(context, () => Response.json({
    code: '42501',
    message: 'Synthetic permission failure',
  }, { status: 403 }));

  await assert.rejects(loadCandidatesFromSupabase(merchantId), CandidateLoadError);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/rest/v1/candidates');
});

test('approved scores join the same merchant role policy and preserve its criterion calculation', async context => {
  const requests = mockDatabase(context, url => {
    if (url.pathname === '/rest/v1/candidates') return Response.json([candidate]);
    assert.equal(url.pathname, '/rest/v1/jobs');
    const queriedRoleIds = url.searchParams.get('id');
    for (const policy of policies) assert.ok(queriedRoleIds?.includes(policy.role_id));
    return Response.json(jobRows);
  });

  const [loaded] = await loadCandidatesFromSupabase(merchantId);
  const expectedPolicy = policies.find(policy => policy.role_id === topRole.role_id)!;
  assert.equal(loaded.job_title, expectedPolicy.role_title);
  assert.deepEqual(loaded.approved_score, {
    role_id: expectedPolicy.role_id,
    role_title: expectedPolicy.role_title,
    policy_id: expectedPolicy.policy_identity.policy_id,
    policy_version: expectedPolicy.policy_identity.policy_version,
    score: 70,
    criteria: [
      { criterion_id: 'team-leadership', criterion_text: 'Team leadership experience', weight: 50, status: 'met' },
      { criterion_id: 'inventory-ordering', criterion_text: 'Inventory ordering experience', weight: 30, status: 'unknown' },
      { criterion_id: 'staff-scheduling', criterion_text: 'Staff scheduling experience', weight: 20, status: 'met' },
    ],
  });
  assert.equal(loaded.application?.state, 'not_submitted');
  assert.equal(requests.length, 3);
});

test('a changed role policy cannot be presented as the approved score breakdown', async context => {
  mockDatabase(context, url => {
    if (url.pathname === '/rest/v1/candidates') return Response.json([candidate]);
    assert.equal(url.pathname, '/rest/v1/jobs');
    return Response.json(jobRows.map(job => ({
      ...job,
      scoring_policy_version: job.id === topRole.role_id ? '2.0.0' : job.scoring_policy_version,
    })));
  });

  const [loaded] = await loadCandidatesFromSupabase(merchantId);
  assert.equal(loaded.fit_score, 70);
  assert.equal(loaded.job_title, 'Shift Lead');
  assert.equal(loaded.approved_score, undefined);
});

test('unscored applicants still resolve the title associated with their job id', async context => {
  const unscoredCandidate = { ...candidate, fit_score: null, analysis: null };
  const requests = mockDatabase(context, url => {
    if (url.pathname === '/rest/v1/candidates') return Response.json([unscoredCandidate]);
    assert.equal(url.pathname, '/rest/v1/jobs');
    assert.equal(url.searchParams.get('id'), `in.(${candidate.job_id})`);
    return Response.json([{
      id: candidate.job_id,
      title: 'Shift Lead',
      scoring_policy_id: null,
      scoring_policy_version: null,
      scoring_criteria: null,
    }]);
  });

  const [loaded] = await loadCandidatesFromSupabase(merchantId);
  assert.equal(loaded.job_title, 'Shift Lead');
  assert.equal(loaded.fit_score, null);
  assert.equal(loaded.approved_score, undefined);
  assert.equal(requests.length, 3);
});
