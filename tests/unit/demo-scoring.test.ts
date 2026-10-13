import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApprovedCandidateScoreDetailsSchema } from '../../lib/contracts/candidate-score.ts';
import { SYNTHETIC_CANDIDATE_CORPUS } from '../../lib/domain/demo-semantic-search-data.ts';
import {
  DEMO_SCORING_POLICIES,
  getDemoScoreDetails,
  getDemoScoreEvidence,
} from '../../lib/domain/demo-scoring.ts';
import { createDemoCandidates, createDemoPersonas, parseDemoWorkspace, restoreDemoCandidates, serializeDemoWorkspace } from '../../lib/domain/demo-workspace.ts';
import { scoreCriterion } from '../../lib/domain/scoring-policy.ts';

test('all fictional role policies total 100 and every canonical profile receives a valid sample score', () => {
  assert.equal(Object.keys(DEMO_SCORING_POLICIES).length, 6);
  for (const policy of Object.values(DEMO_SCORING_POLICIES)) {
    assert.equal(policy.criteria.reduce((sum, criterion) => sum + criterion.weight, 0), 100);
  }
  for (const profile of SYNTHETIC_CANDIDATE_CORPUS) {
    const score = getDemoScoreDetails(profile.candidateRef);
    assert.equal(ApprovedCandidateScoreDetailsSchema.safeParse(score).success, true);
    assert.equal(score.policy_id, DEMO_SCORING_POLICIES[profile.roleId].policy_id);
    assert.equal(score.score, score.criteria.reduce((sum, criterion) => sum + scoreCriterion(criterion), 0));
  }
});

test('every earned sample point is grounded in an explicit canonical source block', () => {
  for (const profile of SYNTHETIC_CANDIDATE_CORPUS) {
    const policy = DEMO_SCORING_POLICIES[profile.roleId];
    for (const assessment of getDemoScoreEvidence(profile.candidateRef)) {
      const criterion = policy.criteria.find(item => item.criterion_id === assessment.criterion_id)!;
      const expectedBlocks = profile.sourceBlocks.filter(block => criterion.evidenceTopics.some(topic => (block.topics as readonly string[]).includes(topic)));
      assert.deepEqual(assessment.sourceBlockIds, expectedBlocks.map(block => block.sourceBlockId));
      assert.equal(assessment.status, expectedBlocks.length ? 'met' : 'unknown');
      for (const sourceBlockId of assessment.sourceBlockIds) {
        assert.ok(profile.sourceBlocks.some(block => block.sourceBlockId === sourceBlockId));
      }
    }
  }
  assert.throws(() => getDemoScoreDetails('connected-candidate'), /canonical fictional candidate/u);
});

test('barista examples show different criterion contributions without treating absent evidence as a failed skill', () => {
  const leo = getDemoScoreDetails('SYN-CAND-002');
  const noah = getDemoScoreDetails('SYN-CAND-007');
  assert.equal(leo.score, 90);
  assert.equal(noah.score, 25);
  assert.deepEqual(getDemoScoreEvidence('SYN-CAND-002').find(item => item.criterion_id === 'espresso')?.sourceBlockIds, ['SYN-RES-002-B01']);
  assert.deepEqual(getDemoScoreEvidence('SYN-CAND-007').find(item => item.criterion_id === 'guest-service')?.sourceBlockIds, ['SYN-RES-007-B01']);
  assert.equal(noah.criteria.find(item => item.criterion_id === 'espresso')?.status, 'unknown');
  assert.equal(noah.criteria.some(item => item.status === 'not_met'), false);
});

test('the board labels sample scores separately and rebuilds them from canonical evidence after restoring storage', () => {
  const candidates = createDemoCandidates();
  for (const candidate of candidates) {
    assert.equal(candidate.data.score.calculation, 'sample_policy');
    assert.equal(candidate.data.score.total, candidate.data.score.sample_policy?.score);
    assert.equal(candidate.data.score.approved_policy, undefined);
  }
  candidates[0].data.score.total = 1;
  candidates[0].data.score.sample_policy!.criteria[0].weight = 1;
  const saved = serializeDemoWorkspace(candidates, createDemoPersonas());
  assert.equal(saved.includes('sample_policy'), false);
  assert.equal(saved.includes('criteria'), false);
  const restored = restoreDemoCandidates(parseDemoWorkspace(saved));
  assert.deepEqual(restored[0].data.score.sample_policy, getDemoScoreDetails(restored[0].id));
  assert.equal(restored[0].data.score.total, 70);
});
