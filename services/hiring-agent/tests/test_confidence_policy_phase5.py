from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from teamflow_hiring_agent.resume_review.confidence import (
    ConfidencePolicy,
    ConfidencePolicyError,
    ConfidenceSignal,
    ConfidenceSignalId,
    assess_confidence,
    build_shadow_record,
    confidence_policy_sha256,
    derive_confidence_signals,
    load_confidence_policy,
    load_default_confidence_policy,
    validate_confidence_assessment,
)
from teamflow_hiring_agent.resume_review.workflow_contracts import ReviewStatus


def all_signals(score: int = 100) -> tuple[ConfidenceSignal, ...]:
    return tuple(
        ConfidenceSignal(component_id=component_id, score=score)
        for component_id in ConfidenceSignalId
    )


def policy_with_weights(
    weighted_component: ConfidenceSignalId,
    *,
    version: str = "1.0.1",
) -> ConfidencePolicy:
    return ConfidencePolicy.model_validate(
        {
            "schema_version": "1.0",
            "policy_id": "resume-review-confidence-test",
            "policy_version": version,
            "mode": "shadow",
            "status": "uncalibrated",
            "components": [
                {
                    "component_id": component_id.value,
                    "weight": 100 if component_id is weighted_component else 0,
                }
                for component_id in ConfidenceSignalId
            ],
        }
    )


def test_default_policy_is_canonical_versioned_and_deterministic() -> None:
    policy = load_default_confidence_policy()
    first = assess_confidence(all_signals(), policy)
    second = assess_confidence(reversed(all_signals()), policy)

    assert policy.mode == "shadow"
    assert policy.status == "uncalibrated"
    assert policy.identity.policy_id == "resume-review-confidence"
    assert policy.identity.policy_version == "1.0.0"
    assert first.model_dump_json() == second.model_dump_json()
    assert first.score == 100
    assert first.is_probability is False
    assert confidence_policy_sha256(policy) == (
        "c83ba0b8261bd5d863feb154f9c816099efe49f7b222e50fe72a45689f611e53"
    )
    assert (
        next(
            component.weight
            for component in policy.components
            if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE
        )
        == 100
    )
    assert all(
        component.weight == 0
        for component in policy.components
        if component.component_id is not ConfidenceSignalId.CRITERIA_COVERAGE
    )

    changed = policy.model_dump(mode="json")
    changed["components"][0]["weight"] = 1
    changed["components"][5]["weight"] = 99
    changed_policy = ConfidencePolicy.model_validate(changed)
    assert confidence_policy_sha256(changed_policy) != confidence_policy_sha256(policy)


def test_threshold_like_environment_cannot_change_shadow_assessment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    policy = load_default_confidence_policy()
    before = assess_confidence(all_signals(73), policy)
    monkeypatch.setenv("RESUME_REVIEW_CONFIDENCE_THRESHOLD", "99")
    after = assess_confidence(all_signals(73), policy)

    assert before == after
    assert "threshold" not in policy.model_dump(mode="json")


def test_policy_engine_honors_an_explicit_single_component_test_policy() -> None:
    for component_id in ConfidenceSignalId:
        policy = policy_with_weights(component_id)
        signals = tuple(
            ConfidenceSignal(
                component_id=item,
                score=37 if item is component_id else 100,
            )
            for item in ConfidenceSignalId
        )
        assessment = assess_confidence(signals, policy)
        assert assessment.score == 37
        assert not assessment.hard_failure


