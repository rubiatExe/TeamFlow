from __future__ import annotations

import hashlib
import math
import re
import struct
from enum import Enum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    StringConstraints,
    model_validator,
)

SCHEMA_VERSION = "1.0"
EMBEDDING_DIMENSIONS = 768
MAX_EXTRACTED_CHARACTERS = 100_000
MAX_SOURCE_BLOCK_CHARACTERS = 4_000
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

BoundedModelId = Annotated[
    StrictStr,
    StringConstraints(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._/:-]+$"),
]
Sha256 = Annotated[StrictStr, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


def _normalize_finite_number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("embedding value must be a JSON number")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError("embedding value must be finite") from exc
    if not math.isfinite(number):
        raise ValueError("embedding value must be finite")
    try:
        float32 = struct.unpack("!f", struct.pack("!f", number))[0]
    except OverflowError as exc:
        raise ValueError("embedding value must be representable as float32") from exc
    if not math.isfinite(float32):
        raise ValueError("embedding value must be representable as finite float32")
    return number


FiniteNumber = Annotated[float, BeforeValidator(_normalize_finite_number)]


def _normalize_json_integer(value: object) -> int:
    if isinstance(value, bool):
        raise ValueError("value must be a JSON integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    raise ValueError("value must be a JSON integer")


JsonInteger = Annotated[int, BeforeValidator(_normalize_json_integer)]


def is_shared_blank(value: str) -> bool:
    return not value or all(ord(character) in _SHARED_BLANK_CODE_POINTS for character in value)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, validate_default=True)


class ExtractionStatus(str, Enum):
    COMPLETE = "complete"
    DEGRADED = "degraded"
    FAILED = "failed"
    MOCK = "mock"


class ExtractionMethod(str, Enum):
    PDF_TEXT = "pdf_text"
    GEMINI_VISION = "gemini_vision"
    NONE = "none"
    MOCK = "mock"


class QualityAssessment(str, Enum):
    USABLE = "usable"
    UNUSABLE = "unusable"


class ExtractionWarning(str, Enum):
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


class QualityReason(str, Enum):
    EMPTY_TEXT = "empty_text"
    INSUFFICIENT_TEXT = "insufficient_text"
    EXCESSIVE_CONTROL_CHARACTERS = "excessive_control_characters"
    TEXT_TOO_LARGE = "text_too_large"
    NO_SOURCE_BLOCKS = "no_source_blocks"
    MALFORMED_DOCUMENT = "malformed_document"
    MOCK_RESULT = "mock_result"


class SourceBlock(StrictModel):
    source_block_id: Annotated[
        StrictStr,
        StringConstraints(pattern=(r"^src-[0-9a-f]{12}-p[0-9]{4}-b[0-9]{4}-[0-9a-f]{12}$")),
    ]
    page_number: Annotated[JsonInteger, Field(ge=1, le=9_999)] | None
    ordinal: Annotated[JsonInteger, Field(ge=1, le=9_999)]
    text: Annotated[
        StrictStr,
        StringConstraints(min_length=1, max_length=MAX_SOURCE_BLOCK_CHARACTERS),
    ]

    @model_validator(mode="after")
    def validate_identifier_coordinates(self) -> SourceBlock:
        match = _SOURCE_BLOCK_ID_RE.fullmatch(self.source_block_id)
        if not match:
            raise ValueError("invalid source block ID")
        encoded_page = int(match.group(2))
        expected_page = self.page_number or 0
        if encoded_page != expected_page or int(match.group(3)) != self.ordinal:
            raise ValueError("source block ID does not match page/ordinal")
        if is_shared_blank(self.text):
            raise ValueError("source block text must not be blank")
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.text):
            raise ValueError("source block text contains an invalid surrogate")
        expected_digest = hashlib.sha256(
            f"{expected_page}|{self.ordinal}|{self.text}".encode("utf-8")
        ).hexdigest()[:12]
        if match.group(4) != expected_digest:
            raise ValueError("source block ID digest does not match block text")
        return self


