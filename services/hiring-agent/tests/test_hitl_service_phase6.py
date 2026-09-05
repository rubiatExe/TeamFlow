from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from teamflow_hiring_agent.resume_review.confidence import (
    ConfidenceSignal,
    ConfidenceSignalId,
    assess_confidence,
    build_shadow_record,
    load_default_confidence_policy,
)
from teamflow_hiring_agent.resume_review.contracts import (
    Agent1Evaluation,
    Agent2QuestionPlan,
    RoleScoringPolicy,
)
from teamflow_hiring_agent.resume_review.hitl.api import (
    HitlDependencyUnavailableError,
    HitlIdentityError,
    HitlInvalidRequestError,
    HitlMembershipDeniedError,
    HitlReviewerDeniedError,
)
from teamflow_hiring_agent.resume_review.hitl.auth import (
    AuthenticatedUser,
    AuthenticationUnavailableError,
    UnauthorizedUserError,
)
from teamflow_hiring_agent.resume_review.hitl.contracts import (
    ApproveResumeReviewDecision,
    ApproveWithEditsResumeReviewDecision,
    HumanReviewReference,
    PendingResumeReviewQueueItem,
    RejectResumeReviewDecision,
    ResumeReviewRunDetailResponse,
    ResumeReviewRunResponse,
    ResumeReviewRunStatus,
    StartResumeReviewRunRequest,
)
from teamflow_hiring_agent.resume_review.hitl.lifecycle import LifecycleStart
from teamflow_hiring_agent.resume_review.hitl.service import (
    DecisionAuthorization,
    DurableHumanReviewService,
    PreparedWorkflow,
    RecordedDecision,
    ReviewMembership,
)
from teamflow_hiring_agent.resume_review.persistence import (
    ReviewPersistenceRecord,
    build_review_persistence_record,
    role_policy_fingerprint,
)
from teamflow_hiring_agent.resume_review.workflow_contracts import (
    QuestionsStatus,
    ResumeReviewRequest,
    ReviewStatus,
)

ACTOR_ID = "10000000-0000-4000-8000-000000000001"
MERCHANT_ID = "20000000-0000-4000-8000-000000000002"
REQUEST_ID = "30000000-0000-4000-8000-000000000003"
CANDIDATE_ID = "40000000-0000-4000-8000-000000000004"
WORKFLOW_ID = "50000000-0000-4000-8000-000000000005"
PROPOSAL_ID = "60000000-0000-4000-8000-000000000006"
REVIEW_ID = "70000000-0000-4000-8000-000000000007"
DECISION_ID = "80000000-0000-4000-8000-000000000008"
ROLE_ID = "90000000-0000-4000-8000-000000000009"
SESSION_ID = "11000000-0000-4000-8000-000000000001"
DOCUMENT_ID = f"doc-{'a' * 64}"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
REVIEWER_FIXTURE = json.loads(
    (REPOSITORY_ROOT / "tests/fixtures/resume-review-reviewer-v2.json").read_text(encoding="utf-8")
)


def run(coro):
    return asyncio.run(coro)


def start_request() -> StartResumeReviewRunRequest:
    return StartResumeReviewRunRequest(
        schema_version="2.0",
        request_id=REQUEST_ID,
        document_id=DOCUMENT_ID,
        candidate_id=CANDIDATE_ID,
    )


