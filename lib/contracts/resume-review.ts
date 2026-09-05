import { z } from 'zod';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const databaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const semanticVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const sharedBlankTextPattern = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]*$/u;

const IdentifierSchema = z.string().min(3).max(120).regex(identifierPattern);
const DatabaseIdSchema = z.string().regex(databaseIdPattern, 'Invalid lowercase UUID');
const SemanticVersionSchema = z.string().regex(semanticVersionPattern);

function nonBlankText(maxLength: number, minLength = 1) {
  return z.string().superRefine((value, context) => {
    if (value.length > maxLength * 2) {
      context.addIssue({
        code: 'custom',
        message: `text must contain at most ${maxLength} Unicode code points`,
      });
      return;
    }
    const codePointLength = Array.from(value).length;
    if (codePointLength < minLength) {
      context.addIssue({
        code: 'custom',
        message: `text must contain at least ${minLength} Unicode code points`,
      });
    } else if (codePointLength > maxLength) {
      context.addIssue({
        code: 'custom',
        message: `text must contain at most ${maxLength} Unicode code points`,
      });
    }
    if (sharedBlankTextPattern.test(value)) {
      context.addIssue({ code: 'custom', message: 'text must not be blank' });
    }
  });
}

export const BoundedTextSchema = nonBlankText(1_000);

function hasDuplicates<T>(values: readonly T[]): boolean {
  return new Set(values).size !== values.length;
}

export const CriterionStatusSchema = z.enum(['met', 'not_met', 'unknown']);
export const GapStatusSchema = z.enum(['not_met', 'unknown']);
export const GapReasonCodeSchema = z.enum([
  'criterion_not_met',
  'criterion_unknown',
]);
export const QuestionPrioritySchema = z.enum(['high', 'medium', 'low']);

export const PolicyIdentitySchema = z.object({
  policy_id: IdentifierSchema,
  policy_version: SemanticVersionSchema,
}).strict();

export const WeightedCriterionSchema = z.object({
  criterion_id: IdentifierSchema,
  criterion_text: nonBlankText(1_000),
  weight: z.number().int().min(0).max(100),
}).strict();

export const RoleScoringPolicySchema = z.object({
  schema_version: z.literal('1.0'),
  role_id: DatabaseIdSchema,
  role_title: nonBlankText(1_000),
  policy_identity: PolicyIdentitySchema,
  criteria: z.array(WeightedCriterionSchema).min(1).max(30),
}).strict().superRefine((policy, context) => {
  const criterionIds = policy.criteria.map(criterion => criterion.criterion_id);
  if (hasDuplicates(criterionIds)) {
    context.addIssue({
      code: 'custom',
      path: ['criteria'],
      message: 'criterion_id values must be unique within a role policy',
    });
  }
  const totalWeight = policy.criteria.reduce(
    (total, criterion) => total + criterion.weight,
    0,
  );
  if (totalWeight !== 100) {
    context.addIssue({
      code: 'custom',
      path: ['criteria'],
      message: 'configured criterion weights must sum to 100',
    });
  }
});

export const SourceEvidenceSchema = z.object({
  criterion_id: IdentifierSchema,
  exact_quote: nonBlankText(2_000, 8),
  source_block_id: IdentifierSchema,
}).strict();

export const CriterionAssessmentSchema = z.object({
  criterion_id: IdentifierSchema,
  status: CriterionStatusSchema,
  evidence: z.array(SourceEvidenceSchema).max(8),
}).strict().superRefine((assessment, context) => {
  if (
    (assessment.status === 'met' || assessment.status === 'not_met') &&
    assessment.evidence.length === 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'met and not_met assessments require source evidence',
    });
  }
  if (assessment.status === 'unknown' && assessment.evidence.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'unknown assessments must not claim source evidence',
    });
  }
  assessment.evidence.forEach((evidence, index) => {
    if (evidence.criterion_id !== assessment.criterion_id) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', index, 'criterion_id'],
        message: 'evidence criterion_id must match its assessment',
      });
    }
  });
  const evidenceKeys = assessment.evidence.map(evidence => JSON.stringify([
    evidence.criterion_id,
    evidence.exact_quote,
    evidence.source_block_id,
  ]));
  if (hasDuplicates(evidenceKeys)) {
    context.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'evidence references must be unique',
    });
  }
});

