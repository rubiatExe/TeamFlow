import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApprovedCandidateScoreDetails } from '../../lib/contracts/candidate-score.ts';

const roleId = '11111111-1111-4111-8111-111111111111';
const policies = [{
  schema_version: '1.0',
  role_id: roleId,
  role_title: 'Barista',
  policy_identity: {
    policy_id: 'barista-score-policy',
    policy_version: '1.0.0',
  },
  criteria: [
    { criterion_id: 'cafe-experience', criterion_text: 'Cafe experience', weight: 70 },
    { criterion_id: 'espresso-equipment', criterion_text: 'Espresso equipment', weight: 30 },
  ],
}];
const evaluation = {
  schema_version: '1.0',
  ranked_roles: [{
    role_id: roleId,
    deterministic_score: 70,
    scoring_policy: policies[0].policy_identity,
    criterion_assessments: [
      {
        criterion_id: 'cafe-experience',
        status: 'met',
        evidence: [{
          criterion_id: 'cafe-experience',
          exact_quote: 'Served cafe guests for three years.',
          source_block_id: 'resume-block-001',
        }],
      },
      {
        criterion_id: 'espresso-equipment',
        status: 'unknown',
        evidence: [],
      },
    ],
    gaps: [{
      role_id: roleId,
      criterion_id: 'espresso-equipment',
      criterion_text: 'Espresso equipment',
      status: 'unknown',
      reason_code: 'criterion_unknown',
    }],
  }],
  recommended_role_id: roleId,
  limitations: [],
};

test('projects an approved score with its exact policy and criterion math', () => {
  assert.deepEqual(buildApprovedCandidateScoreDetails(evaluation, policies, 70), {
    role_id: roleId,
    role_title: 'Barista',
    policy_id: 'barista-score-policy',
    policy_version: '1.0.0',
    score: 70,
    criteria: [
      {
        criterion_id: 'cafe-experience',
        criterion_text: 'Cafe experience',
        weight: 70,
        status: 'met',
      },
      {
        criterion_id: 'espresso-equipment',
        criterion_text: 'Espresso equipment',
        weight: 30,
        status: 'unknown',
      },
    ],
  });
});

test('refuses to display score details when totals or policy identity disagree', () => {
  assert.equal(buildApprovedCandidateScoreDetails(evaluation, policies, 69), null);
  assert.equal(buildApprovedCandidateScoreDetails(evaluation, [{
    ...policies[0],
    policy_identity: { ...policies[0].policy_identity, policy_version: '2.0.0' },
  }], 70), null);
});