def analysis_record() -> ReviewPersistenceRecord:
    payload = json.loads(
        (REPOSITORY_ROOT / "tests/fixtures/resume-review-contract-v1.json").read_text(
            encoding="utf-8"
        )
    )
    policies = tuple(
        RoleScoringPolicy.model_validate(item) for item in payload["role_scoring_policies"]
    )
    evaluation = Agent1Evaluation.model_validate(payload["agent1_evaluation"])
    question_plan = Agent2QuestionPlan.model_validate(payload["agent2_question_plan"])
    confidence_policy = load_default_confidence_policy()
    confidence_signals = tuple(
        ConfidenceSignal(
            component_id=component.component_id,
            score=(82 if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE else 100),
            hard_failure=False,
            reason_codes=(
                ("criteria_evidence_missing",)
                if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE
                else ()
            ),
        )
        for component in confidence_policy.components
    )
    confidence = assess_confidence(confidence_signals, confidence_policy)
    confidence_shadow = build_shadow_record(
        confidence,
        confidence_policy,
        signals=confidence_signals,
        review_required=True,
        status=ReviewStatus.REVIEW_REQUIRED,
    )
    internal_request = ResumeReviewRequest(
        schema_version="1.0",
        request_id=REQUEST_ID,
        merchant_id=MERCHANT_ID,
        document_id=DOCUMENT_ID,
        candidate_id=CANDIDATE_ID,
        persist=False,
    )
    return build_review_persistence_record(
        request=internal_request,
        evaluation=evaluation,
        question_plan=question_plan,
        questions_status=QuestionsStatus.COMPLETE,
        extraction_fingerprint="c" * 64,
        policy_fingerprint=role_policy_fingerprint(policies),
        policy_snapshot=policies,
        confidence_assessment=confidence,
        confidence_shadow_record=confidence_shadow,
        confidence_policy_snapshot=confidence_policy,
        confidence_signal_snapshot=confidence_signals,
        status=ReviewStatus.REVIEW_REQUIRED,
        review_required=True,
        reason_codes=("manual_review_requested",),
    )


def edited_decision_and_evaluation() -> tuple[
    ApproveWithEditsResumeReviewDecision,
    Agent1Evaluation,
]:
    hitl_payload = json.loads(
        (REPOSITORY_ROOT / "tests/fixtures/resume-review-hitl-v2.json").read_text(encoding="utf-8")
    )
    review_payload = json.loads(
        (REPOSITORY_ROOT / "tests/fixtures/resume-review-contract-v1.json").read_text(
            encoding="utf-8"
        )
    )
    return (
        ApproveWithEditsResumeReviewDecision.model_validate(hitl_payload["decisions"][1]),
        Agent1Evaluation.model_validate(review_payload["agent1_evaluation"]),
    )


def pending_response() -> ResumeReviewRunResponse:
    return ResumeReviewRunResponse(
        schema_version="2.0",
        run_id=WORKFLOW_ID,
        request_id=REQUEST_ID,
        document_id=DOCUMENT_ID,
        status=ResumeReviewRunStatus.PENDING_REVIEW,
        run_version=2,
        review=HumanReviewReference(review_id=REVIEW_ID, review_version=1),
        reason_codes=("document_unavailable", "human_approval_required"),
    )


def detail_response() -> ResumeReviewRunDetailResponse:
    return ResumeReviewRunDetailResponse.model_validate(REVIEWER_FIXTURE["detail_response"])


def pending_queue_item() -> PendingResumeReviewQueueItem:
    return PendingResumeReviewQueueItem.model_validate(
        REVIEWER_FIXTURE["queue_response"]["items"][0]
    )


class FakeAuthenticator:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[str | None] = []

    async def authenticate(self, authorization: str | None) -> AuthenticatedUser:
        self.calls.append(authorization)
        if self.error:
            raise self.error
        now = int(time.time())
        return AuthenticatedUser(
            user_id=ACTOR_ID,
            session_id=SESSION_ID,
            assurance_level="aal2",
            authenticated_at=now,
            token_expires_at=now + 3600,
        )


class FakeAnalyzer:
    def __init__(self) -> None:
        self.calls = []

    async def analyze_for_human_review(self, request):
        self.calls.append(request)
        return analysis_record()