export const Agent1RoleAssessmentSchema = z.object({
  role_id: DatabaseIdSchema,
  criterion_assessments: z.array(CriterionAssessmentSchema).min(1).max(30),
}).strict().superRefine((assessment, context) => {
  const criterionIds = assessment.criterion_assessments
    .map(criterion => criterion.criterion_id);
  if (hasDuplicates(criterionIds)) {
    context.addIssue({
      code: 'custom',
      path: ['criterion_assessments'],
      message: 'criterion_id values must be unique within a role assessment',
    });
  }
});

export const Agent1ModelOutputSchema = z.object({
  schema_version: z.literal('1.0'),
  role_assessments: z.array(Agent1RoleAssessmentSchema).min(1).max(20),
  limitations: z.array(nonBlankText(1_000)).max(20),
}).strict().superRefine((output, context) => {
  const roleIds = output.role_assessments.map(role => role.role_id);
  if (hasDuplicates(roleIds)) {
    context.addIssue({
      code: 'custom',
      path: ['role_assessments'],
      message: 'role_id values must be unique in Agent 1 output',
    });
  }
  if (hasDuplicates(output.limitations)) {
    context.addIssue({
      code: 'custom',
      path: ['limitations'],
      message: 'limitations must be unique',
    });
  }
});

export const ValidatedGapSchema = z.object({
  role_id: DatabaseIdSchema,
  criterion_id: IdentifierSchema,
  criterion_text: nonBlankText(1_000),
  status: GapStatusSchema,
  reason_code: GapReasonCodeSchema,
}).strict().superRefine((gap, context) => {
  const expectedReason = gap.status === 'not_met'
    ? 'criterion_not_met'
    : 'criterion_unknown';
  if (gap.reason_code !== expectedReason) {
    context.addIssue({
      code: 'custom',
      path: ['reason_code'],
      message: 'gap reason_code must match the gap status',
    });
  }
});

export const RoleMatchSchema = z.object({
  role_id: DatabaseIdSchema,
  deterministic_score: z.number().int().min(0).max(100),
  scoring_policy: PolicyIdentitySchema,
  criterion_assessments: z.array(CriterionAssessmentSchema).min(1).max(30),
  gaps: z.array(ValidatedGapSchema).max(30),
}).strict().superRefine((roleMatch, context) => {
  const criterionIds = roleMatch.criterion_assessments
    .map(assessment => assessment.criterion_id);
  if (hasDuplicates(criterionIds)) {
    context.addIssue({
      code: 'custom',
      path: ['criterion_assessments'],
      message: 'criterion_id values must be unique within a role match',
    });
  }

  const gapIds = roleMatch.gaps.map(gap => gap.criterion_id);
  if (hasDuplicates(gapIds)) {
    context.addIssue({
      code: 'custom',
      path: ['gaps'],
      message: 'gap criterion_id values must be unique',
    });
  }

  const assessmentByCriterion = new Map(
    roleMatch.criterion_assessments.map(assessment => [
      assessment.criterion_id,
      assessment,
    ]),
  );
  const expectedGapIds = new Set(
    roleMatch.criterion_assessments
      .filter(assessment => assessment.status !== 'met')
      .map(assessment => assessment.criterion_id),
  );
  if (
    gapIds.length !== expectedGapIds.size ||
    gapIds.some(criterionId => !expectedGapIds.has(criterionId))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['gaps'],
      message: 'gaps must exactly match not_met and unknown assessments',
    });
  }
  roleMatch.gaps.forEach((gap, index) => {
    const assessment = assessmentByCriterion.get(gap.criterion_id);
    if (gap.role_id !== roleMatch.role_id) {
      context.addIssue({
        code: 'custom',
        path: ['gaps', index, 'role_id'],
        message: 'gap role_id must match its role match',
      });
    }
    if (assessment && gap.status !== assessment.status) {
      context.addIssue({
        code: 'custom',
        path: ['gaps', index, 'status'],
        message: 'gap status must match its criterion assessment',
      });
    }
  });
});

