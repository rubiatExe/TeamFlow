import { z } from 'zod';

import {
  PendingResumeReviewQueueResponseSchema,
  PendingReviewCursorSchema,
  ResumeReviewDecisionRequestSchema,
  ResumeReviewRunDetailResponseSchema,
  ResumeReviewRunResponseSchema,
} from './resume-review-hitl.ts';

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const documentIdPattern = /^doc-[0-9a-f]{64}$/;

/** Canonical lowercase UUID used as the server-owned workflow request ID. */
export const ResumeReviewIdempotencyKeySchema = z
  .string()
  .regex(canonicalUuidPattern, 'Invalid canonical UUID');

export const ResumeReviewRunIdSchema = ResumeReviewIdempotencyKeySchema;

export const PendingResumeReviewQueueQuerySchema = z.object({
  status: z.literal('pending_review'),
  limit: z.number().int().min(1).max(50),
  cursor: PendingReviewCursorSchema.nullable(),
}).strict();

/**
 * Browser-safe start payload. `request_id`, tenant, actor, scores, and model state
 * are deliberately absent; the adapter supplies `request_id` from Idempotency-Key.
 */
export const StartResumeReviewRunPublicRequestSchema = z.object({
  schema_version: z.literal('2.0'),
  document_id: z.string().regex(documentIdPattern, 'Invalid document ID'),
  candidate_id: ResumeReviewIdempotencyKeySchema,
}).strict();

export const ResumeReviewHitlErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'idempotency_conflict',
  'stale_decision',
  'review_already_decided',
  'invalid_edit',
  'invalid_request',
  'service_unavailable',
  'workflow_failed',
]);

export const ResumeReviewHitlServiceErrorSchema = z.object({
  error: z.string().min(1).max(256),
  code: ResumeReviewHitlErrorCodeSchema,
}).strict();

export {
  PendingResumeReviewQueueResponseSchema,
  ResumeReviewDecisionRequestSchema,
  ResumeReviewRunDetailResponseSchema,
  ResumeReviewRunResponseSchema,
};

export type StartResumeReviewRunPublicRequest = z.infer<
  typeof StartResumeReviewRunPublicRequestSchema
>;
export type ResumeReviewHitlErrorCode = z.infer<
  typeof ResumeReviewHitlErrorCodeSchema
>;
