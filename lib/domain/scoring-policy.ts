export type ScoringCriterionStatus = 'met' | 'not_met' | 'unknown';

export interface WeightedScoringCriterion {
  weight: number;
  status: ScoringCriterionStatus;
}

export interface WeightedScoreSummary {
  earnedPoints: number;
  totalWeight: number;
  metCriteria: number;
  criterionCount: number;
}

/**
 * Role-policy scores are deterministic: a met criterion earns its full configured
 * weight; not-met and unknown criteria earn no points.
 */
export function scoreCriterion(criterion: WeightedScoringCriterion): number {
  return criterion.status === 'met' ? criterion.weight : 0;
}

export function summarizeWeightedScore(
  criteria: readonly WeightedScoringCriterion[],
): WeightedScoreSummary {
  return criteria.reduce<WeightedScoreSummary>((summary, criterion) => ({
    earnedPoints: summary.earnedPoints + scoreCriterion(criterion),
    totalWeight: summary.totalWeight + criterion.weight,
    metCriteria: summary.metCriteria + (criterion.status === 'met' ? 1 : 0),
    criterionCount: summary.criterionCount + 1,
  }), {
    earnedPoints: 0,
    totalWeight: 0,
    metCriteria: 0,
    criterionCount: 0,
  });
}
