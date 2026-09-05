import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PendingResumeReviewQueueResponseSchema,
  ResumeReviewDecisionRequestSchema,
  ResumeReviewHitlContractFixtureSchema,
  ResumeReviewRunDetailResponseSchema,
  ResumeReviewRunResponseSchema,
  ResumeReviewRunStatusSchema,
  StartResumeReviewRunRequestSchema,
} from '../../lib/contracts/resume-review-hitl.ts';

const payload: unknown = JSON.parse(readFileSync(
  new URL('../fixtures/resume-review-hitl-v2.json', import.meta.url),
  'utf8',
));
const reviewerPayload: unknown = JSON.parse(readFileSync(
  new URL('../fixtures/resume-review-reviewer-v2.json', import.meta.url),
  'utf8',
));

function fixture() {
  return ResumeReviewHitlContractFixtureSchema.parse(payload);
}

test('shares the strict additive v2 fixture with Python', () => {
  assert.deepEqual(ResumeReviewHitlContractFixtureSchema.parse(payload), payload);
  assert.deepEqual(
    fixture().decisions.map(decision => decision.action),
    ['approve', 'approve_with_edits', 'reject'],
  );
});

test('validates the bounded reviewer detail and queue projections', () => {
  if (reviewerPayload === null || typeof reviewerPayload !== 'object') {
    throw new Error('reviewer fixture must be an object');
  }
  const fixture = reviewerPayload as Record<string, unknown>;
  const detail = ResumeReviewRunDetailResponseSchema.parse(fixture.detail_response);
  const queue = PendingResumeReviewQueueResponseSchema.parse(fixture.queue_response);

  assert.equal(detail.proposal.roles.length, 2);
  assert.equal(detail.proposal.criterion_details.length, 3);
  assert.equal(detail.proposal.confidence.policy_sha256, 'c'.repeat(64));
  assert.equal(detail.proposal.confidence.is_probability, false);
  assert.equal(detail.proposal.confidence.threshold_applied, false);
  assert.equal(queue.items[0]?.top_role.role_title, 'Shift Lead');
  assert.deepEqual(
    detail.proposal.criterion_details[0]?.evidence_snippets[0],
    detail.proposal.editable_agent1_output.role_assessments[0]
      ?.criterion_assessments[0]?.evidence[0],
  );
});

test('reviewer confidence remains diagnostic, shadow-only, and provenance-bound', () => {
  const fixture = reviewerPayload as Record<string, unknown>;
  const detail = ResumeReviewRunDetailResponseSchema.parse(fixture.detail_response);
  const confidence = detail.proposal.confidence;
  for (const invalidConfidence of [
    { ...confidence, is_probability: true },
    { ...confidence, threshold_applied: true },
    { ...confidence, policy_sha256: 'C'.repeat(64) },
    { ...confidence, status: 'review_required', review_required: false },
    { ...confidence, components: [...confidence.components, confidence.components[0]] },
  ]) {
    assert.equal(ResumeReviewRunDetailResponseSchema.safeParse({
      ...detail,
      proposal: { ...detail.proposal, confidence: invalidConfidence },
    }).success, false);
  }
});

test('reviewer projections reject raw document and private authority fields', () => {
  const fixture = reviewerPayload as Record<string, unknown>;
  const detail = ResumeReviewRunDetailResponseSchema.parse(fixture.detail_response);
  const queue = PendingResumeReviewQueueResponseSchema.parse(fixture.queue_response);
  const forbidden = {
    merchant_id: '69999999-9999-4999-8999-999999999999',
    thread_id: 'private-thread',
    checkpoint_id: 'private-checkpoint',
    extraction_snapshot_sha256: 'a'.repeat(64),
    policy_sha256: 'b'.repeat(64),
    document_snapshot: { text: 'raw resume' },
    source_blocks: [{ text: 'raw resume' }],
    embedding: [0.1],
  };
  for (const [field, value] of Object.entries(forbidden)) {
    assert.equal(ResumeReviewRunDetailResponseSchema.safeParse({
      ...detail,
      [field]: value,
    }).success, false, `${field} must not cross the detail boundary`);
    assert.equal(PendingResumeReviewQueueResponseSchema.safeParse({
      ...queue,
      [field]: value,
    }).success, false, `${field} must not cross the queue boundary`);
  }
});

test('detail-provided editable output forms a valid approve-with-edits request', () => {
  const fixture = reviewerPayload as Record<string, unknown>;
  const detail = ResumeReviewRunDetailResponseSchema.parse(fixture.detail_response);
  if (detail.review === null) throw new Error('fixture must include a review');
  const decision = ResumeReviewDecisionRequestSchema.parse({
    schema_version: '2.0',
    decision_id: '67777777-7777-4777-8777-777777777777',
    review_id: detail.review.review_id,
    expected_review_version: detail.review.review_version,
    action: 'approve_with_edits',
    replacement_agent1_output: detail.proposal.editable_agent1_output,
    reason_code: 'reviewer-confirmed-evidence',
  });
  assert.equal(decision.action, 'approve_with_edits');
  if (decision.action !== 'approve_with_edits') throw new Error('decision mismatch');
  assert.deepEqual(
    decision.replacement_agent1_output,
    detail.proposal.editable_agent1_output,
  );
});