export const Agent1EvaluationSchema = z.object({
  schema_version: z.literal('1.0'),
  ranked_roles: z.array(RoleMatchSchema).min(1).max(20),
  recommended_role_id: DatabaseIdSchema.nullable(),
  limitations: z.array(nonBlankText(1_000)).max(20),
}).strict().superRefine((evaluation, context) => {
  const roleIds = evaluation.ranked_roles.map(role => role.role_id);
  if (hasDuplicates(roleIds)) {
    context.addIssue({
      code: 'custom',
      path: ['ranked_roles'],
      message: 'ranked role_id values must be unique',
    });
  }
  for (let index = 1; index < evaluation.ranked_roles.length; index += 1) {
    const previous = evaluation.ranked_roles[index - 1];
    const current = evaluation.ranked_roles[index];
    const outOfOrder = previous.deterministic_score < current.deterministic_score || (
      previous.deterministic_score === current.deterministic_score &&
      previous.role_id > current.role_id
    );
    if (outOfOrder) {
      context.addIssue({
        code: 'custom',
        path: ['ranked_roles', index],
        message: 'ranked_roles must be sorted by score then role_id',
      });
    }
  }
  const topScore = evaluation.ranked_roles[0]?.deterministic_score;
  const topIsTied = evaluation.ranked_roles.length > 1 &&
    evaluation.ranked_roles[1].deterministic_score === topScore;
  const expectedRecommendation = topScore === 0 || topIsTied
    ? null
    : evaluation.ranked_roles[0]?.role_id;
  if (evaluation.recommended_role_id !== expectedRecommendation) {
    context.addIssue({
      code: 'custom',
      path: ['recommended_role_id'],
      message: 'recommended_role_id must be null for zero/tied leaders and otherwise identify the first ranked role',
    });
  }
  if (hasDuplicates(evaluation.limitations)) {
    context.addIssue({
      code: 'custom',
      path: ['limitations'],
      message: 'limitations must be unique',
    });
  }
});

export const Agent2PlanningContextSchema = z.object({
  schema_version: z.literal('1.0'),
  role_id: DatabaseIdSchema,
  gaps: z.array(ValidatedGapSchema).max(30),
}).strict().superRefine((planningContext, context) => {
  const criterionIds = planningContext.gaps.map(gap => gap.criterion_id);
  if (hasDuplicates(criterionIds)) {
    context.addIssue({
      code: 'custom',
      path: ['gaps'],
      message: 'Agent 2 context gaps must be unique',
    });
  }
  planningContext.gaps.forEach((gap, index) => {
    if (gap.role_id !== planningContext.role_id) {
      context.addIssue({
        code: 'custom',
        path: ['gaps', index, 'role_id'],
        message: 'Agent 2 context gaps must match its role_id',
      });
    }
    if (gap.status !== 'unknown') {
      context.addIssue({
        code: 'custom',
        path: ['gaps', index, 'status'],
        message: 'Agent 2 context may contain only unknown gaps',
      });
    }
  });
});

export const Agent2QuestionSchema = z.object({
  question: nonBlankText(1_000),
  target_criterion_id: IdentifierSchema,
  target_gap_status: z.literal('unknown'),
  purpose: nonBlankText(1_000),
  priority: QuestionPrioritySchema,
}).strict();

export const Agent2QuestionPlanSchema = z.object({
  schema_version: z.literal('1.0'),
  role_id: DatabaseIdSchema,
  questions: z.array(Agent2QuestionSchema).max(10),
}).strict().superRefine((plan, context) => {
  const targets = plan.questions.map(question => JSON.stringify([
    question.target_criterion_id,
    question.target_gap_status,
  ]));
  if (hasDuplicates(targets)) {
    context.addIssue({
      code: 'custom',
      path: ['questions'],
      message: 'Agent 2 questions must target unique validated gaps',
    });
  }
});

export const ConfidenceComponentSchema = z.object({
  component_id: IdentifierSchema,
  score: z.number().int().min(0).max(100),
  reason_codes: z.array(IdentifierSchema).max(20),
}).strict().superRefine((component, context) => {
  if (hasDuplicates(component.reason_codes)) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'component reason_codes must be unique',
    });
  }
});

export const ConfidenceAssessmentSchema = z.object({
  schema_version: z.literal('1.0'),
  score: z.number().int().min(0).max(100),
  is_probability: z.literal(false),
  hard_failure: z.boolean(),
  components: z.array(ConfidenceComponentSchema).min(1).max(20),
  reason_codes: z.array(IdentifierSchema).max(20),
  policy_identity: PolicyIdentitySchema,
}).strict().superRefine((assessment, context) => {
  const componentIds = assessment.components.map(component => component.component_id);
  if (hasDuplicates(componentIds)) {
    context.addIssue({
      code: 'custom',
      path: ['components'],
      message: 'confidence component_id values must be unique',
    });
  }
  if (hasDuplicates(assessment.reason_codes)) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'confidence reason_codes must be unique',
    });
  }
  if (assessment.hard_failure && assessment.reason_codes.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'hard_failure confidence requires reason_codes',
    });
  }
});

