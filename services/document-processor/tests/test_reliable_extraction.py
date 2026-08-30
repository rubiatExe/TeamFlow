import asyncio
import hashlib
import io
import json
import math
import sys
from pathlib import Path

import pytest

SERVICE_DIR = Path(__file__).resolve().parents[1]
FIXTURE_DIR = Path(__file__).parent / "fixtures"
SHARED_FIXTURE = SERVICE_DIR.parents[1] / "tests" / "fixtures" / "document-extraction-v1.json"
sys.path.insert(0, str(SERVICE_DIR))

from teamflow_document_processor.contracts import (  # noqa: E402
    DocumentExtractionResult,
    ExtractionMethod,
    ExtractionStatus,
    QualityAssessment,
)
from teamflow_document_processor.extraction import (  # noqa: E402
    MAX_DOCUMENT_BYTES,
    DocumentExtractionService,
    OcrProviderOutput,
    UploadValidationError,
    build_source_blocks,
    validate_document_upload,
    verify_literal_evidence,
)


class FakeProvider:
    def __init__(
        self,
        *,
        text: object = "# Morgan Lee\nHarbor Cafe\n2021-2024\nmorgan.lee@example.test\n202-555-0188",
        embedding: object = None,
        extraction_error: Exception | None = None,
        embedding_error: Exception | None = None,
        delay_seconds: float = 0,
        model_id: str = "gemini-test-vision",
        finish_reason: str = "STOP",
    ) -> None:
        self.text = text
        self.embedding = [0.01] * 768 if embedding is None else embedding
        self.extraction_error = extraction_error
        self.embedding_error = embedding_error
        self.delay_seconds = delay_seconds
        self.model_id = model_id
        self.finish_reason = finish_reason
        self.extract_calls = 0
        self.embedding_calls = 0
        self.embedding_inputs: list[str] = []

    async def extract_text(self, content: bytes, mime_type: str) -> OcrProviderOutput:
        self.extract_calls += 1
        if self.delay_seconds:
            await asyncio.sleep(self.delay_seconds)
        if self.extraction_error:
            raise self.extraction_error
        return OcrProviderOutput(
            text=self.text,
            model_id=self.model_id,
            finish_reason=self.finish_reason,
        )

    async def generate_embedding(self, text: str) -> object:
        self.embedding_calls += 1
        self.embedding_inputs.append(text)
        if self.embedding_error:
            raise self.embedding_error
        return self.embedding


def fixture_bytes(name: str) -> bytes:
    return (FIXTURE_DIR / name).read_bytes()


def fixture_manifest() -> dict[str, object]:
    return json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))