test('start request requires only caller-safe identifiers and rejects authority', () => {
  const start = fixture().start_request;
  const injections = {
    merchant_id: '69999999-9999-4999-8999-999999999999',
    actor_id: '69999999-9999-4999-8999-999999999999',
    reviewer_id: '69999999-9999-4999-8999-999999999999',
    thread_id: 'caller-controlled-thread',
    checkpoint_id: 'private-checkpoint',
    score: 100,
    recommended_role_id: '69999999-9999-4999-8999-999999999999',
    tool_calls: ['update_fit_score'],
    resume_markdown: '# private resume',
    embedding: [0.1],
    persist: true,
  };
  for (const [field, value] of Object.entries(injections)) {
    assert.equal(StartResumeReviewRunRequestSchema.safeParse({
      ...start,
      [field]: value,
    }).success, false, `${field} must be server-owned or excluded`);
  }

  for (const required of [
    'schema_version',
    'request_id',
    'document_id',
    'candidate_id',
  ] as const) {
    const missing = { ...start } as Record<string, unknown>;
    delete missing[required];
    assert.equal(StartResumeReviewRunRequestSchema.safeParse(missing).success, false);
  }
  assert.equal(StartResumeReviewRunRequestSchema.safeParse({
    ...start,
    schema_version: '1.0',
  }).success, false);
});

test('run projection accepts every v2 status and enforces review lifecycle', () => {
  const [running, pending] = fixture().run_responses;
  for (const status of ResumeReviewRunStatusSchema.options) {
    const base = status === 'running' || status === 'failed' ? running : pending;
    assert.equal(ResumeReviewRunResponseSchema.safeParse({
      ...base,
      status,
    }).success, true, `${status} must have a representable safe projection`);
  }

  assert.equal(ResumeReviewRunResponseSchema.safeParse({
    ...pending,
    review: null,
  }).success, false);
  assert.equal(ResumeReviewRunResponseSchema.safeParse({
    ...running,
    review: pending.review,
  }).success, false);
  assert.equal(ResumeReviewRunResponseSchema.safeParse({
    ...pending,
    reason_codes: ['human-review', 'human-review'],
  }).success, false);

  const privateInjections = {
    merchant_id: '69999999-9999-4999-8999-999999999999',
    actor_id: '69999999-9999-4999-8999-999999999999',
    thread_id: 'private-thread',
    checkpoint: { state: 'private' },
    checkpoint_state: { resume_text: 'private' },
    resume_text: 'private resume',
    contact_email: 'private@example.test',
  };
  for (const [field, value] of Object.entries(privateInjections)) {
    assert.equal(ResumeReviewRunResponseSchema.safeParse({
      ...pending,
      [field]: value,
    }).success, false, `${field} must not cross the safe projection`);
  }
});

test('decision union requires exact action-specific fields', () => {
  const [approve, edited, reject] = fixture().decisions;
  assert.equal(ResumeReviewDecisionRequestSchema.parse(approve).action, 'approve');
  assert.equal(
    ResumeReviewDecisionRequestSchema.parse(edited).action,
    'approve_with_edits',
  );
  assert.equal(ResumeReviewDecisionRequestSchema.parse(reject).action, 'reject');

  assert.equal(ResumeReviewDecisionRequestSchema.safeParse({
    ...approve,
    reason_code: 'unrequested-reason',
  }).success, false);
  assert.equal(ResumeReviewDecisionRequestSchema.safeParse({
    ...edited,
    replacement_agent1_output: null,
  }).success, false);
  const editedWithoutReason = { ...edited } as Record<string, unknown>;
  delete editedWithoutReason.reason_code;
  assert.equal(
    ResumeReviewDecisionRequestSchema.safeParse(editedWithoutReason).success,
    false,
  );
  const rejectWithoutReason = { ...reject } as Record<string, unknown>;
  delete rejectWithoutReason.reason_code;
  assert.equal(
    ResumeReviewDecisionRequestSchema.safeParse(rejectWithoutReason).success,
    false,
  );
  assert.equal(ResumeReviewDecisionRequestSchema.safeParse({
    ...approve,
    action: 'edit',
  }).success, false);
});

test('decisions reject scores, recommendations, tools and authority', () => {
  const [approve, edited] = fixture().decisions;
  const injections = {
    merchant_id: '69999999-9999-4999-8999-999999999999',
    actor_id: '69999999-9999-4999-8999-999999999999',
    reviewer_id: '69999999-9999-4999-8999-999999999999',
    thread_id: 'caller-controlled-thread',
    checkpoint_id: 'private-checkpoint',
    score: 100,
    recommended_role_id: '69999999-9999-4999-8999-999999999999',
    tool_calls: ['update_fit_score'],
  };
  for (const [field, value] of Object.entries(injections)) {
    assert.equal(ResumeReviewDecisionRequestSchema.safeParse({
      ...approve,
      [field]: value,
    }).success, false, `${field} must not be decision-controlled`);
  }

  if (edited.action !== 'approve_with_edits') {
    throw new Error('fixture action mismatch');
  }
  for (const [field, value] of Object.entries({
    score: 100,
    deterministic_score: 100,
    recommended_role_id: '69999999-9999-4999-8999-999999999999',
    tool_calls: ['update_fit_score'],
  })) {
    assert.equal(ResumeReviewDecisionRequestSchema.safeParse({
      ...edited,
      replacement_agent1_output: {
        ...edited.replacement_agent1_output,
        [field]: value,
      },
    }).success, false, `${field} must not be editable`);
  }

  assert.equal(ResumeReviewDecisionRequestSchema.safeParse({
    ...approve,
    expected_review_version: 0,
  }).success, false);
  assert.equal(ResumeReviewDecisionRequestSchema.safeParse({
    ...approve,
    decision_id: 'not-a-uuid',
  }).success, false);
});

test('edit and reject reason codes are bounded identifiers', () => {
  const edited = fixture().decisions[1];
  for (const reasonCode of ['ab', 'contains spaces', 'a'.repeat(121)]) {
    assert.equal(ResumeReviewDecisionRequestSchema.safeParse({
      ...edited,
      reason_code: reasonCode,
    }).success, false);
  }
});
