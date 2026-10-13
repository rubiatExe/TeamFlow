import { randomUUID } from 'node:crypto';
import {
  ManagerCriteriaRequestSchema, ManagerCriteriaProposalSchema, ManagerCriteriaEvaluationSchema,
  type ManagerCriterion, type ManagerCriteriaCandidateResult,
} from '../contracts/manager-criteria.ts';
import {
  assertApprovedCriteria, assertSafeManagerRequest, candidateSnapshotDigest,
  createCriteriaApprovalAuthority, evaluateSampleCriteria, loadSampleCriteriaCandidates,
  ManagerCriteriaError, proposeSampleCriteria, scoreCriteriaCandidate, type CriteriaCandidateSnapshot,
} from '../domain/manager-criteria.ts';
import { CAFE_ROLES } from '../domain/roles.ts';
import { createManagerCriteriaClient, type CriteriaServiceEvaluation } from '../ai/manager-criteria-client.ts';
import { loadConnectedCriteriaCandidates } from '../db/manager-criteria.ts';
import { createDemoSearchRateLimiter } from './demo-semantic-search-route.ts';
import { guardLegacyDemoRoute } from './legacy-demo-route.ts';
import {
  createDeadlineSignal, readBoundedJson, validateBoundedJsonRequestHeaders,
  UnsupportedJsonMediaTypeError, RequestBodyTooLargeError, RequestBodyDeadlineError,
} from './bounded-json.ts';

const RESPONSE_HEADERS = { 'Cache-Control': 'no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
let defaultAuthority: ReturnType<typeof createCriteriaApprovalAuthority> | undefined;
export function configuredCriteriaApprovalAuthority(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const secret = environment.MANAGER_CRITERIA_SIGNING_SECRET || undefined;
  if (secret !== undefined && (secret.length < 32 || secret.length > 512 || secret !== secret.trim())) {
    throw new ManagerCriteriaError('approval_not_configured', 503, 'Criteria approval is not configured. No scores were changed.');
  }
  if (!secret && environment.NODE_ENV === 'production') {
    throw new ManagerCriteriaError('approval_not_configured', 503, 'Criteria approval is not configured. No scores were changed.');
  }
  return createCriteriaApprovalAuthority(secret ? { secret: Buffer.from(secret, 'utf8') } : {});
}
const rateLimit = createDemoSearchRateLimiter({ requestLimit: 20 });
type Dependencies = {
  merchantId: string;
  approvalAuthority?: ReturnType<typeof createCriteriaApprovalAuthority>;
  connectedGuard?: () => Response | null;
  loadConnected?: typeof loadConnectedCriteriaCandidates;
  client?: ReturnType<typeof createManagerCriteriaClient>;
  rateLimit?: ReturnType<typeof createDemoSearchRateLimiter>;
  now?: () => number;
  bodyDeadlineMs?: number;
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...RESPONSE_HEADERS, ...extra } });

function assertFresh(expected: string, candidates: CriteriaCandidateSnapshot[]) {
  if (candidateSnapshotDigest(candidates) !== expected) throw new ManagerCriteriaError('stale_approval', 409,
    'Candidate scores or résumé evidence changed. Create a new proposal before approving.');
}

function requestTargetOrigin(request: Request): string | null {
  const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = request.headers.get('host');
  if (host === null) return url.origin;
  // NextURL normalizes loopback IPs to localhost. Host retains the browser's
  // actual target, and browser scripts cannot set it. Never trust forwarded hosts.
  if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[0-9]+)?$/iu.test(host)) return null;
  try {
    return new URL(`${url.protocol}//${host}`).origin;
  } catch {
    return null;
  }
}

