import { z } from 'zod';

import {
  Agent1ModelOutputSchema,
  Agent2QuestionPlanSchema,
  BoundedTextSchema,
  ConfidenceComponentSchema,
  CriterionStatusSchema,
  GapStatusSchema,
  PolicyIdentitySchema,
} from './resume-review.ts';

const databaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const documentIdPattern = /^doc-[0-9a-f]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

const DatabaseIdSchema = z.string().regex(databaseIdPattern, 'Invalid lowercase UUID');
const DocumentIdSchema = z.string().regex(documentIdPattern, 'Invalid document ID');
const IdentifierSchema = z.string().min(3).max(120).regex(identifierPattern);
const VersionSchema = z.number().int().min(1).max(2_147_483_647);

export const ResumeReviewRunStatusSchema = z.enum([
  'running',
  'pending_review',
  'decision_recorded',
  'applying',
  'completed',
  'rejected',
  'stale',
  'failed',
]);

export const StartResumeReviewRunRequestSchema = z.object({
  schema_version: z.literal('2.0'),
  request_id: DatabaseIdSchema,
  document_id: DocumentIdSchema,
  candidate_id: DatabaseIdSchema,
}).strict();

export const HumanReviewReferenceSchema = z.object({
  review_id: DatabaseIdSchema,
  review_version: VersionSchema,
}).strict();

const reviewCreatedStatuses = new Set([
  'pending_review',
  'decision_recorded',
  'applying',
  'completed',
  'rejected',
  'stale',
]);

export const ResumeReviewRunResponseSchema = z.object({
  schema_version: z.literal('2.0'),
  run_id: DatabaseIdSchema,
  request_id: DatabaseIdSchema,
  document_id: DocumentIdSchema,
  status: ResumeReviewRunStatusSchema,
  run_version: VersionSchema,
  review: HumanReviewReferenceSchema.nullable(),
  reason_codes: z.array(IdentifierSchema).max(20),
}).strict().superRefine((response, context) => {
  if (reviewCreatedStatuses.has(response.status) && response.review === null) {
    context.addIssue({
      code: 'custom',
      path: ['review'],
      message: 'post-review run status requires a review reference',
    });
  }
  if (response.status === 'running' && response.review !== null) {
    context.addIssue({
      code: 'custom',
      path: ['review'],
      message: 'running status cannot expose a review before it is created',
    });
  }
  if (new Set(response.reason_codes).size !== response.reason_codes.length) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'reason_codes must be unique',
    });
  }
});

export const PendingReviewCursorSchema = z
  .string()
  .min(20)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid pending-review cursor');

export const ReviewerEvidenceSnippetSchema = z.object({
  criterion_id: IdentifierSchema,
  exact_quote: z.string().min(8).max(2_000),
  source_block_id: IdentifierSchema,
}).strict();

export const ReviewerCriterionDetailSchema = z.object({
  role_id: DatabaseIdSchema,
  criterion_id: IdentifierSchema,
  criterion_text: BoundedTextSchema,
  weight: z.number().int().min(0).max(100),
  status: CriterionStatusSchema,
  gap_status: GapStatusSchema.nullable(),
  evidence_snippets: z.array(ReviewerEvidenceSnippetSchema).max(3),
}).strict().superRefine((criterion, context) => {
  const expectedGap = criterion.status === 'met' ? null : criterion.status;
  if (criterion.gap_status !== expectedGap) {
    context.addIssue({
      code: 'custom',
      path: ['gap_status'],
      message: 'gap_status must be derived from criterion status',
    });
  }
  if (
    (criterion.status === 'met' || criterion.status === 'not_met') &&
    criterion.evidence_snippets.length === 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['evidence_snippets'],
      message: 'classified criteria require evidence snippets',
    });
  }
  if (criterion.status === 'unknown' && criterion.evidence_snippets.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['evidence_snippets'],
      message: 'unknown criteria cannot expose evidence snippets',
    });
  }
  criterion.evidence_snippets.forEach((evidence, index) => {
    if (evidence.criterion_id !== criterion.criterion_id) {
      context.addIssue({
        code: 'custom',
        path: ['evidence_snippets', index, 'criterion_id'],
        message: 'evidence criterion IDs must match the criterion detail',
      });
    }
  });
});

