import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  ManagerCriteriaSchema, ManagerCriteriaCandidateResultSchema,
  type ManagerCriterion, type ManagerCriteriaCandidateResult,
} from '../contracts/manager-criteria.ts';
import { inspectDemoSearchQuery } from '../demo/semantic-search-core.ts';
import { SYNTHETIC_CANDIDATE_CORPUS } from './demo-semantic-search-data.ts';
import { getDemoScoreDetails } from './demo-scoring.ts';

export class ManagerCriteriaError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ManagerCriteriaError';
    this.code = code;
    this.status = status;
  }
}

export type CriteriaCandidateSnapshot = {
  candidate_id: string;
  display_name: string;
  role_id: string;
  role_title?: string;
  base_score: number | null;
  document_id: string;
  snapshot_sha256: string;
  source_blocks: { source_block_id: string; text: string }[];
};

// A small, explicit catalog keeps the public fictional demo useful without
// pretending a language model ran or scoring arbitrary manager wording.
const SAMPLE_CATALOG = [
  { id: 'espresso', text: 'Experience preparing espresso drinks', request: /\bespresso\b/i, evidence: /\b(?:dialed|prepared|calibration)\b.*\b(?:espresso|grinders)|\bespresso\b.*\bcalibration\b/i },
  { id: 'latte-art', text: 'Demonstrated latte art skills', request: /\blatte art\b/i, evidence: /\blatte art assessment\b/i },
  { id: 'guest-service', text: 'Experience supporting customers or resolving guest concerns', request: /\b(?:customer|guest|hospitality|service desk)\b/i, evidence: /\b(?:resolved guest concerns|de-escalated guest concerns|supported a busy service desk|welcomed attendees|guest questions)\b/i },
  { id: 'pos', text: 'Experience processing transactions with a POS system', request: /\b(?:pos|point of sale|register|transactions?)\b/i, evidence: /\b(?:processed refunds in the POS|used a cloud POS|POS recovery)\b/i },
  { id: 'weekend', text: 'Explicit availability for weekend shifts', request: /\b(?:weekend|weekends|saturday|sunday)\b/i, evidence: /\bavailable\b.*\b(?:Saturday|Sunday|weekend)\b/i },
  { id: 'training', text: 'Experience training or coaching team members', request: /\b(?:train\w*|coach\w*|mentor\w*|onboard\w*)\b/i, evidence: /\b(?:coached|onboarding|shift huddles)\b/i },
  { id: 'leadership', text: 'Experience leading a service team', request: /\b(?:lead\w*|supervis\w*|management)\b/i, evidence: /\b(?:led a six-person|supervised teams)\b/i },
  { id: 'inventory', text: 'Experience managing inventory or stock', request: /\b(?:inventory|stock\w*|ordering)\b/i, evidence: /\b(?:bean and dairy counts|placed weekly|cycle counts|stock checks|purchase orders)\b/i },
  { id: 'cash-handling', text: 'Experience handling cash or balancing a drawer', request: /\bcash\b/i, evidence: /\b(?:balanced a cash drawer|register variances)\b/i },
  { id: 'food-safety', text: 'Documented food safety training or practices', request: /\b(?:food safety|food.handler|servsafe|sanitation)\b/i, evidence: /\b(?:food-handler certificate|ServSafe|holding temperatures|cold-chain|sanitation)\b/i },
  { id: 'scheduling', text: 'Experience scheduling shifts or maintaining coverage', request: /\b(?:scheduling|schedules?|coverage)\b/i, evidence: /\b(?:built weekly schedules|maintained coverage)\b/i },
  { id: 'high-volume', text: 'Experience working during high-volume service', request: /\b(?:high.volume|busy|rush\w*)\b/i, evidence: /\b(?:high-volume service|250-order|300-cover|140 transactions)\b/i },
  { id: 'sourdough', text: 'Experience producing sourdough bread', request: /\b(?:sourdough|bread|bak\w*|pastry)\b/i, evidence: /\bsourdough loaves\b/i },
  { id: 'knife-prep', text: 'Experience using knife skills for ingredient preparation', request: /\b(?:knife|prep\w*)\b/i, evidence: /\b(?:knife prep|knife skills|portioned proteins)\b/i },
  { id: 'recipe-scaling', text: 'Experience scaling recipes or production batches', request: /\b(?:recipe|scaling|batches|batch)\b/i, evidence: /\bscaled formulas\b/i },
] as const;

