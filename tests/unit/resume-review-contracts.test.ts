import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  Agent1EvaluationSchema,
  Agent1ModelOutputSchema,
  Agent2PlanningContextSchema,
  Agent2QuestionPlanSchema,
  ConfidenceAssessmentSchema,
  CriterionAssessmentSchema,
  ResumeReviewContractFixtureSchema,
  RoleScoringPolicySchema,
  SourceEvidenceSchema,
  validateAgent1EvaluationAgainstPolicies,
  validateAgent2QuestionPlan,
} from '../../lib/contracts/resume-review.ts';

const fixturePayload: unknown = JSON.parse(readFileSync(
  new URL('../fixtures/resume-review-contract-v1.json', import.meta.url),
  'utf8',
));

type ConformanceFixture = {
  text_cases: Array<{
    name: string;
    target: 'bounded_text' | 'exact_quote';
    unit: string;
    repeat: number;
    accepted: boolean;
  }>;
  integer_cases: Array<{
    name: string;
    value: unknown;
    accepted: boolean;
  }>;
};

const conformanceFixture = JSON.parse(readFileSync(
  new URL('../fixtures/resume-review-contract-v1-conformance.json', import.meta.url),
  'utf8',
)) as ConformanceFixture;

function loadFixture() {
  return ResumeReviewContractFixtureSchema.parse(fixturePayload);
}

test('shares a strict v1 fixture with Python contracts', () => {
  const fixture = loadFixture();

  assert.deepEqual(
    ResumeReviewContractFixtureSchema.parse(fixture),
    fixturePayload,
  );
  assert.doesNotThrow(() => validateAgent1EvaluationAgainstPolicies(
    fixture.agent1_evaluation,
    fixture.role_scoring_policies,
  ));
  assert.doesNotThrow(() => validateAgent2QuestionPlan(
    fixture.agent2_planning_context,
    fixture.agent2_question_plan,
    fixture.agent1_evaluation,
    fixture.role_scoring_policies,
  ));
  assert.equal(fixture.confidence_assessment.is_probability, false);
});

test('rejects invalid status enums and ungrounded criterion assessments', () => {
  const fixture = loadFixture();
  const met = fixture.agent1_model_output
    .role_assessments[1].criterion_assessments[0];
  const notMet = fixture.agent1_model_output
    .role_assessments[0].criterion_assessments[1];

  assert.equal(CriterionAssessmentSchema.safeParse({
    ...met,
    evidence: [],
  }).success, false);
  assert.equal(CriterionAssessmentSchema.safeParse({
    ...notMet,
    evidence: [],
  }).success, false);
  assert.equal(CriterionAssessmentSchema.safeParse({
    ...met,
    status: 'unknown',
  }).success, false);
  assert.equal(CriterionAssessmentSchema.safeParse({
    ...met,
    status: 'MET',
  }).success, false);
  assert.equal(CriterionAssessmentSchema.safeParse({
    ...met,
    evidence: [{
      ...met.evidence[0],
      criterion_id: 'another-criterion',
    }],
  }).success, false);
});

test('keeps all model-controlled score, rank, recommendation and tool fields out', () => {
  const modelOutput = loadFixture().agent1_model_output;
  const injectedFields = {
    score: 99,
    deterministic_score: 99,
    ranked_roles: [],
    recommended_role_id: '22222222-2222-4222-8222-222222222222',
    confidence: 0.99,
    tool_calls: ['update_fit_score'],
    merchant_id: '00000000-0000-4000-8000-000000000001',
    candidate_id: '00000000-0000-4000-8000-000000000002',
    resume_markdown: '# raw résumé',
    embedding: [0.1, 0.2],
  };

  for (const [field, value] of Object.entries(injectedFields)) {
    assert.equal(Agent1ModelOutputSchema.safeParse({
      ...modelOutput,
      [field]: value,
    }).success, false, `${field} must not be model-controlled`);
  }

  const firstRole = modelOutput.role_assessments[0];
  assert.equal(Agent1ModelOutputSchema.safeParse({
    ...modelOutput,
    role_assessments: [
      { ...firstRole, fit_score: 100 },
      modelOutput.role_assessments[1],
    ],
  }).success, false);

  const firstCriterion = firstRole.criterion_assessments[0];
  assert.equal(Agent1ModelOutputSchema.safeParse({
    ...modelOutput,
    role_assessments: [{
      ...firstRole,
      criterion_assessments: [
        { ...firstCriterion, points: 50 },
        firstRole.criterion_assessments[1],
      ],
    }, modelOutput.role_assessments[1]],
  }).success, false);
});

