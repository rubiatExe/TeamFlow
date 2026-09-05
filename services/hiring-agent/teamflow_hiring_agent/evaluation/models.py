"""Strict, provider-neutral contracts for offline résumé-review evaluation data."""

from __future__ import annotations

import unicodedata
from enum import StrEnum
from pathlib import PurePosixPath
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    StringConstraints,
    field_validator,
    model_validator,
)

Identifier = Annotated[
    StrictStr,
    StringConstraints(min_length=3, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$"),
]
Sha256 = Annotated[StrictStr, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Version = Annotated[StrictStr, StringConstraints(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")]
BoundedText = Annotated[StrictStr, StringConstraints(min_length=1, max_length=1_000)]


class FrozenModel(BaseModel):
    """Reject extra fields and prevent top-level artifact mutation."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        str_strip_whitespace=True,
        validate_default=True,
    )


class DatasetSplit(StrEnum):
    VALIDATION = "validation"
    TEST = "test"
    ADVERSARIAL = "adversarial"


class DatasetPurpose(StrEnum):
    VALIDATION = "validation"
    TEST_EVALUATION = "test_evaluation"
    ADVERSARIAL_EVALUATION = "adversarial_evaluation"
    INTEGRITY_VERIFICATION = "integrity_verification"


class CaseSource(StrEnum):
    SYNTHETIC = "synthetic"
    ANONYMIZED = "anonymized"


class ReviewStatus(StrEnum):
    PENDING_HUMAN_REVIEW = "pending_human_review"
    HUMAN_APPROVED = "human_approved"


class ScenarioCategory(StrEnum):
    CLEAR_FIT = "clear_fit"
    WEAK_FIT = "weak_fit"
    MISSING_EVIDENCE = "missing_evidence"
    CONTRADICTORY_DATES = "contradictory_dates"
    PROMPT_INJECTION = "prompt_injection"
    PROTECTED_TRAIT_PERTURBATION = "protected_trait_perturbation"
    EQUIVALENT_RESUME_PAIR = "equivalent_resume_pair"
    OCR_DEGRADATION = "ocr_degradation"
    WRONG_TENANT_CONTEXT = "wrong_tenant_context"
    PROVIDER_FAILURE = "provider_failure"


class ExpectedStatus(StrEnum):
    COMPLETE = "complete"
    DEGRADED = "degraded"
    REFUSED = "refused"
    REVIEW_REQUIRED = "review_required"


class ProviderFault(StrEnum):
    PRIMARY_TIMEOUT = "primary_timeout"
    ALL_MODELS_TIMEOUT = "all_models_timeout"
    SAFETY_BLOCK = "safety_block"
    MALFORMED_OUTPUT = "malformed_output"


class CriterionFixture(FrozenModel):
    criterion_id: Identifier
    description: BoundedText
    weight: StrictInt | None = Field(default=None, ge=0, le=100)
    required: StrictBool = False


class RoleFixture(FrozenModel):
    role_id: UUID
    title: BoundedText
    criteria: Annotated[tuple[CriterionFixture, ...], Field(min_length=1, max_length=20)]

    @model_validator(mode="after")
    def validate_criteria(self) -> RoleFixture:
        identifiers = [criterion.criterion_id for criterion in self.criteria]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("criterion_id values must be unique within a role")
        weights = [criterion.weight for criterion in self.criteria]
        if any(weight is not None for weight in weights):
            missing_weight = any(weight is None for weight in weights)
            total_weight = sum(weight for weight in weights if weight is not None)
            if missing_weight or total_weight != 100:
                raise ValueError("criterion weights must all be present and sum to 100")
        return self


class ResumeReviewInput(FrozenModel):
    document_id: Identifier
    request_merchant_id: UUID
    candidate_merchant_id: UUID
    role_merchant_id: UUID | None = None
    retrieved_merchant_ids: Annotated[tuple[UUID, ...], Field(max_length=10)] = ()
    resume_markdown: Annotated[StrictStr, StringConstraints(min_length=1, max_length=30_000)]
    role: RoleFixture
    instructions: Annotated[StrictStr, StringConstraints(max_length=4_000)] | None = None
    provider_fault: ProviderFault | None = None
    extraction_quality: Literal["clean", "degraded", "unusable"] = "clean"


class CriticalField(FrozenModel):
    field: Identifier
    value: BoundedText


class ScoreRange(FrozenModel):
    minimum: StrictInt = Field(ge=0, le=100)
    maximum: StrictInt = Field(ge=0, le=100)

    @model_validator(mode="after")
    def validate_bounds(self) -> ScoreRange:
        if self.minimum > self.maximum:
            raise ValueError("score minimum cannot exceed maximum")
        return self


class ExpectedBehavior(FrozenModel):
    status: ExpectedStatus
    critical_fields: Annotated[tuple[CriticalField, ...], Field(max_length=30)] = ()
    accepted_fit_score: ScoreRange | None = None
    must_cite: Annotated[tuple[BoundedText, ...], Field(max_length=30)] = ()
    must_not_claim: Annotated[tuple[BoundedText, ...], Field(max_length=30)] = ()
    warning_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)] = ()
    review_required: StrictBool = False
    allow_model_calls: StrictBool = True
    allow_writes: Literal[False] = False

    @model_validator(mode="after")
    def validate_status(self) -> ExpectedBehavior:
        if self.status in {ExpectedStatus.REFUSED, ExpectedStatus.REVIEW_REQUIRED}:
            if self.accepted_fit_score is not None:
                raise ValueError("refused/review-required cases cannot define a fit score")
        if self.status is ExpectedStatus.REVIEW_REQUIRED and not self.review_required:
            raise ValueError("review_required status must require review")
        return self


class CaseProvenance(FrozenModel):
    source: CaseSource
    generator: Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]
    generator_version: Version
    template_id: Identifier
    seed: StrictInt = Field(ge=0)


def _literal_form(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


class EvaluationCase(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    case_id: Identifier
    split: DatasetSplit
    scenario: ScenarioCategory
    tags: Annotated[tuple[Identifier, ...], Field(max_length=12)] = ()
    title: BoundedText
    input: ResumeReviewInput
    expected: ExpectedBehavior
    provenance: CaseProvenance
    review_status: ReviewStatus
    equivalence_group: Identifier | None = None

    @model_validator(mode="after")
    def validate_case(self) -> EvaluationCase:
        if len(self.tags) != len(set(self.tags)):
            raise ValueError("tags must be unique")
        source = _literal_form(self.input.resume_markdown)
        unsupported = [
            quote for quote in self.expected.must_cite if _literal_form(quote) not in source
        ]
        if unsupported:
            raise ValueError("must_cite values must be literal résumé substrings")
        if self.provenance.source is CaseSource.ANONYMIZED:
            if self.review_status is not ReviewStatus.HUMAN_APPROVED:
                raise ValueError("anonymized cases require human approval before commit")
        return self


def _safe_relative_file(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) != 1 or path.name in {"", ".", ".."}:
        raise ValueError("artifact path must be a direct relative file")
    return value


class SplitManifest(FrozenModel):
    split: DatasetSplit
    file: Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]
    count: StrictInt = Field(ge=1)
    sha256: Sha256
    record_fingerprint_sha256: Sha256
    input_fingerprint_sha256: Sha256
    case_id_sha256: Sha256

    @field_validator("file")
    @classmethod
    def validate_file(cls, value: str) -> str:
        return _safe_relative_file(value)


class DatasetManifest(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    dataset_name: Identifier
    dataset_version: Version
    review_status: ReviewStatus
    total_count: StrictInt = Field(ge=1)
    splits: Annotated[tuple[SplitManifest, ...], Field(min_length=3, max_length=3)]
    test_lock_file: Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]

    @field_validator("test_lock_file")
    @classmethod
    def validate_lock_file(cls, value: str) -> str:
        return _safe_relative_file(value)

    @model_validator(mode="after")
    def validate_manifest(self) -> DatasetManifest:
        splits = [item.split for item in self.splits]
        if len(splits) != len(set(splits)) or set(splits) != set(DatasetSplit):
            raise ValueError("manifest must contain validation, test, and adversarial exactly once")
        if sum(item.count for item in self.splits) != self.total_count:
            raise ValueError("manifest total_count does not equal the split counts")
        return self


class TestSetLock(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    dataset_name: Identifier
    dataset_version: Version
    split: Literal[DatasetSplit.TEST] = DatasetSplit.TEST
    file: Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]
    count: StrictInt = Field(ge=1)
    sha256: Sha256
    record_fingerprint_sha256: Sha256
    input_fingerprint_sha256: Sha256
    case_id_sha256: Sha256
    case_schema_sha256: Sha256

    @field_validator("file")
    @classmethod
    def validate_file(cls, value: str) -> str:
        return _safe_relative_file(value)
