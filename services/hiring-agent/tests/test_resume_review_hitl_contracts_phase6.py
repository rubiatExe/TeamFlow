from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from teamflow_hiring_agent.resume_review.hitl.contracts import (
    ApproveResumeReviewDecision,
    ApproveWithEditsResumeReviewDecision,
    PendingResumeReviewQueueResponse,
    RejectResumeReviewDecision,
    ResumeReviewDecisionRequest,
    ResumeReviewHitlContractFixture,
    ResumeReviewRunDetailResponse,
    ResumeReviewRunResponse,
    ResumeReviewRunStatus,
    StartResumeReviewRunRequest,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = REPOSITORY_ROOT / "tests" / "fixtures" / "resume-review-hitl-v2.json"
REVIEWER_FIXTURE_PATH = REPOSITORY_ROOT / "tests" / "fixtures" / "resume-review-reviewer-v2.json"
DECISION_ADAPTER = TypeAdapter(ResumeReviewDecisionRequest)


def load_payload() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def load_reviewer_payload() -> dict[str, object]:
    return json.loads(REVIEWER_FIXTURE_PATH.read_text(encoding="utf-8"))


def test_shared_v2_fixture_round_trips_without_changing_v1_contracts() -> None:
    payload = load_payload()
    fixture = ResumeReviewHitlContractFixture.model_validate(payload)

    assert fixture.model_dump(mode="json") == payload
    assert type(fixture.decisions[0]) is ApproveResumeReviewDecision
    assert type(fixture.decisions[1]) is ApproveWithEditsResumeReviewDecision
    assert type(fixture.decisions[2]) is RejectResumeReviewDecision


def test_reviewer_detail_and_queue_fixtures_round_trip_with_strict_allowlists() -> None:
    payload = load_reviewer_payload()
    detail = ResumeReviewRunDetailResponse.model_validate(payload["detail_response"])
    queue = PendingResumeReviewQueueResponse.model_validate(payload["queue_response"])

    assert detail.model_dump(mode="json") == payload["detail_response"]
    assert queue.model_dump(mode="json") == payload["queue_response"]
    assert detail.proposal.roles[0].role_id == detail.proposal.top_role_id
    assert queue.items[0].top_role.role_id == detail.proposal.top_role_id

    serialized = detail.model_dump_json()
    for private_field in (
        "merchant_id",
        "actor_id",
        "request_sha256",
        "analysis_input_sha256",
        "extraction_snapshot_sha256",
        "role_policy_snapshot",
        "document_snapshot",
        "source_blocks",
        "resume_text",
        "checkpoint",
        "tool_calls",
    ):
        assert private_field not in serialized
    assert detail.proposal.confidence.policy_sha256 == "c" * 64
    assert detail.proposal.confidence.is_probability is False
    assert detail.proposal.confidence.threshold_applied is False

    raw_detail = payload["detail_response"]
    assert isinstance(raw_detail, dict)
    for field in ("merchant_id", "document_snapshot", "checkpoint_state"):
        with pytest.raises(ValidationError, match="extra_forbidden"):
            ResumeReviewRunDetailResponse.model_validate({**raw_detail, field: "private"})

    raw_proposal = raw_detail["proposal"]
    assert isinstance(raw_proposal, dict)
    for field in ("policy_sha256", "source_blocks", "candidate_score_revision_id"):
        with pytest.raises(ValidationError, match="extra_forbidden"):
            ResumeReviewRunDetailResponse.model_validate(
                {
                    **raw_detail,
                    "proposal": {**raw_proposal, field: "private"},
                }
            )


def test_reviewer_editable_output_round_trips_into_the_edit_decision_contract() -> None:
    detail = ResumeReviewRunDetailResponse.model_validate(
        load_reviewer_payload()["detail_response"]
    )
    decision = DECISION_ADAPTER.validate_python(
        {
            "schema_version": "2.0",
            "decision_id": "66666666-6666-4666-8666-666666666666",
            "review_id": detail.review.review_id if detail.review is not None else None,
            "expected_review_version": (
                detail.review.review_version if detail.review is not None else None
            ),
            "action": "approve_with_edits",
            "replacement_agent1_output": detail.proposal.editable_agent1_output.model_dump(
                mode="json"
            ),
            "reason_code": "reviewer-confirmed-evidence",
        }
    )

    assert isinstance(decision, ApproveWithEditsResumeReviewDecision)
    assert decision.replacement_agent1_output == detail.proposal.editable_agent1_output


def test_reviewer_proposal_rejects_score_evidence_and_question_plan_drift() -> None:
    raw_detail = load_reviewer_payload()["detail_response"]
    assert isinstance(raw_detail, dict)
    raw_proposal = raw_detail["proposal"]
    assert isinstance(raw_proposal, dict)

    roles = raw_proposal["roles"]
    assert isinstance(roles, list)
    with pytest.raises(ValidationError, match="deterministic ranking"):
        ResumeReviewRunDetailResponse.model_validate(
            {
                **raw_detail,
                "proposal": {**raw_proposal, "roles": list(reversed(roles))},
            }
        )

    details = raw_proposal["criterion_details"]
    assert isinstance(details, list)
    changed_details = [dict(item) for item in details]
    changed_details[0]["evidence_snippets"] = []
    with pytest.raises(ValidationError, match="require evidence"):
        ResumeReviewRunDetailResponse.model_validate(
            {
                **raw_detail,
                "proposal": {**raw_proposal, "criterion_details": changed_details},
            }
        )

    question_plan = raw_proposal["question_plan"]
    assert isinstance(question_plan, dict)
    with pytest.raises(ValidationError, match="question plan"):
        ResumeReviewRunDetailResponse.model_validate(
            {
                **raw_detail,
                "proposal": {
                    **raw_proposal,
                    "question_plan": {
                        **question_plan,
                        "role_id": "11111111-1111-4111-8111-111111111111",
                    },
                },
            }
        )


def test_start_request_rejects_authority_private_state_and_decision_injection() -> None:
    payload = load_payload()["start_request"]
    assert isinstance(payload, dict)
    StartResumeReviewRunRequest.model_validate(payload)

    for field, value in (
        ("merchant_id", "69999999-9999-4999-8999-999999999999"),
        ("actor_id", "69999999-9999-4999-8999-999999999999"),
        ("reviewer_id", "69999999-9999-4999-8999-999999999999"),
        ("thread_id", "caller-controlled-thread"),
        ("checkpoint_id", "private-checkpoint"),
        ("score", 100),
        ("recommended_role_id", "69999999-9999-4999-8999-999999999999"),
        ("tool_calls", ["update_fit_score"]),
        ("resume_markdown", "# private resume"),
        ("embedding", [0.1]),
        ("persist", True),
    ):
        with pytest.raises(ValidationError, match="extra_forbidden"):
            StartResumeReviewRunRequest.model_validate({**payload, field: value})

    for required in ("schema_version", "request_id", "document_id", "candidate_id"):
        missing = dict(payload)
        missing.pop(required)
        with pytest.raises(ValidationError, match="Field required"):
            StartResumeReviewRunRequest.model_validate(missing)

    with pytest.raises(ValidationError):
        StartResumeReviewRunRequest.model_validate({**payload, "schema_version": "1.0"})


def test_run_projection_covers_all_statuses_and_enforces_review_lifecycle() -> None:
    fixture = ResumeReviewHitlContractFixture.model_validate(load_payload())
    running = fixture.run_responses[0].model_dump(mode="json")
    pending = fixture.run_responses[1].model_dump(mode="json")

    for status in ResumeReviewRunStatus:
        base = (
            running
            if status in {ResumeReviewRunStatus.RUNNING, ResumeReviewRunStatus.FAILED}
            else pending
        )
        parsed = ResumeReviewRunResponse.model_validate({**base, "status": status.value})
        assert parsed.status is status

    with pytest.raises(ValidationError, match="requires a review"):
        ResumeReviewRunResponse.model_validate({**pending, "review": None})
    with pytest.raises(ValidationError, match="running status"):
        ResumeReviewRunResponse.model_validate({**running, "review": pending["review"]})
    with pytest.raises(ValidationError, match="reason_codes must be unique"):
        ResumeReviewRunResponse.model_validate(
            {**pending, "reason_codes": ["human-review", "human-review"]}
        )

    for field, value in (
        ("merchant_id", "69999999-9999-4999-8999-999999999999"),
        ("actor_id", "69999999-9999-4999-8999-999999999999"),
        ("thread_id", "private-thread"),
        ("checkpoint", {"state": "private"}),
        ("checkpoint_state", {"resume_text": "private"}),
        ("resume_text", "private resume"),
        ("contact_email", "private@example.test"),
    ):
        with pytest.raises(ValidationError, match="extra_forbidden"):
            ResumeReviewRunResponse.model_validate({**pending, field: value})


def test_decision_union_requires_exact_action_specific_fields() -> None:
    decisions = load_payload()["decisions"]
    assert isinstance(decisions, list)
    approve, edited, reject = decisions

    assert isinstance(DECISION_ADAPTER.validate_python(approve), ApproveResumeReviewDecision)
    assert isinstance(
        DECISION_ADAPTER.validate_python(edited),
        ApproveWithEditsResumeReviewDecision,
    )
    assert isinstance(DECISION_ADAPTER.validate_python(reject), RejectResumeReviewDecision)

    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python({**approve, "reason_code": "unrequested-reason"})
    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python({**edited, "replacement_agent1_output": None})
    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python(
            {key: value for key, value in edited.items() if key != "reason_code"}
        )
    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python(
            {key: value for key, value in reject.items() if key != "reason_code"}
        )
    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python({**approve, "action": "edit"})


def test_decisions_reject_scores_recommendations_tools_and_authority_at_every_boundary() -> None:
    decisions = load_payload()["decisions"]
    assert isinstance(decisions, list)
    approve, edited, _ = decisions

    for field, value in (
        ("merchant_id", "69999999-9999-4999-8999-999999999999"),
        ("actor_id", "69999999-9999-4999-8999-999999999999"),
        ("reviewer_id", "69999999-9999-4999-8999-999999999999"),
        ("thread_id", "caller-controlled-thread"),
        ("checkpoint_id", "private-checkpoint"),
        ("score", 100),
        ("recommended_role_id", "69999999-9999-4999-8999-999999999999"),
        ("tool_calls", ["update_fit_score"]),
    ):
        with pytest.raises(ValidationError):
            DECISION_ADAPTER.validate_python({**approve, field: value})

    replacement = edited["replacement_agent1_output"]
    assert isinstance(replacement, dict)
    for field, value in (
        ("score", 100),
        ("deterministic_score", 100),
        ("recommended_role_id", "69999999-9999-4999-8999-999999999999"),
        ("tool_calls", ["update_fit_score"]),
    ):
        with pytest.raises(ValidationError):
            DECISION_ADAPTER.validate_python(
                {
                    **edited,
                    "replacement_agent1_output": {**replacement, field: value},
                }
            )

    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python({**approve, "expected_review_version": 0})
    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python({**approve, "decision_id": "not-a-uuid"})


@pytest.mark.parametrize(
    "reason_code",
    ["ab", "contains spaces", "a" * 121],
)
def test_edit_and_reject_reason_codes_are_bounded(reason_code: str) -> None:
    edited = load_payload()["decisions"][1]
    with pytest.raises(ValidationError):
        DECISION_ADAPTER.validate_python({**edited, "reason_code": reason_code})
