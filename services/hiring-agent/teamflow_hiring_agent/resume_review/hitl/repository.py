"""PostgreSQL repository for the durable human-review boundary.

Only explicit ``teamflow_private`` projections are callable from the dedicated
runtime role.  Raw evidence, bearer tokens, and tenant identifiers never enter the
checkpoint database.  Every mutation is implemented by one database transaction and
is safe to retry with the same public idempotency identity.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4, uuid5

from psycopg import Error as PsycopgError
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import ValidationError

from ...security import (
    contains_instructional_manipulation,
    contains_sensitive_text,
    contains_unsafe_hiring_language,
)
from ..confidence import (
    ConfidencePolicy,
    ConfidenceShadowRecord,
    ConfidenceSignal,
    confidence_policy_sha256,
    validate_confidence_assessment,
)
from ..contracts import (
    Agent1Evaluation,
    Agent1ModelOutput,
    Agent2QuestionPlan,
    ConfidenceAssessment,
    RoleScoringPolicy,
)
from ..evidence import (
    validate_agent1_evidence,
    validate_agent1_projection_safety,
    validate_question_plan_safety,
    validate_role_policy_safety,
)
from ..persistence import ReviewPersistenceRecord, role_policy_fingerprint
from ..scoring import (
    build_agent1_evaluation,
    build_agent2_planning_context,
    validate_agent1_evaluation_against_policies,
)
from ..workflow_contracts import StoredDocumentExtraction
from .api import (
    HitlAlreadyDecidedError,
    HitlDependencyUnavailableError,
    HitlIdempotencyConflictError,
    HitlInvalidEditError,
    HitlMembershipDeniedError,
    HitlNotFoundError,
    HitlReviewerDeniedError,
    HitlStaleDecisionError,
)
from .auth import AuthenticatedUser, decode_capability_secret
from .checkpointing import stable_thread_id
from .contracts import (
    ApproveWithEditsResumeReviewDecision,
    PendingResumeReviewQueueItem,
    ResumeReviewDecisionRequest,
    ResumeReviewProposal,
    ResumeReviewRunDetailResponse,
    ResumeReviewRunResponse,
    StartResumeReviewRunRequest,
)
from .lifecycle import AppliedDecision, CreatedReview
from .service import (
    DecisionAuthorization,
    PreparedWorkflow,
    RecordedDecision,
    ReviewMembership,
)

_ID_NAMESPACE = UUID("ca4969e2-356a-5f52-a658-d17c026bf0a2")
_RETRYABLE_SQLSTATES = frozenset({"40001", "40P01"})
_STALE_MESSAGES = frozenset(
    {
        "teamflow_stale_review_version",
        "teamflow_stale_candidate_version",
    }
)
_ALREADY_DECIDED_MESSAGES = frozenset({"teamflow_review_already_decided"})
_IDENTITY_CONFLICT_MESSAGES = frozenset(
    {
        "teamflow_analysis_idempotency_conflict",
        "teamflow_decision_id_conflict",
        "teamflow_event_idempotency_conflict",
        "teamflow_review_idempotency_conflict",
        "teamflow_workflow_idempotency_conflict",
    }
)

Row = Mapping[str, Any]
_MAX_REVIEWER_EVIDENCE_PER_CRITERION = 3
_CAPABILITY_TTL_SECONDS = 15
_ACTOR_OPERATION_QUERY = """
select capability.result
from teamflow_private.execute_hitl_actor_operation(
  %s::uuid, %s::text, %s::uuid, %s::text, %s::bigint, %s::text,
  %s::text, %s::text, %s::bigint, %s::uuid, %s::text, %s::text
) as capability(result)
"""


class _HitlCapabilityIssuer:
    """Mint one-use database capabilities without retaining the encoded secret."""

    __slots__ = ("_auth_issuer", "_key", "key_id")

    def __init__(self, encoded_secret: str, *, auth_issuer: str) -> None:
        self._key = decode_capability_secret(encoded_secret)
        self._auth_issuer = auth_issuer
        self.key_id = hashlib.sha256(self._key).hexdigest()

    def issue(
        self,
        *,
        actor_id: str,
        operation: str,
        payload: Mapping[str, object],
        decision_actor: AuthenticatedUser | None = None,
    ) -> tuple[tuple[object, ...], str]:
        invalid_payload = False
        try:
            payload_text = json.dumps(
                dict(payload),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            )
            payload_bytes = payload_text.encode("utf-8")
        except (TypeError, ValueError, UnicodeError):
            invalid_payload = True
            payload_text = ""
            payload_bytes = b""
        if invalid_payload:
            raise HitlDependencyUnavailableError
        if not 2 <= len(payload_bytes) <= 1_048_576:
            raise HitlDependencyUnavailableError
        resource_sha256 = hashlib.sha256(payload_bytes).hexdigest()
        expires_at = int(time.time()) + _CAPABILITY_TTL_SECONDS
        nonce = str(uuid4())
        if decision_actor is None:
            session_id: str | None = None
            assurance_level: str | None = None
            authenticated_at: int | None = None
        else:
            if decision_actor.user_id != actor_id:
                raise HitlDependencyUnavailableError
            session_id = decision_actor.session_id
            assurance_level = decision_actor.assurance_level
            authenticated_at = decision_actor.authenticated_at
            if (
                session_id is None
                or assurance_level != "aal2"
                or authenticated_at is None
                or authenticated_at <= 0
            ):
                raise HitlReviewerDeniedError
        message = "\n".join(
            (
                "teamflow-hitl-capability-v2",
                self.key_id,
                self._auth_issuer,
                actor_id,
                session_id or "-",
                assurance_level or "-",
                str(authenticated_at) if authenticated_at is not None else "-",
                operation,
                resource_sha256,
                str(expires_at),
                nonce,
            )
        )
        signature = hmac.new(self._key, message.encode("utf-8"), hashlib.sha256).hexdigest()
        return (
            (
                actor_id,
                self._auth_issuer,
                session_id,
                assurance_level,
                authenticated_at,
                operation,
                resource_sha256,
                expires_at,
                nonce,
                self.key_id,
                signature,
            ),
            payload_text,
        )


def _review_reference(row: Row) -> dict[str, object] | None:
    if row["review_id"] is None:
        return None
    return {
        "review_id": str(row["review_id"]),
        "review_version": int(row["review_version"]),
    }


def _model_output_from_evaluation(evaluation: Agent1Evaluation) -> Agent1ModelOutput:
    """Recover the complete model-owned projection from an immutable evaluation."""

    return Agent1ModelOutput.model_validate(
        {
            "schema_version": "1.0",
            "role_assessments": [
                {
                    "role_id": match.role_id,
                    "criterion_assessments": [
                        assessment.model_dump(mode="json")
                        for assessment in match.criterion_assessments
                    ],
                }
                for match in evaluation.ranked_roles
            ],
            "limitations": evaluation.limitations,
        }
    )


def _validate_public_text(value: str, *, label: str) -> None:
    if (
        contains_sensitive_text(value)
        or contains_unsafe_hiring_language(value)
        or contains_instructional_manipulation(value)
    ):
        raise ValueError(f"{label} failed safety validation")


def _validate_analysis_for_review(analysis: ReviewPersistenceRecord) -> None:
    """Make every public proposal invariant true before admitting a durable run."""

    policies = analysis.role_policy_snapshot
    validate_role_policy_safety(policies)
    if role_policy_fingerprint(policies) != analysis.policy_sha256:
        raise ValueError("analysis policy fingerprint mismatch")
    evaluation = analysis.agent1_evaluation
    validate_agent1_evaluation_against_policies(evaluation, policies)
    validate_agent1_projection_safety(_model_output_from_evaluation(evaluation))
    for limitation in evaluation.limitations:
        _validate_public_text(limitation, label="analysis limitation")
    if analysis.question_plan is not None:
        validate_question_plan_safety(
            build_agent2_planning_context(evaluation, policies),
            analysis.question_plan,
            evaluation=evaluation,
            policies=policies,
        )


def _reviewer_confidence(row: Row) -> dict[str, object]:
    assessment = ConfidenceAssessment.model_validate(row["confidence_assessment"])
    shadow = ConfidenceShadowRecord.model_validate(row["confidence_shadow_record"])
    policy = ConfidencePolicy.model_validate(row["confidence_policy_snapshot"])
    signals = tuple(
        ConfidenceSignal.model_validate(item) for item in row["confidence_signal_snapshot"]
    )
    validate_confidence_assessment(assessment, policy, signals=signals)
    if (
        assessment.score != shadow.score
        or assessment.hard_failure != shadow.hard_failure
        or assessment.reason_codes != shadow.reason_codes
        or assessment.policy_identity != shadow.policy_identity
        or shadow.status.value != row["analysis_status"]
        or shadow.review_required != bool(row["analysis_review_required"])
        or shadow.policy_sha256 != row["confidence_policy_sha256"]
        or confidence_policy_sha256(policy) != row["confidence_policy_sha256"]
        or shadow.threshold_applied
        or bool(row["confidence_threshold_applied"])
    ):
        raise ValueError("review confidence provenance mismatch")
    return {
        "schema_version": shadow.schema_version,
        "mode": shadow.mode,
        "score": assessment.score,
        "is_probability": assessment.is_probability,
        "hard_failure": assessment.hard_failure,
        "threshold_applied": shadow.threshold_applied,
        "review_required": shadow.review_required,
        "status": shadow.status,
        "components": assessment.components,
        "reason_codes": assessment.reason_codes,
        "policy_identity": assessment.policy_identity,
        "policy_sha256": shadow.policy_sha256,
    }


def _reviewer_proposal(row: Row) -> ResumeReviewProposal:
    """Validate immutable v1 artifacts, then remove score/tool/private authority."""

    policies = tuple(RoleScoringPolicy.model_validate(item) for item in row["role_policy_snapshot"])
    if not 1 <= len(policies) <= 5:
        raise ValueError("review proposal policy count is invalid")
    validate_role_policy_safety(policies)
    if role_policy_fingerprint(policies) != row["policy_sha256"]:
        raise ValueError("review proposal policy fingerprint mismatch")
    document = StoredDocumentExtraction.model_validate(row["document_snapshot"])
    if document.snapshot_sha256 != row["extraction_snapshot_sha256"]:
        raise ValueError("review proposal extraction fingerprint mismatch")
    evaluation = Agent1Evaluation.model_validate(row["agent1_evaluation"])
    validate_agent1_evaluation_against_policies(evaluation, policies)
    policy_by_role = {policy.role_id: policy for policy in policies}

    role_summaries: list[dict[str, object]] = []
    editable_roles: list[dict[str, object]] = []
    for match in evaluation.ranked_roles:
        policy = policy_by_role[match.role_id]
        role_summaries.append(
            {
                "role_id": match.role_id,
                "role_title": policy.role_title,
                "scoring_policy": match.scoring_policy.model_dump(mode="json"),
                "deterministic_score": match.deterministic_score,
                "recommended": match.role_id == evaluation.recommended_role_id,
            }
        )
        assessment_by_criterion = {
            assessment.criterion_id: assessment for assessment in match.criterion_assessments
        }
        editable_roles.append(
            {
                "role_id": match.role_id,
                "criterion_assessments": [
                    {
                        "criterion_id": criterion.criterion_id,
                        "status": assessment_by_criterion[criterion.criterion_id].status,
                        "evidence": [
                            evidence.model_dump(mode="json")
                            for evidence in assessment_by_criterion[
                                criterion.criterion_id
                            ].evidence[:_MAX_REVIEWER_EVIDENCE_PER_CRITERION]
                        ],
                    }
                    for criterion in policy.criteria
                ],
            }
        )

    top_match = evaluation.ranked_roles[0]
    top_policy = policy_by_role[top_match.role_id]
    top_assessments = {
        assessment.criterion_id: assessment for assessment in top_match.criterion_assessments
    }
    criterion_details = []
    for criterion in top_policy.criteria:
        assessment = top_assessments[criterion.criterion_id]
        criterion_details.append(
            {
                "role_id": top_match.role_id,
                "criterion_id": criterion.criterion_id,
                "criterion_text": criterion.criterion_text,
                "weight": criterion.weight,
                "status": assessment.status,
                "gap_status": None if assessment.status.value == "met" else assessment.status,
                "evidence_snippets": [
                    evidence.model_dump(mode="json")
                    for evidence in assessment.evidence[:_MAX_REVIEWER_EVIDENCE_PER_CRITERION]
                ],
            }
        )

    question_plan = (
        None
        if row["question_plan"] is None
        else Agent2QuestionPlan.model_validate(row["question_plan"])
    )
    editable_output = Agent1ModelOutput.model_validate(
        {
            "schema_version": "1.0",
            "role_assessments": editable_roles,
            "limitations": evaluation.limitations,
        }
    )
    original_output = _model_output_from_evaluation(evaluation)
    validate_agent1_evidence(original_output, policies, document)
    validate_agent1_projection_safety(editable_output)
    for limitation in evaluation.limitations:
        _validate_public_text(limitation, label="review proposal limitation")
    if question_plan is not None:
        context = build_agent2_planning_context(evaluation, policies)
        validate_question_plan_safety(
            context,
            question_plan,
            evaluation=evaluation,
            policies=policies,
        )
    return ResumeReviewProposal.model_validate(
        {
            "schema_version": "2.0",
            "candidate_id": str(row["candidate_id"]),
            "created_at": row["created_at"],
            "top_role_id": top_match.role_id,
            "recommended_role_id": evaluation.recommended_role_id,
            "roles": role_summaries,
            "criterion_details": criterion_details,
            "limitations": evaluation.limitations,
            "question_plan": question_plan,
            "confidence": _reviewer_confidence(row),
            "editable_agent1_output": editable_output,
        }
    )


def _canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _decision_request_sha256(request: ResumeReviewDecisionRequest) -> str:
    return _canonical_sha256(request.model_dump(mode="json"))


def _stable_database_id(kind: str, *, merchant_id: str, request_id: str) -> str:
    return str(
        uuid5(
            _ID_NAMESPACE,
            f"teamflow:resume-review-hitl:1.0.0:{kind}:{merchant_id}:{request_id}",
        )
    )


def _primary_message(error: PsycopgError) -> str:
    diagnostic = getattr(error, "diag", None)
    value = getattr(diagnostic, "message_primary", None)
    return value if isinstance(value, str) else ""


def _domain_error(
    error: PsycopgError,
    *,
    operation: str,
    invalid_edit: bool = False,
) -> RuntimeError:
    """Translate only whitelisted database signals; never expose driver text."""

    sqlstate = getattr(error, "sqlstate", None)
    message = _primary_message(error)
    if sqlstate == "PT403":
        if operation in {
            "authorize_decision",
            "recover_decision",
            "record_decision",
            "load_edit_context",
        }:
            return HitlReviewerDeniedError()
        return HitlMembershipDeniedError()
    if sqlstate == "PT404":
        return HitlNotFoundError()
    if sqlstate == "PT409":
        if operation == "resolve_membership" and message == "teamflow_active_membership_ambiguous":
            return HitlMembershipDeniedError()
        if message in _STALE_MESSAGES:
            return HitlStaleDecisionError()
        if message in _ALREADY_DECIDED_MESSAGES:
            return HitlAlreadyDecidedError()
        if message in _IDENTITY_CONFLICT_MESSAGES or operation in {
            "lookup_request",
            "prepare_workflow",
            "recover_decision",
        }:
            return HitlIdempotencyConflictError()
        return HitlStaleDecisionError()
    if invalid_edit and sqlstate in {"22023", "23514", "23503"}:
        return HitlInvalidEditError()
    return HitlDependencyUnavailableError()


def _raise_domain_error(
    error: PsycopgError,
    *,
    operation: str,
    invalid_edit: bool = False,
) -> None:
    """Raise a sanitized signal for direct mapping callers and unit tests."""

    raise _domain_error(error, operation=operation, invalid_edit=invalid_edit)


class PostgresHitlRepository:
    """Direct pool whose actor operations require one-use signed capabilities."""

    def __init__(
        self,
        dsn: str,
        *,
        capability_secret: str,
        auth_issuer: str,
        min_size: int = 1,
        max_size: int = 4,
    ) -> None:
        if not isinstance(dsn, str) or not dsn or dsn != dsn.strip():
            raise ValueError("database DSN is required")
        if (
            not isinstance(auth_issuer, str)
            or not 16 <= len(auth_issuer.encode("utf-8")) <= 512
            or auth_issuer != auth_issuer.strip()
            or not auth_issuer.endswith("/auth/v1")
            or any(character.isspace() or ord(character) < 33 for character in auth_issuer)
        ):
            raise ValueError("Supabase Auth issuer is required")
        if not 1 <= min_size <= max_size <= 16:
            raise ValueError("database pool size is invalid")
        self._capabilities = _HitlCapabilityIssuer(
            capability_secret,
            auth_issuer=auth_issuer,
        )
        self._auth_issuer = auth_issuer
        self._pool = AsyncConnectionPool(
            conninfo=dsn,
            min_size=min_size,
            max_size=max_size,
            open=False,
            kwargs={
                "autocommit": False,
                "prepare_threshold": None,
                "row_factory": dict_row,
                # A role/DSN search_path can never redirect the qualified RPCs.
                "options": "-csearch_path=pg_catalog",
            },
        )

    async def open(self) -> None:
        failed = False
        try:
            await self._pool.open(wait=True)
            row = await self._fetch_one(
                "select teamflow_private.attest_hitl_runtime(%s::text, %s::text) as ready",
                (self._capabilities.key_id, self._auth_issuer),
                operation="runtime_attestation",
            )
            if row.get("ready") is not True:
                raise HitlDependencyUnavailableError
        except Exception:
            failed = True
        if failed:
            try:
                await self._pool.close()
            except Exception:
                pass
            raise HitlDependencyUnavailableError

    async def close(self) -> None:
        failed = False
        try:
            await self._pool.close()
        except Exception:
            failed = True
        if failed:
            raise HitlDependencyUnavailableError

    async def __aenter__(self) -> PostgresHitlRepository:
        await self.open()
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.close()

    async def _fetch_optional(
        self,
        query: str,
        params: Sequence[object],
        *,
        operation: str,
        invalid_edit: bool = False,
    ) -> Row | None:
        for attempt in range(3):
            failure: RuntimeError | None = None
            try:
                async with self._pool.connection() as connection:
                    async with connection.transaction():
                        await connection.execute("set local statement_timeout = '10s'")
                        await connection.execute("set local lock_timeout = '3s'")
                        cursor = await connection.execute(query, params)
                        return await cursor.fetchone()
            except PsycopgError as exc:
                if getattr(exc, "sqlstate", None) in _RETRYABLE_SQLSTATES and attempt < 2:
                    await asyncio.sleep(0.025 * (attempt + 1))
                    continue
                failure = _domain_error(
                    exc,
                    operation=operation,
                    invalid_edit=invalid_edit,
                )
            except HitlDependencyUnavailableError:
                raise
            except Exception:
                failure = HitlDependencyUnavailableError()
            if failure is not None:
                raise failure
        raise HitlDependencyUnavailableError

    async def _fetch_one(
        self,
        query: str,
        params: Sequence[object],
        *,
        operation: str,
        invalid_edit: bool = False,
    ) -> Row:
        row = await self._fetch_optional(
            query,
            params,
            operation=operation,
            invalid_edit=invalid_edit,
        )
        if row is None:
            raise HitlDependencyUnavailableError
        return row

    async def _fetch_all(
        self,
        query: str,
        params: Sequence[object],
        *,
        operation: str,
    ) -> tuple[Row, ...]:
        for attempt in range(3):
            failure: RuntimeError | None = None
            try:
                async with self._pool.connection() as connection:
                    async with connection.transaction():
                        await connection.execute("set local statement_timeout = '10s'")
                        await connection.execute("set local lock_timeout = '3s'")
                        cursor = await connection.execute(query, params)
                        return tuple(await cursor.fetchall())
            except PsycopgError as exc:
                if getattr(exc, "sqlstate", None) in _RETRYABLE_SQLSTATES and attempt < 2:
                    await asyncio.sleep(0.025 * (attempt + 1))
                    continue
                failure = _domain_error(exc, operation=operation)
            except HitlDependencyUnavailableError:
                raise
            except Exception:
                failure = HitlDependencyUnavailableError()
            if failure is not None:
                raise failure
        raise HitlDependencyUnavailableError

    async def _actor_fetch_optional(
        self,
        *,
        actor_id: str,
        operation: str,
        payload: Mapping[str, object],
        decision_actor: AuthenticatedUser | None = None,
        invalid_edit: bool = False,
    ) -> Row | None:
        capability, payload_text = self._capabilities.issue(
            actor_id=actor_id,
            operation=operation,
            payload=payload,
            decision_actor=decision_actor,
        )
        row = await self._fetch_optional(
            _ACTOR_OPERATION_QUERY,
            (*capability[:7], payload_text, *capability[7:]),
            operation=operation,
            invalid_edit=invalid_edit,
        )
        if row is None:
            return None
        result = row.get("result")
        if not isinstance(result, Mapping):
            raise HitlDependencyUnavailableError
        return result

    async def _actor_fetch_one(
        self,
        *,
        actor_id: str,
        operation: str,
        payload: Mapping[str, object],
        decision_actor: AuthenticatedUser | None = None,
        invalid_edit: bool = False,
    ) -> Row:
        row = await self._actor_fetch_optional(
            actor_id=actor_id,
            operation=operation,
            payload=payload,
            decision_actor=decision_actor,
            invalid_edit=invalid_edit,
        )
        if row is None:
            raise HitlDependencyUnavailableError
        return row

    async def _actor_fetch_all(
        self,
        *,
        actor_id: str,
        operation: str,
        payload: Mapping[str, object],
        decision_actor: AuthenticatedUser | None = None,
    ) -> tuple[Row, ...]:
        capability, payload_text = self._capabilities.issue(
            actor_id=actor_id,
            operation=operation,
            payload=payload,
            decision_actor=decision_actor,
        )
        rows = await self._fetch_all(
            _ACTOR_OPERATION_QUERY,
            (*capability[:7], payload_text, *capability[7:]),
            operation=operation,
        )
        results: list[Row] = []
        for row in rows:
            result = row.get("result")
            if not isinstance(result, Mapping):
                raise HitlDependencyUnavailableError
            results.append(result)
        return tuple(results)

    async def resolve_membership(
        self,
        *,
        user_id: str,
        allowed_roles: Sequence[str],
    ) -> ReviewMembership:
        row = await self._actor_fetch_one(
            actor_id=user_id,
            operation="resolve_membership",
            payload={},
        )
        membership = ReviewMembership(
            user_id=user_id,
            merchant_id=str(row["merchant_id"]),
            role=row["membership_role"],
        )
        if membership.role not in frozenset(allowed_roles):
            raise HitlMembershipDeniedError
        return membership

    async def lookup_request(
        self,
        *,
        membership: ReviewMembership,
        request: StartResumeReviewRunRequest,
        request_sha256: str,
    ) -> PreparedWorkflow | None:
        payload = {
            "request_id": request.request_id,
            "request_sha256": request_sha256,
            "document_id": request.document_id,
            "candidate_id": request.candidate_id,
        }
        row = await self._actor_fetch_optional(
            actor_id=membership.user_id,
            operation="lookup_request",
            payload=payload,
        )
        if row is None:
            return None
        prepared = PreparedWorkflow(
            workflow_id=str(row["workflow_id"]),
            proposal_id=str(row["analysis_run_id"]),
            merchant_id=str(row["merchant_id"]),
            request_id=str(row["request_id"]),
            request_sha256=row["request_sha256"],
            analysis_input_sha256=row["analysis_input_sha256"],
            reason_codes=tuple(row["reason_codes"]),
            status=row["workflow_status"],
            replayed=bool(row["replayed"]),
        )
        if prepared.merchant_id != membership.merchant_id:
            raise HitlDependencyUnavailableError
        return prepared

    async def prepare_workflow(self, **kwargs: object) -> PreparedWorkflow:
        membership = ReviewMembership.model_validate(kwargs.get("membership"))
        request = StartResumeReviewRunRequest.model_validate(kwargs.get("request"))
        analysis = ReviewPersistenceRecord.model_validate(kwargs.get("analysis"))
        request_sha256 = str(kwargs.get("request_sha256"))
        reason_codes = tuple(kwargs.get("reason_codes", ()))
        expected_thread_id = stable_thread_id(
            merchant_id=membership.merchant_id,
            request_id=request.request_id,
        )
        if kwargs.get("thread_id") != expected_thread_id:
            raise HitlDependencyUnavailableError
        invalid_analysis = False
        try:
            _validate_analysis_for_review(analysis)
        except (ValidationError, ValueError, TypeError, KeyError, AttributeError):
            invalid_analysis = True
        if invalid_analysis:
            raise HitlDependencyUnavailableError

        workflow_id = _stable_database_id(
            "workflow",
            merchant_id=membership.merchant_id,
            request_id=request.request_id,
        )
        analysis_run_id = _stable_database_id(
            "analysis",
            merchant_id=membership.merchant_id,
            request_id=request.request_id,
        )
        payload = {
            "workflow_id": workflow_id,
            "analysis_run_id": analysis_run_id,
            "request_id": request.request_id,
            "request_sha256": request_sha256,
            "document_id": request.document_id,
            "candidate_id": request.candidate_id,
            "analysis_input_sha256": analysis.input_sha256,
            "extraction_snapshot_sha256": analysis.extraction_snapshot_sha256,
            "policy_sha256": analysis.policy_sha256,
            "role_policy_snapshot": [
                item.model_dump(mode="json") for item in analysis.role_policy_snapshot
            ],
            "confidence_assessment": analysis.confidence_assessment.model_dump(mode="json"),
            "confidence_shadow_record": analysis.confidence_shadow_record.model_dump(mode="json"),
            "confidence_policy_snapshot": analysis.confidence_policy_snapshot.model_dump(
                mode="json"
            ),
            "confidence_signal_snapshot": [
                item.model_dump(mode="json") for item in analysis.confidence_signal_snapshot
            ],
            "confidence_policy_sha256": analysis.confidence_policy_sha256,
            "confidence_threshold_applied": analysis.confidence_threshold_applied,
            "analysis_status": analysis.status.value,
            "review_required": analysis.review_required,
            "agent1_evaluation": analysis.agent1_evaluation.model_dump(mode="json"),
            "questions_status": analysis.questions_status.value,
            "question_plan": (
                analysis.question_plan.model_dump(mode="json")
                if analysis.question_plan is not None
                else None
            ),
            "reason_codes": list(analysis.reason_codes),
            "workflow_reason_codes": list(reason_codes),
        }
        row = await self._actor_fetch_one(
            actor_id=membership.user_id,
            operation="prepare_workflow",
            payload=payload,
        )
        # The final argument is the durable workflow reason ledger. Keep the SQL
        # call explicit despite its length so no caller-owned dictionary can alter it.
        prepared = PreparedWorkflow(
            workflow_id=str(row["workflow_id"]),
            proposal_id=str(row["analysis_run_id"]),
            merchant_id=str(row["merchant_id"]),
            request_id=str(row["request_id"]),
            request_sha256=row["request_sha256"],
            analysis_input_sha256=row["analysis_input_sha256"],
            reason_codes=tuple(row["reason_codes"]),
            status=row["workflow_status"],
            replayed=bool(row["replayed"]),
        )
        if (
            prepared.workflow_id != workflow_id
            or prepared.proposal_id != analysis_run_id
            or prepared.merchant_id != membership.merchant_id
            or prepared.request_id != request.request_id
            or prepared.request_sha256 != request_sha256
            or prepared.analysis_input_sha256 != analysis.input_sha256
            or prepared.reason_codes != reason_codes
        ):
            raise HitlDependencyUnavailableError
        return prepared

    async def create_review(
        self,
        *,
        workflow_id: str,
        merchant_id: str,
        request_id: str,
        request_sha256: str,
        analysis_run_id: str,
        reason_codes: tuple[str, ...],
    ) -> CreatedReview:
        row = await self._fetch_one(
            """
            select *
            from teamflow_private.create_resume_review(
              %s::uuid, %s::uuid, %s::text, %s::uuid, %s::jsonb
            )
            """,
            (
                workflow_id,
                request_id,
                request_sha256,
                analysis_run_id,
                Jsonb(list(reason_codes)),
            ),
            operation="create_review",
        )
        if str(row["merchant_id"]) != merchant_id:
            raise HitlDependencyUnavailableError
        return CreatedReview(
            review_id=str(row["review_id"]),
            review_version=int(row["review_version"]),
            status="pending_review",
            replayed=bool(row["replayed"]),
        )

    async def apply_decision(
        self,
        *,
        workflow_id: str,
        merchant_id: str,
        review_id: str,
        expected_review_version: int,
        decision_id: str,
    ) -> AppliedDecision:
        row = await self._fetch_one(
            """
            select *
            from teamflow_private.complete_resume_review_workflow(
              %s::uuid, %s::uuid, %s::uuid, %s::bigint
            )
            """,
            (workflow_id, decision_id, review_id, expected_review_version),
            operation="apply_decision",
        )
        if str(row["merchant_id"]) != merchant_id:
            raise HitlDependencyUnavailableError
        return AppliedDecision(
            review_version=int(row["review_version"]),
            status=row["review_status"],
            replayed=bool(row["replayed"]),
        )

    async def authorize_decision(self, **kwargs: object) -> DecisionAuthorization:
        membership = ReviewMembership.model_validate(kwargs.get("membership"))
        actor = kwargs.get("actor")
        if not isinstance(actor, AuthenticatedUser) or actor.user_id != membership.user_id:
            raise HitlReviewerDeniedError
        run_id = str(kwargs.get("run_id"))
        review_id = str(kwargs.get("review_id"))
        expected_version = int(kwargs.get("expected_review_version", 0))
        payload = {
            "workflow_id": run_id,
            "review_id": review_id,
            "expected_review_version": expected_version,
        }
        row = await self._actor_fetch_one(
            actor_id=membership.user_id,
            operation="authorize_decision",
            payload=payload,
            decision_actor=actor,
        )
        context = DecisionAuthorization(
            user_id=membership.user_id,
            session_id=actor.session_id,
            assurance_level="aal2",
            authenticated_at=actor.authenticated_at,
            workflow_id=str(row["workflow_id"]),
            merchant_id=str(row["merchant_id"]),
            request_id=str(row["request_id"]),
            review_id=str(row["review_id"]),
            review_version=int(row["review_version"]),
            role=row["membership_role"],
        )
        if context.merchant_id != membership.merchant_id:
            raise HitlNotFoundError
        return context

    async def recover_decision(
        self,
        *,
        user_id: str,
        run_id: str,
        request: ResumeReviewDecisionRequest,
        actor: AuthenticatedUser,
    ) -> RecordedDecision | None:
        if actor.user_id != user_id:
            raise HitlReviewerDeniedError
        client_request_sha256 = _decision_request_sha256(request)
        payload = {
            "workflow_id": run_id,
            "review_id": request.review_id,
            "decision_id": request.decision_id,
            "expected_review_version": request.expected_review_version,
            "client_request_sha256": client_request_sha256,
        }
        row = await self._actor_fetch_optional(
            actor_id=user_id,
            operation="recover_decision",
            payload=payload,
            decision_actor=actor,
        )
        if row is None:
            return None
        return RecordedDecision(
            decision_id=str(row["decision_id"]),
            merchant_id=str(row["merchant_id"]),
            request_id=str(row["request_id"]),
            replayed=bool(row["replayed"]),
            requires_resume=bool(row["requires_resume"]),
        )

    async def record_decision(self, **kwargs: object) -> RecordedDecision:
        membership = ReviewMembership.model_validate(kwargs.get("membership"))
        context = DecisionAuthorization.model_validate(kwargs.get("context"))
        actor = kwargs.get("actor")
        if not isinstance(actor, AuthenticatedUser) or actor.user_id != membership.user_id:
            raise HitlReviewerDeniedError
        request = kwargs.get("request")
        if not hasattr(request, "model_dump"):
            raise HitlDependencyUnavailableError
        edited = kwargs.get("edited_evaluation")
        edited_evaluation = Agent1Evaluation.model_validate(edited) if edited is not None else None
        if isinstance(request, ApproveWithEditsResumeReviewDecision):
            if edited_evaluation is None:
                raise HitlInvalidEditError
            reason_code: str | None = request.reason_code
        else:
            reason_code = getattr(request, "reason_code", None)

        client_request_sha256 = _decision_request_sha256(request)
        payload = {
            "workflow_id": context.workflow_id,
            "review_id": context.review_id,
            "decision_id": request.decision_id,
            "expected_review_version": context.review_version,
            "client_request_sha256": client_request_sha256,
            "action": request.action,
            "edited_evaluation": (
                edited_evaluation.model_dump(mode="json") if edited_evaluation is not None else None
            ),
            "reason_code": reason_code,
        }
        row = await self._actor_fetch_one(
            actor_id=membership.user_id,
            operation="record_decision",
            payload=payload,
            decision_actor=actor,
            invalid_edit=isinstance(request, ApproveWithEditsResumeReviewDecision),
        )
        receipt = RecordedDecision(
            decision_id=str(row["decision_id"]),
            merchant_id=str(row["merchant_id"]),
            request_id=str(row["request_id"]),
            replayed=bool(row["replayed"]),
            requires_resume=bool(row["requires_resume"]),
        )
        if receipt.merchant_id != membership.merchant_id:
            raise HitlNotFoundError
        return receipt

    async def inspect(self, *, user_id: str, run_id: str) -> ResumeReviewRunResponse:
        payload = {"workflow_id": run_id}
        row = await self._actor_fetch_one(
            actor_id=user_id,
            operation="inspect",
            payload=payload,
        )
        review = (
            None
            if row["review_id"] is None
            else {
                "review_id": str(row["review_id"]),
                "review_version": int(row["review_version"]),
            }
        )
        return ResumeReviewRunResponse.model_validate(
            {
                "schema_version": row["schema_version"],
                "run_id": str(row["workflow_id"]),
                "request_id": str(row["request_id"]),
                "document_id": row["document_id"],
                "status": row["workflow_status"],
                "run_version": int(row["workflow_version"]),
                "review": review,
                "reason_codes": tuple(row["reason_codes"]),
            }
        )

    async def list_pending(
        self,
        *,
        user_id: str,
        limit: int,
        before_created_at: datetime | None,
        before_id: str | None,
    ) -> tuple[tuple[PendingResumeReviewQueueItem, ...], bool]:
        if (
            isinstance(limit, bool)
            or not 1 <= limit <= 50
            or (before_created_at is None) != (before_id is None)
        ):
            raise HitlDependencyUnavailableError
        before_text = (
            None
            if before_created_at is None
            else before_created_at.isoformat(timespec="microseconds")
        )
        payload = {
            "limit": limit,
            "before_created_at": before_text,
            "before_id": before_id,
        }
        rows = await self._actor_fetch_all(
            actor_id=user_id,
            operation="list_pending",
            payload=payload,
        )
        invalid_projection = False
        try:
            for row in rows:
                _validate_public_text(
                    row["top_role_title"],
                    label="pending queue role title",
                )
            items = tuple(
                PendingResumeReviewQueueItem.model_validate(
                    {
                        "run_id": str(row["workflow_id"]),
                        "candidate_id": str(row["candidate_id"]),
                        "created_at": row["created_at"],
                        "run_version": int(row["workflow_version"]),
                        "review": {
                            "review_id": str(row["review_id"]),
                            "review_version": int(row["review_version"]),
                        },
                        "reason_codes": tuple(row["reason_codes"]),
                        "top_role": {
                            "role_id": str(row["top_role_id"]),
                            "role_title": row["top_role_title"],
                            "deterministic_score": int(row["top_role_score"]),
                            "recommended_role_id": (
                                None
                                if row["recommended_role_id"] is None
                                else str(row["recommended_role_id"])
                            ),
                        },
                    }
                )
                for row in rows
            )
            has_more = bool(rows[0]["has_more"]) if rows else False
            if any(bool(row["has_more"]) != has_more for row in rows):
                raise ValueError("pending queue has inconsistent pagination metadata")
            projection = (items, has_more)
        except (ValidationError, ValueError, TypeError, KeyError, AttributeError):
            invalid_projection = True
            projection = ((), False)
        if invalid_projection:
            raise HitlDependencyUnavailableError
        return projection

    async def inspect_detail(
        self,
        *,
        user_id: str,
        run_id: str,
    ) -> ResumeReviewRunDetailResponse:
        payload = {"workflow_id": run_id}
        row = await self._actor_fetch_one(
            actor_id=user_id,
            operation="inspect_detail",
            payload=payload,
        )
        invalid_projection = False
        try:
            projection = ResumeReviewRunDetailResponse.model_validate(
                {
                    "schema_version": row["schema_version"],
                    "run_id": str(row["workflow_id"]),
                    "request_id": str(row["request_id"]),
                    "document_id": row["document_id"],
                    "status": row["workflow_status"],
                    "run_version": int(row["workflow_version"]),
                    "review": _review_reference(row),
                    "reason_codes": tuple(row["reason_codes"]),
                    "proposal": _reviewer_proposal(row),
                }
            )
        except (ValidationError, ValueError, TypeError, KeyError, AttributeError):
            invalid_projection = True
            projection = None
        if invalid_projection or projection is None:
            raise HitlDependencyUnavailableError
        return projection

    async def load_edit_context(self, context: DecisionAuthorization) -> Row:
        actor = AuthenticatedUser(
            user_id=context.user_id,
            session_id=context.session_id,
            assurance_level=context.assurance_level,
            authenticated_at=context.authenticated_at,
        )
        payload = {
            "workflow_id": context.workflow_id,
            "review_id": context.review_id,
            "expected_review_version": context.review_version,
        }
        return await self._actor_fetch_one(
            actor_id=context.user_id,
            operation="load_edit_context",
            payload=payload,
            decision_actor=actor,
            invalid_edit=True,
        )


class PostgresHumanEditValidator:
    """Revalidate human classifications against immutable sources and policies."""

    def __init__(self, repository: PostgresHitlRepository) -> None:
        self._repository = repository

    async def validate(
        self,
        context: DecisionAuthorization,
        replacement: object,
    ) -> Agent1Evaluation:
        invalid_edit = False
        evaluation: Agent1Evaluation | None = None
        try:
            row = await self._repository.load_edit_context(context)
            if str(row["merchant_id"]) != context.merchant_id:
                raise HitlInvalidEditError
            if row["extraction_snapshot_sha256"] != row["document_snapshot"].get("snapshot_sha256"):
                raise HitlInvalidEditError

            document = StoredDocumentExtraction.model_validate(row["document_snapshot"])
            policies = tuple(
                RoleScoringPolicy.model_validate(item) for item in row["role_policy_snapshot"]
            )
            if not 1 <= len(policies) <= 5:
                raise HitlInvalidEditError
            if role_policy_fingerprint(policies) != row["policy_sha256"]:
                raise HitlInvalidEditError
            validate_role_policy_safety(policies)

            original = Agent1Evaluation.model_validate(row["original_evaluation"])
            model_output = Agent1ModelOutput.model_validate(replacement)
            # The public edit contract grants authority over classifications and
            # evidence only. Preserve the already-sanitized application limitation
            # ledger instead of persisting caller-authored free text.
            classifications = model_output.model_copy(update={"limitations": original.limitations})
            validate_agent1_evidence(classifications, policies, document)
            evaluation = build_agent1_evaluation(classifications, policies)
        except HitlInvalidEditError:
            raise
        except (
            HitlDependencyUnavailableError,
            HitlNotFoundError,
            HitlStaleDecisionError,
            HitlAlreadyDecidedError,
        ):
            raise
        except (ValidationError, ValueError, TypeError, KeyError, AttributeError):
            invalid_edit = True
        if invalid_edit or evaluation is None:
            raise HitlInvalidEditError
        return evaluation


__all__ = [
    "PostgresHitlRepository",
    "PostgresHumanEditValidator",
]