def scanned_pdf_with_visible_decoy(attack_kind: str) -> bytes:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import (
        ArrayObject,
        DecodedStreamObject,
        DictionaryObject,
        NameObject,
        NumberObject,
        RectangleObject,
    )

    reader = PdfReader(io.BytesIO(fixture_bytes("scanned-resume.pdf")), strict=True)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    page = writer.pages[0]
    decoy = (
        b"BT /F1 12 Tf 10 10 Td "
        b"(Decoy ordinary text with enough characters to pass the text gate 1234567890) "
        b"Tj ET"
    )

    if attack_kind == "nested_form":
        old_resources = page.raw_get("/Resources")
        old_resolved_resources = page["/Resources"].get_object()
        form = DecodedStreamObject()
        form.set_data(page.get_contents().get_data())
        form[NameObject("/Type")] = NameObject("/XObject")
        form[NameObject("/Subtype")] = NameObject("/Form")
        form[NameObject("/FormType")] = NumberObject(1)
        form[NameObject("/BBox")] = RectangleObject([0, 0, 612, 792])
        form[NameObject("/Resources")] = old_resources
        form_ref = writer._add_object(form)
        page[NameObject("/Resources")] = DictionaryObject(
            {
                NameObject("/Font"): old_resolved_resources.raw_get("/Font"),
                NameObject("/XObject"): DictionaryObject({NameObject("/FmScan"): form_ref}),
            }
        )
        content = DecodedStreamObject()
        content.set_data(b"q /FmScan Do Q " + decoy)
        page[NameObject("/Contents")] = writer._add_object(content)
    elif attack_kind == "inline_image":
        content = DecodedStreamObject()
        content.set_data(
            b"q 612 0 0 792 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x00\x00\x00 EI Q " + decoy
        )
        page[NameObject("/Contents")] = writer._add_object(content)
    elif attack_kind == "visible_crop":
        original_contents = page.raw_get("/Contents")
        decoy_stream = DecodedStreamObject()
        decoy_stream.set_data(decoy)
        page[NameObject("/Contents")] = ArrayObject(
            [original_contents, writer._add_object(decoy_stream)]
        )
        page[NameObject("/MediaBox")] = RectangleObject([0, 0, 1224, 1584])
        page[NameObject("/CropBox")] = RectangleObject([0, 0, 612, 792])
    elif attack_kind == "tiled_images":
        xobjects = page["/Resources"]["/XObject"].get_object()
        image_name = str(next(iter(xobjects))).encode("ascii")
        placements = b" ".join(
            b"q 306 0 0 396 %d %d cm %s Do Q" % (x, y, image_name)
            for x, y in ((0, 0), (306, 0), (0, 396), (306, 396))
        )
        content = DecodedStreamObject()
        content.set_data(placements + b" " + decoy)
        page[NameObject("/Contents")] = writer._add_object(content)
    else:
        raise AssertionError(f"unsupported attack_kind: {attack_kind}")

    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def compressed_pdf_text_bomb(character_count: int = 200_000) -> bytes:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, DecodedStreamObject, NameObject

    reader = PdfReader(io.BytesIO(fixture_bytes("digital-resume.pdf")), strict=True)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    page = writer.pages[0]
    original_contents = page.raw_get("/Contents")
    expanded_text = DecodedStreamObject()
    expanded_text.set_data(b"BT /F1 12 Tf 10 10 Td (" + (b"A" * character_count) + b") Tj ET")
    compressed_ref = writer._add_object(expanded_text.flate_encode())
    page[NameObject("/Contents")] = ArrayObject([original_contents, compressed_ref])
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def test_shared_v1_fixture_round_trips_through_python_contract():
    raw = SHARED_FIXTURE.read_text(encoding="utf-8")
    expected = json.loads(raw)
    parsed = DocumentExtractionResult.model_validate_json(raw)
    assert parsed.model_dump(mode="json") == expected
    assert parsed.status is ExtractionStatus.DEGRADED
    assert parsed.mock is False


def test_digital_pdf_prefers_deterministic_text_and_preserves_critical_fields():
    provider = FakeProvider()
    content = fixture_bytes("digital-resume.pdf")

    result = asyncio.run(DocumentExtractionService(provider).extract(content, "application/pdf"))

    assert result.status is ExtractionStatus.COMPLETE
    assert result.extraction_method is ExtractionMethod.PDF_TEXT
    assert result.mock is False
    assert result.quality.assessment is QualityAssessment.USABLE
    assert provider.extract_calls == 0
    assert provider.embedding_calls == 1
    assert len(result.embedding or []) == 768
    for expected in fixture_manifest()["files"]["digital-resume.pdf"]["critical_text"]:
        assert expected in result.text


def test_scanned_pdf_uses_bounded_ocr_and_builds_groundable_blocks():
    provider = FakeProvider()
    content = fixture_bytes("scanned-resume.pdf")

    result = asyncio.run(DocumentExtractionService(provider).extract(content, "application/pdf"))

    assert result.status is ExtractionStatus.COMPLETE
    assert result.extraction_method is ExtractionMethod.GEMINI_VISION
    assert provider.extract_calls == 1
    assert provider.embedding_calls == 1
    assert result.source_blocks
    for expected in fixture_manifest()["files"]["scanned-resume.pdf"]["critical_text"]:
        assert expected in result.text
    assert verify_literal_evidence(
        result.source_blocks,
        result.source_blocks[0].source_block_id,
        "Morgan Lee",
    )
    assert not verify_literal_evidence(
        result.source_blocks,
        result.source_blocks[0].source_block_id,
        "morgan lee",
    )


def test_mixed_text_and_scanned_pdf_routes_whole_document_to_ocr():
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    writer.add_page(PdfReader(io.BytesIO(fixture_bytes("digital-resume.pdf"))).pages[0])
    writer.add_page(PdfReader(io.BytesIO(fixture_bytes("scanned-resume.pdf"))).pages[0])
    output = io.BytesIO()
    writer.write(output)
    provider = FakeProvider(
        text="Jordan Rivera\nNorthstar Cafe\nMorgan Lee\nHarbor Cafe\n2021-2024"
    )

    result = asyncio.run(
        DocumentExtractionService(provider).extract(output.getvalue(), "application/pdf")
    )

    assert result.status is ExtractionStatus.COMPLETE
    assert result.extraction_method is ExtractionMethod.GEMINI_VISION
    assert result.quality.page_count == 2
    assert provider.extract_calls == 1
    assert "Morgan Lee" in result.text
    assert not verify_literal_evidence(
        result.source_blocks,
        "src-unknown-p0001-b0001",
        "Morgan Lee",
    )


