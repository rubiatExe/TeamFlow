from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import struct
import sys
import threading
import unicodedata
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Protocol

import pypdf
from pypdf import PdfReader
from pypdf.generic import ContentStream

from .contracts import (
    EMBEDDING_DIMENSIONS,
    MAX_EXTRACTED_CHARACTERS,
    MAX_SOURCE_BLOCK_CHARACTERS,
    SCHEMA_VERSION,
    DocumentExtractionResult,
    ExtractionMethod,
    ExtractionQuality,
    ExtractionStatus,
    ExtractionWarning,
    QualityAssessment,
    QualityReason,
    SourceBlock,
    is_shared_blank,
)

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 50
MAX_SOURCE_BLOCKS = 512
MAX_EMBEDDING_INPUT_CHARACTERS = 8_000
MIN_USABLE_NON_WHITESPACE_CHARACTERS = 40
MAX_CONTROL_CHARACTER_RATIO = 0.01
MAX_PDF_INSPECTION_OPERATIONS = 20_000
MAX_PDF_XOBJECT_DEPTH = 8
DEFAULT_OCR_TIMEOUT_SECONDS = 45.0
DEFAULT_EMBEDDING_TIMEOUT_SECONDS = 15.0
DEFAULT_PDF_TEXT_TIMEOUT_SECONDS = 8.0
MAX_PDF_WORKER_OUTPUT_BYTES = 1024 * 1024
SUPPORTED_MIME_TYPES = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/png",
    }
)
EMBEDDING_MODEL_ID = "models/gemini-embedding-001"
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9._/:-]{1,200}$")
_PDF_ADMISSION = threading.BoundedSemaphore(value=2)
_PDF_WORKER_PATH = Path(__file__).with_name("pdf_worker.py")


