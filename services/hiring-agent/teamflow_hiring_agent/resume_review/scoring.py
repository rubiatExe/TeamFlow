"""Pure deterministic scoring and cross-contract validation for résumé review."""

from __future__ import annotations

from collections.abc import Iterable

from .contracts import (
    Agent1Evaluation,
    Agent1ModelOutput,
    Agent2PlanningContext,
    Agent2Question,
    Agent2QuestionPlan,
    CriterionStatus,
    GapReasonCode,
    GapStatus,
    QuestionPriority,
    RoleMatch,
    RoleScoringPolicy,
    ValidatedGap,
)


class ResumeReviewContractError(ValueError):
    """Raised when individually valid contracts disagree at a trusted boundary."""


def _policy_index(
    policies: Iterable[RoleScoringPolicy],
) -> dict[str, RoleScoringPolicy]:
    policy_by_role: dict[str, RoleScoringPolicy] = {}
    policy_identities: set[tuple[str, str]] = set()
    for policy in policies:
        if policy.role_id in policy_by_role:
            raise ResumeReviewContractError("role scoring policy role IDs must be unique")
        identity = (
            policy.policy_identity.policy_id,
            policy.policy_identity.policy_version,
        )
        if identity in policy_identities:
            raise ResumeReviewContractError(
                "role scoring policy identities must be unique across roles"
            )
        policy_by_role[policy.role_id] = policy
        policy_identities.add(identity)
    if not policy_by_role:
        raise ResumeReviewContractError("at least one configured role policy is required")
    return policy_by_role


def _validate_exact_ids(
    *,
    actual: set[str],
    expected: set[str],
    label: str,
) -> None:
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise ResumeReviewContractError(
            f"{label} do not match the configured catalog (missing={missing}, unknown={unknown})"
        )


def build_agent1_evaluation(
    model_output: Agent1ModelOutput,
    policies: Iterable[RoleScoringPolicy],
) -> Agent1Evaluation:
    """Calculate role scores from configured weights after validating all references."""

    policy_by_role = _policy_index(policies)
    assessment_by_role = {
        assessment.role_id: assessment for assessment in model_output.role_assessments
    }
    _validate_exact_ids(
        actual=set(assessment_by_role),
        expected=set(policy_by_role),
        label="Agent 1 role IDs",
    )

    role_matches: list[RoleMatch] = []
    for role_id, policy in policy_by_role.items():
        role_assessment = assessment_by_role[role_id]
        assessment_by_criterion = {
            assessment.criterion_id: assessment
            for assessment in role_assessment.criterion_assessments
        }
        criterion_by_id = {criterion.criterion_id: criterion for criterion in policy.criteria}
        _validate_exact_ids(
            actual=set(assessment_by_criterion),
            expected=set(criterion_by_id),
            label=f"Agent 1 criterion IDs for role {role_id}",
        )

        ordered_assessments = tuple(
            assessment_by_criterion[criterion.criterion_id] for criterion in policy.criteria
        )
        score = sum(
            criterion.weight
            for criterion in policy.criteria
            if assessment_by_criterion[criterion.criterion_id].status is CriterionStatus.MET
        )
        gaps = tuple(
            ValidatedGap(
                role_id=role_id,
                criterion_id=criterion.criterion_id,
                criterion_text=criterion.criterion_text,
                status=GapStatus(assessment_by_criterion[criterion.criterion_id].status.value),
                reason_code=(
                    GapReasonCode.CRITERION_NOT_MET
                    if assessment_by_criterion[criterion.criterion_id].status
                    is CriterionStatus.NOT_MET
                    else GapReasonCode.CRITERION_UNKNOWN
                ),
            )
            for criterion in policy.criteria
            if assessment_by_criterion[criterion.criterion_id].status is not CriterionStatus.MET
        )
        role_matches.append(
            RoleMatch(
                role_id=role_id,
                deterministic_score=score,
                scoring_policy=policy.policy_identity,
                criterion_assessments=ordered_assessments,
                gaps=gaps,
            )
        )

    ranked_roles = tuple(
        sorted(
            role_matches,
            key=lambda item: (-item.deterministic_score, item.role_id),
        )
    )
    top_score = ranked_roles[0].deterministic_score
    top_is_tied = len(ranked_roles) > 1 and ranked_roles[1].deterministic_score == top_score
    evaluation = Agent1Evaluation(
        schema_version="1.0",
        ranked_roles=ranked_roles,
        recommended_role_id=(None if top_score == 0 or top_is_tied else ranked_roles[0].role_id),
        limitations=model_output.limitations,
    )
    validate_agent1_evaluation_against_policies(evaluation, policy_by_role.values())
    return evaluation