def test_digital_pdf_with_invisible_decoy_text_cannot_bypass_ocr():
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, DecodedStreamObject, NameObject

    # Start from the text-only fixture so this test isolates non-painting text;
    # image-dominance routing is exercised separately below.
    reader = PdfReader(io.BytesIO(fixture_bytes("digital-resume.pdf")), strict=True)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    page = writer.pages[0]
    original_contents = page.raw_get("/Contents")
    invisible_text = DecodedStreamObject()
    invisible_text.set_data(
        b"BT /F1 12 Tf 3 Tr 10 10 Td "
        b"(Decoy digital layer with enough characters to pass the text gate 1234567890) "
        b"Tj ET"
    )
    invisible_text_ref = writer._add_object(invisible_text)
    page[NameObject("/Contents")] = ArrayObject([original_contents, invisible_text_ref])
    output = io.BytesIO()
    writer.write(output)
    attacked_pdf = output.getvalue()
    assert "Decoy digital layer" in (
        PdfReader(io.BytesIO(attacked_pdf), strict=True).pages[0].extract_text() or ""
    )
    provider = FakeProvider()

    result = asyncio.run(
        DocumentExtractionService(provider).extract(attacked_pdf, "application/pdf")
    )

    assert result.status is ExtractionStatus.COMPLETE
    assert result.extraction_method is ExtractionMethod.GEMINI_VISION
    assert provider.extract_calls == 1
    assert "Morgan Lee" in result.text
    assert "Decoy digital layer" not in result.text


@pytest.mark.parametrize(
    "attack_kind",
    ["nested_form", "inline_image", "visible_crop", "tiled_images"],
)
def test_image_backed_pdf_decoys_cannot_bypass_ocr(attack_kind):
    from pypdf import PdfReader

    attacked_pdf = scanned_pdf_with_visible_decoy(attack_kind)
    assert "Decoy ordinary text" in (
        PdfReader(io.BytesIO(attacked_pdf), strict=True).pages[0].extract_text() or ""
    )
    provider = FakeProvider()

    result = asyncio.run(
        DocumentExtractionService(provider).extract(attacked_pdf, "application/pdf")
    )

    assert result.status is ExtractionStatus.COMPLETE
    assert result.extraction_method is ExtractionMethod.GEMINI_VISION
    assert provider.extract_calls == 1
    assert "Morgan Lee" in result.text
    assert "Decoy ordinary text" not in result.text


def test_corrupted_pdf_fails_closed_without_ocr_or_embedding():
    provider = FakeProvider()
    result = asyncio.run(
        DocumentExtractionService(provider).extract(
            fixture_bytes("corrupt-truncated.pdf"),
            "application/pdf",
        )
    )

    assert result.status is ExtractionStatus.FAILED
    assert result.markdown == ""
    assert result.text == ""
    assert result.source_blocks == ()
    assert result.embedding is None
    assert "malformed_document" in result.warnings
    assert provider.extract_calls == 0
    assert provider.embedding_calls == 0


def test_fixture_hashes_and_scanned_fixture_text_layer_are_locked():
    from pypdf import PdfReader

    manifest = fixture_manifest()
    for filename, expected in manifest["files"].items():
        content = fixture_bytes(filename)
        assert hashlib.sha256(content).hexdigest() == expected["sha256"]

    reader = PdfReader(FIXTURE_DIR / "scanned-resume.pdf", strict=True)
    assert all(not (page.extract_text() or "").strip() for page in reader.pages)


