import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCandidateHasNoUnreviewedScore,
  CandidateReviewRequiredError,
  type CandidateRow,
} from '../../lib/db/supabase.ts';

const baseCandidate: CandidateRow = {
  merchant_id: '00000000-0000-0000-0000-000000000001',
  name: 'Synthetic Candidate',
  status: 'new',
  resume_url: 'private/synthetic.pdf',
  source: 'upload',
};

test('candidate creation rejects an unreviewed numeric score', () => {
  assert.throws(
    () => assertCandidateHasNoUnreviewedScore({ ...baseCandidate, fit_score: 91 }),
    CandidateReviewRequiredError,
  );
});

test('candidate creation rejects unreviewed model analysis', () => {
  assert.throws(
    () => assertCandidateHasNoUnreviewedScore({
      ...baseCandidate,
      analysis: { explanation: 'Model-owned decision text' },
    }),
    CandidateReviewRequiredError,
  );
});

test('candidate creation rejects unreviewed model red flags', () => {
  assert.throws(
    () => assertCandidateHasNoUnreviewedScore({
      ...baseCandidate,
      red_flags: ['Model-generated decision signal'],
    }),
    CandidateReviewRequiredError,
  );
});

test('candidate identity and document metadata can be created before review', () => {
  assert.doesNotThrow(() => assertCandidateHasNoUnreviewedScore(baseCandidate));
});