test('rejects malformed catalog references and tampered deterministic scores', () => {
  const fixture = loadFixture();
  const firstRole = fixture.agent1_model_output.role_assessments[0];

  assert.equal(Agent1ModelOutputSchema.safeParse({
    ...fixture.agent1_model_output,
    role_assessments: [{
      ...firstRole,
      criterion_assessments: [
        firstRole.criterion_assessments[0],
        firstRole.criterion_assessments[0],
      ],
    }, fixture.agent1_model_output.role_assessments[1]],
  }).success, false);

  const changedScore = structuredClone(fixture.agent1_evaluation);
  changedScore.ranked_roles[0].deterministic_score = 99;
  assert.throws(
    () => validateAgent1EvaluationAgainstPolicies(
      changedScore,
      fixture.role_scoring_policies,
    ),
    /deterministic score/,
  );

  const missingCriterion = structuredClone(fixture.agent1_evaluation);
  missingCriterion.ranked_roles[0].criterion_assessments.pop();
  assert.throws(
    () => validateAgent1EvaluationAgainstPolicies(
      missingCriterion,
      fixture.role_scoring_policies,
    ),
    /criterion IDs/,
  );

  const changedIdentity = structuredClone(fixture.agent1_evaluation);
  changedIdentity.ranked_roles[0].scoring_policy.policy_version = '9.9.9';
  assert.throws(
    () => validateAgent1EvaluationAgainstPolicies(
      changedIdentity,
      fixture.role_scoring_policies,
    ),
    /policy identity/,
  );

  const reorderedCriteria = structuredClone(fixture.agent1_evaluation);
  reorderedCriteria.ranked_roles[0].criterion_assessments.reverse();
  assert.throws(
    () => validateAgent1EvaluationAgainstPolicies(
      reorderedCriteria,
      fixture.role_scoring_policies,
    ),
    /criterion order/,
  );

  const invalidPolicy = structuredClone(fixture.role_scoring_policies[0]);
  invalidPolicy.criteria[0].weight = 59;
  assert.equal(RoleScoringPolicySchema.safeParse(invalidPolicy).success, false);

  const duplicateIdentityPolicies = structuredClone(fixture.role_scoring_policies);
  duplicateIdentityPolicies[1].policy_identity =
    duplicateIdentityPolicies[0].policy_identity;
  assert.throws(
    () => validateAgent1EvaluationAgainstPolicies(
      fixture.agent1_evaluation,
      duplicateIdentityPolicies,
    ),
    /identities must be unique/,
  );
});

test('enforces deterministic role ordering and recommendation invariants', () => {
  const evaluation = loadFixture().agent1_evaluation;

  assert.equal(Agent1EvaluationSchema.safeParse({
    ...evaluation,
    ranked_roles: [...evaluation.ranked_roles].reverse(),
  }).success, false);
  assert.equal(Agent1EvaluationSchema.safeParse({
    ...evaluation,
    recommended_role_id: evaluation.ranked_roles[1].role_id,
  }).success, false);

  const tiedRoles = structuredClone(evaluation.ranked_roles);
  tiedRoles[0].deterministic_score = 60;
  tiedRoles.reverse();
  assert.equal(Agent1EvaluationSchema.safeParse({
    ...evaluation,
    ranked_roles: tiedRoles,
    recommended_role_id: null,
  }).success, true);
  assert.equal(Agent1EvaluationSchema.safeParse({
    ...evaluation,
    ranked_roles: tiedRoles,
    recommended_role_id: tiedRoles[0].role_id,
  }).success, false);
});

