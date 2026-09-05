import asyncio
import base64
import json

import httpx
from test_resume_review_workflow_phase4 import (
    MERCHANT_ID,
    REQUEST_ID,
    agent1_output,
    agent2_output,
    policies,
    request,
)

from teamflow_hiring_agent.resume_review.confidence import (
    ConfidencePolicy,
    ConfidenceShadowRecord,
    ConfidenceSignal,
    ConfidenceSignalId,
    assess_confidence,
    build_shadow_record,
    load_default_confidence_policy,
)
from teamflow_hiring_agent.resume_review.contracts import ConfidenceAssessment
from teamflow_hiring_agent.resume_review.persistence import (
    ReviewPersistenceError,
    SupabaseReviewWriter,
)
from teamflow_hiring_agent.resume_review.scoring import build_agent1_evaluation
from teamflow_hiring_agent.resume_review.workflow_contracts import QuestionsStatus, ReviewStatus


def _writer(handler) -> SupabaseReviewWriter:
    payload = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "role": "teamflow_review_writer",
                    "merchant_id": MERCHANT_ID,
                    "exp": 4_102_444_800,
                },
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    return SupabaseReviewWriter(
        url="https://supabase.test",
        trusted_origin="https://supabase.test",
        api_key="publishable-test-key",
        access_token=f"header.{payload}.signature",
        transport=httpx.MockTransport(handler),
    )


def _confidence(
    score: int,
) -> tuple[
    ConfidenceAssessment,
    ConfidenceShadowRecord,
    ConfidencePolicy,
    tuple[ConfidenceSignal, ...],
]:
    policy = load_default_confidence_policy()
    signals = tuple(
        ConfidenceSignal(
            component_id=component.component_id,
            score=(
                score if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE else 100
            ),
            hard_failure=False,
            reason_codes=(
                ("criteria_evidence_missing",)
                if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE and score < 100
                else ()
            ),
        )
        for component in policy.components
    )
    assessment = assess_confidence(signals, policy)
    shadow = build_shadow_record(
        assessment,
        policy,
        signals=signals,
        review_required=True,
        status=ReviewStatus.REVIEW_REQUIRED,
    )
    return assessment, shadow, policy, signals


def _persist(writer: SupabaseReviewWriter, *, evaluation=None, confidence_score: int = 88):
    role_policies = policies()
    resolved_evaluation = evaluation or build_agent1_evaluation(agent1_output(), role_policies)
    assessment, shadow, confidence_policy, confidence_signals = _confidence(confidence_score)
    return asyncio.run(
        writer.persist(
            request=request(persist=True),
            evaluation=resolved_evaluation,
            question_plan=agent2_output(),
            questions_status=QuestionsStatus.COMPLETE,
            extraction_fingerprint="c" * 64,
            policy_fingerprint="d" * 64,
            policy_snapshot=role_policies,
            confidence_assessment=assessment,
            confidence_shadow_record=shadow,
            confidence_policy_snapshot=confidence_policy,
            confidence_signal_snapshot=confidence_signals,
            status=ReviewStatus.REVIEW_REQUIRED,
            review_required=True,
            reason_codes=("model_classification_requires_human_review",),
        )
    )


def test_persistence_sends_an_auditable_policy_snapshot_and_final_output_fingerprint() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        return httpx.Response(
            201,
            json=[
                {
                    "id": "77777777-7777-4777-8777-777777777777",
                    "input_sha256": payload["input_sha256"],
                }
            ],
        )

    receipt = _persist(_writer(handler))

    assert receipt.replayed is False
    assert seen["merchant_id"] == MERCHANT_ID
    assert seen["request_id"] == REQUEST_ID
    assert len(seen["role_policy_snapshot"]) == 2
    assert seen["agent1_evaluation"]["ranked_roles"][0]["deterministic_score"] == 70
    assert seen["confidence_assessment"]["score"] == 88
    assert seen["confidence_shadow_record"]["status"] == "review_required"
    assert seen["review_required"] is True
    assert len(seen["confidence_policy_snapshot"]["components"]) == 10
    assert len(seen["confidence_signal_snapshot"]) == 10
    assert seen["confidence_threshold_applied"] is False


def test_idempotent_replay_requires_the_exact_final_result_fingerprint() -> None:
    posted_hashes: list[str] = []

    def conflict_handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            payload = json.loads(request.content)
            posted_hashes.append(payload["input_sha256"])
            return httpx.Response(409, json={"code": "23505"})
        return httpx.Response(
            200,
            json=[
                {
                    "id": "77777777-7777-4777-8777-777777777777",
                    "input_sha256": posted_hashes[0],
                }
            ],
        )

    first = _persist(_writer(conflict_handler))
    assert first.replayed is True

    changed_output = agent1_output().model_copy(
        update={"limitations": ("A different validated limitation.",)}
    )
    changed_evaluation = build_agent1_evaluation(changed_output, policies())
    try:
        _persist(_writer(conflict_handler), evaluation=changed_evaluation)
    except ReviewPersistenceError:
        pass
    else:
        raise AssertionError("different final output must not be accepted as an idempotent replay")
    try:
        _persist(_writer(conflict_handler), confidence_score=87)
    except ReviewPersistenceError:
        pass
    else:
        raise AssertionError("different confidence provenance must change idempotency identity")
    assert len(posted_hashes) == 3
    assert posted_hashes[0] != posted_hashes[1]
    assert posted_hashes[0] != posted_hashes[2]