class FakeLifecycle:
    def __init__(self) -> None:
        self.starts: list[LifecycleStart] = []
        self.resumes: list[dict[str, object]] = []
        self.fail_resume = False

    async def start(self, value):
        parsed = LifecycleStart.model_validate(value)
        self.starts.append(parsed)
        return {"review_status": "pending_review"}

    async def resume(self, *, merchant_id: str, request_id: str, decision: object):
        self.resumes.append(
            {
                "merchant_id": merchant_id,
                "request_id": request_id,
                "decision": decision,
            }
        )
        if self.fail_resume:
            raise RuntimeError("private checkpoint failure")
        return {"review_status": "approved"}


class FakeEditValidator:
    def __init__(self, replacement, evaluation) -> None:
        self.replacement = replacement
        self.evaluation = evaluation
        self.calls: list[tuple[DecisionAuthorization, object]] = []

    async def validate(self, context, replacement):
        self.calls.append((context, replacement))
        assert replacement == self.replacement
        return self.evaluation


class FakeRepository:
    def __init__(self) -> None:
        self.lookup_result: PreparedWorkflow | None = None
        self.membership = ReviewMembership(
            user_id=ACTOR_ID,
            merchant_id=MERCHANT_ID,
            role="manager",
        )
        self.prepared = PreparedWorkflow(
            workflow_id=WORKFLOW_ID,
            proposal_id=PROPOSAL_ID,
            merchant_id=MERCHANT_ID,
            request_id=REQUEST_ID,
            request_sha256="b" * 64,
            analysis_input_sha256=analysis_record().input_sha256,
            reason_codes=("document_unavailable", "human_approval_required"),
            status="running",
            replayed=False,
        )
        self.decision_context = DecisionAuthorization(
            user_id=ACTOR_ID,
            session_id=SESSION_ID,
            assurance_level="aal2",
            authenticated_at=int(time.time()),
            workflow_id=WORKFLOW_ID,
            merchant_id=MERCHANT_ID,
            request_id=REQUEST_ID,
            review_id=REVIEW_ID,
            review_version=1,
            role="manager",
        )
        self.recorded = RecordedDecision(
            decision_id=DECISION_ID,
            merchant_id=MERCHANT_ID,
            request_id=REQUEST_ID,
            replayed=False,
            requires_resume=True,
        )
        self.recovery_result: RecordedDecision | None = None
        self.resolve_calls = []
        self.lookup_calls = []
        self.prepare_calls = []
        self.authorize_calls = []
        self.recover_calls = []
        self.record_calls = []
        self.inspect_calls = []
        self.inspect_detail_calls = []
        self.list_pending_calls = []
        self.pending_items = (pending_queue_item(),)
        self.pending_has_more = False
        self.candidate_writes = 0

    async def resolve_membership(self, *, user_id, allowed_roles):
        self.resolve_calls.append((user_id, tuple(allowed_roles)))
        if self.membership.role not in allowed_roles:
            raise HitlMembershipDeniedError
        return self.membership

    async def lookup_request(self, *, membership, request, request_sha256):
        self.lookup_calls.append((membership, request, request_sha256))
        if self.lookup_result is None:
            return None
        return self.lookup_result.model_copy(update={"request_sha256": request_sha256})

    async def prepare_workflow(self, **kwargs):
        self.prepare_calls.append(kwargs)
        analysis = kwargs["analysis"]
        return self.prepared.model_copy(
            update={
                "request_sha256": kwargs["request_sha256"],
                "analysis_input_sha256": analysis.input_sha256,
            }
        )

    async def authorize_decision(self, **kwargs):
        self.authorize_calls.append(kwargs)
        return self.decision_context

    async def recover_decision(self, *, user_id, run_id, request, actor):
        self.recover_calls.append((user_id, run_id, request, actor))
        return self.recovery_result

    async def record_decision(self, **kwargs):
        self.record_calls.append(kwargs)
        return self.recorded

    async def inspect(self, *, user_id, run_id):
        self.inspect_calls.append((user_id, run_id))
        response = pending_response()
        if self.record_calls or self.recovery_result is not None:
            action = self.record_calls[-1]["request"].action if self.record_calls else "approve"
            status = (
                ResumeReviewRunStatus.REJECTED
                if action == "reject"
                else ResumeReviewRunStatus.COMPLETED
            )
            return response.model_copy(
                update={
                    "status": status,
                    "run_version": 4,
                    "review": HumanReviewReference(
                        review_id=REVIEW_ID,
                        review_version=2,
                    ),
                    "reason_codes": (),
                }
            )
        return response

    async def inspect_detail(self, *, user_id, run_id):
        self.inspect_detail_calls.append((user_id, run_id))
        return detail_response()

    async def list_pending(
        self,
        *,
        user_id,
        limit,
        before_created_at,
        before_id,
    ):
        self.list_pending_calls.append((user_id, limit, before_created_at, before_id))
        return self.pending_items, self.pending_has_more