test('limits Agent 2 to the exact validated gaps and forbids scoring or tools', () => {
  const fixture = loadFixture();
  const plan = fixture.agent2_question_plan;
  const firstQuestion = plan.questions[0];
  assert.deepEqual(
    Object.keys(fixture.agent2_planning_context).sort(),
    ['gaps', 'role_id', 'schema_version'],
  );
  assert.equal(Agent2PlanningContextSchema.safeParse({
    ...fixture.agent2_planning_context,
    resume_markdown: '# raw résumé',
  }).success, false);

  assert.throws(
    () => validateAgent2QuestionPlan(
      fixture.agent2_planning_context,
      {
        ...plan,
        questions: [{
          ...firstQuestion,
          target_criterion_id: 'unvalidated-gap',
        }],
      },
      fixture.agent1_evaluation,
      fixture.role_scoring_policies,
    ),
    /validated gap/,
  );
  assert.equal(Agent2QuestionPlanSchema.safeParse({
    ...plan,
    questions: [{
      ...firstQuestion,
      target_gap_status: 'not_met',
    }],
  }).success, false);

  assert.throws(
    () => validateAgent2QuestionPlan(
      fixture.agent2_planning_context,
      {
        ...plan,
        questions: [{
          ...firstQuestion,
          question: 'Tell me about your inventory ordering experience.',
        }],
      },
      fixture.agent1_evaluation,
      fixture.role_scoring_policies,
    ),
    /application-owned safe question template/,
  );

  const fabricatedContext = Agent2PlanningContextSchema.parse({
    ...fixture.agent2_planning_context,
    gaps: [{
      role_id: fixture.agent2_planning_context.role_id,
      criterion_id: 'fabricated-gap',
      criterion_text: 'Fabricated criterion',
      status: 'unknown',
      reason_code: 'criterion_unknown',
    }],
  });
  const fabricatedPlan = Agent2QuestionPlanSchema.parse({
    ...plan,
    questions: [{
      ...firstQuestion,
      target_criterion_id: 'fabricated-gap',
    }],
  });
  assert.throws(
    () => validateAgent2QuestionPlan(
      fabricatedContext,
      fabricatedPlan,
      fixture.agent1_evaluation,
      fixture.role_scoring_policies,
    ),
    /must be derived/,
  );

  assert.equal(Agent2QuestionPlanSchema.safeParse({
    ...plan,
    questions: [firstQuestion, firstQuestion],
  }).success, false);
  assert.equal(Agent2QuestionPlanSchema.safeParse({
    ...plan,
    questions: [{ ...firstQuestion, priority: 'required' }],
  }).success, false);

  const injectedFields = {
    score: 100,
    ranked_roles: [],
    recommended_role_id: plan.role_id,
    tool_calls: ['semantic_search_candidates'],
    sql: 'select * from candidates',
    resume_markdown: '# raw résumé',
    candidate_id: '00000000-0000-4000-8000-000000000002',
  };
  for (const [field, value] of Object.entries(injectedFields)) {
    assert.equal(Agent2QuestionPlanSchema.safeParse({
      ...plan,
      [field]: value,
    }).success, false, `${field} must not be available to Agent 2`);
  }
});

test('requires exact schema versions and diagnostic-not-probability confidence', () => {
  const fixture = loadFixture();
  const versionedSchemas = [
    [RoleScoringPolicySchema, fixture.role_scoring_policies[0]],
    [Agent1ModelOutputSchema, fixture.agent1_model_output],
    [Agent1EvaluationSchema, fixture.agent1_evaluation],
    [Agent2PlanningContextSchema, fixture.agent2_planning_context],
    [Agent2QuestionPlanSchema, fixture.agent2_question_plan],
    [ConfidenceAssessmentSchema, fixture.confidence_assessment],
  ] as const;

  for (const [schema, value] of versionedSchemas) {
    const withoutVersion = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'schema_version'),
    );
    assert.equal(schema.safeParse(withoutVersion).success, false);
    assert.equal(schema.safeParse({ ...value, schema_version: '2.0' }).success, false);
    assert.equal(schema.safeParse({ ...value, schema_version: 1 }).success, false);
  }

  assert.equal(Agent1ModelOutputSchema.safeParse(null).success, false);
  assert.equal(Agent1ModelOutputSchema.safeParse([]).success, false);
  assert.equal(Agent1ModelOutputSchema.safeParse({
    schema_version: '1.0',
  }).success, false);

  const confidence = fixture.confidence_assessment;
  assert.equal(ConfidenceAssessmentSchema.safeParse({
    ...confidence,
    is_probability: true,
  }).success, false);
  assert.equal(ConfidenceAssessmentSchema.safeParse({
    ...confidence,
    is_probability: 0,
  }).success, false);
  assert.equal(ConfidenceAssessmentSchema.safeParse({
    ...confidence,
    score: 82.5,
  }).success, false);
  assert.equal(ConfidenceAssessmentSchema.safeParse({
    ...confidence,
    hard_failure: true,
  }).success, true);
  assert.equal(ConfidenceAssessmentSchema.safeParse({
    ...confidence,
    hard_failure: true,
    reason_codes: [],
  }).success, false);
  assert.equal(ConfidenceAssessmentSchema.safeParse({
    ...confidence,
    reason_codes: ['duplicate', 'duplicate'],
  }).success, false);
});

test('shares Unicode text and JSON integer edge semantics with Python', () => {
  const fixture = loadFixture();
  const policy = fixture.role_scoring_policies[0];
  const evidence = fixture.agent1_model_output
    .role_assessments[0].criterion_assessments[0].evidence[0];

  for (const conformanceCase of conformanceFixture.text_cases) {
    const value = conformanceCase.unit.repeat(conformanceCase.repeat);
    const result = conformanceCase.target === 'bounded_text'
      ? RoleScoringPolicySchema.safeParse({ ...policy, role_title: value })
      : SourceEvidenceSchema.safeParse({ ...evidence, exact_quote: value });
    assert.equal(
      result.success,
      conformanceCase.accepted,
      conformanceCase.name,
    );
  }

  for (const conformanceCase of conformanceFixture.integer_cases) {
    const result = ConfidenceAssessmentSchema.safeParse({
      ...fixture.confidence_assessment,
      score: conformanceCase.value,
    });
    assert.equal(
      result.success,
      conformanceCase.accepted,
      conformanceCase.name,
    );
  }
});
