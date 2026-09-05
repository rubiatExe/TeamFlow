"""Strict v1 contracts for the two-agent résumé-review boundary."""

from __future__ import annotations

import math
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    StringConstraints,
    model_validator,
)

_SHARED_BLANK_CODE_POINTS = frozenset(
    {
        *range(0x0009, 0x000E),
        *range(0x001C, 0x0020),
        0x0020,
        0x0085,
        0x00A0,
        0x1680,
        *range(0x2000, 0x200B),
        *range(0x200B, 0x200E),
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x2060,
        0x3000,
        0xFEFF,
    }
)


def _require_nonblank(value: str) -> str:
    if all(ord(character) in _SHARED_BLANK_CODE_POINTS for character in value):
        raise ValueError("text must not be blank")
    return value


def _require_strict_boolean(value: object) -> object:
    if not isinstance(value, bool):
        raise ValueError("value must be a JSON boolean")
    return value


def _normalize_json_integer(value: object) -> int:
    """Match JSON/JavaScript integer semantics without accepting strings or booleans."""

    if isinstance(value, bool):
        raise ValueError("value must be a JSON integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    raise ValueError("value must be a JSON integer")


Identifier = Annotated[
    StrictStr,
    StringConstraints(min_length=3, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$"),
]
DatabaseId = Annotated[
    StrictStr,
    StringConstraints(pattern=(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")),
]
SemanticVersion = Annotated[
    StrictStr,
    StringConstraints(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$"),
]
BoundedText = Annotated[
    StrictStr,
    StringConstraints(min_length=1, max_length=1_000),
    AfterValidator(_require_nonblank),
]
ExactQuote = Annotated[
    StrictStr,
    StringConstraints(min_length=8, max_length=2_000),
    AfterValidator(_require_nonblank),
]
NotProbability = Annotated[Literal[False], BeforeValidator(_require_strict_boolean)]
JsonInteger = Annotated[int, BeforeValidator(_normalize_json_integer)]


class FrozenContract(BaseModel):
    """Make every nested boundary strict, immutable, and extra-field rejecting."""

    model_config = ConfigDict(extra="forbid", frozen=True, validate_default=True)


class CriterionStatus(StrEnum):
    MET = "met"
    NOT_MET = "not_met"
    UNKNOWN = "unknown"


class GapStatus(StrEnum):
    NOT_MET = "not_met"
    UNKNOWN = "unknown"


class GapReasonCode(StrEnum):
    CRITERION_NOT_MET = "criterion_not_met"
    CRITERION_UNKNOWN = "criterion_unknown"


class QuestionPriority(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class PolicyIdentity(FrozenContract):
    policy_id: Identifier
    policy_version: SemanticVersion


class WeightedCriterion(FrozenContract):
    criterion_id: Identifier
    criterion_text: BoundedText
    weight: JsonInteger = Field(ge=0, le=100)


class RoleScoringPolicy(FrozenContract):
    """Application-owned, configured weights for one role."""

    schema_version: Literal["1.0"]
    role_id: DatabaseId
    role_title: BoundedText
    policy_identity: PolicyIdentity
    criteria: Annotated[tuple[WeightedCriterion, ...], Field(min_length=1, max_length=30)]

    @model_validator(mode="after")
    def validate_criteria(self) -> RoleScoringPolicy:
        criterion_ids = [criterion.criterion_id for criterion in self.criteria]
        if len(criterion_ids) != len(set(criterion_ids)):
            raise ValueError("criterion_id values must be unique within a role policy")
        if sum(criterion.weight for criterion in self.criteria) != 100:
            raise ValueError("configured criterion weights must sum to 100")
        return self


class SourceEvidence(FrozenContract):
    criterion_id: Identifier
    exact_quote: ExactQuote
    source_block_id: Identifier


class CriterionAssessment(FrozenContract):
    criterion_id: Identifier
    status: CriterionStatus
    evidence: Annotated[tuple[SourceEvidence, ...], Field(max_length=8)]

    @model_validator(mode="after")
    def validate_evidence(self) -> CriterionAssessment:
        if self.status in {CriterionStatus.MET, CriterionStatus.NOT_MET} and not self.evidence:
            raise ValueError("met and not_met assessments require source evidence")
        if self.status is CriterionStatus.UNKNOWN and self.evidence:
            raise ValueError("unknown assessments must not claim source evidence")
        if any(item.criterion_id != self.criterion_id for item in self.evidence):
            raise ValueError("evidence criterion_id must match its assessment")
        evidence_keys = [
            (item.criterion_id, item.exact_quote, item.source_block_id) for item in self.evidence
        ]
        if len(evidence_keys) != len(set(evidence_keys)):
            raise ValueError("evidence references must be unique")
        return self


class Agent1RoleAssessment(FrozenContract):
    """Model-owned classifications for one configured role; scores are absent."""

    role_id: DatabaseId
    criterion_assessments: Annotated[
        tuple[CriterionAssessment, ...],
        Field(min_length=1, max_length=30),
    ]

    @model_validator(mode="after")
    def validate_unique_criteria(self) -> Agent1RoleAssessment:
        criterion_ids = [item.criterion_id for item in self.criterion_assessments]
        if len(criterion_ids) != len(set(criterion_ids)):
            raise ValueError("criterion_id values must be unique within a role assessment")
        return self


class Agent1ModelOutput(FrozenContract):
    """The only Phase 2 contract intended for future Agent 1 model output."""

    schema_version: Literal["1.0"]
    role_assessments: Annotated[
        tuple[Agent1RoleAssessment, ...],
        Field(min_length=1, max_length=20),
    ]
    limitations: Annotated[tuple[BoundedText, ...], Field(max_length=20)]

    @model_validator(mode="after")
    def validate_unique_roles(self) -> Agent1ModelOutput:
        role_ids = [item.role_id for item in self.role_assessments]
        if len(role_ids) != len(set(role_ids)):
            raise ValueError("role_id values must be unique in Agent 1 output")
        if len(self.limitations) != len(set(self.limitations)):
            raise ValueError("limitations must be unique")
        return self


class ValidatedGap(FrozenContract):
    """Application-derived gap safe to hand to Agent 2."""

    role_id: DatabaseId
    criterion_id: Identifier
    criterion_text: BoundedText
    status: GapStatus
    reason_code: GapReasonCode

    @model_validator(mode="after")
    def validate_reason(self) -> ValidatedGap:
        expected = {
            GapStatus.NOT_MET: GapReasonCode.CRITERION_NOT_MET,
            GapStatus.UNKNOWN: GapReasonCode.CRITERION_UNKNOWN,
        }[self.status]
        if self.reason_code is not expected:
            raise ValueError("gap reason_code must match the gap status")
        return self


class RoleMatch(FrozenContract):
    """Application-owned score, evidence, and derived gaps for one role."""

    role_id: DatabaseId
    deterministic_score: JsonInteger = Field(ge=0, le=100)
    scoring_policy: PolicyIdentity
    criterion_assessments: Annotated[
        tuple[CriterionAssessment, ...],
        Field(min_length=1, max_length=30),
    ]
    gaps: Annotated[tuple[ValidatedGap, ...], Field(max_length=30)]

    @model_validator(mode="after")
    def validate_assessments_and_gaps(self) -> RoleMatch:
        assessments = {item.criterion_id: item for item in self.criterion_assessments}
        if len(assessments) != len(self.criterion_assessments):
            raise ValueError("criterion_id values must be unique within a role match")
        gap_ids = [gap.criterion_id for gap in self.gaps]
        if len(gap_ids) != len(set(gap_ids)):
            raise ValueError("gap criterion_id values must be unique")
        expected_gap_ids = {
            item.criterion_id
            for item in self.criterion_assessments
            if item.status is not CriterionStatus.MET
        }
        if set(gap_ids) != expected_gap_ids:
            raise ValueError("gaps must exactly match not_met and unknown assessments")
        for gap in self.gaps:
            assessment = assessments[gap.criterion_id]
            if gap.role_id != self.role_id:
                raise ValueError("gap role_id must match its role match")
            if gap.status.value != assessment.status.value:
                raise ValueError("gap status must match its criterion assessment")
        return self


class Agent1Evaluation(FrozenContract):
    """Application-owned, deterministic Agent 1 result."""

    schema_version: Literal["1.0"]
    ranked_roles: Annotated[tuple[RoleMatch, ...], Field(min_length=1, max_length=20)]
    recommended_role_id: DatabaseId | None
    limitations: Annotated[tuple[BoundedText, ...], Field(max_length=20)]

    @model_validator(mode="after")
    def validate_ranking(self) -> Agent1Evaluation:
        role_ids = [item.role_id for item in self.ranked_roles]
        if len(role_ids) != len(set(role_ids)):
            raise ValueError("ranked role_id values must be unique")
        expected = sorted(
            self.ranked_roles,
            key=lambda item: (-item.deterministic_score, item.role_id),
        )
        if list(self.ranked_roles) != expected:
            raise ValueError("ranked_roles must be sorted by score then role_id")
        top_score = self.ranked_roles[0].deterministic_score
        top_is_tied = (
            len(self.ranked_roles) > 1 and self.ranked_roles[1].deterministic_score == top_score
        )
        expected_recommendation = (
            None if top_score == 0 or top_is_tied else self.ranked_roles[0].role_id
        )
        if self.recommended_role_id != expected_recommendation:
            raise ValueError(
                "recommended_role_id must be null for zero/tied leaders and otherwise "
                "identify the first ranked role"
            )
        if len(self.limitations) != len(set(self.limitations)):
            raise ValueError("limitations must be unique")
        return self


class Agent2PlanningContext(FrozenContract):
    """Least-privilege handoff derived from the recommended Agent 1 role."""

    schema_version: Literal["1.0"]
    role_id: DatabaseId
    gaps: Annotated[tuple[ValidatedGap, ...], Field(max_length=30)]

    @model_validator(mode="after")
    def validate_gaps(self) -> Agent2PlanningContext:
        criterion_ids = [gap.criterion_id for gap in self.gaps]
        if len(criterion_ids) != len(set(criterion_ids)):
            raise ValueError("Agent 2 context gaps must be unique")
        if any(gap.role_id != self.role_id for gap in self.gaps):
            raise ValueError("Agent 2 context gaps must match its role_id")
        if any(gap.status is not GapStatus.UNKNOWN for gap in self.gaps):
            raise ValueError("Agent 2 context may contain only unknown gaps")
        return self


class Agent2Question(FrozenContract):
    question: BoundedText
    target_criterion_id: Identifier
    target_gap_status: Literal[GapStatus.UNKNOWN]
    purpose: BoundedText
    priority: QuestionPriority


class Agent2QuestionPlan(FrozenContract):
    """Future Agent 2 model boundary; deliberately has no score or tool fields."""

    schema_version: Literal["1.0"]
    role_id: DatabaseId
    questions: Annotated[tuple[Agent2Question, ...], Field(max_length=10)]

    @model_validator(mode="after")
    def validate_unique_targets(self) -> Agent2QuestionPlan:
        targets = [
            (question.target_criterion_id, question.target_gap_status)
            for question in self.questions
        ]
        if len(targets) != len(set(targets)):
            raise ValueError("Agent 2 questions must target unique validated gaps")
        return self


class ConfidenceComponent(FrozenContract):
    component_id: Identifier
    score: JsonInteger = Field(ge=0, le=100)
    reason_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)]

    @model_validator(mode="after")
    def validate_reason_codes(self) -> ConfidenceComponent:
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("component reason_codes must be unique")
        return self


class ConfidenceAssessment(FrozenContract):
    """Application diagnostic value; score is explicitly not a probability."""

    schema_version: Literal["1.0"]
    score: JsonInteger = Field(ge=0, le=100)
    is_probability: NotProbability
    hard_failure: StrictBool
    components: Annotated[tuple[ConfidenceComponent, ...], Field(min_length=1, max_length=20)]
    reason_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)]
    policy_identity: PolicyIdentity

    @model_validator(mode="after")
    def validate_confidence(self) -> ConfidenceAssessment:
        component_ids = [item.component_id for item in self.components]
        if len(component_ids) != len(set(component_ids)):
            raise ValueError("confidence component_id values must be unique")
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("confidence reason_codes must be unique")
        if self.hard_failure and not self.reason_codes:
            raise ValueError("hard_failure confidence requires reason_codes")
        return self


class ResumeReviewContractFixture(FrozenContract):
    """Shared conformance fixture parsed by both Python and TypeScript tests."""

    role_scoring_policies: Annotated[
        tuple[RoleScoringPolicy, ...],
        Field(min_length=1, max_length=20),
    ]
    agent1_model_output: Agent1ModelOutput
    agent1_evaluation: Agent1Evaluation
    agent2_planning_context: Agent2PlanningContext
    agent2_question_plan: Agent2QuestionPlan
    confidence_assessment: ConfidenceAssessment

    @model_validator(mode="after")
    def validate_unique_policies(self) -> ResumeReviewContractFixture:
        role_ids = [policy.role_id for policy in self.role_scoring_policies]
        if len(role_ids) != len(set(role_ids)):
            raise ValueError("role scoring policies must have unique role_id values")
        identities = [
            (
                policy.policy_identity.policy_id,
                policy.policy_identity.policy_version,
            )
            for policy in self.role_scoring_policies
        ]
        if len(identities) != len(set(identities)):
            raise ValueError("role scoring policy identities must be unique across roles")
        return self
