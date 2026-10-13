import type { CandidateCardData, CandidateWithStatus } from '../contracts/candidate.ts';
import type { ManagerCriteriaEvaluation, ManagerCriteriaProposal, ManagerCriterion } from '../contracts/manager-criteria.ts';

export function criteriaBaseScore(data: CandidateCardData, sample: boolean): number | null {
  if (sample) return data.score.total;
  return data.score.calculation === 'weighted_policy'
    && data.score.approved_policy?.role_id === data.candidate.applied_job_id
    && data.candidate.applied_job_id !== undefined ? data.score.total : null;
}

export function evaluationMatchesApproval(
  evaluation: ManagerCriteriaEvaluation,
  proposal: ManagerCriteriaProposal,
  criteria: ManagerCriterion[],
  weight: number,
): boolean {
  return evaluation.proposal_id === proposal.proposal_id
    && evaluation.role_id === proposal.role_id && evaluation.mode === proposal.mode
    && evaluation.additional_weight_percent === weight
    && JSON.stringify(evaluation.criteria) === JSON.stringify(criteria)
    && JSON.stringify(evaluation.results.map(result => result.candidate_id).sort())
      === JSON.stringify(proposal.candidate_ids.slice().sort());
}

/** An assessment is a snapshot; never attach it to a changed base, role, or data source. */
export function isCriteriaEvaluationCurrent(
  evaluation: ManagerCriteriaEvaluation,
  candidates: readonly CandidateWithStatus[],
  sample: boolean,
): boolean {
  if (evaluation.mode !== (sample ? 'sample' : 'connected')) return false;
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  return evaluation.results.every(result => {
    const candidate = byId.get(result.candidate_id);
    return candidate !== undefined
      && candidate.data.candidate.applied_role === evaluation.role_id
      && criteriaBaseScore(candidate.data, sample) === result.base_score;
  });
}