class ExtractionQuality(StrictModel):
    assessment: QualityAssessment
    character_count: Annotated[JsonInteger, Field(ge=0, le=MAX_EXTRACTED_CHARACTERS)]
    block_count: Annotated[JsonInteger, Field(ge=0, le=512)]
    page_count: Annotated[JsonInteger, Field(ge=0, le=50)]
    reason_codes: tuple[QualityReason, ...] = Field(max_length=8)

    @model_validator(mode="after")
    def validate_reason_codes(self) -> ExtractionQuality:
        if len(set(self.reason_codes)) != len(self.reason_codes):
            raise ValueError("quality reason codes must be unique")
        if self.assessment is QualityAssessment.USABLE and self.reason_codes:
            raise ValueError("usable quality must not contain failure reasons")
        if self.assessment is QualityAssessment.UNUSABLE and not self.reason_codes:
            raise ValueError("unusable quality requires a reason code")
        return self


class DocumentExtractionResult(StrictModel):
    schema_version: Literal[SCHEMA_VERSION]
    document_id: Annotated[
        StrictStr,
        StringConstraints(pattern=r"^doc-[0-9a-f]{64}$"),
    ]
    status: ExtractionStatus
    markdown: Annotated[
        StrictStr,
        StringConstraints(max_length=MAX_EXTRACTED_CHARACTERS),
    ]
    text: Annotated[
        StrictStr,
        StringConstraints(max_length=MAX_EXTRACTED_CHARACTERS),
    ]
    source_blocks: tuple[SourceBlock, ...] = Field(max_length=512)
    embedding: tuple[FiniteNumber, ...] | None
    extraction_method: ExtractionMethod
    model_id: BoundedModelId | None
    embedding_model_id: BoundedModelId | None
    content_sha256: Sha256
    mock: StrictBool
    warnings: tuple[ExtractionWarning, ...] = Field(max_length=16)
    quality: ExtractionQuality

    @model_validator(mode="after")
    def validate_result_invariants(self) -> DocumentExtractionResult:
        document_match = _DOCUMENT_ID_RE.fullmatch(self.document_id)
        if not document_match or document_match.group(1) != self.content_sha256:
            raise ValueError("document_id must be derived from content_sha256")
        if len(set(self.warnings)) != len(self.warnings):
            raise ValueError("warnings must be unique")
        if self.markdown != self.text:
            raise ValueError("markdown and canonical text must match in schema v1")
        if self.quality.character_count != len(self.text):
            raise ValueError("quality character count does not match text")
        if self.quality.block_count != len(self.source_blocks):
            raise ValueError("quality block count does not match source blocks")

        block_ids = [block.source_block_id for block in self.source_blocks]
        if len(set(block_ids)) != len(block_ids):
            raise ValueError("source block IDs must be unique")
        for expected_ordinal, block in enumerate(self.source_blocks, start=1):
            if block.ordinal != expected_ordinal:
                raise ValueError("source blocks must use contiguous canonical ordinals")
            match = _SOURCE_BLOCK_ID_RE.fullmatch(block.source_block_id)
            if not match or match.group(1) != self.content_sha256[:12]:
                raise ValueError("source block ID does not match document content hash")
            if block.page_number is not None and block.page_number > self.quality.page_count:
                raise ValueError("source block page exceeds the document page count")

        reconstructed_text = "\n\n".join(block.text for block in self.source_blocks)
        if reconstructed_text != self.text:
            raise ValueError("source blocks must exactly reconstruct canonical text")

        if self.embedding is not None:
            if len(self.embedding) != EMBEDDING_DIMENSIONS:
                raise ValueError("embedding must contain exactly 768 values")
            if any(isinstance(value, bool) or not math.isfinite(value) for value in self.embedding):
                raise ValueError("embedding values must be finite numbers")
            if not any(
                struct.unpack("!f", struct.pack("!f", value))[0] != 0.0 for value in self.embedding
            ):
                raise ValueError("embedding must not collapse to a zero vector")
            if self.embedding_model_id is None:
                raise ValueError("embedding model ID is required with an embedding")
        elif self.embedding_model_id is not None:
            raise ValueError("embedding model ID requires an embedding")

        if self.status in {ExtractionStatus.COMPLETE, ExtractionStatus.DEGRADED}:
            self._validate_usable_result()
        else:
            self._validate_unusable_result()

        if self.status is ExtractionStatus.COMPLETE and self.embedding is None:
            raise ValueError("complete extraction requires a valid embedding")
        if (
            self.status is ExtractionStatus.COMPLETE
            and ExtractionWarning.EMBEDDING_FAILED in self.warnings
        ):
            raise ValueError("complete extraction cannot report an embedding failure")
        if self.status is ExtractionStatus.DEGRADED:
            if (
                self.embedding is not None
                or ExtractionWarning.EMBEDDING_FAILED not in self.warnings
            ):
                raise ValueError("degraded extraction must record an embedding failure")
        return self

    def _validate_usable_result(self) -> None:
        if self.mock or self.quality.assessment is not QualityAssessment.USABLE:
            raise ValueError("usable extraction cannot be mock or unusable")
        if is_shared_blank(self.text) or not self.source_blocks or self.quality.page_count < 1:
            raise ValueError("usable extraction requires text, blocks, and pages")
        if self.extraction_method not in {
            ExtractionMethod.PDF_TEXT,
            ExtractionMethod.GEMINI_VISION,
        }:
            raise ValueError("usable extraction requires a real extraction method")
        if self.model_id is None:
            raise ValueError("usable extraction requires extraction model provenance")
        failure_warnings = {
            ExtractionWarning.MALFORMED_DOCUMENT,
            ExtractionWarning.ENCRYPTED_DOCUMENT,
            ExtractionWarning.PAGE_LIMIT_EXCEEDED,
            ExtractionWarning.PDF_TEXT_TIMEOUT,
            ExtractionWarning.PDF_TEXT_OVERLOADED,
            ExtractionWarning.OCR_PROVIDER_FAILED,
            ExtractionWarning.OCR_PROVIDER_TIMEOUT,
            ExtractionWarning.OCR_RESPONSE_INCOMPLETE,
            ExtractionWarning.PROVIDER_UNAVAILABLE,
            ExtractionWarning.EMPTY_EXTRACTION,
            ExtractionWarning.MALFORMED_EXTRACTION,
            ExtractionWarning.MOCK_MODE_ENABLED,
        }
        if failure_warnings.intersection(self.warnings):
            raise ValueError("usable extraction cannot contain a failure warning")

    def _validate_unusable_result(self) -> None:
        expected_mock = self.status is ExtractionStatus.MOCK
        if self.mock is not expected_mock:
            raise ValueError("mock flag and status disagree")
        expected_method = ExtractionMethod.MOCK if expected_mock else ExtractionMethod.NONE
        if self.extraction_method is not expected_method:
            raise ValueError("failed/mock extraction method is invalid")
        if self.model_id is not None:
            raise ValueError("failed/mock extraction must not claim a model")
        if self.text or self.source_blocks or self.embedding is not None:
            raise ValueError("failed/mock extraction must not contain candidate evidence")
        if self.quality.assessment is not QualityAssessment.UNUSABLE:
            raise ValueError("failed/mock extraction must be unusable")
        if any(
            (
                self.quality.character_count,
                self.quality.block_count,
                self.quality.page_count,
            )
        ):
            raise ValueError("failed/mock quality counts must be zero")
        if not self.warnings:
            raise ValueError("failed/mock extraction requires a warning")
        if expected_mock and ExtractionWarning.MOCK_MODE_ENABLED not in self.warnings:
            raise ValueError("mock extraction requires the mock-mode warning")
        if not expected_mock and ExtractionWarning.MOCK_MODE_ENABLED in self.warnings:
            raise ValueError("failed extraction cannot claim mock mode")