def service(*, repository=None, authenticator=None, analyzer=None, lifecycle=None, edit=None):
    repository = repository or FakeRepository()
    analyzer = analyzer or FakeAnalyzer()
    lifecycle = lifecycle or FakeLifecycle()
    return (
        DurableHumanReviewService(
            authenticator=authenticator or FakeAuthenticator(),
            repository=repository,
            analysis_runner=analyzer,
            lifecycle=lifecycle,
            edit_validator=edit,
        ),
        repository,
        analyzer,
        lifecycle,
    )


def test_start_derives_tenant_runs_private_analysis_and_checkpoints_only_references() -> None:
    workflow, repository, analyzer, lifecycle = service()

    result = run(workflow.start(start_request(), "Bearer verified"))

    assert result.status is ResumeReviewRunStatus.PENDING_REVIEW
    assert repository.resolve_calls == [(ACTOR_ID, ("owner", "manager"))]
    assert len(analyzer.calls) == 1
    internal_request = analyzer.calls[0]
    assert internal_request.merchant_id == MERCHANT_ID
    assert internal_request.persist is False
    assert internal_request.candidate_id == CANDIDATE_ID
    assert len(repository.prepare_calls) == 1
    assert repository.prepare_calls[0]["analysis"] == analysis_record()
    assert len(lifecycle.starts) == 1
    checkpoint_start = lifecycle.starts[0]
    assert checkpoint_start.workflow_id == WORKFLOW_ID
    assert checkpoint_start.merchant_id == MERCHANT_ID
    assert not hasattr(checkpoint_start, "analysis")
    assert not hasattr(checkpoint_start, "candidate_id")
    assert repository.candidate_writes == 0


def test_exact_start_replay_skips_model_and_does_not_create_another_review() -> None:
    repository = FakeRepository()
    repository.lookup_result = repository.prepared.model_copy(update={"status": "pending_review"})
    workflow, _, analyzer, lifecycle = service(repository=repository)

    result = run(workflow.start(start_request(), "Bearer verified"))

    assert result.status is ResumeReviewRunStatus.PENDING_REVIEW
    assert analyzer.calls == []
    assert repository.prepare_calls == []
    assert lifecycle.starts == []


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (UnauthorizedUserError("no"), "identity"),
        (AuthenticationUnavailableError("down"), "dependency"),
    ],
)
def test_start_maps_identity_failures_without_touching_repository(error, expected) -> None:
    workflow, repository, analyzer, lifecycle = service(
        authenticator=FakeAuthenticator(error=error)
    )
    exception = HitlDependencyUnavailableError if expected == "dependency" else HitlIdentityError
    with pytest.raises(exception):
        run(workflow.start(start_request(), "Bearer untrusted"))
    assert repository.resolve_calls == []
    assert analyzer.calls == []
    assert lifecycle.starts == []


