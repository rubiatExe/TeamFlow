"""Strict, additive Phase 6 contracts for durable human review.

These contracts deliberately contain no tenant, actor, thread, checkpoint, score, or
tool authority. Authentication and tenant derivation belong to the service boundary;
the durable runtime is implemented separately from this contract-only slice.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import (
    AwareDatetime,
    Field,
    StrictBool,
    StrictStr,
    StringConstraints,
    model_validator,
)

from ..contracts import (
    Agent1ModelOutput,
    Agent2QuestionPlan,
    BoundedText,
    ConfidenceComponent,
    CriterionStatus,
    DatabaseId,
    ExactQuote,
    FrozenContract,
    GapStatus,
    Identifier,
    JsonInteger,
    NotProbability,
    PolicyIdentity,
    SourceEvidence,
)
from ..workflow_contracts import DocumentId, ReviewStatus, Sha256


class ResumeReviewRunStatus(StrEnum):
    RUNNING = "running"
    PENDING_REVIEW = "pending_review"
    DECISION_RECORDED = "decision_recorded"
    APPLYING = "applying"
    COMPLETED = "completed"
    REJECTED = "rejected"
    STALE = "stale"
    FAILED = "failed"


class StartResumeReviewRunRequest(FrozenContract):
    """Caller input for a durable run; identity and authority are server-derived."""

    schema_version: Literal["2.0"]
    request_id: DatabaseId
    document_id: DocumentId
    candidate_id: DatabaseId


class HumanReviewReference(FrozenContract):
    """Safe reference to a review without checkpoint or private document state."""

    review_id: DatabaseId
    review_version: JsonInteger = Field(ge=1, le=2_147_483_647)


_REVIEW_CREATED_STATUSES = frozenset(
    {
        ResumeReviewRunStatus.PENDING_REVIEW,
        ResumeReviewRunStatus.DECISION_RECORDED,
        ResumeReviewRunStatus.APPLYING,
        ResumeReviewRunStatus.COMPLETED,
        ResumeReviewRunStatus.REJECTED,
        ResumeReviewRunStatus.STALE,
    }
)


class ResumeReviewRunResponse(FrozenContract):
    """Safe projection shared by invoke and inspect operations."""

    schema_version: Literal["2.0"]
    run_id: DatabaseId
    request_id: DatabaseId
    document_id: DocumentId
    status: ResumeReviewRunStatus
    run_version: JsonInteger = Field(ge=1, le=2_147_483_647)
    review: HumanReviewReference | None
    reason_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)]

    @model_validator(mode="after")
    def validate_lifecycle_projection(self) -> ResumeReviewRunResponse:
        if self.status in _REVIEW_CREATED_STATUSES and self.review is None:
            raise ValueError("post-review run status requires a review reference")
        if self.status is ResumeReviewRunStatus.RUNNING and self.review is not None:
            raise ValueError("running status cannot expose a review before it is created")
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("reason_codes must be unique")
        return self


PendingReviewCursor = Annotated[
    StrictStr,
    StringConstraints(min_length=20, max_length=256, pattern=r"^[A-Za-z0-9_-]+$"),
]


class ReviewerEvidenceSnippet(FrozenContract):
    """Exact, bounded evidence plus an opaque source-block provenance reference."""

    criterion_id: Identifier
    exact_quote: ExactQuote
    source_block_id: Identifier


class ReviewerCriterionDetail(FrozenContract):
    role_id: DatabaseId
    criterion_id: Identifier
    criterion_text: BoundedText
    weight: JsonInteger = Field(ge=0, le=100)
    status: CriterionStatus
    gap_status: GapStatus | None
    evidence_snippets: Annotated[
        tuple[ReviewerEvidenceSnippet, ...],
        Field(max_length=3),
    ]

    @model_validator(mode="after")
    def validate_gap_and_evidence(self) -> ReviewerCriterionDetail:
        expected_gap = None if self.status is CriterionStatus.MET else GapStatus(self.status.value)
        if self.gap_status is not expected_gap:
            raise ValueError("gap_status must be derived from criterion status")
        if self.status in {CriterionStatus.MET, CriterionStatus.NOT_MET}:
            if not self.evidence_snippets:
                raise ValueError("classified criteria require evidence snippets")
        elif self.evidence_snippets:
            raise ValueError("unknown criteria cannot expose evidence snippets")
        if any(evidence.criterion_id != self.criterion_id for evidence in self.evidence_snippets):
            raise ValueError("evidence criterion IDs must match the criterion detail")
        return self


class ReviewerRoleSummary(FrozenContract):
    role_id: DatabaseId
    role_title: BoundedText
    scoring_policy: PolicyIdentity
    deterministic_score: JsonInteger = Field(ge=0, le=100)
    recommended: StrictBool


class ReviewerConfidenceSummary(FrozenContract):
    """Bounded final provenance; the numeric diagnostic is never a probability."""

    schema_version: Literal["1.0"]
    mode: Literal["shadow"]
    score: JsonInteger = Field(ge=0, le=100)
    is_probability: NotProbability
    hard_failure: StrictBool
    threshold_applied: NotProbability
    review_required: StrictBool
    status: ReviewStatus
    components: Annotated[tuple[ConfidenceComponent, ...], Field(min_length=1, max_length=20)]
    reason_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)]
    policy_identity: PolicyIdentity
    policy_sha256: Sha256

    @model_validator(mode="after")
    def validate_provenance(self) -> ReviewerConfidenceSummary:
        component_ids = [component.component_id for component in self.components]
        if len(component_ids) != len(set(component_ids)):
            raise ValueError("confidence component IDs must be unique")
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("confidence reason codes must be unique")
        if self.review_required != (self.status is ReviewStatus.REVIEW_REQUIRED):
            raise ValueError("confidence status and review_required must agree")
        if self.hard_failure and (not self.review_required or not self.reason_codes):
            raise ValueError("confidence hard failures must have reasons and require review")
        return self


class ResumeReviewProposal(FrozenContract):
    """Least-privilege packet sufficient for a reviewer to make a decision."""

    schema_version: Literal["2.0"]
    candidate_id: DatabaseId
    created_at: AwareDatetime
    top_role_id: DatabaseId
    recommended_role_id: DatabaseId | None
    roles: Annotated[tuple[ReviewerRoleSummary, ...], Field(min_length=1, max_length=5)]
    criterion_details: Annotated[
        tuple[ReviewerCriterionDetail, ...],
        Field(min_length=1, max_length=30),
    ]
    limitations: Annotated[tuple[BoundedText, ...], Field(max_length=20)]
    question_plan: Agent2QuestionPlan | None
    confidence: ReviewerConfidenceSummary
    editable_agent1_output: Agent1ModelOutput

    @model_validator(mode="after")
    def validate_projection(self) -> ResumeReviewProposal:
        role_ids = [role.role_id for role in self.roles]
        if len(role_ids) != len(set(role_ids)):
            raise ValueError("reviewer role summaries must be unique")
        expected_roles = sorted(
            self.roles,
            key=lambda role: (-role.deterministic_score, role.role_id),
        )
        if list(self.roles) != expected_roles or self.top_role_id != self.roles[0].role_id:
            raise ValueError("reviewer role summaries must retain deterministic ranking")

        top_score = self.roles[0].deterministic_score
        top_is_tied = len(self.roles) > 1 and self.roles[1].deterministic_score == top_score
        expected_recommendation = None if top_score == 0 or top_is_tied else self.roles[0].role_id
        if self.recommended_role_id != expected_recommendation:
            raise ValueError("reviewer recommendation must match the deterministic ranking")
        for role in self.roles:
            if role.recommended != (role.role_id == self.recommended_role_id):
                raise ValueError("recommended flags must match recommended_role_id")

        criterion_ids = [criterion.criterion_id for criterion in self.criterion_details]
        if len(criterion_ids) != len(set(criterion_ids)):
            raise ValueError("reviewer criterion details must be unique")
        if any(criterion.role_id != self.top_role_id for criterion in self.criterion_details):
            raise ValueError("criterion details must describe only the top role")
        if sum(criterion.weight for criterion in self.criterion_details) != 100:
            raise ValueError("reviewer criterion weights must reproduce the configured policy")
        derived_score = sum(
            criterion.weight
            for criterion in self.criterion_details
            if criterion.status is CriterionStatus.MET
        )
        if derived_score != top_score:
            raise ValueError("reviewer criterion details must reproduce the top-role score")
        if len(self.limitations) != len(set(self.limitations)):
            raise ValueError("reviewer limitations must be unique")
        if self.editable_agent1_output.limitations != self.limitations:
            raise ValueError("editable output must retain the immutable limitation ledger")
        editable_role_ids = [role.role_id for role in self.editable_agent1_output.role_assessments]
        if editable_role_ids != role_ids:
            raise ValueError("editable output must cover the ranked role catalog")
        top_editable = self.editable_agent1_output.role_assessments[0]
        editable_by_criterion = {
            criterion.criterion_id: criterion for criterion in top_editable.criterion_assessments
        }
        if set(editable_by_criterion) != set(criterion_ids):
            raise ValueError("top-role detail must cover the editable top-role criteria")
        for criterion in self.criterion_details:
            editable = editable_by_criterion[criterion.criterion_id]
            projected_evidence = tuple(
                SourceEvidence(
                    criterion_id=evidence.criterion_id,
                    exact_quote=evidence.exact_quote,
                    source_block_id=evidence.source_block_id,
                )
                for evidence in criterion.evidence_snippets
            )
            if editable.status is not criterion.status or editable.evidence != projected_evidence:
                raise ValueError("top-role detail must match the editable evidence projection")
        if self.question_plan is not None and (
            self.recommended_role_id is None
            or self.question_plan.role_id != self.recommended_role_id
        ):
            raise ValueError("question plan must target the recommended top role")
        if self.question_plan is not None:
            unknown_ids = {
                criterion.criterion_id
                for criterion in self.criterion_details
                if criterion.status is CriterionStatus.UNKNOWN
            }
            question_ids = {
                question.target_criterion_id for question in self.question_plan.questions
            }
            if question_ids != unknown_ids:
                raise ValueError("question plan must cover the top role's unknown criteria")
        return self


class ResumeReviewRunDetailResponse(ResumeReviewRunResponse):
    proposal: ResumeReviewProposal


class PendingResumeReviewTopRole(FrozenContract):
    role_id: DatabaseId
    role_title: BoundedText
    deterministic_score: JsonInteger = Field(ge=0, le=100)
    recommended_role_id: DatabaseId | None

    @model_validator(mode="after")
    def validate_recommendation(self) -> PendingResumeReviewTopRole:
        if self.recommended_role_id not in {None, self.role_id}:
            raise ValueError("queue recommendation must be null or identify the top role")
        return self


class PendingResumeReviewQueueItem(FrozenContract):
    run_id: DatabaseId
    candidate_id: DatabaseId
    created_at: AwareDatetime
    run_version: JsonInteger = Field(ge=1, le=2_147_483_647)
    review: HumanReviewReference
    reason_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)]
    top_role: PendingResumeReviewTopRole

    @model_validator(mode="after")
    def validate_reason_codes(self) -> PendingResumeReviewQueueItem:
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("reason_codes must be unique")
        return self


class PendingResumeReviewQueueResponse(FrozenContract):
    schema_version: Literal["2.0"]
    status: Literal["pending_review"]
    items: Annotated[tuple[PendingResumeReviewQueueItem, ...], Field(max_length=50)]
    next_cursor: PendingReviewCursor | None

    @model_validator(mode="after")
    def validate_page(self) -> PendingResumeReviewQueueResponse:
        run_ids = [item.run_id for item in self.items]
        if len(run_ids) != len(set(run_ids)):
            raise ValueError("pending queue run IDs must be unique")
        expected = sorted(
            self.items,
            key=lambda item: (item.created_at, item.run_id),
            reverse=True,
        )
        if list(self.items) != expected:
            raise ValueError("pending queue must use newest-first keyset order")
        if self.next_cursor is not None and not self.items:
            raise ValueError("an empty queue page cannot have a next cursor")
        return self


class _DecisionRequest(FrozenContract):
    schema_version: Literal["2.0"]
    decision_id: DatabaseId
    review_id: DatabaseId
    expected_review_version: JsonInteger = Field(ge=1, le=2_147_483_647)


class ApproveResumeReviewDecision(_DecisionRequest):
    action: Literal["approve"]


class ApproveWithEditsResumeReviewDecision(_DecisionRequest):
    """Human classifications only; deterministic score ownership stays server-side."""

    action: Literal["approve_with_edits"]
    replacement_agent1_output: Agent1ModelOutput
    reason_code: Identifier


class RejectResumeReviewDecision(_DecisionRequest):
    action: Literal["reject"]
    reason_code: Identifier


ResumeReviewDecisionRequest = Annotated[
    ApproveResumeReviewDecision | ApproveWithEditsResumeReviewDecision | RejectResumeReviewDecision,
    Field(discriminator="action"),
]


class ResumeReviewHitlContractFixture(FrozenContract):
    """Cross-runtime fixture parsed by both Pydantic and Zod tests."""

    start_request: StartResumeReviewRunRequest
    run_responses: Annotated[
        tuple[ResumeReviewRunResponse, ...],
        Field(min_length=1, max_length=16),
    ]
    decisions: Annotated[
        tuple[ResumeReviewDecisionRequest, ...],
        Field(min_length=1, max_length=16),
    ]
