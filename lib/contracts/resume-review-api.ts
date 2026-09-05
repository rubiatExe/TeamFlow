import { z } from 'zod';

import {
  Agent1EvaluationSchema,
  Agent2QuestionPlanSchema,
} from './resume-review.ts';

const DatabaseIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'Invalid lowercase UUID',
);
const DocumentIdSchema = z.string().regex(/^doc-[0-9a-f]{64}$/);
const ReasonCodeSchema = z.string()
  .min(3)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const ResumeReviewPublicRequestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  documentId: DocumentIdSchema,
  candidateId: DatabaseIdSchema.optional(),
}).strict();

export const ResumeReviewServiceRequestSchema = z.object({
  schema_version: z.literal('1.0'),
  request_id: DatabaseIdSchema,
  merchant_id: DatabaseIdSchema,
  document_id: DocumentIdSchema,
  candidate_id: DatabaseIdSchema.nullable(),
  persist: z.boolean(),
}).strict();

export const ResumeReviewResponseSchema = z.object({
  schema_version: z.literal('1.0'),
  request_id: DatabaseIdSchema,
  document_id: DocumentIdSchema,
  status: z.enum(['complete', 'degraded', 'review_required']),
  review_required: z.boolean(),
  agent1_evaluation: Agent1EvaluationSchema.nullable(),
  question_plan: Agent2QuestionPlanSchema.nullable(),
  questions_status: z.enum([
    'complete',
    'degraded',
    'not_required',
    'skipped',
  ]),
  persistence_status: z.enum([
    'succeeded',
    'failed',
    'skipped',
    'not_requested',
  ]),
  reason_codes: z.array(ReasonCodeSchema).max(20),
  extraction_status: z.enum(['complete', 'degraded']).nullable(),
  embedding_available: z.boolean(),
}).strict().superRefine((response, context) => {
  const hardAgent1Failures = new Set([
    'document_unavailable',
    'tenant_mismatch',
    'invalid_extraction',
    'document_instruction_detected',
    'no_active_roles',
    'active_roles_unavailable',
    'agent1_refused',
    'agent1_invalid_output',
    'agent1_provider_failed',
    'agent1_invalid_evidence',
    'score_calculation_failed',
  ]);
  if (new Set(response.reason_codes).size !== response.reason_codes.length) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'reason_codes must be unique',
    });
  }
  if ((response.questions_status === 'complete') !== (response.question_plan !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['question_plan'],
      message: 'question plan must match complete question status',
    });
  }
  if (response.agent1_evaluation === null && response.questions_status !== 'skipped') {
    context.addIssue({
      code: 'custom',
      path: ['questions_status'],
      message: 'questions must be skipped when Agent 1 has no evaluation',
    });
  }
  if (
    response.agent1_evaluation !== null &&
    response.reason_codes.some(code => hardAgent1Failures.has(code))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['agent1_evaluation'],
      message: 'hard Agent 1 failures cannot include an evaluation',
    });
  }
  if (
    response.agent1_evaluation === null &&
    response.persistence_status !== 'skipped' &&
    response.persistence_status !== 'not_requested'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['persistence_status'],
      message: 'invalid Agent 1 output cannot be persisted',
    });
  }
  if (response.persistence_status === 'succeeded' && response.agent1_evaluation === null) {
    context.addIssue({
      code: 'custom',
      path: ['persistence_status'],
      message: 'persistence cannot succeed without a validated evaluation',
    });
  }
  if (
    response.agent1_evaluation !== null &&
    (response.status !== 'review_required' || !response.review_required)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'model evaluations are unapproved review proposals',
    });
  }
  if (
    (response.status === 'review_required') !== response.review_required
  ) {
    context.addIssue({
      code: 'custom',
      path: ['review_required'],
      message: 'review_required must match review_required status',
    });
  }
});

export type ResumeReviewPublicRequest = z.infer<
  typeof ResumeReviewPublicRequestSchema
>;
export type ResumeReviewServiceRequest = z.infer<
  typeof ResumeReviewServiceRequestSchema
>;
export type ResumeReviewResponse = z.infer<typeof ResumeReviewResponseSchema>;
