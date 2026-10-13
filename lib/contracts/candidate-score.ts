import { z } from 'zod';

import {
  Agent1EvaluationSchema,
  CriterionStatusSchema,
  RoleScoringPolicySchema,
  validateAgent1EvaluationAgainstPolicies,
} from './resume-review.ts';
import { summarizeWeightedScore } from '../domain/scoring-policy.ts';

export const ApprovedCandidateScoreCriterionSchema = z.object({
  criterion_id: z.string().min(3).max(120),
  criterion_text: z.string().trim().min(1).max(1_000),
  weight: z.number().int().min(0).max(100),
  status: CriterionStatusSchema,
}).strict();

export const ApprovedCandidateScoreDetailsSchema = z.object({
  role_id: z.string().uuid(),
  role_title: z.string().trim().min(1).max(1_000),
  policy_id: z.string().min(3).max(120),
  policy_version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
  score: z.number().int().min(0).max(100),
  criteria: z.array(ApprovedCandidateScoreCriterionSchema).min(1).max(30),
}).strict().superRefine((details, context) => {
  const criterionIds = details.criteria.map(criterion => criterion.criterion_id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['criteria'],
      message: 'approved score criteria must be unique',
    });
  }
  const summary = summarizeWeightedScore(details.criteria);
  if (summary.totalWeight !== 100) {
    context.addIssue({
      code: 'custom',
      path: ['criteria'],
      message: 'approved score criterion weights must total 100',
    });
  }
  if (summary.earnedPoints !== details.score) {
    context.addIssue({
      code: 'custom',
      path: ['score'],
      message: 'approved score must equal met criterion weights',
    });
  }
});

export type CandidateScoreDetails = z.infer<
  typeof ApprovedCandidateScoreDetailsSchema
>;

export type ApprovedCandidateScoreDetails = CandidateScoreDetails;

/**
 * Build a board-safe score projection only after the immutable evaluation agrees
 * with the role-policy identities, criterion catalog, ordering, and score math.
 */
export function buildApprovedCandidateScoreDetails(
  evaluationInput: unknown,
  policiesInput: unknown,
  expectedScore: unknown,
): ApprovedCandidateScoreDetails | null {
  try {
    const evaluation = Agent1EvaluationSchema.parse(evaluationInput);
    const policies = z.array(RoleScoringPolicySchema).min(1).max(20).parse(policiesInput);
    validateAgent1EvaluationAgainstPolicies(evaluation, policies);
    const topRole = evaluation.ranked_roles[0];
    if (
      !topRole ||
      typeof expectedScore !== 'number' ||
      !Number.isInteger(expectedScore) ||
      expectedScore !== topRole.deterministic_score
    ) {
      return null;
    }
    const policy = policies.find(item => item.role_id === topRole.role_id);
    if (!policy) return null;
    const assessmentByCriterion = new Map(
      topRole.criterion_assessments.map(assessment => [
        assessment.criterion_id,
        assessment,
      ]),
    );

    return ApprovedCandidateScoreDetailsSchema.parse({
      role_id: policy.role_id,
      role_title: policy.role_title,
      policy_id: policy.policy_identity.policy_id,
      policy_version: policy.policy_identity.policy_version,
      score: topRole.deterministic_score,
      criteria: policy.criteria.map(criterion => ({
        ...criterion,
        status: assessmentByCriterion.get(criterion.criterion_id)?.status,
      })),
    });
  } catch {
    return null;
  }
}