export function assertSafeManagerRequest(value: string): void {
  // Reuse the app's protected-trait/contact/instruction safety gate. Split only
  // to honor this contract's 500-character limit; overlapping chunks preserve
  // cross-boundary phrases. All canonical sample criterion wording is <280.
  const normalized = value.normalize('NFKC').trim();
  const chunks = normalized.length <= 280 ? [normalized] : [normalized.slice(0, 280), normalized.slice(-280)];
  if (chunks.some(chunk => !inspectDemoSearchQuery(chunk).ok)) {
    throw new ManagerCriteriaError('unsafe_criteria', 422,
      'Use job-related skills, experience, certifications, or availability. Do not include protected traits, contact details, or instructions to change scores.');
  }
}

export function proposeSampleCriteria(managerRequest: string): ManagerCriterion[] {
  assertSafeManagerRequest(managerRequest);
  if (/\b(?:not|no|never|without|exclude|avoid|don.t|doesn.t)\b/i.test(managerRequest)) {
    throw new ManagerCriteriaError('unsupported_sample_criteria', 422,
      'For the sample preview, describe the positive job skills you want to assess. Complex or negative requirements need a connected Agent 1 review.');
  }
  const matched = SAMPLE_CATALOG.filter(item => item.request.test(managerRequest));
  if (matched.length === 0 || matched.length > 5) {
    throw new ManagerCriteriaError('unsupported_sample_criteria', 422,
      'Try one to five specific job skills, such as latte art, customer service, POS, food safety, or weekend availability.');
  }
  const weight = Math.floor(100 / matched.length);
  return matched.map((item, index) => ({
    criterion_id: item.id, criterion_text: item.text,
    weight: weight + (index < 100 % matched.length ? 1 : 0),
  }));
}

export function loadSampleCriteriaCandidates(roleId: string, ids: readonly string[]): CriteriaCandidateSnapshot[] {
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) {
    throw new ManagerCriteriaError('invalid_scope', 400, 'Choose one to twenty distinct candidates in the selected role.');
  }
  return ids.map(id => {
    const profile = SYNTHETIC_CANDIDATE_CORPUS.find(item => item.candidateRef === id);
    if (!profile || profile.roleId !== roleId) {
      throw new ManagerCriteriaError('invalid_scope', 400, 'Sample criteria can only assess fictional profiles in the selected role.');
    }
    const blocks = profile.sourceBlocks.map(block => ({ source_block_id: block.sourceBlockId, text: block.text }));
    return {
      candidate_id: id, display_name: profile.displayName, role_id: roleId,
      base_score: getDemoScoreDetails(id).score, document_id: `sample-${id}`,
      snapshot_sha256: createHash('sha256').update(JSON.stringify(blocks)).digest('hex'), source_blocks: blocks,
    };
  });
}

export function candidateSnapshotDigest(candidates: readonly CriteriaCandidateSnapshot[]): string {
  return createHash('sha256').update(JSON.stringify(candidates.map(item => ({
    id: item.candidate_id, name: item.display_name, role: item.role_id, role_title: item.role_title,
    base: item.base_score, document: item.document_id, snapshot: item.snapshot_sha256,
    blocks: item.source_blocks,
  })))).digest('hex');
}

export function scoreCriteriaCandidate(
  candidate: CriteriaCandidateSnapshot,
  criteria: ManagerCriteriaCandidateResult['criteria'],
  additionalWeight: number,
): ManagerCriteriaCandidateResult {
  const additional = criteria.reduce((sum, item) => sum + item.points, 0);
  return ManagerCriteriaCandidateResultSchema.parse({
    candidate_id: candidate.candidate_id, display_name: candidate.display_name,
    base_score: candidate.base_score, additional_score: additional,
    updated_score: candidate.base_score === null ? null
      : Math.round(candidate.base_score * (100 - additionalWeight) / 100 + additional * additionalWeight / 100),
    additional_weight_percent: additionalWeight,
    provisional: criteria.some(item => item.status === 'unknown'), criteria,
  });
}

