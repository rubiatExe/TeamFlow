import { z } from 'zod';

export const ManagerCriterionSchema = z.object({
  criterion_id: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  criterion_text: z.string().trim().min(3).max(300),
  weight: z.number().int().min(1).max(100),
}).strict();

export const ManagerCriteriaSchema = z.array(ManagerCriterionSchema).min(1).max(5)
  .superRefine((criteria, context) => {
    if (criteria.reduce((sum, item) => sum + item.weight, 0) !== 100) {
      context.addIssue({ code: 'custom', message: 'Criterion weights must add up to 100.' });
    }
    if (new Set(criteria.map(item => item.criterion_id)).size !== criteria.length) {
      context.addIssue({ code: 'custom', message: 'Criterion IDs must be unique.' });
    }
  });

const CandidateIdSchema = z.string().min(1).max(80);
export const ManagerCriteriaRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('propose'),
    mode: z.enum(['sample', 'connected']),
    role_id: z.string().min(1).max(120),
    candidate_ids: z.array(CandidateIdSchema).min(1).max(20),
    manager_request: z.string().trim().min(3).max(500),
  }).strict(),
  z.object({
    action: z.literal('approve'),
    approval_token: z.string().min(1).max(16000),
    criteria: ManagerCriteriaSchema,
    additional_weight_percent: z.number().int().min(1).max(50),
  }).strict(),
]);

export const ManagerCriteriaProposalSchema = z.object({
  status: z.literal('review_required'),
  proposal_id: z.uuid(),
  mode: z.enum(['sample', 'connected']),
  role_id: z.string().min(1).max(120),
  manager_request: z.string().max(500),
  criteria: ManagerCriteriaSchema,
  candidate_ids: z.array(CandidateIdSchema).min(1).max(20),
  approval_token: z.string().min(1).max(16000),
  expires_at: z.iso.datetime(),
  warnings: z.array(z.string().max(500)).max(10),
}).strict();

export const ManagerCriterionAssessmentSchema = ManagerCriterionSchema.extend({
  status: z.enum(['met', 'not_met', 'unknown']),
  points: z.number().int().min(0).max(100),
  evidence: z.array(z.object({
    source_block_id: z.string().min(1).max(200),
    exact_quote: z.string().min(1).max(2000),
  }).strict()).max(8),
}).strict().superRefine((item, context) => {
  if (item.points !== (item.status === 'met' ? item.weight : 0)) {
    context.addIssue({ code: 'custom', message: 'Points must match the criterion status and weight.' });
  }
  if (item.status !== 'unknown' && item.evidence.length === 0) {
    context.addIssue({ code: 'custom', message: 'A classification requires cited evidence.' });
  }
});

export const ManagerCriteriaCandidateResultSchema = z.object({
  candidate_id: CandidateIdSchema,
  display_name: z.string().min(1).max(200),
  base_score: z.number().int().min(0).max(100).nullable(),
  additional_score: z.number().int().min(0).max(100),
  updated_score: z.number().int().min(0).max(100).nullable(),
  additional_weight_percent: z.number().int().min(1).max(50),
  provisional: z.boolean(),
  criteria: z.array(ManagerCriterionAssessmentSchema).min(1).max(5),
}).strict().superRefine((result, context) => {
  const total = result.criteria.reduce((sum, item) => sum + item.points, 0);
  const updated = result.base_score === null ? null : Math.round(
    result.base_score * (100 - result.additional_weight_percent) / 100
    + total * result.additional_weight_percent / 100,
  );
  if (total !== result.additional_score || updated !== result.updated_score
    || result.criteria.reduce((sum, item) => sum + item.weight, 0) !== 100
    || new Set(result.criteria.map(item => item.criterion_id)).size !== result.criteria.length
    || result.provisional !== result.criteria.some(item => item.status === 'unknown')) {
    context.addIssue({ code: 'custom', message: 'Assessment totals or evidence coverage are inconsistent.' });
  }
});

export const ManagerCriteriaEvaluationSchema = z.object({
  status: z.literal('evaluated'),
  proposal_id: z.uuid(),
  role_id: z.string().min(1).max(120),
  mode: z.enum(['sample', 'connected']),
  criteria: ManagerCriteriaSchema,
  additional_weight_percent: z.number().int().min(1).max(50),
  results: z.array(ManagerCriteriaCandidateResultSchema).min(1).max(20),
  approved_at: z.iso.datetime(),
  warnings: z.array(z.string().max(500)).max(10),
}).strict().superRefine((evaluation, context) => {
  if (new Set(evaluation.results.map(result => result.candidate_id)).size !== evaluation.results.length
    || evaluation.results.some(result => result.additional_weight_percent !== evaluation.additional_weight_percent
      || result.criteria.length !== evaluation.criteria.length
      || result.criteria.some((criterion, index) => {
        const expected = evaluation.criteria[index];
        return criterion.criterion_id !== expected.criterion_id || criterion.criterion_text !== expected.criterion_text
          || criterion.weight !== expected.weight;
      }))) {
    context.addIssue({ code: 'custom', message: 'Assessment must use the exact approved criteria and weight.' });
  }
});

export type ManagerCriterion = z.infer<typeof ManagerCriterionSchema>;
export type ManagerCriteriaProposal = z.infer<typeof ManagerCriteriaProposalSchema>;
export type ManagerCriteriaEvaluation = z.infer<typeof ManagerCriteriaEvaluationSchema>;
export type ManagerCriteriaCandidateResult = z.infer<typeof ManagerCriteriaCandidateResultSchema>;
