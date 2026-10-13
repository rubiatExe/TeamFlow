import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApplicationCompleteness, ApplicationEvidenceRow } from '../contracts/application-completeness.ts';
import { summarizeApplicationCompleteness, unknownApplicationCompleteness } from '../domain/application-completeness.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 1_000;
type ApplicationCandidateReference = { id?: string; resume_url: string };

function webformApplicationId(candidate: ApplicationCandidateReference): string | undefined {
  if (!candidate.resume_url.startsWith('webform_')) return undefined;
  const id = candidate.resume_url.slice('webform_'.length);
  return UUID.test(id) ? id : undefined;
}

/** Input candidates must already be scoped to the authorized merchant. Never join by name/email. */
export async function loadApplicationCompleteness(
  db: SupabaseClient,
  candidates: ApplicationCandidateReference[],
): Promise<Map<string, ApplicationCompleteness>> {
  const result = new Map<string, ApplicationCompleteness>();
  const candidateIds = candidates.flatMap(candidate => candidate.id && UUID.test(candidate.id) ? [candidate.id] : []);
  const applicationIds = candidates.flatMap(candidate => {
    const id = webformApplicationId(candidate);
    return id ? [id] : [];
  });
  if (candidateIds.length === 0 && applicationIds.length === 0) return result;

  async function readApplications(column: 'candidate_id' | 'id', ids: string[]): Promise<ApplicationEvidenceRow[]> {
    if (ids.length === 0) return [];
    const rows: ApplicationEvidenceRow[] = [];
    // Both the IN list and page count are bounded; a truncated lookup never means "not submitted".
    for (let start = 0; start < ids.length; start += 100) {
      const chunk = Array.from(new Set(ids.slice(start, start + 100)));
      let exhausted = false;
      for (let page = 0; page < 10; page += 1) {
        const { data, error } = await db.from('applications')
          .select('id,candidate_id,role_id,data,submitted_at')
          .in(column, chunk)
          .order('submitted_at', { ascending: false, nullsFirst: false })
          .order('id', { ascending: true })
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (error || !Array.isArray(data)) throw new Error('Application status lookup unavailable');
        rows.push(...data as ApplicationEvidenceRow[]);
        if (data.length < PAGE_SIZE) {
          exhausted = true;
          break;
        }
      }
      if (!exhausted) throw new Error('Application status lookup limit reached');
    }
    return rows;
  }

  try {
    const [linkedRows, webformRows] = await Promise.all([
      readApplications('candidate_id', candidateIds),
      readApplications('id', applicationIds),
    ]);
    const allRows = [...new Map([...linkedRows, ...webformRows].map(row => [row.id, row])).values()];
    for (const candidate of candidates) {
      if (!candidate.id || !UUID.test(candidate.id)) continue;
      const directId = webformApplicationId(candidate);
      const matchingRows = allRows.filter(row => row.candidate_id === candidate.id || row.id === directId);
      // A referenced form missing from the database is not proof that no form was submitted.
      result.set(candidate.id, directId && !matchingRows.some(row => row.id === directId)
        ? unknownApplicationCompleteness('This profile references an application that could not be loaded.')
        : summarizeApplicationCompleteness(matchingRows));
    }
  } catch {
    console.warn('[Supabase] Application completeness unavailable');
    for (const candidate of candidates) {
      if (candidate.id) result.set(candidate.id, unknownApplicationCompleteness());
    }
  }
  return result;
}
