"""Tenant-scoped, idempotent persistence for validated résumé-review runs."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

import httpx
from pydantic import Field, StrictBool, model_validator

from ..supabase_http import (
    SupabaseBoundaryError,
    SupabaseJSONClient,
    scoped_merchant_id_from_jwt,
)
from .confidence import (
    ConfidencePolicy,
    ConfidenceShadowRecord,
    ConfidenceSignal,
    validate_confidence_assessment,
)
from .confidence import (
    confidence_policy_sha256 as calculate_confidence_policy_sha256,
)
from .contracts import (
    Agent1Evaluation,
    Agent2QuestionPlan,
    ConfidenceAssessment,
    DatabaseId,
    FrozenContract,
    Identifier,
    RoleScoringPolicy,
)
from .fingerprints import role_policy_fingerprint as role_policy_fingerprint
from .workflow_contracts import (
    DocumentId,
    PersistedReview,
    QuestionsStatus,
    ResumeReviewRequest,
    ReviewStatus,
    Sha256,
)


class ReviewPersistenceError(RuntimeError):
    """A sanitized persistence failure safe to classify at the graph boundary."""


class ReviewPersistenceRecord(FrozenContract):
    """Validated immutable evidence passed to either Phase 4 or Phase 6 storage."""

    schema_version: Literal["1.0"]
    request_id: DatabaseId
    merchant_id: DatabaseId
    document_id: DocumentId
    candidate_id: DatabaseId | None
    input_sha256: Sha256
    extraction_snapshot_sha256: Sha256
    policy_sha256: Sha256
    role_policy_snapshot: tuple[RoleScoringPolicy, ...] = Field(
        min_length=1,
        max_length=5,
    )
    confidence_assessment: ConfidenceAssessment
    confidence_shadow_record: ConfidenceShadowRecord
    confidence_policy_snapshot: ConfidencePolicy
    confidence_signal_snapshot: tuple[ConfidenceSignal, ...] = Field(
        min_length=10,
        max_length=10,
    )
    confidence_policy_sha256: Sha256
    confidence_threshold_applied: Literal[False]
    status: ReviewStatus
    review_required: StrictBool
    agent1_evaluation: Agent1Evaluation
    questions_status: QuestionsStatus
    question_plan: Agent2QuestionPlan | None
    reason_codes: tuple[Identifier, ...] = Field(max_length=20)

    @model_validator(mode="after")
    def validate_record(self) -> ReviewPersistenceRecord:
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("reason_codes must be unique")
        if (self.questions_status is QuestionsStatus.COMPLETE) != (self.question_plan is not None):
            raise ValueError("question_plan must match complete questions status")
        if (self.status is ReviewStatus.REVIEW_REQUIRED) != self.review_required:
            raise ValueError("review status and review_required must agree")
        if not self.review_required:
            raise ValueError("model-derived review records are unapproved proposals")
        assessment = self.confidence_assessment
        shadow = self.confidence_shadow_record
        if (
            assessment.score != shadow.score
            or assessment.hard_failure != shadow.hard_failure
            or assessment.reason_codes != shadow.reason_codes
            or assessment.policy_identity != shadow.policy_identity
        ):
            raise ValueError("confidence assessment and shadow record must agree")
        if shadow.status is not self.status or shadow.review_required != self.review_required:
            raise ValueError("confidence shadow record must bind the final disposition")
        if self.confidence_policy_sha256 != shadow.policy_sha256:
            raise ValueError("confidence policy hash must match the shadow record")
        if (
            calculate_confidence_policy_sha256(self.confidence_policy_snapshot)
            != self.confidence_policy_sha256
        ):
            raise ValueError("confidence policy snapshot must match its canonical hash")
        validate_confidence_assessment(
            assessment,
            self.confidence_policy_snapshot,
            signals=self.confidence_signal_snapshot,
        )
        if self.confidence_threshold_applied or shadow.threshold_applied:
            raise ValueError("uncalibrated confidence must not apply a threshold")
        if assessment.hard_failure and (not self.review_required or not assessment.reason_codes):
            raise ValueError("confidence hard failures must have reasons and require review")
        return self

    def rest_payload(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


def build_review_persistence_record(
    *,
    request: ResumeReviewRequest,
    evaluation: Agent1Evaluation,
    question_plan: Agent2QuestionPlan | None,
    questions_status: QuestionsStatus,
    extraction_fingerprint: str,
    policy_fingerprint: str,
    policy_snapshot: tuple[RoleScoringPolicy, ...],
    confidence_assessment: ConfidenceAssessment,
    confidence_shadow_record: ConfidenceShadowRecord,
    confidence_policy_snapshot: ConfidencePolicy,
    confidence_signal_snapshot: tuple[ConfidenceSignal, ...],
    status: ReviewStatus,
    review_required: bool,
    reason_codes: tuple[str, ...],
) -> ReviewPersistenceRecord:
    """Build and content-bind the exact validated result stored for later review."""

    evaluation_payload = evaluation.model_dump(mode="json")
    question_payload = question_plan.model_dump(mode="json") if question_plan is not None else None
    policy_payload = [policy.model_dump(mode="json") for policy in policy_snapshot]
    confidence_payload = confidence_assessment.model_dump(mode="json")
    confidence_shadow_payload = confidence_shadow_record.model_dump(mode="json")
    confidence_policy_payload = confidence_policy_snapshot.model_dump(mode="json")
    confidence_signal_payload = [
        signal.model_dump(mode="json") for signal in confidence_signal_snapshot
    ]
    confidence_policy_fingerprint = calculate_confidence_policy_sha256(confidence_policy_snapshot)
    identity = {
        "candidate_id": request.candidate_id,
        "confidence_assessment": confidence_payload,
        "confidence_policy_sha256": confidence_policy_fingerprint,
        "confidence_policy_snapshot": confidence_policy_payload,
        "confidence_signal_snapshot": confidence_signal_payload,
        "confidence_shadow_record": confidence_shadow_payload,
        "confidence_threshold_applied": False,
        "document_id": request.document_id,
        "evaluation": evaluation_payload,
        "extraction_fingerprint": extraction_fingerprint,
        "merchant_id": request.merchant_id,
        "policy_fingerprint": policy_fingerprint,
        "policy_snapshot": policy_payload,
        "question_plan": question_payload,
        "questions_status": questions_status.value,
        "reason_codes": list(reason_codes),
        "review_required": review_required,
        "schema_version": "1.0",
        "status": status.value,
    }
    input_sha256 = hashlib.sha256(
        json.dumps(
            identity,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    return ReviewPersistenceRecord(
        schema_version="1.0",
        request_id=request.request_id,
        merchant_id=request.merchant_id,
        document_id=request.document_id,
        candidate_id=request.candidate_id,
        input_sha256=input_sha256,
        extraction_snapshot_sha256=extraction_fingerprint,
        policy_sha256=policy_fingerprint,
        role_policy_snapshot=policy_snapshot,
        confidence_assessment=confidence_assessment,
        confidence_shadow_record=confidence_shadow_record,
        confidence_policy_snapshot=confidence_policy_snapshot,
        confidence_signal_snapshot=confidence_signal_snapshot,
        confidence_policy_sha256=confidence_policy_fingerprint,
        confidence_threshold_applied=False,
        status=status,
        review_required=review_required,
        agent1_evaluation=evaluation,
        questions_status=questions_status,
        question_plan=question_plan,
        reason_codes=reason_codes,
    )


class SupabaseReviewWriter:
    def __init__(
        self,
        *,
        url: str,
        trusted_origin: str,
        api_key: str,
        access_token: str,
        production: bool = False,
        timeout_seconds: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._merchant_id = scoped_merchant_id_from_jwt(
            access_token,
            expected_role="teamflow_review_writer",
        )
        self._client = SupabaseJSONClient(
            url=url,
            trusted_origin=trusted_origin,
            api_key=api_key,
            access_token=access_token,
            production=production,
            timeout_seconds=timeout_seconds,
            max_response_bytes=65_536,
            transport=transport,
        )

    async def persist(
        self,
        *,
        request: ResumeReviewRequest,
        evaluation: Agent1Evaluation,
        question_plan: Agent2QuestionPlan | None,
        questions_status: QuestionsStatus,
        extraction_fingerprint: str,
        policy_fingerprint: str,
        policy_snapshot: tuple[RoleScoringPolicy, ...],
        confidence_assessment: ConfidenceAssessment,
        confidence_shadow_record: ConfidenceShadowRecord,
        confidence_policy_snapshot: ConfidencePolicy,
        confidence_signal_snapshot: tuple[ConfidenceSignal, ...],
        status: ReviewStatus,
        review_required: bool,
        reason_codes: tuple[str, ...],
    ) -> PersistedReview:
        if str(request.merchant_id) != self._merchant_id:
            raise ReviewPersistenceError("Résumé-review writer merchant scope mismatch")
        record = build_review_persistence_record(
            request=request,
            evaluation=evaluation,
            question_plan=question_plan,
            questions_status=questions_status,
            extraction_fingerprint=extraction_fingerprint,
            policy_fingerprint=policy_fingerprint,
            policy_snapshot=policy_snapshot,
            confidence_assessment=confidence_assessment,
            confidence_shadow_record=confidence_shadow_record,
            confidence_policy_snapshot=confidence_policy_snapshot,
            confidence_signal_snapshot=confidence_signal_snapshot,
            status=status,
            review_required=review_required,
            reason_codes=reason_codes,
        )
        payload = record.rest_payload()

        try:
            response = await self._client.request_json(
                "POST",
                "/rest/v1/resume_review_runs?select=id,input_sha256",
                json_body=payload,
                extra_headers={"Prefer": "return=representation"},
                allowed_statuses=(200, 201, 409),
            )
            if response.status_code == 409:
                existing = await self._client.request_json(
                    "GET",
                    "/rest/v1/resume_review_runs"
                    f"?merchant_id=eq.{request.merchant_id}&request_id=eq.{request.request_id}"
                    "&select=id,input_sha256&limit=1",
                )
                rows = existing.payload
                if (
                    isinstance(rows, list)
                    and len(rows) == 1
                    and isinstance(rows[0], dict)
                    and rows[0].get("input_sha256") == record.input_sha256
                ):
                    return PersistedReview(review_id=rows[0]["id"], replayed=True)
                raise ReviewPersistenceError("Résumé-review idempotency conflict")
            rows = response.payload
        except SupabaseBoundaryError as exc:
            raise ReviewPersistenceError("Résumé-review persistence is unavailable") from exc
        if not (
            isinstance(rows, list)
            and len(rows) == 1
            and isinstance(rows[0], dict)
            and set(rows[0]) == {"id", "input_sha256"}
            and rows[0].get("input_sha256") == record.input_sha256
        ):
            raise ReviewPersistenceError("Résumé-review insert was not confirmed")
        return PersistedReview(review_id=rows[0]["id"], replayed=False)