def test_upload_validation_enforces_mime_signature_and_bytes():
    pdf = fixture_bytes("digital-resume.pdf")
    validate_document_upload(pdf, "application/pdf")
    validate_document_upload(b"%PDF-1.7\n" + b"x" * (MAX_DOCUMENT_BYTES - 9), "application/pdf")

    with pytest.raises(UploadValidationError, match="unsupported_mime"):
        validate_document_upload(pdf, "application/msword")
    with pytest.raises(UploadValidationError, match="mime_signature_mismatch"):
        validate_document_upload(pdf, "image/png")
    with pytest.raises(UploadValidationError, match="mime_signature_mismatch"):
        validate_document_upload(b"\x89PNG\r\n\x1a\nrest", "application/pdf")
    with pytest.raises(UploadValidationError, match="empty_document"):
        validate_document_upload(b"", "application/pdf")
    with pytest.raises(UploadValidationError, match="document_too_large"):
        validate_document_upload(b"%PDF-1.7\n" + b"x" * MAX_DOCUMENT_BYTES, "application/pdf")


@pytest.mark.parametrize(
    ("provider", "warning"),
    [
        (
            FakeProvider(extraction_error=RuntimeError("provider payload with private data")),
            "ocr_provider_failed",
        ),
        (FakeProvider(text="   \n\t"), "empty_extraction"),
        (FakeProvider(text="\x00\x01\x02" * 100), "malformed_extraction"),
        (FakeProvider(text=None), "malformed_extraction"),
        (FakeProvider(model_id="invalid model id"), "malformed_extraction"),
        (FakeProvider(finish_reason="MAX_TOKENS"), "ocr_response_incomplete"),
        (
            FakeProvider(text="Jordan Rivera valid resume text " * 4 + "\ud800"),
            "malformed_extraction",
        ),
        (
            FakeProvider(text="Jordan Rivera valid resume text " * 4 + "\x7f" * 1_000),
            "malformed_extraction",
        ),
        (
            FakeProvider(text="Jordan Rivera valid resume text " * 4 + "\ufffd" * 1_000),
            "malformed_extraction",
        ),
    ],
)
def test_provider_failures_and_malformed_output_are_never_scoreable(provider, warning):
    result = asyncio.run(
        DocumentExtractionService(provider).extract(
            fixture_bytes("scanned-resume.pdf"),
            "application/pdf",
        )
    )

    assert result.status is ExtractionStatus.FAILED
    assert result.mock is False
    assert result.text == ""
    assert result.source_blocks == ()
    assert result.embedding is None
    assert warning in result.warnings
    assert provider.embedding_calls == 0


def test_provider_timeout_fails_closed():
    provider = FakeProvider(delay_seconds=0.05)
    result = asyncio.run(
        DocumentExtractionService(
            provider,
            ocr_timeout_seconds=0.001,
        ).extract(fixture_bytes("scanned-resume.pdf"), "application/pdf")
    )

    assert result.status is ExtractionStatus.FAILED
    assert "ocr_provider_timeout" in result.warnings
    assert provider.embedding_calls == 0


def test_mock_result_has_no_resume_or_embedding():
    provider = FakeProvider()
    result = asyncio.run(
        DocumentExtractionService(provider, mock_mode=True).extract(
            fixture_bytes("digital-resume.pdf"),
            "application/pdf",
        )
    )

    assert result.status is ExtractionStatus.MOCK
    assert result.mock is True
    assert result.extraction_method is ExtractionMethod.MOCK
    assert result.markdown == ""
    assert result.source_blocks == ()
    assert result.embedding is None
    assert provider.extract_calls == 0
    assert provider.embedding_calls == 0


@pytest.mark.parametrize(
    "embedding",
    [
        [],
        [0.1] * 767,
        [0.1] * 767 + [math.nan],
        [0.1] * 767 + [math.inf],
        [0.0] * 768,
        [1e-50] * 768,
        [1e308] * 768,
    ],
)
def test_invalid_embedding_degrades_without_fabricating_extraction(embedding):
    provider = FakeProvider(embedding=embedding)
    result = asyncio.run(
        DocumentExtractionService(provider).extract(
            fixture_bytes("digital-resume.pdf"),
            "application/pdf",
        )
    )

    assert result.status is ExtractionStatus.DEGRADED
    assert result.quality.assessment is QualityAssessment.USABLE
    assert result.embedding is None
    assert "embedding_failed" in result.warnings
    assert "Jordan Rivera" in result.text