export function validateCriteriaServiceResults(
  service: CriteriaServiceEvaluation, candidates: CriteriaCandidateSnapshot[], criteria: ManagerCriterion[], weight: number,
): ManagerCriteriaCandidateResult[] {
  if (service.results.length !== candidates.length || new Set(service.results.map(item => item.candidate_id)).size !== candidates.length) {
    throw new ManagerCriteriaError('invalid_agent_response', 502, 'Agent 1 returned an invalid candidate scope.');
  }
  return candidates.map(candidate => {
    const result = service.results.find(item => item.candidate_id === candidate.candidate_id);
    if (!result || result.criteria.length !== criteria.length || new Set(result.criteria.map(item => item.criterion_id)).size !== criteria.length) {
      throw new ManagerCriteriaError('invalid_agent_response', 502, 'Agent 1 returned an invalid criterion scope.');
    }
    const assessed = criteria.map(criterion => {
      const item = result.criteria.find(entry => entry.criterion_id === criterion.criterion_id);
      if (!item || (item.status === 'unknown' ? item.evidence.length !== 0 : item.evidence.length === 0)
        || item.evidence.some(evidence => !candidate.source_blocks.find(block => block.source_block_id === evidence.source_block_id)?.text.includes(evidence.exact_quote))) {
        throw new ManagerCriteriaError('invalid_agent_evidence', 502, 'Agent 1 returned evidence that does not match the linked résumé.');
      }
      return { ...criterion, ...item, points: item.status === 'met' ? criterion.weight : 0 };
    });
    const scored = scoreCriteriaCandidate(candidate, assessed, weight);
    if (scored.additional_score !== result.additional_score) throw new ManagerCriteriaError('invalid_agent_response', 502, 'Agent 1 returned inconsistent points.');
    return scored;
  });
}

