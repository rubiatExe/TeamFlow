import { z } from 'zod';

const DatabaseIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'Invalid UUID',
);

export const HiringAgentRequestSchema = z.object({
  candidateId: DatabaseIdSchema.optional(),
  roleId: DatabaseIdSchema.optional(),
  operation: z.enum(['review_candidate', 'search_candidates'])
    .default('review_candidate'),
  instructions: z.string().max(4_000).optional(),
}).strict().superRefine((request, context) => {
  if (request.operation === 'search_candidates') {
    if (request.candidateId) {
      context.addIssue({
        code: 'custom',
        path: ['candidateId'],
        message: 'candidateId is not allowed for candidate search',
      });
    }
    if (!request.instructions?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['instructions'],
        message: 'instructions are required for candidate search',
      });
    }
  }
});

export const HiringAgentServiceRequestSchema = z.object({
  candidateId: DatabaseIdSchema.optional(),
  roleId: DatabaseIdSchema.optional(),
  merchantId: DatabaseIdSchema,
  requestId: z.uuid(),
  operation: z.enum(['review_candidate', 'search_candidates']),
  instructions: z.string().max(4_000).optional(),
}).strict();

const HiringAgentAnalysisSchema = z.object({
  evidence: z.array(z.string().max(500)).max(20),
  gaps: z.array(z.string().max(500)).max(20),
  limitations: z.array(z.string().max(500)).max(20),
  confidence: z.enum(['low', 'medium', 'high']),
}).strict();

export const HiringAgentResponseSchema = z.object({
  summary: z.string().min(1).max(500),
  recommendation: z.string().min(1).max(1_000),
  fit_score: z.number().int().min(0).max(100).nullable(),
  analysis: HiringAgentAnalysisSchema,
  status: z.enum(['complete', 'degraded', 'refused']),
  write_status: z.literal('not_requested'),
  warnings: z.array(z.string().max(100)).max(20),
  request_id: z.uuid(),
  tool_calls: z.array(z.enum([
    'get_candidate',
    'get_job_requirements',
    'list_candidates',
    'semantic_search_candidates',
  ])).max(4),
}).strict();

export type HiringAgentRequest = z.infer<typeof HiringAgentRequestSchema>;
export type HiringAgentServiceRequest = z.infer<typeof HiringAgentServiceRequestSchema>;
export type HiringAgentResponse = z.infer<typeof HiringAgentResponseSchema>;