export const ResumeReviewContractFixtureSchema = z.object({
  role_scoring_policies: z.array(RoleScoringPolicySchema).min(1).max(20),
  agent1_model_output: Agent1ModelOutputSchema,
  agent1_evaluation: Agent1EvaluationSchema,
  agent2_planning_context: Agent2PlanningContextSchema,
  agent2_question_plan: Agent2QuestionPlanSchema,
  confidence_assessment: ConfidenceAssessmentSchema,
}).strict().superRefine((fixture, context) => {
  const roleIds = fixture.role_scoring_policies.map(policy => policy.role_id);
  if (hasDuplicates(roleIds)) {
    context.addIssue({
      code: 'custom',
      path: ['role_scoring_policies'],
      message: 'role scoring policies must have unique role_id values',
    });
  }
  const policyIdentities = fixture.role_scoring_policies.map(policy => JSON.stringify([
    policy.policy_identity.policy_id,
    policy.policy_identity.policy_version,
  ]));
  if (hasDuplicates(policyIdentities)) {
    context.addIssue({
      code: 'custom',
      path: ['role_scoring_policies'],
      message: 'role scoring policy identities must be unique across roles',
    });
  }
});

function assertExactIds(
  actual: Set<string>,
  expected: Set<string>,
  label: string,
): void {
  const missing = [...expected].filter(value => !actual.has(value)).sort();
  const unknown = [...actual].filter(value => !expected.has(value)).sort();
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} do not match the configured catalog ` +
      `(missing=${JSON.stringify(missing)}, unknown=${JSON.stringify(unknown)})`,
    );
  }
}

export function validateAgent1EvaluationAgainstPolicies(
  evaluationInput: unknown,
  policiesInput: unknown,
): void {
  const evaluation = Agent1EvaluationSchema.parse(evaluationInput);
  const policies = z.array(RoleScoringPolicySchema).min(1).max(20).parse(policiesInput);
  const policyByRole = new Map(policies.map(policy => [policy.role_id, policy]));
  if (policyByRole.size !== policies.length) {
    throw new Error('role scoring policy role IDs must be unique');
  }
  const policyIdentities = policies.map(policy => JSON.stringify([
    policy.policy_identity.policy_id,
    policy.policy_identity.policy_version,
  ]));
  if (hasDuplicates(policyIdentities)) {
    throw new Error('role scoring policy identities must be unique across roles');
  }
  const matchByRole = new Map(
    evaluation.ranked_roles.map(roleMatch => [roleMatch.role_id, roleMatch]),
  );
  assertExactIds(
    new Set(matchByRole.keys()),
    new Set(policyByRole.keys()),
    'Agent 1 evaluation role IDs',
  );

  for (const [roleId, policy] of policyByRole) {
    const roleMatch = matchByRole.get(roleId);
    if (!roleMatch) throw new Error(`missing role match ${roleId}`);
    if (
      roleMatch.scoring_policy.policy_id !== policy.policy_identity.policy_id ||
      roleMatch.scoring_policy.policy_version !== policy.policy_identity.policy_version
    ) {
      throw new Error(`scoring policy identity does not match role ${roleId}`);
    }
    const assessmentByCriterion = new Map(
      roleMatch.criterion_assessments.map(assessment => [
        assessment.criterion_id,
        assessment,
      ]),
    );
    const criterionById = new Map(
      policy.criteria.map(criterion => [criterion.criterion_id, criterion]),
    );
    assertExactIds(
      new Set(assessmentByCriterion.keys()),
      new Set(criterionById.keys()),
      `Agent 1 evaluation criterion IDs for role ${roleId}`,
    );
    const expectedCriterionOrder = policy.criteria
      .map(criterion => criterion.criterion_id);
    const actualCriterionOrder = roleMatch.criterion_assessments
      .map(assessment => assessment.criterion_id);
    if (JSON.stringify(actualCriterionOrder) !== JSON.stringify(expectedCriterionOrder)) {
      throw new Error(
        `criterion order does not match configured policy for role ${roleId}`,
      );
    }
    const expectedScore = policy.criteria.reduce((total, criterion) => (
      assessmentByCriterion.get(criterion.criterion_id)?.status === 'met'
        ? total + criterion.weight
        : total
    ), 0);
    if (roleMatch.deterministic_score !== expectedScore) {
      throw new Error(
        `deterministic score does not match configured weights for role ${roleId}`,
      );
    }
    const gapByCriterion = new Map(
      roleMatch.gaps.map(gap => [gap.criterion_id, gap]),
    );
    const expectedGapOrder = policy.criteria
      .filter(criterion => (
        assessmentByCriterion.get(criterion.criterion_id)?.status !== 'met'
      ))
      .map(criterion => criterion.criterion_id);
    const actualGapOrder = roleMatch.gaps.map(gap => gap.criterion_id);
    if (JSON.stringify(actualGapOrder) !== JSON.stringify(expectedGapOrder)) {
      throw new Error(
        `gap order does not match configured policy for role ${roleId}`,
      );
    }
    for (const criterion of policy.criteria) {
      const gap = gapByCriterion.get(criterion.criterion_id);
      if (gap && gap.criterion_text !== criterion.criterion_text) {
        throw new Error(
          `gap criterion text does not match configured policy for role ${roleId}`,
        );
      }
    }
  }
}

export function buildAgent2PlanningContext(
  evaluationInput: unknown,
  policiesInput: unknown,
) {
  validateAgent1EvaluationAgainstPolicies(evaluationInput, policiesInput);
  const evaluation = Agent1EvaluationSchema.parse(evaluationInput);
  if (evaluation.recommended_role_id === null) {
    throw new Error(
      'Agent 2 cannot run without a unique evidence-backed recommended role',
    );
  }
  const recommended = evaluation.ranked_roles.find(
    role => role.role_id === evaluation.recommended_role_id,
  );
  if (!recommended) throw new Error('recommended role is absent from ranked roles');
  return Agent2PlanningContextSchema.parse({
    schema_version: '1.0',
    role_id: recommended.role_id,
    gaps: recommended.gaps.filter(gap => gap.status === 'unknown'),
  });
}

export function buildApplicationQuestionPlan(contextInput: unknown) {
  const context = Agent2PlanningContextSchema.parse(contextInput);
  return Agent2QuestionPlanSchema.parse({
    schema_version: '1.0',
    role_id: context.role_id,
    questions: context.gaps.map(gap => ({
      question: `Tell me about any ${gap.criterion_id} work you have done, including the checks you used.`,
      target_criterion_id: gap.criterion_id,
      target_gap_status: 'unknown',
      purpose: 'Verify whether the unknown gap reflects an omitted résumé detail.',
      priority: 'high',
    })),
  });
}

export function validateAgent2QuestionPlan(
  contextInput: unknown,
  planInput: unknown,
  evaluationInput: unknown,
  policiesInput: unknown,
): void {
  const context = Agent2PlanningContextSchema.parse(contextInput);
  const plan = Agent2QuestionPlanSchema.parse(planInput);
  const expectedContext = buildAgent2PlanningContext(
    evaluationInput,
    policiesInput,
  );
  if (JSON.stringify(context) !== JSON.stringify(expectedContext)) {
    throw new Error(
      'Agent 2 context must be derived from the validated Agent 1 evaluation',
    );
  }
  if (plan.role_id !== context.role_id) {
    throw new Error('Agent 2 plan role_id must match the recommended role context');
  }
  const allowedTargets = new Set(context.gaps.map(gap => JSON.stringify([
    gap.criterion_id,
    gap.status,
  ])));
  const unsupported = plan.questions.filter(question => !allowedTargets.has(JSON.stringify([
    question.target_criterion_id,
    question.target_gap_status,
  ])));
  if (unsupported.length > 0) {
    throw new Error('Agent 2 question targets an unsupported validated gap');
  }
  const expectedPlan = buildApplicationQuestionPlan(context);
  if (JSON.stringify(plan) !== JSON.stringify(expectedPlan)) {
    throw new Error(
      'Agent 2 plan must reproduce the application-owned safe question template',
    );
  }
}

export type RoleScoringPolicy = z.infer<typeof RoleScoringPolicySchema>;
export type Agent1ModelOutput = z.infer<typeof Agent1ModelOutputSchema>;
export type Agent1Evaluation = z.infer<typeof Agent1EvaluationSchema>;
export type Agent2PlanningContext = z.infer<typeof Agent2PlanningContextSchema>;
export type Agent2QuestionPlan = z.infer<typeof Agent2QuestionPlanSchema>;
export type ConfidenceAssessment = z.infer<typeof ConfidenceAssessmentSchema>;