def test_approve_rechecks_membership_records_decision_then_resumes_by_id_only() -> None:
    workflow, repository, _, lifecycle = service()
    decision = ApproveResumeReviewDecision(
        schema_version="2.0",
        decision_id=DECISION_ID,
        review_id=REVIEW_ID,
        expected_review_version=1,
        action="approve",
    )

    result = run(workflow.decide(WORKFLOW_ID, decision, "Bearer verified"))

    assert result.status is ResumeReviewRunStatus.COMPLETED
    assert repository.resolve_calls == [(ACTOR_ID, ("owner", "manager", "reviewer"))]
    assert len(repository.authorize_calls) == 1
    assert len(repository.record_calls) == 1
    assert repository.record_calls[0]["edited_evaluation"] is None
    assert lifecycle.resumes == [
        {
            "merchant_id": MERCHANT_ID,
            "request_id": REQUEST_ID,
            "decision": {"decision_id": DECISION_ID},
        }
    ]


@pytest.mark.parametrize(
    "identity",
    [
        AuthenticatedUser(
            user_id=ACTOR_ID,
            session_id=SESSION_ID,
            assurance_level="aal1",
            authenticated_at=int(time.time()),
            token_expires_at=int(time.time()) + 3600,
        ),
        AuthenticatedUser(
            user_id=ACTOR_ID,
            session_id=SESSION_ID,
            assurance_level="aal2",
            authenticated_at=int(time.time()) - 601,
            token_expires_at=int(time.time()) + 3600,
        ),
        AuthenticatedUser(
            user_id=ACTOR_ID,
            session_id=None,
            assurance_level="aal2",
            authenticated_at=int(time.time()),
            token_expires_at=int(time.time()) + 3600,
        ),
    ],
)
def test_decision_requires_recent_aal2_session_before_database_access(identity) -> None:
    class AssuranceAuthenticator:
        async def authenticate(self, _authorization):
            return identity

    workflow, repository, _, lifecycle = service(authenticator=AssuranceAuthenticator())
    decision = ApproveResumeReviewDecision(
        schema_version="2.0",
        decision_id=DECISION_ID,
        review_id=REVIEW_ID,
        expected_review_version=1,
        action="approve",
    )
    with pytest.raises(HitlReviewerDeniedError):
        run(workflow.decide(WORKFLOW_ID, decision, "Bearer verified"))
    assert repository.recover_calls == []
    assert repository.resolve_calls == []
    assert repository.record_calls == []
    assert lifecycle.resumes == []


def test_reject_never_invokes_edit_validation_or_candidate_write() -> None:
    workflow, repository, _, lifecycle = service()
    decision = RejectResumeReviewDecision(
        schema_version="2.0",
        decision_id=DECISION_ID,
        review_id=REVIEW_ID,
        expected_review_version=1,
        action="reject",
        reason_code="insufficient-evidence",
    )

    result = run(workflow.decide(WORKFLOW_ID, decision, "Bearer verified"))

    assert result.status is ResumeReviewRunStatus.REJECTED
    assert repository.record_calls[0]["edited_evaluation"] is None
    assert repository.candidate_writes == 0
    assert len(lifecycle.resumes) == 1


def test_approve_with_edits_revalidates_then_persists_derived_evaluation() -> None:
    decision, evaluation = edited_decision_and_evaluation()
    validator = FakeEditValidator(
        decision.replacement_agent1_output,
        evaluation,
    )
    workflow, repository, _, lifecycle = service(edit=validator)

    result = run(workflow.decide(WORKFLOW_ID, decision, "Bearer verified"))

    assert result.status is ResumeReviewRunStatus.COMPLETED
    assert validator.calls == [(repository.decision_context, decision.replacement_agent1_output)]
    assert repository.record_calls[0]["edited_evaluation"] == evaluation
    assert lifecycle.resumes[0]["decision"] == {"decision_id": DECISION_ID}