export const ReviewerRoleSummarySchema = z.object({
  role_id: DatabaseIdSchema,
  role_title: BoundedTextSchema,
  scoring_policy: PolicyIdentitySchema,
  deterministic_score: z.number().int().min(0).max(100),
  recommended: z.boolean(),
}).strict();

export const ReviewerConfidenceSummarySchema = z.object({
  schema_version: z.literal('1.0'),
  mode: z.literal('shadow'),
  score: z.number().int().min(0).max(100),
  is_probability: z.literal(false),
  hard_failure: z.boolean(),
  threshold_applied: z.literal(false),
  review_required: z.boolean(),
  status: z.enum(['complete', 'degraded', 'review_required']),
  components: z.array(ConfidenceComponentSchema).min(1).max(20),
  reason_codes: z.array(IdentifierSchema).max(20),
  policy_identity: PolicyIdentitySchema,
  policy_sha256: z.string().regex(sha256Pattern, 'Invalid SHA-256 digest'),
}).strict().superRefine((confidence, context) => {
  const componentIds = confidence.components.map(component => component.component_id);
  if (new Set(componentIds).size !== componentIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['components'],
      message: 'confidence component IDs must be unique',
    });
  }
  if (new Set(confidence.reason_codes).size !== confidence.reason_codes.length) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'confidence reason codes must be unique',
    });
  }
  if (confidence.review_required !== (confidence.status === 'review_required')) {
    context.addIssue({
      code: 'custom',
      path: ['review_required'],
      message: 'confidence status and review_required must agree',
    });
  }
  if (
    confidence.hard_failure &&
    (!confidence.review_required || confidence.reason_codes.length === 0)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['hard_failure'],
      message: 'confidence hard failures must have reasons and require review',
    });
  }
});

