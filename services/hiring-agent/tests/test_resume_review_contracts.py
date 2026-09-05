from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from teamflow_hiring_agent.resume_review.contracts import (
    Agent1Evaluation,
    Agent1ModelOutput,
    Agent2PlanningContext,
    Agent2QuestionPlan,
    ConfidenceAssessment,
    CriterionAssessment,
    CriterionStatus,
    ResumeReviewContractFixture,
    RoleScoringPolicy,
    SourceEvidence,
)
from teamflow_hiring_agent.resume_review.scoring import (
    ResumeReviewContractError,
    build_agent1_evaluation,
    build_agent2_planning_context,
    validate_agent1_evaluation_against_policies,
    validate_agent2_question_plan,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = REPOSITORY_ROOT / "tests" / "fixtures" / "resume-review-contract-v1.json"
CONFORMANCE_PATH = (
    REPOSITORY_ROOT / "tests" / "fixtures" / "resume-review-contract-v1-conformance.json"
)


def load_fixture_payload() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def load_fixture() -> ResumeReviewContractFixture:
    return ResumeReviewContractFixture.model_validate(load_fixture_payload())


def test_shared_fixture_round_trips_and_application_owns_scores() -> None:
    fixture = load_fixture()

    evaluation = build_agent1_evaluation(
        fixture.agent1_model_output,
        fixture.role_scoring_policies,
    )
    assert evaluation == fixture.agent1_evaluation
    validate_agent1_evaluation_against_policies(
        evaluation,
        fixture.role_scoring_policies,
    )

    planning_context = build_agent2_planning_context(
        evaluation,
        fixture.role_scoring_policies,
    )
    assert planning_context == fixture.agent2_planning_context
    validate_agent2_question_plan(
        planning_context,
        fixture.agent2_question_plan,
        evaluation,
        fixture.role_scoring_policies,
    )

    assert fixture.confidence_assessment.is_probability is False
    assert fixture.model_dump(mode="json") == load_fixture_payload()


def test_criterion_enums_and_evidence_invariants_fail_closed() -> None:
    fixture = load_fixture()
    assessments = tuple(
        assessment
        for role in fixture.agent1_model_output.role_assessments
        for assessment in role.criterion_assessments
    )
    assert {assessment.status for assessment in assessments} == {
        CriterionStatus.MET,
        CriterionStatus.NOT_MET,
        CriterionStatus.UNKNOWN,
    }
    met = next(item for item in assessments if item.status is CriterionStatus.MET)
    not_met = next(item for item in assessments if item.status is CriterionStatus.NOT_MET)

    met_without_evidence = met.model_dump(mode="json")
    met_without_evidence["evidence"] = []
    with pytest.raises(ValidationError, match="evidence"):
        CriterionAssessment.model_validate(met_without_evidence)

    not_met_without_evidence = not_met.model_dump(mode="json")
    not_met_without_evidence["evidence"] = []
    with pytest.raises(ValidationError, match="evidence"):
        CriterionAssessment.model_validate(not_met_without_evidence)

    unknown_with_evidence = met.model_dump(mode="json")
    unknown_with_evidence["status"] = "unknown"
    with pytest.raises(ValidationError, match="unknown"):
        CriterionAssessment.model_validate(unknown_with_evidence)

    mismatched_evidence = met.model_dump(mode="json")
    mismatched_evidence["evidence"][0]["criterion_id"] = "another-criterion"
    with pytest.raises(ValidationError, match="criterion_id"):
        CriterionAssessment.model_validate(mismatched_evidence)

    invalid_enum = met.model_dump(mode="json")
    invalid_enum["status"] = "MET"
    with pytest.raises(ValidationError):
        CriterionAssessment.model_validate(invalid_enum)


def test_model_output_rejects_score_rank_recommendation_and_tool_fields() -> None:
    payload = load_fixture_payload()["agent1_model_output"]
    assert isinstance(payload, dict)

    for field, value in (
        ("score", 99),
        ("deterministic_score", 99),
        ("ranked_roles", []),
        ("recommended_role_id", "22222222-2222-4222-8222-222222222222"),
        ("confidence", 0.99),
        ("tool_calls", ["update_fit_score"]),
        ("merchant_id", "00000000-0000-4000-8000-000000000001"),
        ("candidate_id", "00000000-0000-4000-8000-000000000002"),
        ("resume_markdown", "# raw résumé"),
        ("embedding", [0.1, 0.2]),
    ):
        injected = {**payload, field: value}
        with pytest.raises(ValidationError, match="extra_forbidden"):
            Agent1ModelOutput.model_validate(injected)

    role_payload = dict(payload["role_assessments"][0])
    role_payload["fit_score"] = 100
    injected_role = {
        **payload,
        "role_assessments": [role_payload, payload["role_assessments"][1]],
    }
    with pytest.raises(ValidationError, match="extra_forbidden"):
        Agent1ModelOutput.model_validate(injected_role)

    criterion_payload = dict(role_payload["criterion_assessments"][0])
    criterion_payload["points"] = 50
    role_with_points = dict(payload["role_assessments"][0])
    role_with_points["criterion_assessments"] = [
        criterion_payload,
        role_with_points["criterion_assessments"][1],
    ]
    with pytest.raises(ValidationError, match="extra_forbidden"):
        Agent1ModelOutput.model_validate(
            {
                **payload,
                "role_assessments": [
                    role_with_points,
                    payload["role_assessments"][1],
                ],
            }
        )


def test_catalog_validator_rejects_foreign_missing_and_duplicate_references() -> None:
    fixture = load_fixture()
    model_payload = fixture.agent1_model_output.model_dump(mode="json")

    foreign_role = json.loads(json.dumps(model_payload))
    foreign_role["role_assessments"][0]["role_id"] = "99999999-9999-4999-8999-999999999999"
    with pytest.raises(ResumeReviewContractError, match="role IDs"):
        build_agent1_evaluation(
            Agent1ModelOutput.model_validate(foreign_role),
            fixture.role_scoring_policies,
        )

    missing_criterion = json.loads(json.dumps(model_payload))
    missing_criterion["role_assessments"][0]["criterion_assessments"].pop()
    with pytest.raises(ResumeReviewContractError, match="criterion IDs"):
        build_agent1_evaluation(
            Agent1ModelOutput.model_validate(missing_criterion),
            fixture.role_scoring_policies,
        )

    duplicate_criterion = json.loads(json.dumps(model_payload))
    duplicate_criterion["role_assessments"][0]["criterion_assessments"][1] = duplicate_criterion[
        "role_assessments"
    ][0]["criterion_assessments"][0]
    with pytest.raises(ValidationError, match="criterion_id"):
        Agent1ModelOutput.model_validate(duplicate_criterion)

    invalid_policy = fixture.role_scoring_policies[0].model_dump(mode="json")
    invalid_policy["criteria"][0]["weight"] = 59
    with pytest.raises(ValidationError, match="sum to 100"):
        RoleScoringPolicy.model_validate(invalid_policy)

    duplicate_policy_criterion = fixture.role_scoring_policies[0].model_dump(mode="json")
    duplicate_policy_criterion["criteria"][1]["criterion_id"] = duplicate_policy_criterion[
        "criteria"
    ][0]["criterion_id"]
    with pytest.raises(ValidationError, match="unique"):
        RoleScoringPolicy.model_validate(duplicate_policy_criterion)

    duplicate_identity_payloads = [
        policy.model_dump(mode="json") for policy in fixture.role_scoring_policies
    ]
    duplicate_identity_payloads[1]["policy_identity"] = duplicate_identity_payloads[0][
        "policy_identity"
    ]
    with pytest.raises(ResumeReviewContractError, match="identities must be unique"):
        build_agent1_evaluation(
            fixture.agent1_model_output,
            tuple(
                RoleScoringPolicy.model_validate(policy) for policy in duplicate_identity_payloads
            ),
        )


def test_deterministic_score_rank_and_recommendation_are_revalidated() -> None:
    fixture = load_fixture()
    valid = fixture.agent1_evaluation.model_dump(mode="json")

    changed_score = json.loads(json.dumps(valid))
    changed_score["ranked_roles"][0]["deterministic_score"] = 99
    tampered = Agent1Evaluation.model_validate(changed_score)
    with pytest.raises(ResumeReviewContractError, match="deterministic score"):
        validate_agent1_evaluation_against_policies(
            tampered,
            fixture.role_scoring_policies,
        )

    changed_identity = json.loads(json.dumps(valid))
    changed_identity["ranked_roles"][0]["scoring_policy"]["policy_version"] = "9.9.9"
    with pytest.raises(ResumeReviewContractError, match="policy identity"):
        validate_agent1_evaluation_against_policies(
            Agent1Evaluation.model_validate(changed_identity),
            fixture.role_scoring_policies,
        )

    reordered_criteria = json.loads(json.dumps(valid))
    reordered_criteria["ranked_roles"][0]["criterion_assessments"].reverse()
    with pytest.raises(ResumeReviewContractError, match="criterion order"):
        validate_agent1_evaluation_against_policies(
            Agent1Evaluation.model_validate(reordered_criteria),
            fixture.role_scoring_policies,
        )

    wrong_order = json.loads(json.dumps(valid))
    wrong_order["ranked_roles"].reverse()
    with pytest.raises(ValidationError, match="sorted"):
        Agent1Evaluation.model_validate(wrong_order)

    wrong_recommendation = {**valid, "recommended_role_id": valid["ranked_roles"][1]["role_id"]}
    with pytest.raises(ValidationError, match="recommended_role_id"):
        Agent1Evaluation.model_validate(wrong_recommendation)

    tie_payload = json.loads(json.dumps(valid))
    tie_payload["ranked_roles"][0]["deterministic_score"] = 60
    tie_payload["ranked_roles"].reverse()
    tie_payload["recommended_role_id"] = None
    tie = Agent1Evaluation.model_validate(tie_payload)
    assert [match.role_id for match in tie.ranked_roles] == sorted(
        match.role_id for match in tie.ranked_roles
    )

    with pytest.raises(ValidationError, match="zero/tied"):
        Agent1Evaluation.model_validate(
            {
                **tie_payload,
                "recommended_role_id": tie_payload["ranked_roles"][0]["role_id"],
            }
        )

    all_unknown = fixture.agent1_model_output.model_dump(mode="json")
    for role in all_unknown["role_assessments"]:
        for assessment in role["criterion_assessments"]:
            assessment["status"] = "unknown"
            assessment["evidence"] = []
    no_evidence_evaluation = build_agent1_evaluation(
        Agent1ModelOutput.model_validate(all_unknown),
        fixture.role_scoring_policies,
    )
    assert no_evidence_evaluation.recommended_role_id is None
    with pytest.raises(ResumeReviewContractError, match="cannot run"):
        build_agent2_planning_context(
            no_evidence_evaluation,
            fixture.role_scoring_policies,
        )

    tied_policy_payloads = [
        policy.model_dump(mode="json") for policy in fixture.role_scoring_policies
    ]
    tied_policy_payloads[0]["policy_identity"]["policy_version"] = "1.0.1"
    tied_policy_payloads[0]["criteria"][0]["weight"] = 70
    tied_policy_payloads[0]["criteria"][1]["weight"] = 30
    tied_evaluation = build_agent1_evaluation(
        fixture.agent1_model_output,
        tuple(RoleScoringPolicy.model_validate(policy) for policy in tied_policy_payloads),
    )
    assert [role.deterministic_score for role in tied_evaluation.ranked_roles] == [70, 70]
    assert tied_evaluation.recommended_role_id is None


def test_agent2_is_limited_to_validated_gaps_and_cannot_rescore_or_use_tools() -> None:
    fixture = load_fixture()
    context = fixture.agent2_planning_context
    plan_payload = fixture.agent2_question_plan.model_dump(mode="json")
    context_payload = context.model_dump(mode="json")
    assert set(context_payload) == {"schema_version", "role_id", "gaps"}
    assert all("evidence" not in gap for gap in context_payload["gaps"])
    with pytest.raises(ValidationError, match="extra_forbidden"):
        Agent2PlanningContext.model_validate({**context_payload, "resume_markdown": "# raw résumé"})

    unsupported = json.loads(json.dumps(plan_payload))
    unsupported["questions"][0]["target_criterion_id"] = "unvalidated-gap"
    with pytest.raises(ResumeReviewContractError, match="validated gap"):
        validate_agent2_question_plan(
            context,
            Agent2QuestionPlan.model_validate(unsupported),
            fixture.agent1_evaluation,
            fixture.role_scoring_policies,
        )

    wrong_status = json.loads(json.dumps(plan_payload))
    wrong_status["questions"][0]["target_gap_status"] = "not_met"
    with pytest.raises(ValidationError):
        Agent2QuestionPlan.model_validate(wrong_status)

    wrong_role = {**plan_payload, "role_id": "11111111-1111-4111-8111-111111111111"}
    with pytest.raises(ResumeReviewContractError, match="recommended role"):
        validate_agent2_question_plan(
            context,
            Agent2QuestionPlan.model_validate(wrong_role),
            fixture.agent1_evaluation,
            fixture.role_scoring_policies,
        )

    fabricated_context_payload = context_payload
    fabricated_context_payload["gaps"] = [
        {
            "role_id": context.role_id,
            "criterion_id": "fabricated-gap",
            "criterion_text": "Fabricated criterion",
            "status": "unknown",
            "reason_code": "criterion_unknown",
        }
    ]
    fabricated_plan = json.loads(json.dumps(plan_payload))
    fabricated_plan["questions"][0]["target_criterion_id"] = "fabricated-gap"
    with pytest.raises(ResumeReviewContractError, match="must be derived"):
        validate_agent2_question_plan(
            Agent2PlanningContext.model_validate(fabricated_context_payload),
            Agent2QuestionPlan.model_validate(fabricated_plan),
            fixture.agent1_evaluation,
            fixture.role_scoring_policies,
        )

    duplicate_target = {
        **plan_payload,
        "questions": [plan_payload["questions"][0], plan_payload["questions"][0]],
    }
    with pytest.raises(ValidationError, match="unique"):
        Agent2QuestionPlan.model_validate(duplicate_target)

    invalid_priority = json.loads(json.dumps(plan_payload))
    invalid_priority["questions"][0]["priority"] = "required"
    with pytest.raises(ValidationError):
        Agent2QuestionPlan.model_validate(invalid_priority)

    for field, value in (
        ("score", 100),
        ("ranked_roles", []),
        ("recommended_role_id", context.role_id),
        ("tool_calls", ["semantic_search_candidates"]),
        ("sql", "select * from candidates"),
        ("resume_markdown", "# raw résumé"),
        ("candidate_id", "00000000-0000-4000-8000-000000000002"),
    ):
        with pytest.raises(ValidationError, match="extra_forbidden"):
            Agent2QuestionPlan.model_validate({**plan_payload, field: value})


def test_schema_versions_malformed_outputs_and_confidence_marker() -> None:
    fixture_payload = load_fixture_payload()
    top_level_models = (
        (RoleScoringPolicy, fixture_payload["role_scoring_policies"][0]),
        (Agent1ModelOutput, fixture_payload["agent1_model_output"]),
        (Agent1Evaluation, fixture_payload["agent1_evaluation"]),
        (Agent2PlanningContext, fixture_payload["agent2_planning_context"]),
        (Agent2QuestionPlan, fixture_payload["agent2_question_plan"]),
        (ConfidenceAssessment, fixture_payload["confidence_assessment"]),
    )
    for model, valid_payload in top_level_models:
        assert isinstance(valid_payload, dict)
        without_version = {
            key: value for key, value in valid_payload.items() if key != "schema_version"
        }
        with pytest.raises(ValidationError):
            model.model_validate(without_version)
        with pytest.raises(ValidationError):
            model.model_validate({**valid_payload, "schema_version": "2.0"})
        with pytest.raises(ValidationError):
            model.model_validate({**valid_payload, "schema_version": 1.0})

    with pytest.raises(ValidationError):
        Agent1ModelOutput.model_validate([])
    with pytest.raises(ValidationError):
        Agent1ModelOutput.model_validate(None)
    with pytest.raises(ValidationError):
        Agent1ModelOutput.model_validate({"schema_version": "1.0"})

    confidence = fixture_payload["confidence_assessment"]
    assert isinstance(confidence, dict)
    with pytest.raises(ValidationError, match="is_probability"):
        ConfidenceAssessment.model_validate({**confidence, "is_probability": True})
    with pytest.raises(ValidationError, match="is_probability"):
        ConfidenceAssessment.model_validate({**confidence, "is_probability": 0})
    with pytest.raises(ValidationError):
        ConfidenceAssessment.model_validate({**confidence, "score": 82.5})
    assert (
        ConfidenceAssessment.model_validate({**confidence, "hard_failure": True, "score": 82}).score
        == 82
    )
    with pytest.raises(ValidationError, match="reason_codes"):
        ConfidenceAssessment.model_validate(
            {**confidence, "hard_failure": True, "reason_codes": []}
        )
    with pytest.raises(ValidationError, match="reason_codes"):
        ConfidenceAssessment.model_validate(
            {**confidence, "reason_codes": ["duplicate", "duplicate"]}
        )


def test_shared_unicode_and_json_number_conformance_cases() -> None:
    fixture = load_fixture()
    cases = json.loads(CONFORMANCE_PATH.read_text(encoding="utf-8"))
    policy_payload = fixture.role_scoring_policies[0].model_dump(mode="json")
    evidence_payload = (
        fixture.agent1_model_output.role_assessments[0]
        .criterion_assessments[0]
        .evidence[0]
        .model_dump(mode="json")
    )

    for case in cases["text_cases"]:
        value = case["unit"] * case["repeat"]
        if case["target"] == "bounded_text":
            model = RoleScoringPolicy
            payload = {**policy_payload, "role_title": value}
        else:
            model = SourceEvidence
            payload = {**evidence_payload, "exact_quote": value}
        if case["accepted"]:
            assert model.model_validate(payload), case["name"]
        else:
            with pytest.raises(ValidationError):
                model.model_validate(payload)

    confidence = fixture.confidence_assessment.model_dump(mode="json")
    for case in cases["integer_cases"]:
        if case["accepted"]:
            parsed = ConfidenceAssessment.model_validate({**confidence, "score": case["value"]})
            assert parsed.score == 82, case["name"]
        else:
            with pytest.raises(ValidationError):
                ConfidenceAssessment.model_validate({**confidence, "score": case["value"]})
