"""Application service joining verified identity, private analysis, and durable review.

The service deliberately keeps bearer tokens and Phase 4 model output out of LangGraph
checkpoint state.  PostgreSQL remains authoritative for membership, idempotency, and
the guarded decision transaction.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import time
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Literal, Protocol

from pydantic import Field, TypeAdapter, ValidationError

from ..contracts import Agent1Evaluation, DatabaseId, FrozenContract, Identifier
from ..persistence import ReviewPersistenceRecord
from ..workflow_contracts import ResumeReviewRequest, Sha256
from .api import (
    HitlDependencyUnavailableError,
    HitlIdentityError,
    HitlInvalidEditError,
    HitlInvalidRequestError,
    HitlReviewerDeniedError,
)
from .auth import (
    AuthenticatedUser,
    AuthenticationUnavailableError,
    UnauthorizedUserError,
)
from .checkpointing import stable_thread_id
from .contracts import (
    ApproveWithEditsResumeReviewDecision,
    PendingResumeReviewQueueItem,
    PendingResumeReviewQueueResponse,
    PendingReviewCursor,
    ResumeReviewDecisionRequest,
    ResumeReviewRunDetailResponse,
    ResumeReviewRunResponse,
    StartResumeReviewRunRequest,
)
from .lifecycle import LifecycleStart

MembershipRole = Literal["owner", "manager", "reviewer", "viewer"]
WorkflowStatus = Literal[
    "running",
    "pending_review",
    "decision_recorded",
    "applying",
    "completed",
    "rejected",
    "stale",
    "failed",
]


class ReviewMembership(FrozenContract):
    user_id: DatabaseId
    merchant_id: DatabaseId
    role: MembershipRole


class PreparedWorkflow(FrozenContract):
    workflow_id: DatabaseId
    proposal_id: DatabaseId
    merchant_id: DatabaseId
    request_id: DatabaseId
    request_sha256: Sha256
    analysis_input_sha256: Sha256
    reason_codes: tuple[Identifier, ...] = Field(max_length=20)
    status: WorkflowStatus
    replayed: bool


class DecisionAuthorization(FrozenContract):
    user_id: DatabaseId
    session_id: DatabaseId
    assurance_level: Literal["aal2"]
    authenticated_at: int = Field(ge=1)
    workflow_id: DatabaseId
    merchant_id: DatabaseId
    request_id: DatabaseId
    review_id: DatabaseId
    review_version: int = Field(ge=1)
    role: Literal["owner", "manager", "reviewer"]


class RecordedDecision(FrozenContract):
    decision_id: DatabaseId
    merchant_id: DatabaseId
    request_id: DatabaseId
    replayed: bool
    requires_resume: bool


class UserAuthenticator(Protocol):
    async def authenticate(self, authorization: str | None) -> AuthenticatedUser: ...


class PrivateAnalysisRunner(Protocol):
    async def analyze_for_human_review(
        self,
        request: ResumeReviewRequest,
    ) -> ReviewPersistenceRecord: ...


class HumanReviewLifecycle(Protocol):
    async def start(
        self,
        value: LifecycleStart | Mapping[str, object],
    ) -> Mapping[str, object]: ...

    async def resume(
        self,
        *,
        merchant_id: str,
        request_id: str,
        decision: object,
    ) -> Mapping[str, object]: ...


class HumanEditValidator(Protocol):
    async def validate(
        self,
        context: DecisionAuthorization,
        replacement: object,
    ) -> Agent1Evaluation: ...


class HumanReviewServiceRepository(Protocol):
    async def resolve_membership(
        self,
        *,
        user_id: str,
        allowed_roles: Sequence[str],
    ) -> ReviewMembership | Mapping[str, object]: ...

    async def lookup_request(
        self,
        *,
        membership: ReviewMembership,
        request: StartResumeReviewRunRequest,
        request_sha256: str,
    ) -> PreparedWorkflow | Mapping[str, object] | None: ...

    async def prepare_workflow(
        self,
        **kwargs: object,
    ) -> PreparedWorkflow | Mapping[str, object]: ...

    async def authorize_decision(
        self,
        **kwargs: object,
    ) -> DecisionAuthorization | Mapping[str, object]: ...

    async def recover_decision(
        self,
        *,
        user_id: str,
        run_id: str,
        request: ResumeReviewDecisionRequest,
        actor: AuthenticatedUser,
    ) -> RecordedDecision | Mapping[str, object] | None: ...

    async def record_decision(
        self,
        **kwargs: object,
    ) -> RecordedDecision | Mapping[str, object]: ...

    async def inspect(
        self,
        *,
        user_id: str,
        run_id: str,
    ) -> ResumeReviewRunResponse | Mapping[str, object]: ...

    async def inspect_detail(
        self,
        *,
        user_id: str,
        run_id: str,
    ) -> ResumeReviewRunDetailResponse | Mapping[str, object]: ...

    async def list_pending(
        self,
        *,
        user_id: str,
        limit: int,
        before_created_at: datetime | None,
        before_id: str | None,
    ) -> tuple[tuple[PendingResumeReviewQueueItem, ...], bool]: ...


def _canonical_request_sha256(
    request: StartResumeReviewRunRequest,
    *,
    merchant_id: str,
) -> str:
    payload = {
        "candidate_id": request.candidate_id,
        "document_id": request.document_id,
        "merchant_id": merchant_id,
        "request_id": request.request_id,
        "schema_version": request.schema_version,
    }
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _reason_codes(analysis: ReviewPersistenceRecord) -> tuple[str, ...]:
    codes = tuple(dict.fromkeys((*analysis.reason_codes, "human_approval_required")))
    if len(codes) > 20:
        raise HitlDependencyUnavailableError("Review reason budget exceeded")
    return codes


_CURSOR_ADAPTER = TypeAdapter(PendingReviewCursor)
_DATABASE_ID_ADAPTER = TypeAdapter(DatabaseId)


def _encode_pending_cursor(created_at: datetime, run_id: str) -> str:
    if created_at.tzinfo is None or created_at.utcoffset() is None:
        raise HitlDependencyUnavailableError
    normalized = (
        created_at.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    )
    canonical_id = _DATABASE_ID_ADAPTER.validate_python(run_id)
    encoded = base64.urlsafe_b64encode(f"{normalized}|{canonical_id}".encode("ascii")).decode(
        "ascii"
    )
    return _CURSOR_ADAPTER.validate_python(encoded.rstrip("="))


def _decode_pending_cursor(cursor: str | None) -> tuple[datetime | None, str | None]:
    if cursor is None:
        return None, None
    invalid = False
    try:
        validated = _CURSOR_ADAPTER.validate_python(cursor)
        raw = base64.b64decode(
            validated + "=" * (-len(validated) % 4),
            altchars=b"-_",
            validate=True,
        ).decode("ascii")
        timestamp_text, run_id = raw.rsplit("|", 1)
        created_at = datetime.fromisoformat(timestamp_text.replace("Z", "+00:00"))
        canonical_id = _DATABASE_ID_ADAPTER.validate_python(run_id)
        if _encode_pending_cursor(created_at, canonical_id) != validated:
            raise ValueError("noncanonical cursor")
        decoded = (created_at, canonical_id)
    except (
        UnicodeError,
        ValueError,
        TypeError,
        binascii.Error,
        ValidationError,
    ):
        invalid = True
        decoded = (None, None)
    if invalid:
        raise HitlInvalidRequestError("Invalid pending-review cursor")
    return decoded


class DurableHumanReviewService:
    """Coordinate v2 operations without accepting caller-owned tenant authority."""

    def __init__(
        self,
        *,
        authenticator: UserAuthenticator,
        repository: HumanReviewServiceRepository,
        analysis_runner: PrivateAnalysisRunner,
        lifecycle: HumanReviewLifecycle,
        edit_validator: HumanEditValidator | None,
    ) -> None:
        self._authenticator = authenticator
        self._repository = repository
        self._analysis_runner = analysis_runner
        self._lifecycle = lifecycle
        self._edit_validator = edit_validator

    async def _user(self, authorization: str | None) -> AuthenticatedUser:
        failure: type[HitlIdentityError] | type[HitlDependencyUnavailableError] | None = None
        try:
            user = await self._authenticator.authenticate(authorization)
        except UnauthorizedUserError:
            failure = HitlIdentityError
            user = None
        except AuthenticationUnavailableError:
            failure = HitlDependencyUnavailableError
            user = None
        if failure is not None or user is None:
            raise (failure or HitlDependencyUnavailableError)()
        return user

    async def _membership(
        self,
        user_id: str,
        *,
        allowed_roles: tuple[str, ...],
    ) -> ReviewMembership:
        raw = await self._repository.resolve_membership(
            user_id=user_id,
            allowed_roles=allowed_roles,
        )
        return raw if isinstance(raw, ReviewMembership) else ReviewMembership.model_validate(raw)

    @staticmethod
    def _decision_actor(user: AuthenticatedUser) -> AuthenticatedUser:
        now = int(time.time())
        if (
            user.session_id is None
            or user.assurance_level != "aal2"
            or user.authenticated_at is None
            or user.authenticated_at > now + 30
            or user.authenticated_at < now - 600
            or user.token_expires_at is None
            or user.token_expires_at <= now
        ):
            raise HitlReviewerDeniedError
        return user

    async def start(
        self,
        request: StartResumeReviewRunRequest,
        authorization: str,
    ) -> ResumeReviewRunResponse:
        user = await self._user(authorization)
        membership = await self._membership(
            user.user_id,
            allowed_roles=("owner", "manager"),
        )
        request_sha256 = _canonical_request_sha256(
            request,
            merchant_id=membership.merchant_id,
        )
        raw_existing = await self._repository.lookup_request(
            membership=membership,
            request=request,
            request_sha256=request_sha256,
        )
        if raw_existing is not None:
            existing = (
                raw_existing
                if isinstance(raw_existing, PreparedWorkflow)
                else PreparedWorkflow.model_validate(raw_existing)
            )
            # A pending/terminal ledger row proves the side-effecting create node ran.
            # A running row is retried below to recover a crash before the first checkpoint.
            if existing.status != "running":
                return await self._inspect_lifecycle(existing.workflow_id, authorization)
            prepared = existing
        else:
            internal_request = ResumeReviewRequest(
                schema_version="1.0",
                request_id=request.request_id,
                merchant_id=membership.merchant_id,
                document_id=request.document_id,
                candidate_id=request.candidate_id,
                persist=False,
            )
            analysis_failed = False
            try:
                raw_analysis = await self._analysis_runner.analyze_for_human_review(
                    internal_request
                )
                analysis = (
                    raw_analysis
                    if isinstance(raw_analysis, ReviewPersistenceRecord)
                    else ReviewPersistenceRecord.model_validate(raw_analysis)
                )
            except Exception:
                analysis_failed = True
                analysis = None
            if analysis_failed or analysis is None:
                raise HitlDependencyUnavailableError
            if (
                analysis.request_id != request.request_id
                or analysis.document_id != request.document_id
                or analysis.candidate_id != request.candidate_id
                or analysis.merchant_id != membership.merchant_id
            ):
                raise HitlDependencyUnavailableError
            raw_prepared = await self._repository.prepare_workflow(
                membership=membership,
                request=request,
                request_sha256=request_sha256,
                thread_id=stable_thread_id(
                    merchant_id=membership.merchant_id,
                    request_id=request.request_id,
                ),
                analysis=analysis,
                reason_codes=_reason_codes(analysis),
            )
            prepared = (
                raw_prepared
                if isinstance(raw_prepared, PreparedWorkflow)
                else PreparedWorkflow.model_validate(raw_prepared)
            )

            if prepared.analysis_input_sha256 != analysis.input_sha256:
                raise HitlDependencyUnavailableError

        if (
            prepared.merchant_id != membership.merchant_id
            or prepared.request_id != request.request_id
            or prepared.request_sha256 != request_sha256
        ):
            raise HitlDependencyUnavailableError

        await self._lifecycle.start(
            LifecycleStart(
                schema_version="1.0",
                workflow_id=prepared.workflow_id,
                merchant_id=prepared.merchant_id,
                request_id=prepared.request_id,
                request_sha256=prepared.request_sha256,
                analysis_run_id=prepared.proposal_id,
                reason_codes=list(prepared.reason_codes),
            )
        )
        return await self._inspect_lifecycle(prepared.workflow_id, authorization)

    async def _inspect_lifecycle(
        self,
        run_id: str,
        authorization: str,
    ) -> ResumeReviewRunResponse:
        user = await self._user(authorization)
        raw = await self._repository.inspect(user_id=user.user_id, run_id=run_id)
        return (
            raw
            if isinstance(raw, ResumeReviewRunResponse)
            else ResumeReviewRunResponse.model_validate(raw)
        )

    async def inspect(
        self,
        run_id: str,
        authorization: str,
    ) -> ResumeReviewRunDetailResponse:
        user = await self._user(authorization)
        raw = await self._repository.inspect_detail(user_id=user.user_id, run_id=run_id)
        return (
            raw
            if isinstance(raw, ResumeReviewRunDetailResponse)
            else ResumeReviewRunDetailResponse.model_validate(raw)
        )

    async def list_pending(
        self,
        *,
        limit: int,
        cursor: str | None,
        authorization: str,
    ) -> PendingResumeReviewQueueResponse:
        if isinstance(limit, bool) or not 1 <= limit <= 50:
            raise HitlInvalidRequestError("Invalid pending-review page size")
        before_created_at, before_id = _decode_pending_cursor(cursor)
        user = await self._user(authorization)
        items, has_more = await self._repository.list_pending(
            user_id=user.user_id,
            limit=limit,
            before_created_at=before_created_at,
            before_id=before_id,
        )
        if len(items) > limit or (has_more and not items):
            raise HitlDependencyUnavailableError
        return PendingResumeReviewQueueResponse(
            schema_version="2.0",
            status="pending_review",
            items=items,
            next_cursor=(
                _encode_pending_cursor(items[-1].created_at, items[-1].run_id) if has_more else None
            ),
        )

    async def decide(
        self,
        run_id: str,
        request: ResumeReviewDecisionRequest,
        authorization: str,
    ) -> ResumeReviewRunResponse:
        user = self._decision_actor(await self._user(authorization))
        # A database decision may have committed immediately before the service or
        # checkpoint process crashed. Recover that exact immutable decision before
        # requiring current membership: the recovery RPC binds the original actor and
        # canonical public request hash and cannot create or alter a candidate score.
        raw_recovered = await self._repository.recover_decision(
            user_id=user.user_id,
            run_id=run_id,
            request=request,
            actor=user,
        )
        if raw_recovered is not None:
            recovered = (
                raw_recovered
                if isinstance(raw_recovered, RecordedDecision)
                else RecordedDecision.model_validate(raw_recovered)
            )
            if recovered.requires_resume:
                resume_failed = False
                try:
                    await self._lifecycle.resume(
                        merchant_id=recovered.merchant_id,
                        request_id=recovered.request_id,
                        decision={"decision_id": recovered.decision_id},
                    )
                except Exception:
                    resume_failed = True
                if resume_failed:
                    raise HitlDependencyUnavailableError
            return await self._inspect_lifecycle(run_id, authorization)

        membership = await self._membership(
            user.user_id,
            allowed_roles=("owner", "manager", "reviewer"),
        )
        raw_context = await self._repository.authorize_decision(
            membership=membership,
            actor=user,
            run_id=run_id,
            review_id=request.review_id,
            expected_review_version=request.expected_review_version,
        )
        context = (
            raw_context
            if isinstance(raw_context, DecisionAuthorization)
            else DecisionAuthorization.model_validate(raw_context)
        )
        if context.user_id != membership.user_id or context.merchant_id != membership.merchant_id:
            raise HitlDependencyUnavailableError
        edited_evaluation: Agent1Evaluation | None = None
        if isinstance(request, ApproveWithEditsResumeReviewDecision):
            if self._edit_validator is None:
                raise HitlInvalidEditError
            validation_failed = False
            try:
                edited_evaluation = await self._edit_validator.validate(
                    context,
                    request.replacement_agent1_output,
                )
            except HitlInvalidEditError:
                raise
            except Exception:
                validation_failed = True
            if validation_failed:
                raise HitlInvalidEditError

        raw_receipt = await self._repository.record_decision(
            membership=membership,
            context=context,
            actor=user,
            request=request,
            edited_evaluation=edited_evaluation,
        )
        receipt = (
            raw_receipt
            if isinstance(raw_receipt, RecordedDecision)
            else RecordedDecision.model_validate(raw_receipt)
        )
        if receipt.requires_resume:
            resume_failed = False
            try:
                await self._lifecycle.resume(
                    merchant_id=receipt.merchant_id,
                    request_id=receipt.request_id,
                    decision={"decision_id": receipt.decision_id},
                )
            except Exception:
                # The database decision is already durable.  A retry replays it and
                # resumes the same thread without duplicating the candidate write.
                resume_failed = True
            if resume_failed:
                raise HitlDependencyUnavailableError
        return await self._inspect_lifecycle(run_id, authorization)


__all__ = [
    "DecisionAuthorization",
    "DurableHumanReviewService",
    "PreparedWorkflow",
    "RecordedDecision",
    "ReviewMembership",
]