def test_pathological_paragraph_count_is_bounded_without_dropping_text():
    text = "\n\n".join(f"Employment evidence paragraph {index:04d}" for index in range(600))
    provider = FakeProvider(text=text)
    result = asyncio.run(
        DocumentExtractionService(provider).extract(
            fixture_bytes("scanned-resume.pdf"),
            "application/pdf",
        )
    )

    assert result.status is ExtractionStatus.COMPLETE
    assert len(result.source_blocks) <= 512
    assert "Employment evidence paragraph 0000" in result.text
    assert "Employment evidence paragraph 0599" in result.text
    assert result.text == "\n\n".join(block.text for block in result.source_blocks)


def test_embedding_input_truncation_is_explicit_and_bounded():
    provider = FakeProvider(text="Documented café experience and service skills. " * 250)
    result = asyncio.run(
        DocumentExtractionService(provider).extract(
            fixture_bytes("scanned-resume.pdf"),
            "application/pdf",
        )
    )

    assert result.status is ExtractionStatus.COMPLETE
    assert "embedding_input_truncated" in result.warnings
    assert len(provider.embedding_inputs) == 1
    assert len(provider.embedding_inputs[0]) == 8_000


def test_pdf_timeout_kills_workers_and_restores_bounded_admission():
    import teamflow_document_processor.extraction as extraction_module

    async def exercise_pool():
        service = DocumentExtractionService(
            FakeProvider(),
            pdf_text_timeout_seconds=0.001,
        )
        first, second = await asyncio.gather(
            service.extract(fixture_bytes("digital-resume.pdf"), "application/pdf"),
            service.extract(fixture_bytes("digital-resume.pdf"), "application/pdf"),
        )
        overloaded = await service.extract(
            fixture_bytes("digital-resume.pdf"),
            "application/pdf",
        )
        return first, second, overloaded

    first, second, overloaded = asyncio.run(exercise_pool())
    assert all(result.status is ExtractionStatus.FAILED for result in (first, second))
    assert all("pdf_text_timeout" in result.warnings for result in (first, second))
    assert overloaded.status is ExtractionStatus.FAILED
    assert "pdf_text_timeout" in overloaded.warnings
    assert extraction_module._PDF_ADMISSION.acquire(blocking=False)
    assert extraction_module._PDF_ADMISSION.acquire(blocking=False)
    assert not extraction_module._PDF_ADMISSION.acquire(blocking=False)
    extraction_module._PDF_ADMISSION.release()
    extraction_module._PDF_ADMISSION.release()


def test_compressed_pdf_text_bomb_is_bounded_and_worker_recovers():
    provider = FakeProvider()
    attacked_pdf = compressed_pdf_text_bomb()
    assert len(attacked_pdf) < 10_000

    result = asyncio.run(
        DocumentExtractionService(provider).extract(attacked_pdf, "application/pdf")
    )

    assert result.status is ExtractionStatus.FAILED
    assert "malformed_extraction" in result.warnings
    assert result.quality.reason_codes == ("text_too_large",)
    assert provider.extract_calls == 0
    assert provider.embedding_calls == 0

    recovered = asyncio.run(
        DocumentExtractionService(provider).extract(
            fixture_bytes("digital-resume.pdf"), "application/pdf"
        )
    )
    assert recovered.status is ExtractionStatus.COMPLETE
    assert recovered.extraction_method is ExtractionMethod.PDF_TEXT


def test_pdf_worker_cancellation_terminates_child_before_releasing_admission(
    monkeypatch,
):
    import teamflow_document_processor.extraction as extraction_module

    started = asyncio.Event()

    class FakeProcess:
        returncode = None
        terminated = False
        killed = False

        async def communicate(self, _content):
            started.set()
            await asyncio.Future()

        def terminate(self):
            self.terminated = True
            self.returncode = -15

        def kill(self):
            self.killed = True
            self.returncode = -9

        async def wait(self):
            return self.returncode

    process = FakeProcess()

    async def fake_subprocess(*_args, **_kwargs):
        return process

    monkeypatch.setattr(
        extraction_module.asyncio,
        "create_subprocess_exec",
        fake_subprocess,
    )

    async def exercise():
        task = asyncio.create_task(extraction_module._read_pdf_pages_with_budget(b"%PDF", 5))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(exercise())

    assert process.terminated
    assert not process.killed
    assert extraction_module._PDF_ADMISSION.acquire(blocking=False)
    assert extraction_module._PDF_ADMISSION.acquire(blocking=False)
    assert not extraction_module._PDF_ADMISSION.acquire(blocking=False)
    extraction_module._PDF_ADMISSION.release()
    extraction_module._PDF_ADMISSION.release()


