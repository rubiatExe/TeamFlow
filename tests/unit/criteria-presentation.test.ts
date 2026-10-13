import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerCriteriaCandidateResultSchema, ManagerCriteriaEvaluationSchema, ManagerCriteriaProposalSchema } from '../../lib/contracts/manager-criteria.ts';
import { criteriaBaseScore, evaluationMatchesApproval, isCriteriaEvaluationCurrent } from '../../lib/domain/criteria-presentation.ts';
import { createDemoCandidates } from '../../lib/domain/demo-workspace.ts';

function fixture() {
  const candidate = createDemoCandidates().find(item => item.id === 'SYN-CAND-002')!;
  const criteria = [{ criterion_id: 'latte_art', criterion_text: 'Documented latte art', weight: 100 }];
  const evaluation = ManagerCriteriaEvaluationSchema.parse({
    status: 'evaluated', proposal_id: '00000000-0000-4000-8000-000000000001', role_id: 'barista',
    mode: 'sample', criteria, additional_weight_percent: 20, approved_at: '2026-10-12T00:00:00Z', warnings: [],
    results: [{
      candidate_id: candidate.id, display_name: candidate.data.candidate.name,
      base_score: 90, additional_score: 100, updated_score: 92, additional_weight_percent: 20, provisional: false,
      criteria: [{ ...criteria[0], status: 'met', points: 100, evidence: [{ source_block_id: 'sample-source', exact_quote: 'Completed latte art assessment' }] }],
    }],
  });
  return { candidate, evaluation };
}

test('manager assessment projection requires matching current base, role, candidate and source mode', () => {
  const { candidate, evaluation } = fixture();
  assert.equal(isCriteriaEvaluationCurrent(evaluation, [candidate], true), true);
  assert.equal(isCriteriaEvaluationCurrent(evaluation, [candidate], false), false);
  assert.equal(isCriteriaEvaluationCurrent(evaluation, [], true), false);
  assert.equal(isCriteriaEvaluationCurrent(evaluation, [{ ...candidate, data: { ...candidate.data, score: { ...candidate.data.score, total: 75 } } }], true), false);
  assert.equal(isCriteriaEvaluationCurrent(evaluation, [{ ...candidate, data: { ...candidate.data, candidate: { ...candidate.data.candidate, applied_role: 'baker' } } }], true), false);
});

test('criteria response rejects inconsistent totals, blend weight, criteria and evidence coverage', () => {
  const { evaluation } = fixture();
  const result = evaluation.results[0];
  for (const patch of [{ updated_score: 100 }, { additional_score: 90 }, { provisional: true }, { base_score: null }]) {
    assert.equal(ManagerCriteriaCandidateResultSchema.safeParse({ ...result, ...patch }).success, false);
  }
  assert.equal(ManagerCriteriaEvaluationSchema.safeParse({ ...evaluation, additional_weight_percent: 30 }).success, false);
  assert.equal(ManagerCriteriaEvaluationSchema.safeParse({ ...evaluation, results: [result, result] }).success, false);
  assert.equal(ManagerCriteriaEvaluationSchema.safeParse({ ...evaluation, criteria: [{ ...evaluation.criteria[0], criterion_text: 'Different criterion' }] }).success, false);
  assert.equal(ManagerCriteriaCandidateResultSchema.safeParse({ ...result, criteria: [{ ...result.criteria[0], evidence: [] }] }).success, false);
});

test('missing base stays pending and unknown evidence is provisional rather than a negative classification', () => {
  const { evaluation } = fixture();
  const result = evaluation.results[0];
  const pending = ManagerCriteriaCandidateResultSchema.parse({ ...result, base_score: null, updated_score: null });
  assert.equal(pending.additional_score, 100);
  const unknown = ManagerCriteriaCandidateResultSchema.parse({
    ...result, additional_score: 0, updated_score: 72, provisional: true,
    criteria: [{ ...result.criteria[0], status: 'unknown', points: 0, evidence: [] }],
  });
  assert.equal(unknown.criteria[0].status, 'unknown');
});

test('approval response must match the exact proposal, role, scope, criteria and blend', () => {
  const { evaluation } = fixture();
  const proposal = ManagerCriteriaProposalSchema.parse({
    status: 'review_required', proposal_id: evaluation.proposal_id, mode: 'sample', role_id: 'barista',
    manager_request: 'Latte art', criteria: evaluation.criteria, candidate_ids: ['SYN-CAND-002'],
    approval_token: 'opaque-signed-token', expires_at: '2026-10-12T00:15:00Z', warnings: [],
  });
  assert.equal(evaluationMatchesApproval(evaluation, proposal, evaluation.criteria, 20), true);
  assert.equal(evaluationMatchesApproval(evaluation, { ...proposal, role_id: 'baker' }, evaluation.criteria, 20), false);
  assert.equal(evaluationMatchesApproval(evaluation, { ...proposal, candidate_ids: ['SYN-CAND-007'] }, evaluation.criteria, 20), false);
  assert.equal(evaluationMatchesApproval(evaluation, { ...proposal, mode: 'connected' }, evaluation.criteria, 20), false);
  assert.equal(evaluationMatchesApproval(evaluation, proposal, evaluation.criteria, 30), false);
  assert.equal(evaluationMatchesApproval(evaluation, proposal, [{ ...evaluation.criteria[0], criterion_text: 'Changed' }], 20), false);
});

test('legacy or unavailable connected scores cannot masquerade as a reviewed deterministic base', () => {
  const { candidate } = fixture();
  assert.equal(criteriaBaseScore(candidate.data, true), 90);
  assert.equal(criteriaBaseScore(candidate.data, false), null);
  assert.equal(criteriaBaseScore({ ...candidate.data, score: { ...candidate.data.score, calculation: 'legacy_preview' } }, false), null);
  const reviewed = {
    ...candidate.data,
    candidate: { ...candidate.data.candidate, applied_job_id: candidate.data.score.sample_policy!.role_id },
    score: { ...candidate.data.score, calculation: 'weighted_policy' as const, approved_policy: candidate.data.score.sample_policy },
  };
  assert.equal(criteriaBaseScore(reviewed, false), 90);
  assert.equal(criteriaBaseScore({ ...reviewed, candidate: { ...reviewed.candidate, applied_job_id: '00000000-0000-4000-8000-000000000002' } }, false), null);
});