export function evaluateSampleCriteria(
  candidates: readonly CriteriaCandidateSnapshot[], criteria: ManagerCriterion[], weight: number,
): ManagerCriteriaCandidateResult[] {
  ManagerCriteriaSchema.parse(criteria);
  return candidates.map(candidate => scoreCriteriaCandidate(candidate, criteria.map(criterion => {
    const definition = SAMPLE_CATALOG.find(item => item.id === criterion.criterion_id && item.text === criterion.criterion_text);
    if (!definition) throw new ManagerCriteriaError('invalid_criteria', 422, 'Request a new proposal to change criterion wording.');
    // Keep independent assertions separate: seeking a first café role does not
    // invalidate an explicit availability clause in the same source block.
    const evidence = candidate.source_blocks.filter(block => block.text.split(/[.;!?]|\b(?:and|but|however)\b/iu)
      .some(clause => definition.evidence.test(clause)
        && !/\b(?:not|no|never|without|lack|lacks|cannot|can.t|unavailable|seeking|aspiring|hoping|want|wants|eager to|learn to|learning)\b/i.test(clause)))
      .slice(0, 5).map(block => ({ source_block_id: block.source_block_id, exact_quote: block.text }));
    return { ...criterion, status: evidence.length ? 'met' as const : 'unknown' as const,
      points: evidence.length ? criterion.weight : 0, evidence };
  }), weight));
}

const ApprovalClaimsSchema = z.object({
  version: z.literal(1), proposal_id: z.uuid(), mode: z.enum(['sample', 'connected']),
  merchant_id: z.string(), role_id: z.string(), candidate_ids: z.array(z.string()).min(1).max(20),
  criteria: ManagerCriteriaSchema, snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.number().int(),
}).strict();
export type ApprovalClaims = z.infer<typeof ApprovalClaimsSchema>;

export function createCriteriaApprovalAuthority(options: { secret?: Uint8Array; now?: () => number } = {}) {
  const secret = options.secret ?? randomBytes(32);
  const now = options.now ?? Date.now;
  return {
    issue(input: Omit<ApprovalClaims, 'version' | 'proposal_id' | 'expires_at'>) {
      const claims = ApprovalClaimsSchema.parse({ ...input, version: 1, proposal_id: randomUUID(), expires_at: now() + 15 * 60_000 });
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = createHmac('sha256', secret).update(payload).digest('base64url');
      return { claims, token: `${payload}.${signature}` };
    },
    verify(token: string): ApprovalClaims {
      const parts = token.split('.');
      if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
        throw new ManagerCriteriaError('invalid_approval', 409, 'This proposal is no longer valid. Create a new proposal.');
      }
      const expected = createHmac('sha256', secret).update(parts[0]).digest();
      const actual = Buffer.from(parts[1], 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new ManagerCriteriaError('invalid_approval', 409, 'This proposal is no longer valid. Create a new proposal.');
      }
      let claims: ApprovalClaims;
      try { claims = ApprovalClaimsSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString())); }
      catch { throw new ManagerCriteriaError('invalid_approval', 409, 'This proposal is no longer valid. Create a new proposal.'); }
      if (claims.expires_at <= now()) throw new ManagerCriteriaError('expired_approval', 409, 'This proposal expired. Create a new proposal before approving.');
      return claims;
    },
  };
}

export function assertApprovedCriteria(claims: ApprovalClaims, criteria: ManagerCriterion[]): void {
  if (criteria.length !== claims.criteria.length || criteria.some((item, index) => (
    item.criterion_id !== claims.criteria[index].criterion_id || item.criterion_text !== claims.criteria[index].criterion_text
  ))) throw new ManagerCriteriaError('invalid_approval', 409, 'Criterion wording changed. Create a new proposal before approving.');
  criteria.forEach(item => assertSafeManagerRequest(item.criterion_text));
}