export const ResumeReviewProposalSchema = z.object({
  schema_version: z.literal('2.0'),
  candidate_id: DatabaseIdSchema,
  created_at: z.iso.datetime({ offset: true }),
  top_role_id: DatabaseIdSchema,
  recommended_role_id: DatabaseIdSchema.nullable(),
  roles: z.array(ReviewerRoleSummarySchema).min(1).max(5),
  criterion_details: z.array(ReviewerCriterionDetailSchema).min(1).max(30),
  limitations: z.array(BoundedTextSchema).max(20),
  question_plan: Agent2QuestionPlanSchema.nullable(),
  confidence: ReviewerConfidenceSummarySchema,
  editable_agent1_output: Agent1ModelOutputSchema,
}).strict().superRefine((proposal, context) => {
  const roleIds = proposal.roles.map(role => role.role_id);
  if (new Set(roleIds).size !== roleIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['roles'],
      message: 'reviewer role summaries must be unique',
    });
  }
  proposal.roles.forEach((role, index) => {
    if (index === 0) return;
    const previous = proposal.roles[index - 1];
    if (
      previous.deterministic_score < role.deterministic_score ||
      (previous.deterministic_score === role.deterministic_score &&
        previous.role_id > role.role_id)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['roles', index],
        message: 'reviewer role summaries must retain deterministic ranking',
      });
    }
  });
  if (proposal.top_role_id !== proposal.roles[0]?.role_id) {
    context.addIssue({
      code: 'custom',
      path: ['top_role_id'],
      message: 'top_role_id must identify the first ranked role',
    });
  }
  const topScore = proposal.roles[0]?.deterministic_score;
  const tied = proposal.roles.length > 1 &&
    proposal.roles[1].deterministic_score === topScore;
  const expectedRecommendation = topScore === 0 || tied
    ? null
    : proposal.roles[0]?.role_id;
  if (proposal.recommended_role_id !== expectedRecommendation) {
    context.addIssue({
      code: 'custom',
      path: ['recommended_role_id'],
      message: 'reviewer recommendation must match deterministic ranking',
    });
  }
  proposal.roles.forEach((role, index) => {
    if (role.recommended !== (role.role_id === proposal.recommended_role_id)) {
      context.addIssue({
        code: 'custom',
        path: ['roles', index, 'recommended'],
        message: 'recommended flags must match recommended_role_id',
      });
    }
  });

  const criterionIds = proposal.criterion_details
    .map(criterion => criterion.criterion_id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['criterion_details'],
      message: 'reviewer criterion details must be unique',
    });
  }
  proposal.criterion_details.forEach((criterion, index) => {
    if (criterion.role_id !== proposal.top_role_id) {
      context.addIssue({
        code: 'custom',
        path: ['criterion_details', index, 'role_id'],
        message: 'criterion details must describe only the top role',
      });
    }
  });
  const totalWeight = proposal.criterion_details.reduce(
    (total, criterion) => total + criterion.weight,
    0,
  );
  if (totalWeight !== 100) {
    context.addIssue({
      code: 'custom',
      path: ['criterion_details'],
      message: 'reviewer criterion weights must reproduce configured policy',
    });
  }
  const derivedScore = proposal.criterion_details.reduce(
    (total, criterion) => total + (criterion.status === 'met' ? criterion.weight : 0),
    0,
  );
  if (derivedScore !== topScore) {
    context.addIssue({
      code: 'custom',
      path: ['criterion_details'],
      message: 'reviewer criterion details must reproduce top-role score',
    });
  }
  if (new Set(proposal.limitations).size !== proposal.limitations.length) {
    context.addIssue({
      code: 'custom',
      path: ['limitations'],
      message: 'reviewer limitations must be unique',
    });
  }
  if (
    JSON.stringify(proposal.editable_agent1_output.limitations) !==
    JSON.stringify(proposal.limitations)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['editable_agent1_output', 'limitations'],
      message: 'editable output must retain the immutable limitation ledger',
    });
  }
  const editableRoleIds = proposal.editable_agent1_output.role_assessments
    .map(role => role.role_id);
  if (JSON.stringify(editableRoleIds) !== JSON.stringify(roleIds)) {
    context.addIssue({
      code: 'custom',
      path: ['editable_agent1_output', 'role_assessments'],
      message: 'editable output must cover the ranked role catalog',
    });
  }
  const topEditable = proposal.editable_agent1_output.role_assessments[0];
  if (topEditable) {
    const editableByCriterion = new Map(
      topEditable.criterion_assessments.map(criterion => [
        criterion.criterion_id,
        criterion,
      ]),
    );
    if (
      editableByCriterion.size !== criterionIds.length ||
      criterionIds.some(criterionId => !editableByCriterion.has(criterionId))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['criterion_details'],
        message: 'top-role detail must cover editable top-role criteria',
      });
    }
    proposal.criterion_details.forEach((criterion, index) => {
      const editable = editableByCriterion.get(criterion.criterion_id);
      if (
        !editable ||
        editable.status !== criterion.status ||
        JSON.stringify(editable.evidence) !== JSON.stringify(criterion.evidence_snippets)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['criterion_details', index],
          message: 'top-role detail must match editable evidence projection',
        });
      }
    });
  }
  if (
    proposal.question_plan !== null &&
    (
      proposal.recommended_role_id === null ||
      proposal.question_plan.role_id !== proposal.recommended_role_id
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['question_plan'],
      message: 'question plan must target the recommended top role',
    });
  }
  if (proposal.question_plan !== null) {
    const unknownIds = new Set(
      proposal.criterion_details
        .filter(criterion => criterion.status === 'unknown')
        .map(criterion => criterion.criterion_id),
    );
    const questionIds = new Set(
      proposal.question_plan.questions.map(question => question.target_criterion_id),
    );
    if (
      unknownIds.size !== questionIds.size ||
      [...unknownIds].some(criterionId => !questionIds.has(criterionId))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['question_plan'],
        message: 'question plan must cover top-role unknown criteria',
      });
    }
  }
});

export const ResumeReviewRunDetailResponseSchema = ResumeReviewRunResponseSchema.safeExtend({
  proposal: ResumeReviewProposalSchema,
});

