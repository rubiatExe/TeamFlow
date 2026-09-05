"""Strict runtime contracts for the versioned résumé-review workflow."""

from __future__ import annotations

import hashlib
import json
import re
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, StrictBool, StrictStr, StringConstraints, model_validator

from .contracts import (
    Agent1Evaluation,
    Agent2QuestionPlan,
    DatabaseId,
    FrozenContract,
    Identifier,
    JsonInteger,
)

_DOCUMENT_ID_RE = re.compile(r"^doc-([0-9a-f]{64})$")
_SOURCE_BLOCK_ID_RE = re.compile(r"^src-([0-9a-f]{12})-p([0-9]{4})-b([0-9]{4})-([0-9a-f]{12})$")
_SHARED_BLANK_CODE_POINTS = frozenset(
    {
        *range(0x0009, 0x000E),
        *range(0x001C, 0x0020),
        0x0020,
        0x0085,
        0x00A0,
        0x1680,
        *range(0x2000, 0x200E),
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x2060,
        0x3000,
        0xFEFF,
    }
)

DocumentId = Annotated[
    StrictStr,
    StringConstraints(pattern=r"^doc-[0-9a-f]{64}$"),
]
Sha256 = Annotated[
    StrictStr,
    StringConstraints(pattern=r"^[0-9a-f]{64}$"),
]


def canonical_snapshot_sha256(payload: dict[str, object]) -> str:
    """Hash a snapshot with deterministic cross-runtime JSON key ordering."""

    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


class ExtractionStatus(StrEnum):
    COMPLETE = "complete"
    DEGRADED = "degraded"


class StoredExtractionWarning(StrEnum):
    OCR_REQUIRED = "ocr_required"
    EMBEDDING_FAILED = "embedding_failed"
    EMBEDDING_INPUT_TRUNCATED = "embedding_input_truncated"
    MALFORMED_DOCUMENT = "malformed_document"
    ENCRYPTED_DOCUMENT = "encrypted_document"
    PAGE_LIMIT_EXCEEDED = "page_limit_exceeded"
    PDF_TEXT_TIMEOUT = "pdf_text_timeout"
    PDF_TEXT_OVERLOADED = "pdf_text_overloaded"
    OCR_PROVIDER_FAILED = "ocr_provider_failed"
    OCR_PROVIDER_TIMEOUT = "ocr_provider_timeout"
    OCR_RESPONSE_INCOMPLETE = "ocr_response_incomplete"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    EMPTY_EXTRACTION = "empty_extraction"
    MALFORMED_EXTRACTION = "malformed_extraction"
    MOCK_MODE_ENABLED = "mock_mode_enabled"


_FAILURE_WARNINGS = frozenset(
    {
        StoredExtractionWarning.MALFORMED_DOCUMENT,
        StoredExtractionWarning.ENCRYPTED_DOCUMENT,
        StoredExtractionWarning.PAGE_LIMIT_EXCEEDED,
        StoredExtractionWarning.PDF_TEXT_TIMEOUT,
        StoredExtractionWarning.PDF_TEXT_OVERLOADED,
        StoredExtractionWarning.OCR_PROVIDER_FAILED,
        StoredExtractionWarning.OCR_PROVIDER_TIMEOUT,
        StoredExtractionWarning.OCR_RESPONSE_INCOMPLETE,
        StoredExtractionWarning.PROVIDER_UNAVAILABLE,
        StoredExtractionWarning.EMPTY_EXTRACTION,
        StoredExtractionWarning.MALFORMED_EXTRACTION,
        StoredExtractionWarning.MOCK_MODE_ENABLED,
    }
)


def _validate_usable_extraction_status(
    status: ExtractionStatus,
    embedding_available: bool,
    warnings: tuple[StoredExtractionWarning, ...],
) -> None:
    if _FAILURE_WARNINGS.intersection(warnings):
        raise ValueError("usable extraction cannot contain a failure warning")
    has_embedding_failure = StoredExtractionWarning.EMBEDDING_FAILED in warnings
    if status is ExtractionStatus.COMPLETE and (not embedding_available or has_embedding_failure):
        raise ValueError("complete extraction requires an available embedding")
    if status is ExtractionStatus.DEGRADED and (embedding_available or not has_embedding_failure):
        raise ValueError("degraded extraction must record an embedding failure")


class ReviewStatus(StrEnum):
    COMPLETE = "complete"
    DEGRADED = "degraded"
    REVIEW_REQUIRED = "review_required"