class UploadValidationError(ValueError):
    def __init__(self, code: str, status_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class DocumentStructureError(ValueError):
    def __init__(
        self,
        warning: ExtractionWarning,
        reason: QualityReason | None = None,
    ) -> None:
        super().__init__(warning.value)
        self.warning = warning
        self.reason = reason or (
            QualityReason.MALFORMED_DOCUMENT
            if warning is ExtractionWarning.MALFORMED_DOCUMENT
            else QualityReason.NO_SOURCE_BLOCKS
        )


class PdfParserBusyError(RuntimeError):
    pass


@dataclass(frozen=True)
class OcrProviderOutput:
    text: object
    model_id: str
    finish_reason: str


class DocumentProvider(Protocol):
    async def extract_text(self, content: bytes, mime_type: str) -> OcrProviderOutput: ...

    async def generate_embedding(self, text: str) -> object: ...


@dataclass(frozen=True)
class TextAssessment:
    text: str
    usable: bool
    reasons: tuple[QualityReason, ...]
    warning: ExtractionWarning | None


@dataclass
class _PdfInspectionBudget:
    operation_count: int = 0
    cumulative_image_area: float = 0.0


def normalize_mime_type(mime_type: str | None) -> str:
    return (mime_type or "").split(";", 1)[0].strip().lower()


def validate_document_upload(content: bytes, mime_type: str | None) -> str:
    normalized_mime = normalize_mime_type(mime_type)
    if normalized_mime not in SUPPORTED_MIME_TYPES:
        raise UploadValidationError("unsupported_mime", 415)
    if not content:
        raise UploadValidationError("empty_document", 422)
    if len(content) > MAX_DOCUMENT_BYTES:
        raise UploadValidationError("document_too_large", 413)

    detected_mime = _detect_mime_signature(content)
    if detected_mime != normalized_mime:
        raise UploadValidationError("mime_signature_mismatch", 415)
    return normalized_mime


def _detect_mime_signature(content: bytes) -> str | None:
    if content.startswith(b"%PDF-"):
        return "application/pdf"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    return None


def normalize_extracted_text(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def assess_extracted_text(value: object) -> TextAssessment:
    if not isinstance(value, str):
        return TextAssessment(
            text="",
            usable=False,
            reasons=(QualityReason.EMPTY_TEXT,),
            warning=ExtractionWarning.MALFORMED_EXTRACTION,
        )
    if len(value) > MAX_EXTRACTED_CHARACTERS:
        return TextAssessment(
            text="",
            usable=False,
            reasons=(QualityReason.TEXT_TOO_LARGE,),
            warning=ExtractionWarning.MALFORMED_EXTRACTION,
        )

    text = normalize_extracted_text(value)
    if not text:
        return TextAssessment(
            text="",
            usable=False,
            reasons=(QualityReason.EMPTY_TEXT,),
            warning=ExtractionWarning.EMPTY_EXTRACTION,
        )

    if any(unicodedata.category(character) == "Cs" for character in text):
        return TextAssessment(
            text="",
            usable=False,
            reasons=(QualityReason.EXCESSIVE_CONTROL_CHARACTERS,),
            warning=ExtractionWarning.MALFORMED_EXTRACTION,
        )
    dangerous_bidi = {
        *range(0x202A, 0x202F),
        *range(0x2066, 0x206A),
    }
    if any(ord(character) in dangerous_bidi for character in text):
        return TextAssessment(
            text="",
            usable=False,
            reasons=(QualityReason.EXCESSIVE_CONTROL_CHARACTERS,),
            warning=ExtractionWarning.MALFORMED_EXTRACTION,
        )
    if any(
        0xFDD0 <= ord(character) <= 0xFDEF or ord(character) & 0xFFFF in {0xFFFE, 0xFFFF}
        for character in text
    ):
        return TextAssessment(
            text="",
            usable=False,
            reasons=(QualityReason.EXCESSIVE_CONTROL_CHARACTERS,),
            warning=ExtractionWarning.MALFORMED_EXTRACTION,
        )
    replacement_count = text.count("\ufffd")
    if replacement_count / max(len(text), 1) > MAX_CONTROL_CHARACTER_RATIO:
        return TextAssessment(
            text="",
            usable=False,
            reasons=(QualityReason.EXCESSIVE_CONTROL_CHARACTERS,),
            warning=ExtractionWarning.MALFORMED_EXTRACTION,
        )
    control_count = sum(
        1
        for character in text
        if character not in "\n\t" and unicodedata.category(character) in {"Cc", "Cf"}
    )
    if control_count / max(len(text), 1) > MAX_CONTROL_CHARACTER_RATIO:
        return TextAssessment(
            text="",
            usable=False,
            reasons=(QualityReason.EXCESSIVE_CONTROL_CHARACTERS,),
            warning=ExtractionWarning.MALFORMED_EXTRACTION,
        )

    non_whitespace_count = sum(not character.isspace() for character in text)
    alphanumeric_count = sum(character.isalnum() for character in text)
    if non_whitespace_count < MIN_USABLE_NON_WHITESPACE_CHARACTERS or alphanumeric_count < 20:
        return TextAssessment(
            text=text,
            usable=False,
            reasons=(QualityReason.INSUFFICIENT_TEXT,),
            warning=None,
        )
    return TextAssessment(text=text, usable=True, reasons=(), warning=None)


def _split_source_text(text: str) -> tuple[str, ...]:
    paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n[ \t]*\n+", text)
        if paragraph.strip() and not is_shared_blank(paragraph.strip())
    ]
    blocks: list[str] = []
    for paragraph in paragraphs:
        remaining = paragraph
        while len(remaining) > MAX_SOURCE_BLOCK_CHARACTERS:
            split_at = remaining.rfind("\n", 0, MAX_SOURCE_BLOCK_CHARACTERS + 1)
            if split_at <= 0:
                split_at = MAX_SOURCE_BLOCK_CHARACTERS
            blocks.append(remaining[:split_at].strip())
            remaining = remaining[split_at:].strip()
        if remaining:
            blocks.append(remaining)
    if len(blocks) > MAX_SOURCE_BLOCKS:
        return _split_text_into_bounded_chunks(text)
    return tuple(blocks)


def _split_text_into_bounded_chunks(text: str) -> tuple[str, ...]:
    """Bound pathological paragraph counts without dropping canonical text."""
    chunks: list[str] = []
    remaining = text.strip()
    while remaining:
        if len(remaining) <= MAX_SOURCE_BLOCK_CHARACTERS:
            chunk = remaining
            remaining = ""
        else:
            split_at = remaining.rfind("\n\n", 0, MAX_SOURCE_BLOCK_CHARACTERS + 1)
            separator_length = 2
            if split_at <= 0:
                split_at = remaining.rfind("\n", 0, MAX_SOURCE_BLOCK_CHARACTERS + 1)
                separator_length = 1
            if split_at <= 0:
                split_at = MAX_SOURCE_BLOCK_CHARACTERS
                separator_length = 0
            chunk = remaining[:split_at].strip()
            remaining = remaining[split_at + separator_length :].strip()
        if chunk and not is_shared_blank(chunk):
            chunks.append(chunk)
    return tuple(chunks)


def build_source_blocks(
    text: str,
    *,
    content_hash: str,
    page_number: int | None,
    start_ordinal: int = 1,
) -> tuple[SourceBlock, ...]:
    blocks: list[SourceBlock] = []
    page_token = page_number or 0
    for offset, block_text in enumerate(_split_source_text(text)):
        ordinal = start_ordinal + offset
        block_digest = hashlib.sha256(
            f"{page_token}|{ordinal}|{block_text}".encode("utf-8")
        ).hexdigest()[:12]
        source_block_id = f"src-{content_hash[:12]}-p{page_token:04d}-b{ordinal:04d}-{block_digest}"
        blocks.append(
            SourceBlock(
                source_block_id=source_block_id,
                page_number=page_number,
                ordinal=ordinal,
                text=block_text,
            )
        )
    return tuple(blocks)


def verify_literal_evidence(
    source_blocks: tuple[SourceBlock, ...] | list[SourceBlock],
    source_block_id: str,
    exact_quote: str,
) -> bool:
    if not exact_quote:
        return False
    block = next(
        (item for item in source_blocks if item.source_block_id == source_block_id),
        None,
    )
    return block is not None and exact_quote in block.text


def _read_pdf_pages(
    content: bytes,
) -> tuple[tuple[str, ...], int, tuple[bool, ...]]:
    try:
        reader = PdfReader(BytesIO(content), strict=True)
        if reader.is_encrypted:
            raise DocumentStructureError(ExtractionWarning.ENCRYPTED_DOCUMENT)
        page_count = len(reader.pages)
        if page_count == 0:
            raise DocumentStructureError(ExtractionWarning.MALFORMED_DOCUMENT)
        if page_count > MAX_PDF_PAGES:
            raise DocumentStructureError(ExtractionWarning.PAGE_LIMIT_EXCEEDED)
        pages: list[str] = []
        pages_requiring_ocr: list[bool] = []
        retained_characters = 0
        nonempty_pages = 0
        for page in reader.pages:
            page_text = normalize_extracted_text(page.extract_text() or "")
            projected_characters = retained_characters + len(page_text)
            if page_text and nonempty_pages:
                projected_characters += 2
            if (
                len(page_text) > MAX_EXTRACTED_CHARACTERS
                or projected_characters > MAX_EXTRACTED_CHARACTERS
            ):
                raise DocumentStructureError(
                    ExtractionWarning.MALFORMED_EXTRACTION,
                    QualityReason.TEXT_TOO_LARGE,
                )
            pages.append(page_text)
            retained_characters = projected_characters
            if page_text:
                nonempty_pages += 1
            pages_requiring_ocr.append(_pdf_page_requires_ocr(page))
        return tuple(pages), page_count, tuple(pages_requiring_ocr)
    except DocumentStructureError:
        raise
    except Exception as exc:
        raise DocumentStructureError(ExtractionWarning.MALFORMED_DOCUMENT) from exc


def _resolve_pdf_object(value: Any) -> Any:
    get_object = getattr(value, "get_object", None)
    return get_object() if callable(get_object) else value


def _matrix_area_scale(matrix: object) -> float | None:
    if not isinstance(matrix, (list, tuple)) or len(matrix) != 6:
        return None
    try:
        a, b, c, d = (float(item) for item in matrix[:4])
    except (TypeError, ValueError, OverflowError):
        return None
    determinant = abs((a * d) - (b * c))
    return determinant if math.isfinite(determinant) else None


def _pdf_object_identity(reference: object, resolved: object) -> tuple[object, ...]:
    id_number = getattr(reference, "idnum", None)
    generation = getattr(reference, "generation", None)
    if isinstance(id_number, int) and isinstance(generation, int):
        return ("indirect", id_number, generation)
    return ("direct", id(resolved))


def _pdf_stream_requires_ocr(
    *,
    content_stream: object,
    resources: object,
    pdf: object,
    page_area: float,
    initial_area_scale: float,
    depth: int,
    active_xobjects: frozenset[tuple[object, ...]],
    budget: _PdfInspectionBudget,
) -> bool:
    if depth > MAX_PDF_XOBJECT_DEPTH:
        return True
    operations = getattr(content_stream, "operations", None)
    if operations is None:
        return True

    current_area_scale = initial_area_scale
    area_stack: list[float] = []
    for operands, operator in operations:
        budget.operation_count += 1
        if budget.operation_count > MAX_PDF_INSPECTION_OPERATIONS:
            return True
        if operator == b"q":
            area_stack.append(current_area_scale)
        elif operator == b"Q":
            if not area_stack:
                return True
            current_area_scale = area_stack.pop()
        elif operator == b"cm":
            area_multiplier = _matrix_area_scale(operands)
            if area_multiplier is None:
                return True
            current_area_scale *= area_multiplier
            if not math.isfinite(current_area_scale):
                return True
        elif operator == b"Tr" and operands:
            # Render modes 3 and 7 do not paint glyphs. pypdf still extracts
            # their text, so accepting it would allow an invisible decoy layer.
            try:
                if int(operands[0]) in {3, 7}:
                    return True
            except (TypeError, ValueError, OverflowError):
                return True
        elif operator == b"INLINE IMAGE":
            budget.cumulative_image_area += min(current_area_scale, page_area)
            if budget.cumulative_image_area / page_area >= 0.5:
                return True
        elif operator == b"Do":
            if not operands or not hasattr(resources, "get"):
                return True
            xobjects = _resolve_pdf_object(resources.get("/XObject"))
            if not hasattr(xobjects, "get"):
                return True
            reference = xobjects.get(operands[0])
            if reference is None:
                return True
            resolved = _resolve_pdf_object(reference)
            if not hasattr(resolved, "get"):
                return True
            subtype = resolved.get("/Subtype")
            if subtype == "/Image":
                budget.cumulative_image_area += min(current_area_scale, page_area)
                if budget.cumulative_image_area / page_area >= 0.5:
                    return True
                continue
            if subtype != "/Form":
                return True

            identity = _pdf_object_identity(reference, resolved)
            if identity in active_xobjects or depth == MAX_PDF_XOBJECT_DEPTH:
                return True
            form_matrix = resolved.get("/Matrix", [1, 0, 0, 1, 0, 0])
            form_area_scale = _matrix_area_scale(form_matrix)
            if form_area_scale is None:
                return True
            nested_area_scale = current_area_scale * form_area_scale
            if not math.isfinite(nested_area_scale):
                return True
            form_resources = _resolve_pdf_object(resolved.get("/Resources"))
            if not hasattr(form_resources, "get"):
                form_resources = resources
            try:
                form_stream = ContentStream(resolved, pdf)
            except Exception:
                return True
            if _pdf_stream_requires_ocr(
                content_stream=form_stream,
                resources=form_resources,
                pdf=pdf,
                page_area=page_area,
                initial_area_scale=nested_area_scale,
                depth=depth + 1,
                active_xobjects=active_xobjects | {identity},
                budget=budget,
            ):
                return True
    return bool(area_stack)


def _pdf_page_requires_ocr(page: Any) -> bool:
    """Detect image-backed or non-painting PDF text that must not be trusted."""
    resources = _resolve_pdf_object(page.get("/Resources"))
    try:
        media_box = page.mediabox
        crop_box = page.cropbox
        visible_left = max(float(media_box.left), float(crop_box.left))
        visible_bottom = max(float(media_box.bottom), float(crop_box.bottom))
        visible_right = min(float(media_box.right), float(crop_box.right))
        visible_top = min(float(media_box.top), float(crop_box.top))
        visible_width = visible_right - visible_left
        visible_height = visible_top - visible_bottom
        page_area = visible_width * visible_height
    except (AttributeError, TypeError, ValueError, OverflowError):
        return True
    if not math.isfinite(page_area) or page_area <= 0:
        return True
    content_stream = page.get_contents()
    if content_stream is None or not hasattr(resources, "get"):
        return True
    return _pdf_stream_requires_ocr(
        content_stream=content_stream,
        resources=resources,
        pdf=page.pdf,
        page_area=page_area,
        initial_area_scale=1.0,
        depth=0,
        active_xobjects=frozenset(),
        budget=_PdfInspectionBudget(),
    )


def _build_blocks_from_pages(
    pages: tuple[str, ...],
    *,
    content_hash: str,
) -> tuple[SourceBlock, ...]:
    blocks: list[SourceBlock] = []
    ordinal = 1
    for page_number, page_text in enumerate(pages, start=1):
        page_blocks = build_source_blocks(
            page_text,
            content_hash=content_hash,
            page_number=page_number,
            start_ordinal=ordinal,
        )
        blocks.extend(page_blocks)
        ordinal += len(page_blocks)
    return tuple(blocks)


async def _read_pdf_pages_with_budget(
    content: bytes,
    timeout_seconds: float,
) -> tuple[tuple[str, ...], int, tuple[bool, ...]]:
    if not _PDF_ADMISSION.acquire(blocking=False):
        raise PdfParserBusyError("pdf_parser_overloaded")
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            str(_PDF_WORKER_PATH),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={"LANG": "C.UTF-8"},
        )
        stdout, _stderr = await asyncio.wait_for(
            process.communicate(content), timeout=timeout_seconds
        )
    except BaseException:
        if process is not None and process.returncode is None:
            cleanup = asyncio.create_task(_terminate_pdf_worker(process))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await asyncio.shield(cleanup)
        raise
    finally:
        _PDF_ADMISSION.release()

    if process.returncode != 0 or len(stdout) > MAX_PDF_WORKER_OUTPUT_BYTES:
        raise DocumentStructureError(ExtractionWarning.MALFORMED_DOCUMENT)
    try:
        payload = json.loads(stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DocumentStructureError(ExtractionWarning.MALFORMED_DOCUMENT) from exc
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise DocumentStructureError(ExtractionWarning.MALFORMED_DOCUMENT)
    if payload.get("status") == "error":
        try:
            warning = ExtractionWarning(payload.get("warning"))
            reason = QualityReason(payload.get("reason"))
        except (TypeError, ValueError) as exc:
            raise DocumentStructureError(ExtractionWarning.MALFORMED_DOCUMENT) from exc
        raise DocumentStructureError(warning, reason)
    if payload.get("status") != "ok":
        raise DocumentStructureError(ExtractionWarning.MALFORMED_DOCUMENT)

    pages = payload.get("pages")
    page_count = payload.get("page_count")
    pages_requiring_ocr = payload.get("pages_requiring_ocr")
    if (
        not isinstance(pages, list)
        or not pages
        or len(pages) > MAX_PDF_PAGES
        or not all(isinstance(page, str) for page in pages)
        or isinstance(page_count, bool)
        or not isinstance(page_count, int)
        or page_count != len(pages)
        or not isinstance(pages_requiring_ocr, list)
        or len(pages_requiring_ocr) != page_count
        or not all(isinstance(value, bool) for value in pages_requiring_ocr)
        or len("\n\n".join(page for page in pages if page)) > MAX_EXTRACTED_CHARACTERS
    ):
        raise DocumentStructureError(ExtractionWarning.MALFORMED_DOCUMENT)
    return tuple(pages), page_count, tuple(pages_requiring_ocr)


async def _terminate_pdf_worker(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=0.5)
    except TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            return
        await process.wait()


def _quality(
    *,
    assessment: QualityAssessment,
    text: str,
    blocks: tuple[SourceBlock, ...],
    page_count: int,
    reasons: tuple[QualityReason, ...] = (),
) -> ExtractionQuality:
    return ExtractionQuality(
        assessment=assessment,
        character_count=len(text),
        block_count=len(blocks),
        page_count=page_count,
        reason_codes=reasons,
    )


def _unusable_result(
    *,
    content_hash: str,
    warning: ExtractionWarning,
    reason: QualityReason,
    mock: bool = False,
) -> DocumentExtractionResult:
    return DocumentExtractionResult(
        schema_version=SCHEMA_VERSION,
        document_id=f"doc-{content_hash}",
        status=ExtractionStatus.MOCK if mock else ExtractionStatus.FAILED,
        markdown="",
        text="",
        source_blocks=(),
        embedding=None,
        extraction_method=ExtractionMethod.MOCK if mock else ExtractionMethod.NONE,
        model_id=None,
        embedding_model_id=None,
        content_sha256=content_hash,
        mock=mock,
        warnings=(warning,),
        quality=_quality(
            assessment=QualityAssessment.UNUSABLE,
            text="",
            blocks=(),
            page_count=0,
            reasons=(reason,),
        ),
    )


def _validate_embedding(value: object) -> tuple[float, ...] | None:
    if not isinstance(value, (list, tuple)) or len(value) != EMBEDDING_DIMENSIONS:
        return None
    embedding: list[float] = []
    has_nonzero_float32 = False
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            return None
        number = float(item)
        if not math.isfinite(number):
            return None
        try:
            float32 = struct.unpack("!f", struct.pack("!f", number))[0]
        except OverflowError:
            return None
        if not math.isfinite(float32):
            return None
        has_nonzero_float32 = has_nonzero_float32 or float32 != 0.0
        embedding.append(number)
    return tuple(embedding) if has_nonzero_float32 else None


class DocumentExtractionService:
    def __init__(
        self,
        provider: DocumentProvider | None,
        *,
        mock_mode: bool = False,
        ocr_timeout_seconds: float = DEFAULT_OCR_TIMEOUT_SECONDS,
        embedding_timeout_seconds: float = DEFAULT_EMBEDDING_TIMEOUT_SECONDS,
        pdf_text_timeout_seconds: float = DEFAULT_PDF_TEXT_TIMEOUT_SECONDS,
        embedding_model_id: str = EMBEDDING_MODEL_ID,
    ) -> None:
        self._provider = provider
        self._mock_mode = mock_mode
        self._ocr_timeout_seconds = ocr_timeout_seconds
        self._embedding_timeout_seconds = embedding_timeout_seconds
        self._pdf_text_timeout_seconds = pdf_text_timeout_seconds
        self._embedding_model_id = embedding_model_id

    async def extract(self, content: bytes, mime_type: str | None) -> DocumentExtractionResult:
        normalized_mime = validate_document_upload(content, mime_type)
        content_hash = hashlib.sha256(content).hexdigest()
        if self._mock_mode:
            return _unusable_result(
                content_hash=content_hash,
                warning=ExtractionWarning.MOCK_MODE_ENABLED,
                reason=QualityReason.MOCK_RESULT,
                mock=True,
            )

        page_count = 1
        extraction_method = ExtractionMethod.GEMINI_VISION
        model_id: str | None = None
        warnings: list[ExtractionWarning] = []
        source_blocks: tuple[SourceBlock, ...] = ()
        text = ""

        if normalized_mime == "application/pdf":
            try:
                pages, page_count, pages_requiring_ocr = await _read_pdf_pages_with_budget(
                    content,
                    self._pdf_text_timeout_seconds,
                )
            except TimeoutError:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.PDF_TEXT_TIMEOUT,
                    reason=QualityReason.MALFORMED_DOCUMENT,
                )
            except PdfParserBusyError:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.PDF_TEXT_OVERLOADED,
                    reason=QualityReason.NO_SOURCE_BLOCKS,
                )
            except DocumentStructureError as exc:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=exc.warning,
                    reason=exc.reason,
                )

            page_assessments = tuple(assess_extracted_text(page) for page in pages)
            deterministic_text = "\n\n".join(page for page in pages if page)
            document_assessment = assess_extracted_text(deterministic_text)
            malformed_assessment = next(
                (
                    assessment
                    for assessment in (*page_assessments, document_assessment)
                    if assessment.warning is ExtractionWarning.MALFORMED_EXTRACTION
                ),
                None,
            )
            if malformed_assessment is not None:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.MALFORMED_EXTRACTION,
                    reason=malformed_assessment.reasons[0],
                )
            # A document-wide text threshold can hide image-only pages in a mixed PDF.
            # Use deterministic extraction only when every page has usable text.
            if (
                not any(pages_requiring_ocr)
                and document_assessment.usable
                and all(assessment.usable for assessment in page_assessments)
            ):
                source_blocks = _build_blocks_from_pages(pages, content_hash=content_hash)
                if len(source_blocks) > MAX_SOURCE_BLOCKS:
                    source_blocks = build_source_blocks(
                        document_assessment.text,
                        content_hash=content_hash,
                        page_number=None,
                    )
                if source_blocks:
                    text = "\n\n".join(block.text for block in source_blocks)
                    extraction_method = ExtractionMethod.PDF_TEXT
                    model_id = f"pypdf-{pypdf.__version__}"
            if not text:
                warnings.append(ExtractionWarning.OCR_REQUIRED)

        if not text:
            if self._provider is None:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.PROVIDER_UNAVAILABLE,
                    reason=QualityReason.NO_SOURCE_BLOCKS,
                )
            try:
                provider_output = await asyncio.wait_for(
                    self._provider.extract_text(content, normalized_mime),
                    timeout=self._ocr_timeout_seconds,
                )
            except TimeoutError:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.OCR_PROVIDER_TIMEOUT,
                    reason=QualityReason.NO_SOURCE_BLOCKS,
                )
            except Exception:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.OCR_PROVIDER_FAILED,
                    reason=QualityReason.NO_SOURCE_BLOCKS,
                )

            provider_text = getattr(provider_output, "text", None)
            provider_model_id = getattr(provider_output, "model_id", None)
            provider_finish_reason = getattr(provider_output, "finish_reason", None)
            if provider_finish_reason != "STOP":
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.OCR_RESPONSE_INCOMPLETE,
                    reason=QualityReason.NO_SOURCE_BLOCKS,
                )
            assessment = assess_extracted_text(provider_text)
            if not assessment.usable:
                warning = assessment.warning or ExtractionWarning.MALFORMED_EXTRACTION
                return _unusable_result(
                    content_hash=content_hash,
                    warning=warning,
                    reason=assessment.reasons[0],
                )
            if not isinstance(provider_model_id, str) or not _MODEL_ID_RE.fullmatch(
                provider_model_id
            ):
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.MALFORMED_EXTRACTION,
                    reason=QualityReason.NO_SOURCE_BLOCKS,
                )

            block_page = 1 if page_count == 1 else None
            try:
                source_blocks = build_source_blocks(
                    assessment.text,
                    content_hash=content_hash,
                    page_number=block_page,
                )
            except ValueError:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.MALFORMED_EXTRACTION,
                    reason=QualityReason.NO_SOURCE_BLOCKS,
                )
            if not source_blocks:
                return _unusable_result(
                    content_hash=content_hash,
                    warning=ExtractionWarning.MALFORMED_EXTRACTION,
                    reason=QualityReason.NO_SOURCE_BLOCKS,
                )
            text = "\n\n".join(block.text for block in source_blocks)
            extraction_method = ExtractionMethod.GEMINI_VISION
            model_id = provider_model_id

        embedding: tuple[float, ...] | None = None
        if self._provider is not None:
            embedding_input = text
            if len(embedding_input) > MAX_EMBEDDING_INPUT_CHARACTERS:
                embedding_input = embedding_input[:MAX_EMBEDDING_INPUT_CHARACTERS]
                warnings.append(ExtractionWarning.EMBEDDING_INPUT_TRUNCATED)
            try:
                raw_embedding = await asyncio.wait_for(
                    self._provider.generate_embedding(embedding_input),
                    timeout=self._embedding_timeout_seconds,
                )
                embedding = _validate_embedding(raw_embedding)
            except Exception:
                embedding = None

        status = ExtractionStatus.COMPLETE
        if embedding is None:
            status = ExtractionStatus.DEGRADED
            warnings.append(ExtractionWarning.EMBEDDING_FAILED)

        try:
            return DocumentExtractionResult(
                schema_version=SCHEMA_VERSION,
                document_id=f"doc-{content_hash}",
                status=status,
                markdown=text,
                text=text,
                source_blocks=source_blocks,
                embedding=embedding,
                extraction_method=extraction_method,
                model_id=model_id,
                embedding_model_id=self._embedding_model_id if embedding is not None else None,
                content_sha256=content_hash,
                mock=False,
                warnings=tuple(dict.fromkeys(warnings)),
                quality=_quality(
                    assessment=QualityAssessment.USABLE,
                    text=text,
                    blocks=source_blocks,
                    page_count=page_count,
                ),
            )
        except ValueError:
            return _unusable_result(
                content_hash=content_hash,
                warning=ExtractionWarning.MALFORMED_EXTRACTION,
                reason=QualityReason.NO_SOURCE_BLOCKS,
            )