def validate_agent1_evaluation_against_policies(
    evaluation: Agent1Evaluation,
    policies: Iterable[RoleScoringPolicy],
) -> None:
    """Reject a parsed evaluation whose app-owned scores or references were tampered."""

    policy_by_role = _policy_index(policies)
    match_by_role = {match.role_id: match for match in evaluation.ranked_roles}
    _validate_exact_ids(
        actual=set(match_by_role),
        expected=set(policy_by_role),
        label="Agent 1 evaluation role IDs",
    )

    for role_id, policy in policy_by_role.items():
        role_match = match_by_role[role_id]
        if role_match.scoring_policy != policy.policy_identity:
            raise ResumeReviewContractError(
                f"scoring policy identity does not match role {role_id}"
            )
        assessment_by_criterion = {
            assessment.criterion_id: assessment for assessment in role_match.criterion_assessments
        }
        criterion_by_id = {criterion.criterion_id: criterion for criterion in policy.criteria}
        _validate_exact_ids(
            actual=set(assessment_by_criterion),
            expected=set(criterion_by_id),
            label=f"Agent 1 evaluation criterion IDs for role {role_id}",
        )
        expected_criterion_order = tuple(criterion.criterion_id for criterion in policy.criteria)
        actual_criterion_order = tuple(
            assessment.criterion_id for assessment in role_match.criterion_assessments
        )
        if actual_criterion_order != expected_criterion_order:
            raise ResumeReviewContractError(
                f"criterion order does not match configured policy for role {role_id}"
            )
        expected_score = sum(
            criterion.weight
            for criterion in policy.criteria
            if assessment_by_criterion[criterion.criterion_id].status is CriterionStatus.MET
        )
        if role_match.deterministic_score != expected_score:
            raise ResumeReviewContractError(
                f"deterministic score does not match configured weights for role {role_id}"
            )
        gap_by_criterion = {gap.criterion_id: gap for gap in role_match.gaps}
        expected_gap_order = tuple(
            criterion.criterion_id
            for criterion in policy.criteria
            if assessment_by_criterion[criterion.criterion_id].status is not CriterionStatus.MET
        )
        actual_gap_order = tuple(gap.criterion_id for gap in role_match.gaps)
        if actual_gap_order != expected_gap_order:
            raise ResumeReviewContractError(
                f"gap order does not match configured policy for role {role_id}"
            )
        for criterion in policy.criteria:
            gap = gap_by_criterion.get(criterion.criterion_id)
            if gap is not None and gap.criterion_text != criterion.criterion_text:
                raise ResumeReviewContractError(
                    f"gap criterion text does not match configured policy for role {role_id}"
                )


def build_agent2_planning_context(
    evaluation: Agent1Evaluation,
    policies: Iterable[RoleScoringPolicy],
) -> Agent2PlanningContext:
    """Expose only the recommended role's validated unknown gaps to Agent 2."""

    validate_agent1_evaluation_against_policies(evaluation, policies)
    if evaluation.recommended_role_id is None:
        raise ResumeReviewContractError(
            "Agent 2 cannot run without a unique evidence-backed recommended role"
        )
    recommended = next(
        role for role in evaluation.ranked_roles if role.role_id == evaluation.recommended_role_id
    )
    return Agent2PlanningContext(
        schema_version="1.0",
        role_id=recommended.role_id,
        gaps=tuple(gap for gap in recommended.gaps if gap.status is GapStatus.UNKNOWN),
    )


def build_application_question_plan(
    context: Agent2PlanningContext,
) -> Agent2QuestionPlan:
    """Build the only approved, least-privilege follow-up wording.

    Agent 2 may reproduce this application-owned plan, but it cannot invent free-form
    recruiter-facing language.  Criterion identifiers are policy-validated and are the
    only criterion content interpolated into the public question.
    """

    return Agent2QuestionPlan(
        schema_version="1.0",
        role_id=context.role_id,
        questions=tuple(
            Agent2Question(
                question=(
                    f"Tell me about any {gap.criterion_id} work you have done, "
                    "including the checks you used."
                ),
                target_criterion_id=gap.criterion_id,
                target_gap_status=GapStatus.UNKNOWN,
                purpose="Verify whether the unknown gap reflects an omitted résumé detail.",
                priority=QuestionPriority.HIGH,
            )
            for gap in context.gaps
        ),
    )


def validate_agent2_question_plan(
    context: Agent2PlanningContext,
    plan: Agent2QuestionPlan,
    evaluation: Agent1Evaluation,
    policies: Iterable[RoleScoringPolicy],
) -> None:
    """Ensure every generated question targets an exact validated Agent 1 gap."""

    expected_context = build_agent2_planning_context(evaluation, policies)
    if context != expected_context:
        raise ResumeReviewContractError(
            "Agent 2 context must be derived from the validated Agent 1 evaluation"
        )
    if plan.role_id != context.role_id:
        raise ResumeReviewContractError(
            "Agent 2 plan role_id must match the recommended role context"
        )
    allowed_targets = {(gap.criterion_id, gap.status) for gap in context.gaps}
    unsupported = [
        (question.target_criterion_id, question.target_gap_status.value)
        for question in plan.questions
        if (question.target_criterion_id, question.target_gap_status) not in allowed_targets
    ]
    if unsupported:
        raise ResumeReviewContractError(
            f"Agent 2 question targets an unsupported validated gap: {unsupported}"
        )
    expected_plan = build_application_question_plan(context)
    if plan != expected_plan:
        raise ResumeReviewContractError(
            "Agent 2 plan must reproduce the application-owned safe question template"
        )