class QuestionsStatus(StrEnum):
    COMPLETE = "complete"
    DEGRADED = "degraded"
    NOT_REQUIRED = "not_required"
    SKIPPED = "skipped"


class PersistenceStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    NOT_REQUESTED = "not_requested"


class DocumentSourceBlock(FrozenContract):
    source_block_id: Annotated[
        StrictStr,
        StringConstraints(pattern=_SOURCE_BLOCK_ID_RE.pattern),
    ]
    page_number: JsonInteger | None = Field(default=None, ge=1, le=9_999)
    ordinal: JsonInteger = Field(ge=1, le=9_999)
    text: Annotated[
        StrictStr,
        StringConstraints(min_length=1, max_length=4_000),
    ]

    @model_validator(mode="after")
    def validate_source_id(self) -> DocumentSourceBlock:
        match = _SOURCE_BLOCK_ID_RE.fullmatch(self.source_block_id)
        assert match is not None
        expected_page = f"{self.page_number or 0:04d}"
        expected_ordinal = f"{self.ordinal:04d}"
        digest = hashlib.sha256(
            f"{self.page_number or 0}|{self.ordinal}|{self.text}".encode()
        ).hexdigest()[:12]
        if (match.group(2), match.group(3), match.group(4)) != (
            expected_page,
            expected_ordinal,
            digest,
        ):
            raise ValueError("source block ID must match page, ordinal, and text")
        if all(ord(character) in _SHARED_BLANK_CODE_POINTS for character in self.text):
            raise ValueError("source block text must not be blank")
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.text):
            raise ValueError("source block text contains an invalid surrogate")
        return self


class StoredExtractionQuality(FrozenContract):
    assessment: Literal["usable"]
    character_count: JsonInteger = Field(ge=1, le=100_000)
    block_count: JsonInteger = Field(ge=1, le=512)
    page_count: JsonInteger = Field(ge=1, le=50)
    reason_codes: tuple[()] = ()


class DocumentMetadata(FrozenContract):
    schema_version: Literal["1.0"]
    document_id: DocumentId
    merchant_id: DatabaseId
    content_sha256: Sha256
    mock: Literal[False]

    @model_validator(mode="after")
    def validate_document_id(self) -> DocumentMetadata:
        if self.document_id != f"doc-{self.content_sha256}":
            raise ValueError("document_id must be derived from content_sha256")
        return self


class ExtractionSummary(FrozenContract):
    schema_version: Literal["1.0"]
    document_id: DocumentId
    merchant_id: DatabaseId
    status: ExtractionStatus
    extraction_method: Literal["pdf_text", "gemini_vision"]
    model_id: Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]
    embedding_available: StrictBool
    mock: Literal[False]
    quality: Literal["usable"]
    character_count: JsonInteger = Field(ge=1, le=100_000)
    block_count: JsonInteger = Field(ge=1, le=512)
    page_count: JsonInteger = Field(ge=1, le=50)
    warnings: Annotated[tuple[StoredExtractionWarning, ...], Field(max_length=16)]
    snapshot_sha256: Sha256

    @model_validator(mode="after")
    def validate_warnings(self) -> ExtractionSummary:
        if len(self.warnings) != len(set(self.warnings)):
            raise ValueError("extraction warnings must be unique")
        _validate_usable_extraction_status(
            self.status,
            self.embedding_available,
            self.warnings,
        )
        return self


