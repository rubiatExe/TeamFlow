import assert from 'node:assert/strict';
import test from 'node:test';

import {
  scoreCriterion,
  summarizeWeightedScore,
} from '../../lib/domain/scoring-policy.ts';

test('weighted scoring awards configured points only to met criteria', () => {
  const criteria = [
    { weight: 50, status: 'met' as const },
    { weight: 30, status: 'unknown' as const },
    { weight: 20, status: 'not_met' as const },
  ];

  assert.equal(scoreCriterion(criteria[0]), 50);
  assert.equal(scoreCriterion(criteria[1]), 0);
  assert.equal(scoreCriterion(criteria[2]), 0);
  assert.deepEqual(summarizeWeightedScore(criteria), {
    earnedPoints: 50,
    totalWeight: 100,
    metCriteria: 1,
    criterionCount: 3,
  });
});

test('weighted scoring reproduces the configured 70-point reviewer fixture', () => {
  const summary = summarizeWeightedScore([
    { weight: 50, status: 'met' },
    { weight: 30, status: 'unknown' },
    { weight: 20, status: 'met' },
  ]);

  assert.equal(summary.earnedPoints, 70);
  assert.equal(summary.totalWeight, 100);
  assert.equal(summary.metCriteria, 2);
});
