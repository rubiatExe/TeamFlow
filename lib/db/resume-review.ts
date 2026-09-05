import type { DocumentExtractionResult } from '../contracts/document-extraction.ts';
import { buildStoredResumeDocumentSnapshot } from '../contracts/resume-review-storage.ts';
import { getSupabase } from './supabase.ts';

export async function saveResumeDocumentExtraction(
  merchantId: string,
  extraction: DocumentExtractionResult,
): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const snapshot = buildStoredResumeDocumentSnapshot(merchantId, extraction);

  const { error } = await db.from('resume_documents').insert(snapshot);
  if (error) {
    if (error.code === '23505') {
      const { data: existing, error: readError } = await db
        .from('resume_documents')
        .select('snapshot_sha256')
        .eq('merchant_id', merchantId)
        .eq('document_id', extraction.document_id)
        .limit(1)
        .maybeSingle();
      if (!readError && existing?.snapshot_sha256 === snapshot.snapshot_sha256) {
        return true;
      }
    }
    console.error('[Supabase] Resume document save failed', {
      code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'unknown',
    });
    return false;
  }
  return true;
}

export async function linkResumeDocumentToCandidate(
  merchantId: string,
  candidateId: string,
  documentId: string,
): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;

  const { error } = await db.from('candidate_resume_documents').insert({
    merchant_id: merchantId,
    candidate_id: candidateId,
    document_id: documentId,
  });
  if (!error || error.code === '23505') return true;
  console.error('[Supabase] Candidate/document link failed', {
    code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'unknown',
  });
  return false;
}