class StoredDocumentExtraction(FrozenContract):
    """Private, scoreable Phase 3 snapshot loaded by document_id and tenant."""

    schema_version: Literal["1.0"]
    merchant_id: DatabaseId
    document_id: DocumentId
    content_sha256: Sha256
    snapshot_sha256: Sha256
    status: ExtractionStatus
    text: Annotated[
        StrictStr,
        StringConstraints(min_length=1, max_length=100_000),
    ]
    source_blocks: Annotated[
        tuple[DocumentSourceBlock, ...],
        Field(min_length=1, max_length=512),
    ]
    extraction_method: Literal["pdf_text", "gemini_vision"]
    model_id: Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]
    embedding_available: StrictBool
    mock: Literal[False]
    warnings: Annotated[tuple[StoredExtractionWarning, ...], Field(max_length=16)]
    quality: StoredExtractionQuality

    @model_validator(mode="after")
    def validate_snapshot(self) -> StoredDocumentExtraction:
        document_match = _DOCUMENT_ID_RE.fullmatch(self.document_id)
        assert document_match is not None
        if document_match.group(1) != self.content_sha256:
            raise ValueError("document_id must be derived from content_sha256")
        if len(self.warnings) != len(set(self.warnings)):
            raise ValueError("document warnings must be unique")
        _validate_usable_extraction_status(
            self.status,
            self.embedding_available,
            self.warnings,
        )
        if tuple(block.ordinal for block in self.source_blocks) != tuple(
            range(1, len(self.source_blocks) + 1)
        ):
            raise ValueError("source block ordinals must be globally ordered from 1")
        for block in self.source_blocks:
            block_match = _SOURCE_BLOCK_ID_RE.fullmatch(block.source_block_id)
            assert block_match is not None
            if block_match.group(1) != self.content_sha256[:12]:
                raise ValueError("source block document hash must match content_sha256")
            if block.page_number is not None and block.page_number > self.quality.page_count:
                raise ValueError("source block page cannot exceed document page count")
        if "\n\n".join(block.text for block in self.source_blocks) != self.text:
            raise ValueError("source blocks must exactly reconstruct canonical text")
        if self.quality.character_count != len(self.text):
            raise ValueError("quality character_count must equal canonical text length")
        if self.quality.block_count != len(self.source_blocks):
            raise ValueError("quality block_count must equal source block count")

        canonical = self.model_dump(mode="json", exclude={"snapshot_sha256"})
        expected_snapshot = canonical_snapshot_sha256(canonical)
        if self.snapshot_sha256 != expected_snapshot:
            raise ValueError("snapshot_sha256 must match the canonical extraction snapshot")
        return self


class ResumeReviewRequest(FrozenContract):
    """Internal service request; merchant_id is injected by the trusted server."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        validate_default=True,
        populate_by_name=True,
    )

    schema_version: Literal["1.0"]
    request_id: DatabaseId = Field(alias="requestId")
    merchant_id: DatabaseId = Field(alias="merchantId")
    document_id: DocumentId = Field(alias="documentId")
    candidate_id: DatabaseId | None = Field(default=None, alias="candidateId")
    persist: StrictBool = False


class ResumeReviewResponse(FrozenContract):
    schema_version: Literal["1.0"]
    request_id: DatabaseId
    document_id: DocumentId
    status: ReviewStatus
    review_required: StrictBool
    agent1_evaluation: Agent1Evaluation | None
    questions_status: QuestionsStatus
    question_plan: Agent2QuestionPlan | None
    persistence_status: PersistenceStatus
    reason_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)]
    extraction_status: ExtractionStatus | None
    embedding_available: StrictBool

    @model_validator(mode="after")
    def validate_stage_consistency(self) -> ResumeReviewResponse:
        hard_agent1_failures = {
            "document_unavailable",
            "tenant_mismatch",
            "invalid_extraction",
            "document_instruction_detected",
            "no_active_roles",
            "active_roles_unavailable",
            "agent1_refused",
            "agent1_invalid_output",
            "agent1_provider_failed",
            "agent1_invalid_evidence",
            "score_calculation_failed",
        }
        if (self.questions_status is QuestionsStatus.COMPLETE) != (self.question_plan is not None):
            raise ValueError("question plan must match complete question status")
        if self.agent1_evaluation is None and self.questions_status is not QuestionsStatus.SKIPPED:
            raise ValueError("questions must be skipped when Agent 1 has no evaluation")
        if self.agent1_evaluation is not None and hard_agent1_failures.intersection(
            self.reason_codes
        ):
            raise ValueError("hard Agent 1 failures cannot include an evaluation")
        if self.agent1_evaluation is None and self.persistence_status not in {
            PersistenceStatus.SKIPPED,
            PersistenceStatus.NOT_REQUESTED,
        }:
            raise ValueError("invalid Agent 1 output cannot be persisted")
        if self.persistence_status is PersistenceStatus.SUCCEEDED and (
            self.agent1_evaluation is None
        ):
            raise ValueError("persistence cannot succeed without a validated evaluation")
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("reason_codes must be unique")
        if self.status is ReviewStatus.REVIEW_REQUIRED and not self.review_required:
            raise ValueError("review_required status requires review_required=true")
        if self.review_required and self.status is not ReviewStatus.REVIEW_REQUIRED:
            raise ValueError("review_required=true requires review_required status")
        return self


class PersistedReview(FrozenContract):
    review_id: DatabaseId
    replayed: StrictBool
