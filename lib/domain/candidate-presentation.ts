import type { CandidateStatus, CandidateWithStatus } from '../contracts/candidate.ts';
import type { CandidateRow } from '../db/supabase.ts';
import { CAFE_ROLES, getRoleById } from './roles.ts';
import { unknownApplicationCompleteness } from './application-completeness.ts';

export function hasCandidateScore(candidate: CandidateWithStatus): candidate is CandidateWithStatus & {
  data: { score: { total: number } };
} {
  return typeof candidate.data.score.total === 'number'
    && Number.isInteger(candidate.data.score.total)
    && candidate.data.score.total >= 0
    && candidate.data.score.total <= 100;
}

export function compareCandidateScores(left: CandidateWithStatus, right: CandidateWithStatus): number {
  const leftScored = hasCandidateScore(left);
  const rightScored = hasCandidateScore(right);
  if (leftScored && rightScored) return right.data.score.total - left.data.score.total;
  if (leftScored !== rightScored) return leftScored ? -1 : 1;
  return left.data.candidate.name.localeCompare(right.data.candidate.name);
}

export function rowToCandidate(row: CandidateRow): CandidateWithStatus {
  const jobTitle = row.job_title?.trim();
  const requestedRole = row.job_id || row.analysis?.applied_role;
  const knownRole = CAFE_ROLES.find(role => jobTitle && role.title.toLocaleLowerCase('en-US') === jobTitle.toLocaleLowerCase('en-US'))
    ?? (requestedRole ? getRoleById(requestedRole) : undefined);
  const roleId = knownRole?.id ?? requestedRole ?? 'unassigned';
  const total = typeof row.fit_score === 'number' && Number.isInteger(row.fit_score)
    && row.fit_score >= 0 && row.fit_score <= 100 ? row.fit_score : null;
  const approvedPolicy = total !== null && row.approved_score?.score === total ? row.approved_score : undefined;
  const legacyBreakdown = row.analysis?.breakdown;
  const legacyTotal = legacyBreakdown
    ? legacyBreakdown.constraints + legacyBreakdown.experience + legacyBreakdown.logistics
    : null;
  const calculation = total === null
    ? 'awaiting_review'
    : approvedPolicy
      ? 'weighted_policy'
      : legacyBreakdown && legacyTotal === total
        ? 'legacy_preview'
        : 'unavailable';

  return {
    id: row.id || `candidate_${crypto.randomUUID()}`,
    status: (row.status as CandidateStatus) || 'new',
    data: {
      application: row.application ?? unknownApplicationCompleteness(),
      candidate: {
        name: row.name,
        email: row.email,
        phone: row.phone,
        city: row.city,
        skills: row.analysis?.skills || [],
        experience_years: row.analysis?.experience_years,
        applied_role: roleId,
        applied_job_id: row.job_id,
        applied_role_title: jobTitle || knownRole?.title || row.analysis?.applied_role || 'Role not assigned',
      },
      score: {
        total,
        breakdown: legacyBreakdown || { constraints: 0, experience: 0, logistics: 0 },
        explanation: approvedPolicy
          ? `Human-approved score calculated from ${approvedPolicy.criteria.length} weighted criteria.`
          : row.analysis?.explanation || row.summary || 'Awaiting manager review.',
        calculation,
        approved_policy: approvedPolicy,
      },
      red_flags: row.red_flags || [],
    },
  };
}