export async function handleManagerCriteriaRequest(request: Request, dependencies: Dependencies): Promise<Response> {
  const requestId = randomUUID();
  const expectedOrigin = requestTargetOrigin(request);
  const suppliedOrigin = request.headers.get('origin');
  if (expectedOrigin === null || (suppliedOrigin !== null && suppliedOrigin !== expectedOrigin)
    || (suppliedOrigin === null && request.headers.get('sec-fetch-site') !== 'same-origin')) {
    return json({ error: 'Criteria requests must come from the TeamFlow page.', code: 'invalid_origin', request_id: requestId }, 403);
  }
  const rate = (dependencies.rateLimit ?? rateLimit)(request);
  if (!rate.allowed) return json({ error: 'Please wait briefly before requesting another assessment.', code: 'rate_limited', request_id: requestId }, 429,
    { 'Retry-After': String(rate.retryAfterSeconds) });
  let body: unknown;
  try {
    validateBoundedJsonRequestHeaders(request, 24_576);
    const deadline = createDeadlineSignal(dependencies.bodyDeadlineMs ?? 3_000, request.signal);
    try { body = await readBoundedJson(request, 24_576, { signal: deadline.signal }); }
    finally { deadline.dispose(); }
  } catch (error) {
    const status = error instanceof UnsupportedJsonMediaTypeError ? 415 : error instanceof RequestBodyTooLargeError ? 413
      : error instanceof RequestBodyDeadlineError ? 408 : 400;
    return json({ error: 'Submit a bounded JSON criteria request.', code: 'invalid_request', request_id: requestId }, status);
  }
  const input = ManagerCriteriaRequestSchema.safeParse(body);
  if (!input.success) return json({ error: 'Check the candidate selection, criteria, and weights.', code: 'invalid_request', request_id: requestId }, 400);
  const client = dependencies.client ?? createManagerCriteriaClient({ signal: request.signal });
  const load = dependencies.loadConnected ?? loadConnectedCriteriaCandidates;
  const now = dependencies.now ?? Date.now;
  try {
    if (input.data.action === 'propose' && input.data.mode === 'connected') {
      const blocked = (dependencies.connectedGuard ?? guardLegacyDemoRoute)();
      if (blocked) return blocked;
    }
    const signer = dependencies.approvalAuthority ?? (defaultAuthority ??= configuredCriteriaApprovalAuthority());
    if (input.data.action === 'propose') {
      const data = input.data;
      assertSafeManagerRequest(data.manager_request);
      const candidates = data.mode === 'sample' ? loadSampleCriteriaCandidates(data.role_id, data.candidate_ids)
        : await load(dependencies.merchantId, data.role_id, data.candidate_ids);
      const proposed = data.mode === 'sample' ? { criteria: proposeSampleCriteria(data.manager_request), warnings: [] }
        : await client.propose({ schema_version: '1.0', merchant_id: dependencies.merchantId, request_id: requestId,
          manager_request: data.manager_request, role_id: data.role_id,
          role_title: candidates[0].role_title ?? CAFE_ROLES.find(role => role.id === data.role_id)?.title ?? data.role_id });
      proposed.criteria.forEach(item => assertSafeManagerRequest(item.criterion_text));
      const { token, claims } = signer.issue({
        mode: data.mode, merchant_id: dependencies.merchantId, role_id: data.role_id,
        candidate_ids: data.candidate_ids, criteria: proposed.criteria, snapshot_digest: candidateSnapshotDigest(candidates),
      });
      return json(ManagerCriteriaProposalSchema.parse({
        status: 'review_required', proposal_id: claims.proposal_id, mode: data.mode, role_id: data.role_id,
        manager_request: data.manager_request, criteria: proposed.criteria, candidate_ids: data.candidate_ids,
        approval_token: token, expires_at: new Date(claims.expires_at).toISOString(),
        warnings: data.mode === 'sample'
          ? ['Illustrative criteria drafted from a supported job-skill catalog; no live agent was called.', 'Review whether this draft captures your entire request. Scores remain unchanged until you approve.']
          : ['Agent 1 drafted these criteria for your review. Scores remain unchanged until you approve.', 'This is a session-only assessment; it does not replace the approved base policy.'],
      }));
    }
    const data = input.data;
    const claims = signer.verify(data.approval_token);
    if (claims.merchant_id !== dependencies.merchantId) throw new ManagerCriteriaError('invalid_approval', 409, 'This proposal does not belong to this workspace.');
    if (claims.mode === 'connected') {
      const blocked = (dependencies.connectedGuard ?? guardLegacyDemoRoute)();
      if (blocked) return blocked;
    }
    assertApprovedCriteria(claims, data.criteria);
    const candidates = claims.mode === 'sample' ? loadSampleCriteriaCandidates(claims.role_id, claims.candidate_ids)
      : await load(dependencies.merchantId, claims.role_id, claims.candidate_ids);
    assertFresh(claims.snapshot_digest, candidates);
    let results: ManagerCriteriaCandidateResult[];
    if (claims.mode === 'sample') {
      results = evaluateSampleCriteria(candidates, data.criteria, data.additional_weight_percent);
    } else {
      const service = await client.evaluate({ schema_version: '1.0', merchant_id: dependencies.merchantId, request_id: requestId,
        criteria: data.criteria, candidates: candidates.map(item => ({ candidate_id: item.candidate_id, document_id: item.document_id })), approved: true });
      results = validateCriteriaServiceResults(service, candidates, data.criteria, data.additional_weight_percent);
      assertFresh(claims.snapshot_digest, await load(dependencies.merchantId, claims.role_id, claims.candidate_ids));
    }
    return json(ManagerCriteriaEvaluationSchema.parse({
      status: 'evaluated', proposal_id: claims.proposal_id, mode: claims.mode, role_id: claims.role_id,
      criteria: data.criteria, additional_weight_percent: data.additional_weight_percent, results,
      approved_at: new Date(now()).toISOString(),
      warnings: [claims.mode === 'sample' ? 'Illustrative sample assessment using fictional résumé passages.' : 'Session-only assessment from Agent 1; approved base scores were not changed.',
        'Missing evidence is unknown, not proof that a candidate lacks a skill. Confirm gaps with the candidate.',
        'Combined score = base × base weight + additional criteria × added weight. A missing approved base remains unscored.'],
    }));
  } catch (error) {
    if (error instanceof ManagerCriteriaError) return json({ error: error.message, code: error.code, request_id: requestId }, error.status);
    console.error('[Manager Criteria] Assessment failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
    return json({ error: 'This criteria assessment is temporarily unavailable. No scores were changed.', code: 'assessment_unavailable', request_id: requestId }, 503);
  }
}