def test_missing_provider_grounding_and_conflict_signals_fail_closed() -> None:
    policy = load_default_confidence_policy()
    missing = tuple(
        signal
        for signal in all_signals()
        if signal.component_id is not ConfidenceSignalId.CONTEXT_VALIDATION_GATE
    )
    missing_assessment = assess_confidence(missing, policy)
    assert missing_assessment.hard_failure
    assert "missing_context_validation_gate" in missing_assessment.reason_codes

    for component_id, reason_code in (
        (ConfidenceSignalId.PROVIDER_COMPLETION_GATE, "agent1_provider_failed"),
        (ConfidenceSignalId.LITERAL_GROUNDING_GATE, "agent1_invalid_evidence"),
        (ConfidenceSignalId.EVIDENCE_CONSISTENCY_GATE, "conflicting_evidence"),
        (ConfidenceSignalId.SCORE_CALCULATION_GATE, "calculation_inconsistent"),
        (ConfidenceSignalId.SAFETY_VALIDATION_GATE, "safety_violation"),
    ):
        signals = tuple(
            ConfidenceSignal(
                component_id=item,
                score=0 if item is component_id else 100,
                hard_failure=item is component_id,
                reason_codes=(reason_code,) if item is component_id else (),
            )
            for item in ConfidenceSignalId
        )
        assessment = assess_confidence(signals, policy)
        assert assessment.hard_failure
        assert reason_code in assessment.reason_codes
        assert assessment.score > 0

    future_failure = assess_confidence(
        derive_confidence_signals({"failure_code": "future_workflow_failure"}),
        policy,
    )
    assert future_failure.hard_failure
    assert "future_workflow_failure" in future_failure.reason_codes


def test_malformed_policy_never_falls_back(tmp_path: Path) -> None:
    policy = load_default_confidence_policy().model_dump(mode="json")
    policy["threshold"] = 85
    invalid = tmp_path / "policy.json"
    invalid.write_text(json.dumps(policy, sort_keys=True, separators=(",", ":")) + "\n")
    with pytest.raises(ConfidencePolicyError):
        load_confidence_policy(invalid)

    missing = load_default_confidence_policy().model_dump(mode="json")
    missing["components"] = missing["components"][:-1]
    with pytest.raises(ValidationError, match="at least 10 items"):
        ConfidencePolicy.model_validate(missing)

    wrong_total = load_default_confidence_policy().model_dump(mode="json")
    wrong_total["components"][0]["weight"] = 9
    with pytest.raises(ValidationError, match="sum to 100"):
        ConfidencePolicy.model_validate(wrong_total)


def test_shadow_record_has_no_threshold_decision_or_private_identifiers() -> None:
    policy = load_default_confidence_policy()
    assessment = assess_confidence(all_signals(37), policy)
    record = build_shadow_record(
        assessment,
        policy,
        signals=all_signals(37),
        review_required=False,
        status=ReviewStatus.COMPLETE,
    )
    payload = record.model_dump(mode="json")

    assert payload["threshold_applied"] is False
    assert "threshold" not in payload
    assert "would_accept" not in payload
    assert "candidate_id" not in payload
    assert "merchant_id" not in payload
    assert "document_id" not in payload
    assert "Jordan Rivera" not in json.dumps(payload)
    assert "Northstar Cafe" not in json.dumps(payload)

    tampered = assessment.model_copy(update={"score": 99})
    with pytest.raises(ConfidencePolicyError, match="formula"):
        validate_confidence_assessment(tampered, policy, signals=all_signals(37))

    hard = assess_confidence(
        tuple(
            ConfidenceSignal(
                component_id=item,
                score=0 if item is ConfidenceSignalId.PROVIDER_COMPLETION_GATE else 100,
                hard_failure=item is ConfidenceSignalId.PROVIDER_COMPLETION_GATE,
                reason_codes=("agent1_provider_failed",)
                if item is ConfidenceSignalId.PROVIDER_COMPLETION_GATE
                else (),
            )
            for item in ConfidenceSignalId
        ),
        policy,
    )
    forged = hard.model_copy(update={"hard_failure": False, "reason_codes": ()})
    with pytest.raises(ConfidencePolicyError, match="source signals"):
        validate_confidence_assessment(
            forged,
            policy,
            signals=tuple(
                ConfidenceSignal(
                    component_id=item,
                    score=0 if item is ConfidenceSignalId.PROVIDER_COMPLETION_GATE else 100,
                    hard_failure=item is ConfidenceSignalId.PROVIDER_COMPLETION_GATE,
                    reason_codes=("agent1_provider_failed",)
                    if item is ConfidenceSignalId.PROVIDER_COMPLETION_GATE
                    else (),
                )
                for item in ConfidenceSignalId
            ),
        )
