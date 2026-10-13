import { z } from 'zod';
import { ManagerCriteriaSchema, type ManagerCriterion } from '../contracts/manager-criteria.ts';
import { ManagerCriteriaError } from '../domain/manager-criteria.ts';
import { createDeadlineSignal, readBoundedJsonResponse } from '../http/bounded-json.ts';
import { resolveTrustedServiceBaseUrl } from '../http/trusted-service-url.ts';
import { isValidServiceToken } from '../http/service-token.ts';

const ProposalSchema = z.object({
  schema_version: z.literal('1.0'), request_id: z.uuid(), status: z.literal('review_required'),
  criteria: ManagerCriteriaSchema, review_required: z.literal(true), warnings: z.array(z.string().max(500)).max(10),
}).strict();
const EvaluationSchema = z.object({
  schema_version: z.literal('1.0'), request_id: z.uuid(),
  results: z.array(z.object({
    candidate_id: z.uuid(), additional_score: z.number().int().min(0).max(100),
    criteria: z.array(z.object({
      criterion_id: z.string().min(1).max(120), status: z.enum(['met', 'not_met', 'unknown']),
      evidence: z.array(z.object({ source_block_id: z.string().min(1).max(200), exact_quote: z.string().min(1).max(2000) }).strict()).max(8),
    }).strict()).min(1).max(5),
  }).strict()).min(1).max(20), warnings: z.array(z.string().max(500)).max(10),
}).strict();
export type CriteriaServiceEvaluation = z.infer<typeof EvaluationSchema>;
export type CriteriaServiceProposal = z.infer<typeof ProposalSchema>;

type Context = { schema_version: '1.0'; merchant_id: string; request_id: string };
export type CriteriaProposeServiceRequest = Context & { manager_request: string; role_id: string; role_title: string };
export type CriteriaEvaluateServiceRequest = Context & { criteria: ManagerCriterion[]; candidates: { candidate_id: string; document_id: string }[]; approved: true };

export function createManagerCriteriaClient(options: {
  serviceUrl?: string; trustedOrigin?: string; token?: string; timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal;
} = {}) {
  async function call<T>(path: string, body: Context, schema: z.ZodType<T>): Promise<T> {
    let baseUrl: string;
    const token = options.token ?? process.env.HIRING_AGENT_TOKEN;
    const timeoutMs = options.timeoutMs ?? 49_000;
    try {
      if (!isValidServiceToken(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 49_000) throw new Error();
      baseUrl = resolveTrustedServiceBaseUrl(options.serviceUrl ?? process.env.HIRING_AGENT_URL, options.trustedOrigin ?? process.env.HIRING_AGENT_TRUSTED_ORIGIN);
    } catch {
      throw new ManagerCriteriaError('agent_not_configured', 503, 'Agent 1 is not configured for this environment. No scores were changed.');
    }
    const deadline = createDeadlineSignal(timeoutMs, options.signal);
    try {
      const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': token as string },
        body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: deadline.signal,
      });
      const payload = await readBoundedJsonResponse(response, 2_097_152, { signal: deadline.signal });
      if (!response.ok) throw new ManagerCriteriaError('agent_unavailable', [422, 429, 503, 504].includes(response.status) ? response.status : 502,
        response.status === 422 ? 'Agent 1 could not safely interpret these job criteria. Reword the request.' : 'Agent 1 could not complete this assessment. No scores were changed.');
      const parsed = schema.safeParse(payload);
      if (!parsed.success || (parsed.data as { request_id: string }).request_id !== body.request_id) {
        throw new ManagerCriteriaError('invalid_agent_response', 502, 'Agent 1 returned an invalid assessment. No scores were changed.');
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ManagerCriteriaError) throw error;
      throw new ManagerCriteriaError(deadline.signal.aborted ? 'agent_timeout' : 'agent_unavailable', deadline.signal.aborted ? 504 : 502,
        'Agent 1 could not complete this assessment. No scores were changed.');
    } finally { deadline.dispose(); }
  }
  return {
    propose: (request: CriteriaProposeServiceRequest) => call('/v1/manager-criteria/propose', request, ProposalSchema),
    evaluate: (request: CriteriaEvaluateServiceRequest) => call('/v1/manager-criteria/evaluate', request, EvaluationSchema),
  };
}