def test_committed_decision_remains_retryable_when_checkpoint_resume_fails() -> None:
    lifecycle = FakeLifecycle()
    lifecycle.fail_resume = True
    workflow, repository, _, _ = service(lifecycle=lifecycle)
    decision = ApproveResumeReviewDecision(
        schema_version="2.0",
        decision_id=DECISION_ID,
        review_id=REVIEW_ID,
        expected_review_version=1,
        action="approve",
    )

    with pytest.raises(HitlDependencyUnavailableError):
        run(workflow.decide(WORKFLOW_ID, decision, "Bearer verified"))

    assert len(repository.record_calls) == 1
    assert len(lifecycle.resumes) == 1


def test_exact_committed_recovery_precedes_membership_and_only_resumes_checkpoint() -> None:
    repository = FakeRepository()
    repository.recovery_result = repository.recorded.model_copy(update={"replayed": True})
    workflow, _, analyzer, lifecycle = service(repository=repository)
    decision = ApproveResumeReviewDecision(
        schema_version="2.0",
        decision_id=DECISION_ID,
        review_id=REVIEW_ID,
        expected_review_version=1,
        action="approve",
    )

    result = run(workflow.decide(WORKFLOW_ID, decision, "Bearer verified"))

    assert result.status is ResumeReviewRunStatus.COMPLETED
    assert len(repository.recover_calls) == 1
    assert repository.resolve_calls == []
    assert repository.authorize_calls == []
    assert repository.record_calls == []
    assert analyzer.calls == []
    assert lifecycle.resumes == [
        {
            "merchant_id": MERCHANT_ID,
            "request_id": REQUEST_ID,
            "decision": {"decision_id": DECISION_ID},
        }
    ]


def test_inspect_authenticates_then_delegates_without_accepting_tenant() -> None:
    workflow, repository, _, _ = service()
    result = run(workflow.inspect(WORKFLOW_ID, "Bearer verified"))
    assert result.status is ResumeReviewRunStatus.PENDING_REVIEW
    assert (
        result.proposal.editable_agent1_output == detail_response().proposal.editable_agent1_output
    )
    assert repository.inspect_detail_calls == [(ACTOR_ID, WORKFLOW_ID)]
    assert repository.inspect_calls == []


def test_pending_queue_authenticates_and_round_trips_the_opaque_keyset_cursor() -> None:
    repository = FakeRepository()
    repository.pending_has_more = True
    workflow, _, _, _ = service(repository=repository)

    first = run(
        workflow.list_pending(
            limit=1,
            cursor=None,
            authorization="Bearer verified",
        )
    )

    assert first.items == repository.pending_items
    assert first.next_cursor is not None
    assert repository.list_pending_calls == [(ACTOR_ID, 1, None, None)]

    repository.pending_has_more = False
    second = run(
        workflow.list_pending(
            limit=1,
            cursor=first.next_cursor,
            authorization="Bearer verified",
        )
    )
    assert second.next_cursor is None
    assert repository.list_pending_calls[1] == (
        ACTOR_ID,
        1,
        repository.pending_items[0].created_at,
        repository.pending_items[0].run_id,
    )


@pytest.mark.parametrize("limit", [False, 0, 51])
def test_pending_queue_rejects_invalid_limits_before_identity_or_repository(limit) -> None:
    workflow, repository, _, _ = service()

    with pytest.raises(HitlInvalidRequestError):
        run(
            workflow.list_pending(
                limit=limit,
                cursor=None,
                authorization="Bearer verified",
            )
        )

    assert repository.list_pending_calls == []


def test_pending_queue_rejects_tampered_cursor_and_inconsistent_repository_page() -> None:
    workflow, repository, _, _ = service()
    with pytest.raises(HitlInvalidRequestError):
        run(
            workflow.list_pending(
                limit=1,
                cursor="a" * 20,
                authorization="Bearer verified",
            )
        )
    assert repository.list_pending_calls == []

    repository.pending_items = ()
    repository.pending_has_more = True
    with pytest.raises(HitlDependencyUnavailableError):
        run(
            workflow.list_pending(
                limit=1,
                cursor=None,
                authorization="Bearer verified",
            )
        )
