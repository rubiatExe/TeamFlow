import assert from 'node:assert/strict';
import test from 'node:test';

import type { CandidateRow } from '../../lib/db/supabase.ts';
import { compareCandidateScores, hasCandidateScore, rowToCandidate } from '../../lib/domain/candidate-presentation.ts';

const baseRow: CandidateRow = {
  id: 'candidate-test',
  merchant_id: 'merchant-test',
  name: 'Unreviewed Applicant',
  status: 'pending',
  resume_url: '',
  source: 'upload',
};

test('missing database scores remain unscored while a reviewed zero remains a score', () => {
  for (const fit_score of [null, undefined]) {
    const candidate = rowToCandidate({ ...baseRow, fit_score });
    assert.equal(candidate.data.score.total, null);
    assert.equal(candidate.data.score.calculation, 'awaiting_review');
    assert.equal(hasCandidateScore(candidate), false);
  }
  const zero = rowToCandidate({ ...baseRow, fit_score: 0 });
  assert.equal(zero.data.score.total, 0);
  assert.equal(zero.data.score.calculation, 'unavailable');
  assert.equal(hasCandidateScore(zero), true);
});

test('database job title maps the applied role without borrowing the score recommendation', () => {
  const supervisor = rowToCandidate({
    ...baseRow,
    job_id: '11111111-1111-4111-8111-111111111111',
    job_title: 'Shift Supervisor',
    analysis: { applied_role: 'barista' },
  });
  assert.equal(supervisor.data.candidate.applied_role, 'shift_lead');
  assert.equal(supervisor.data.candidate.applied_role_title, 'Shift Supervisor');

  const custom = rowToCandidate({ ...baseRow, job_id: 'custom-job', job_title: 'Pastry Chef' });
  assert.equal(custom.data.candidate.applied_role, 'custom-job');
  assert.equal(custom.data.candidate.applied_role_title, 'Pastry Chef');
  const unassigned = rowToCandidate(baseRow);
  assert.equal(unassigned.data.candidate.applied_role, 'unassigned');
  assert.equal(unassigned.data.candidate.applied_role_title, 'Role not assigned');
});

test('score ranking and averages exclude unreviewed applicants without excluding approved zero', () => {
  const candidates = [
    rowToCandidate({ ...baseRow, name: 'A awaiting', fit_score: null }),
    rowToCandidate({ ...baseRow, name: 'B zero', fit_score: 0 }),
    rowToCandidate({ ...baseRow, name: 'C scored', fit_score: 80 }),
  ];
  assert.deepEqual([...candidates].sort(compareCandidateScores).map(candidate => candidate.data.candidate.name), ['C scored', 'B zero', 'A awaiting']);
  const scored = candidates.filter(hasCandidateScore);
  assert.equal(scored.length, 2);
  assert.equal(scored.reduce((total, candidate) => total + candidate.data.score.total, 0) / scored.length, 40);
});