def test_source_block_ids_are_deterministic_filename_independent_and_literal():
    content_hash = hashlib.sha256(b"same document bytes").hexdigest()
    text = "Jordan Rivera\n\nNorthstar Cafe\n\nRepeated block\n\nRepeated block"

    first = build_source_blocks(text, content_hash=content_hash, page_number=1)
    second = build_source_blocks(text, content_hash=content_hash, page_number=1)
    changed = build_source_blocks(
        text + " changed",
        content_hash=hashlib.sha256(b"changed bytes").hexdigest(),
        page_number=1,
    )

    assert first == second
    assert [block.source_block_id for block in first] != [
        block.source_block_id for block in changed
    ]
    assert len({block.source_block_id for block in first}) == len(first)
    assert verify_literal_evidence(first, first[0].source_block_id, "Jordan Rivera")
    assert not verify_literal_evidence(first, first[0].source_block_id, "Jordan  Rivera")
    assert not verify_literal_evidence(first, first[0].source_block_id, "Rivera\n\nNorthstar")


def test_result_contract_rejects_mock_or_failed_content_and_invalid_counts():
    valid = {
        "schema_version": "1.0",
        "document_id": "doc-" + "a" * 64,
        "status": "complete",
        "markdown": "Jordan Rivera",
        "text": "Jordan Rivera",
        "source_blocks": [
            {
                "source_block_id": "src-aaaaaaaaaaaa-p0001-b0001-006cb820d755",
                "page_number": 1,
                "ordinal": 1,
                "text": "Jordan Rivera",
            }
        ],
        "embedding": [0.1] * 768,
        "extraction_method": "pdf_text",
        "model_id": "pypdf-6.16.2",
        "embedding_model_id": "models/gemini-embedding-001",
        "content_sha256": "a" * 64,
        "mock": False,
        "warnings": [],
        "quality": {
            "assessment": "usable",
            "character_count": 13,
            "block_count": 1,
            "page_count": 1,
            "reason_codes": [],
        },
    }
    assert DocumentExtractionResult.model_validate(valid)

    integral_json_number = {
        **valid,
        "source_blocks": [
            {
                **valid["source_blocks"][0],
                "page_number": 1.0,
                "ordinal": 1e0,
            }
        ],
        "quality": {
            **valid["quality"],
            "character_count": 13.0,
            "block_count": 1e0,
            "page_count": 1.0,
        },
    }
    assert DocumentExtractionResult.model_validate(integral_json_number)

    with pytest.raises(ValueError):
        DocumentExtractionResult.model_validate(
            {
                **valid,
                "status": "mock",
                "mock": True,
                "extraction_method": "mock",
            }
        )
    with pytest.raises(ValueError):
        DocumentExtractionResult.model_validate(
            {
                **valid,
                "source_blocks": [
                    {
                        **valid["source_blocks"][0],
                        "source_block_id": "src-aaaaaaaaaaaa-p0001-b0001-deadbeefdead",
                    }
                ],
            }
        )
    with pytest.raises(ValueError):
        DocumentExtractionResult.model_validate(
            {
                **valid,
                "markdown": "Jordan Rivera\n\nuncovered",
                "text": "Jordan Rivera\n\nuncovered",
                "quality": {**valid["quality"], "character_count": 24},
            }
        )
    with pytest.raises(ValueError):
        DocumentExtractionResult.model_validate(
            {
                **valid,
                "warnings": ["mock_mode_enabled"],
            }
        )
    with pytest.raises(ValueError):
        DocumentExtractionResult.model_validate(
            {
                **valid,
                "source_blocks": [
                    {
                        **valid["source_blocks"][0],
                        "page_number": 2,
                        "source_block_id": "src-aaaaaaaaaaaa-p0002-b0001-67f911bf14b9",
                    }
                ],
            }
        )
    with pytest.raises(ValueError):
        DocumentExtractionResult.model_validate(
            {
                **valid,
                "embedding": [10**10_000] + [0.1] * 767,
            }
        )
    with pytest.raises(ValueError):
        DocumentExtractionResult.model_validate(
            {
                **valid,
                "source_blocks": [
                    {
                        **valid["source_blocks"][0],
                        "text": "Jordan Rivera\ud800",
                    }
                ],
            }
        )
    with pytest.raises(ValueError):
        DocumentExtractionResult.model_validate(
            {
                **valid,
                "quality": {**valid["quality"], "block_count": 2},
            }
        )
