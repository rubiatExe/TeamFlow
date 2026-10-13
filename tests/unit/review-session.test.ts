import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ResumeReviewRunDetailResponseSchema } from '../../lib/contracts/resume-review-hitl.ts';
import { createReviewRequestScope, reviewDecisionMessage } from '../../lib/domain/review-session.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/resume-review-reviewer-v2.json', import.meta.url), 'utf8'));
const detail = ResumeReviewRunDetailResponseSchema.parse(fixture.detail_response);
const response = {
  schema_version: detail.schema_version, run_id: detail.run_id, request_id: detail.request_id,
  document_id: detail.document_id, status: detail.status, run_version: detail.run_version,
  review: detail.review, reason_codes: detail.reason_codes,
};

test('disconnect invalidates every old reviewer response before a new session starts', async () => {
  const scope = createReviewRequestScope();
  const oldQueue = scope.begin('queue');
  const oldDetail = scope.begin('detail');
  const oldDecision = scope.begin('decision');
  let release: (() => void) | undefined;
  let visible = 'new reviewer';
  const pending = new Promise<void>(resolve => { release = resolve; }).then(() => {
    // A response may already be buffered when cancellation happens.
    if (oldQueue.isCurrent()) visible = 'old reviewer';
  });
  scope.reset();
  const newQueue = scope.begin('queue');
  release!();
  await pending;
  assert.equal(visible, 'new reviewer');
  assert.ok([oldQueue, oldDetail, oldDecision].every(request => request.signal.aborted && !request.isCurrent()));
  assert.equal(newQueue.isCurrent(), true);
});

test('opening another review suppresses a late response from the previous selection', () => {
  const scope = createReviewRequestScope();
  const queue = scope.begin('queue');
  const first = scope.begin('detail');
  const second = scope.begin('detail');
  assert.equal(first.isCurrent(), false);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.isCurrent(), true);
  assert.equal(queue.isCurrent(), true);
});

test('only a matching finalized decision is reported as final success', () => {
  assert.equal(reviewDecisionMessage({ ...response, status: 'completed' }, detail, 'approve').type, 'success');
  assert.equal(reviewDecisionMessage({ ...response, status: 'rejected' }, detail, 'reject').type, 'success');
  for (const status of ['decision_recorded', 'applying']) {
    const result = reviewDecisionMessage({ ...response, status }, detail, 'approve');
    assert.equal(result.type, 'warning');
    assert.match(result.message, /still being applied/u);
  }
  for (const status of ['failed', 'stale', 'pending_review', 'rejected']) {
    assert.equal(reviewDecisionMessage({ ...response, status }, detail, 'approve').type, 'error');
  }
  assert.equal(reviewDecisionMessage({ ...response, status: 'completed' }, detail, 'reject').type, 'error');
});

test('malformed or mismatched decision payloads never announce success', () => {
  for (const payload of [
    null,
    { success: true },
    { ...response, status: 'completed', run_id: '00000000-0000-4000-8000-000000000099' },
    { ...response, status: 'completed', review: { ...response.review, review_id: '00000000-0000-4000-8000-000000000099' } },
    { ...response, status: 'completed', document_id: `doc-${'f'.repeat(64)}` },
  ]) assert.equal(reviewDecisionMessage(payload, detail, 'approve').type, 'error');
});
