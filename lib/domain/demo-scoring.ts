import {
  ApprovedCandidateScoreDetailsSchema,
  type ApprovedCandidateScoreDetails,
} from '../contracts/candidate-score.ts';
import { SYNTHETIC_CANDIDATE_CORPUS } from './demo-semantic-search-data.ts';
import { summarizeWeightedScore } from './scoring-policy.ts';

type DemoRoleId = typeof SYNTHETIC_CANDIDATE_CORPUS[number]['roleId'];

interface DemoScoringCriterion {
  criterion_id: string;
  criterion_text: string;
  weight: number;
  evidenceTopics: readonly string[];
}

interface DemoScoringPolicy {
  role_id: string;
  role_title: string;
  policy_id: string;
  policy_version: string;
  criteria: readonly DemoScoringCriterion[];
}

function criterion(
  criterion_id: string,
  criterion_text: string,
  weight: number,
  ...evidenceTopics: string[]
): DemoScoringCriterion {
  return { criterion_id, criterion_text, weight, evidenceTopics };
}

// Illustrative policies for the fictional workspace, never production hiring
// policies or human approvals. Only explicit job-skill evidence earns points;
// absent evidence is unknown, not evidence that the person lacks a skill.
export const DEMO_SCORING_POLICIES: Readonly<Record<DemoRoleId, DemoScoringPolicy>> = {
  barista: {
    role_id: '00000000-0000-4000-8000-000000000001',
    role_title: 'Barista',
    policy_id: 'sample-barista-v1',
    policy_version: '1.0.0',
    criteria: [
      criterion('espresso', 'Espresso preparation and grinder calibration', 35, 'Espresso'),
      criterion('latte-art', 'Latte art and drink presentation', 15, 'Latte art'),
      criterion('guest-service', 'Customer service experience', 25, 'Customer service'),
      criterion('pos-systems', 'POS transaction experience', 15, 'POS systems'),
      criterion('sanitation', 'Documented sanitation practices', 10, 'Sanitation'),
    ],
  },
  shift_lead: {
    role_id: '00000000-0000-4000-8000-000000000002',
    role_title: 'Shift Supervisor',
    policy_id: 'sample-shift-lead-v1',
    policy_version: '1.0.0',
    criteria: [
      criterion('leadership', 'Team leadership during service', 30, 'Leadership'),
      criterion('staff-coaching', 'Staff training or coaching', 20, 'Barista training', 'Team coaching'),
      criterion('scheduling', 'Staff scheduling and coverage', 20, 'Scheduling'),
      criterion('inventory', 'Inventory management and ordering', 20, 'Inventory'),
      criterion('cash-controls', 'Cash controls and variance handling', 10, 'Cash controls'),
    ],
  },
  line_cook: {
    role_id: '00000000-0000-4000-8000-000000000003',
    role_title: 'Line Cook',
    policy_id: 'sample-line-cook-v1',
    policy_version: '1.0.0',
    criteria: [
      criterion('line-cooking', 'Hot-line cooking during service', 35, 'Line cooking'),
      criterion('knife-prep', 'Knife skills and ingredient preparation', 25, 'Knife skills'),
      criterion('food-safety', 'Documented food safety practices', 20, 'Food safety'),
      criterion('sanitation', 'Closing sanitation practices', 10, 'Sanitation'),
      criterion('plating', 'Plating and presentation experience', 10, 'Plating'),
    ],
  },
  prep_cook: {
    role_id: '00000000-0000-4000-8000-000000000004',
    role_title: 'Prep Cook',
    policy_id: 'sample-prep-cook-v1',
    policy_version: '1.0.0',
    criteria: [
      criterion('ingredient-prep', 'Knife skills or ingredient preparation', 40, 'Knife skills', 'Food prep'),
      criterion('food-safety', 'Safe food storage and handling', 25, 'Food safety'),
      criterion('receiving', 'Ingredient receiving and stock controls', 20, 'Receiving'),
      criterion('recipe-scaling', 'Recipe scaling for batch preparation', 15, 'Recipe scaling'),
    ],
  },
  cashier: {
    role_id: '00000000-0000-4000-8000-000000000005',
    role_title: 'Cashier',
    policy_id: 'sample-cashier-v1',
    policy_version: '1.0.0',
    criteria: [
      criterion('guest-recovery', 'Guest concern resolution', 30, 'Guest recovery'),
      criterion('cash-handling', 'Cash handling and drawer balancing', 30, 'Cash handling'),
      criterion('pos-systems', 'POS transaction experience', 25, 'POS systems'),
      criterion('coffee-service', 'Espresso preparation for counter service', 15, 'Espresso'),
    ],
  },
  baker: {
    role_id: '00000000-0000-4000-8000-000000000006',
    role_title: 'Baker / Pastry',
    policy_id: 'sample-baker-v1',
    policy_version: '1.0.0',
    criteria: [
      criterion('bread-production', 'Sourdough production and fermentation', 35, 'Sourdough'),
      criterion('recipe-scaling', 'Recipe scaling and batch yields', 25, 'Recipe scaling'),
      criterion('oven-operations', 'Oven operations and production timing', 25, 'Oven operations'),
      criterion('food-safety', 'Documented food safety training', 15, 'Food safety'),
    ],
  },
};

export function getDemoScoreEvidence(candidateId: string) {
  const profile = SYNTHETIC_CANDIDATE_CORPUS.find(item => item.candidateRef === candidateId);
  if (!profile) throw new Error('Sample scoring requires a canonical fictional candidate.');
  const policy = DEMO_SCORING_POLICIES[profile.roleId];
  return policy.criteria.map(({ evidenceTopics, ...criterionDetails }) => {
    const sourceBlockIds = profile.sourceBlocks
      .filter(block => evidenceTopics.some(topic => (block.topics as readonly string[]).includes(topic)))
      .map(block => block.sourceBlockId);
    return {
      ...criterionDetails,
      status: sourceBlockIds.length > 0 ? 'met' as const : 'unknown' as const,
      sourceBlockIds,
    };
  });
}

export function getDemoScoreDetails(candidateId: string): ApprovedCandidateScoreDetails {
  const profile = SYNTHETIC_CANDIDATE_CORPUS.find(item => item.candidateRef === candidateId);
  if (!profile) throw new Error('Sample scoring requires a canonical fictional candidate.');
  const policy = DEMO_SCORING_POLICIES[profile.roleId];
  const criteria = getDemoScoreEvidence(candidateId).map(({ criterion_id, criterion_text, weight, status }) => ({
    criterion_id, criterion_text, weight, status,
  }));
  return ApprovedCandidateScoreDetailsSchema.parse({
    role_id: policy.role_id,
    role_title: policy.role_title,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    score: summarizeWeightedScore(criteria).earnedPoints,
    criteria,
  });
}
