import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getSupabase } from './supabase.ts';
import { SourceBlockSchema, ExtractionMethodSchema, ExtractionQualitySchema, ExtractionWarningSchema } from '../contracts/document-extraction.ts';
import { Agent1EvaluationSchema, RoleScoringPolicySchema } from '../contracts/resume-review.ts';
import { buildApprovedCandidateScoreDetails } from '../contracts/candidate-score.ts';
import { CAFE_ROLES } from '../domain/roles.ts';
import { ManagerCriteriaError, type CriteriaCandidateSnapshot } from '../domain/manager-criteria.ts';

const StoredDocumentSchema = z.object({
  schema_version: z.literal('1.0'), merchant_id: z.uuid(), document_id: z.string().regex(/^doc-[a-f0-9]{64}$/),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/), snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['complete', 'degraded']), text: z.string().min(1).max(100_000),
  source_blocks: z.array(SourceBlockSchema).min(1).max(512),
  extraction_method: ExtractionMethodSchema.exclude(['none', 'mock']), model_id: z.string().min(1).max(200),
  embedding_available: z.boolean(), mock: z.literal(false), warnings: z.array(ExtractionWarningSchema).max(16),
  quality: ExtractionQualitySchema,
});
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}

export function validateCriteriaStoredDocument(raw: unknown, merchantId: string) {
  const parsed = StoredDocumentSchema.safeParse(raw);
  if (!parsed.success) throw new ManagerCriteriaError('document_unavailable', 409, 'A candidate needs a canonical, linked résumé extraction before criteria can be assessed.');
  const { snapshot_sha256, ...snapshot } = parsed.data;
  if (snapshot.merchant_id !== merchantId || snapshot.document_id !== `doc-${snapshot.content_sha256}`
    || snapshot.quality.assessment !== 'usable'
    || new Set(snapshot.source_blocks.map(block => block.source_block_id)).size !== snapshot.source_blocks.length
    || snapshot.source_blocks.some(block => !block.source_block_id.startsWith(`src-${snapshot.content_sha256.slice(0, 12)}-`))
    || createHash('sha256').update(JSON.stringify(canonicalize(snapshot))).digest('hex') !== snapshot_sha256) {
    throw new ManagerCriteriaError('document_unavailable', 409, 'The stored résumé snapshot could not be verified. Re-extract it before assessment.');
  }
  return parsed.data;
}

/** Local-demo only; the HTTP adapter gates this before privileged reads. */
export async function loadConnectedCriteriaCandidates(merchantId: string, roleId: string, ids: string[]): Promise<CriteriaCandidateSnapshot[]> {
  if (!z.uuid().safeParse(merchantId).success || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length
    || ids.some(id => !z.uuid().safeParse(id).success)) {
    throw new ManagerCriteriaError('invalid_scope', 400, 'Choose saved candidates in the selected role.');
  }
  const db = getSupabase();
  if (!db) throw new ManagerCriteriaError('candidates_unavailable', 503, 'Saved candidates are unavailable. No scores were changed.');
  const signal = AbortSignal.timeout(5_000);
  const { data: candidates, error } = await db.from('candidates').select('id,name,job_id,fit_score,analysis')
    .eq('merchant_id', merchantId).in('id', ids).limit(20).abortSignal(signal);
  if (error || !candidates || candidates.length !== ids.length) {
    throw new ManagerCriteriaError('candidates_unavailable', 503, 'The selected saved candidates could not be loaded.');
  }
  const jobIds = [...new Set(candidates.flatMap(row => {
    const analysis = Agent1EvaluationSchema.safeParse(row.analysis);
    return [...(typeof row.job_id === 'string' ? [row.job_id] : []),
      ...(analysis.success ? analysis.data.ranked_roles.map(role => role.role_id) : [])];
  }))];
  const { data: jobs, error: jobError } = await db.from('jobs')
    .select('id,title,scoring_policy_id,scoring_policy_version,scoring_criteria').eq('merchant_id', merchantId)
    .in('id', jobIds).limit(400).abortSignal(signal);
  if (jobError) throw new ManagerCriteriaError('candidates_unavailable', 503, 'Candidate role policies could not be loaded.');
  // Fetch at most two links per candidate, individually: ambiguous document
  // histories must be resolved explicitly, never choose an arbitrary résumé.
  const links = await Promise.all(ids.map(async id => {
    const { data, error: linkError } = await db.from('candidate_resume_documents').select('document_id')
      .eq('merchant_id', merchantId).eq('candidate_id', id).limit(2).abortSignal(signal);
    if (linkError || !data || data.length !== 1) throw new ManagerCriteriaError('document_unavailable', 409,
      'Each selected candidate needs exactly one canonical linked résumé before this session assessment.');
    return { candidateId: id, documentId: data[0].document_id as string };
  }));
  const { data: documents, error: documentError } = await db.from('resume_documents').select('*')
    .eq('merchant_id', merchantId).in('document_id', [...new Set(links.map(link => link.documentId))]).limit(20).abortSignal(signal);
  if (documentError || !documents) throw new ManagerCriteriaError('document_unavailable', 503, 'Canonical résumé documents could not be loaded.');
  const documentMap = new Map(documents.map(row => {
    const document = validateCriteriaStoredDocument(row, merchantId);
    return [document.document_id, document];
  }));
  return ids.map(id => {
    const row = candidates.find(item => item.id === id)!;
    const job = jobs?.find(item => item.id === row.job_id);
    const canonicalRole = CAFE_ROLES.find(item => typeof job?.title === 'string' && item.title.toLowerCase() === job.title.toLowerCase());
    if (row.job_id !== roleId && canonicalRole?.id !== roleId) throw new ManagerCriteriaError('invalid_scope', 409, 'A candidate no longer belongs to the selected role. Refresh and try again.');
    const analysis = Agent1EvaluationSchema.safeParse(row.analysis);
    const policies = (jobs ?? []).flatMap(item => {
      if (!analysis.success || !analysis.data.ranked_roles.some(role => role.role_id === item.id)) return [];
      const policy = RoleScoringPolicySchema.safeParse({ schema_version: '1.0', role_id: item.id, role_title: item.title,
        policy_identity: { policy_id: item.scoring_policy_id, policy_version: item.scoring_policy_version }, criteria: item.scoring_criteria });
      return policy.success ? [policy.data] : [];
    });
    const approved = analysis.success ? buildApprovedCandidateScoreDetails(analysis.data, policies, row.fit_score) : null;
    // The durable review projects the best-ranked role without reassigning the
    // application. Never blend that score with criteria for a different job.
    const baseScore = approved && approved.role_id === row.job_id ? approved.score : null;
    const document = documentMap.get(links.find(link => link.candidateId === id)!.documentId);
    if (!document) throw new ManagerCriteriaError('document_unavailable', 409, 'A linked canonical résumé is missing.');
    return {
      candidate_id: id, display_name: row.name, role_id: roleId, role_title: job?.title, base_score: baseScore,
      document_id: document.document_id, snapshot_sha256: document.snapshot_sha256,
      source_blocks: document.source_blocks.map(block => ({ source_block_id: block.source_block_id, text: block.text })),
    };
  });
}