export const PendingResumeReviewTopRoleSchema = z.object({
  role_id: DatabaseIdSchema,
  role_title: BoundedTextSchema,
  deterministic_score: z.number().int().min(0).max(100),
  recommended_role_id: DatabaseIdSchema.nullable(),
}).strict().superRefine((role, context) => {
  if (role.recommended_role_id !== null && role.recommended_role_id !== role.role_id) {
    context.addIssue({
      code: 'custom',
      path: ['recommended_role_id'],
      message: 'queue recommendation must be null or identify the top role',
    });
  }
});

export const PendingResumeReviewQueueItemSchema = z.object({
  run_id: DatabaseIdSchema,
  candidate_id: DatabaseIdSchema,
  created_at: z.iso.datetime({ offset: true }),
  run_version: VersionSchema,
  review: HumanReviewReferenceSchema,
  reason_codes: z.array(IdentifierSchema).max(20),
  top_role: PendingResumeReviewTopRoleSchema,
}).strict().superRefine((item, context) => {
  if (new Set(item.reason_codes).size !== item.reason_codes.length) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'reason_codes must be unique',
    });
  }
});

export const PendingResumeReviewQueueResponseSchema = z.object({
  schema_version: z.literal('2.0'),
  status: z.literal('pending_review'),
  items: z.array(PendingResumeReviewQueueItemSchema).max(50),
  next_cursor: PendingReviewCursorSchema.nullable(),
}).strict().superRefine((page, context) => {
  const runIds = page.items.map(item => item.run_id);
  if (new Set(runIds).size !== runIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['items'],
      message: 'pending queue run IDs must be unique',
    });
  }
  page.items.forEach((item, index) => {
    if (index === 0) return;
    const previous = page.items[index - 1];
    const previousTime = Date.parse(previous.created_at);
    const itemTime = Date.parse(item.created_at);
    if (previousTime < itemTime || (
      previousTime === itemTime && previous.run_id < item.run_id
    )) {
      context.addIssue({
        code: 'custom',
        path: ['items', index],
        message: 'pending queue must use newest-first keyset order',
      });
    }
  });
  if (page.next_cursor !== null && page.items.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['next_cursor'],
      message: 'an empty queue page cannot have a next cursor',
    });
  }
});

const decisionIdentity = {
  schema_version: z.literal('2.0'),
  decision_id: DatabaseIdSchema,
  review_id: DatabaseIdSchema,
  expected_review_version: VersionSchema,
};

export const ApproveResumeReviewDecisionSchema = z.object({
  ...decisionIdentity,
  action: z.literal('approve'),
}).strict();

export const ApproveWithEditsResumeReviewDecisionSchema = z.object({
  ...decisionIdentity,
  action: z.literal('approve_with_edits'),
  replacement_agent1_output: Agent1ModelOutputSchema,
  reason_code: IdentifierSchema,
}).strict();

export const RejectResumeReviewDecisionSchema = z.object({
  ...decisionIdentity,
  action: z.literal('reject'),
  reason_code: IdentifierSchema,
}).strict();

export const ResumeReviewDecisionRequestSchema = z.discriminatedUnion('action', [
  ApproveResumeReviewDecisionSchema,
  ApproveWithEditsResumeReviewDecisionSchema,
  RejectResumeReviewDecisionSchema,
]);

export const ResumeReviewHitlContractFixtureSchema = z.object({
  start_request: StartResumeReviewRunRequestSchema,
  run_responses: z.array(ResumeReviewRunResponseSchema).min(1).max(16),
  decisions: z.array(ResumeReviewDecisionRequestSchema).min(1).max(16),
}).strict();

export type StartResumeReviewRunRequest = z.infer<
  typeof StartResumeReviewRunRequestSchema
>;
export type ResumeReviewRunResponse = z.infer<typeof ResumeReviewRunResponseSchema>;
export type ReviewerConfidenceSummary = z.infer<
  typeof ReviewerConfidenceSummarySchema
>;
export type ResumeReviewRunDetailResponse = z.infer<
  typeof ResumeReviewRunDetailResponseSchema
>;
export type PendingResumeReviewQueueResponse = z.infer<
  typeof PendingResumeReviewQueueResponseSchema
>;
export type ResumeReviewDecisionRequest = z.infer<
  typeof ResumeReviewDecisionRequestSchema
>;
