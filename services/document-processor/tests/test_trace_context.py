import asyncio
import importlib.util
import os
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

os.environ["ENVIRONMENT"] = "test"
os.environ["MOCK_MODE"] = "True"
os.environ["OCR_SERVICE_TOKEN"] = "test-token"
os.environ["OTEL_CONSOLE_EXPORT_ENABLED"] = "false"

SERVICE_DIR = Path(__file__).resolve().parents[1]
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SERVICE_DIR))

from fastapi.testclient import TestClient  # noqa: E402
from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode  # noqa: E402

module_spec = importlib.util.spec_from_file_location(
    "teamflow_document_processor_main",
    SERVICE_DIR / "main.py",
)
assert module_spec is not None and module_spec.loader is not None
document_processor_main = importlib.util.module_from_spec(module_spec)
sys.modules[module_spec.name] = document_processor_main
module_spec.loader.exec_module(document_processor_main)
app = document_processor_main.app


@pytest.mark.parametrize("value", ["", "prod", "production-like", "unknown"])
def test_environment_setting_rejects_unknown_values(value):
    with pytest.raises(RuntimeError, match="ENVIRONMENT_invalid"):
        document_processor_main._environment_setting({"ENVIRONMENT": value})


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("development", "development"),
        (" TEST ", "test"),
        ("Production", "production"),
    ],
)
def test_environment_setting_accepts_only_known_values(value, expected):
    assert document_processor_main._environment_setting({"ENVIRONMENT": value}) == expected


def test_cloud_run_traceparent_is_reused_without_sensitive_span_or_log_data(caplog):
    caplog.set_level("INFO")
    exporter = InMemorySpanExporter()
    provider = trace.get_tracer_provider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    trace_id = "1234567890abcdef1234567890abcdef"
    upstream_span_id = "1234567890abcdef"

    response = TestClient(app).post(
        "/extract",
        headers={
            "X-OCR-Token": "test-token",
            "traceparent": f"00-{trace_id}-{upstream_span_id}-01",
        },
        files={
            "file": (
                "private-filename-marker.pdf",
                b"%PDF-1.7\nPRIVATE_RESUME_MARKER",
                "application/pdf; private=raw-mime-marker",
            )
        },
    )

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "mock"
    assert body["mock"] is True
    assert body["markdown"] == ""
    assert body["source_blocks"] == []
    assert body["embedding"] is None

    spans = exporter.get_finished_spans()
    ocr_span = next(span for span in spans if span.name == "ocr_extraction")
    server_span = next(span for span in spans if span.context.span_id == ocr_span.parent.span_id)

    assert f"{ocr_span.context.trace_id:032x}" == trace_id
    assert f"{server_span.context.trace_id:032x}" == trace_id
    assert server_span.parent is not None
    assert f"{server_span.parent.span_id:016x}" == upstream_span_id
    assert "file.name" not in ocr_span.attributes
    assert "file.content_type" not in ocr_span.attributes
    assert ocr_span.attributes["teamflow.pipeline.stage"] == "ocr"
    assert ocr_span.status.status_code == StatusCode.ERROR
    assert "teamflow.content_sha256" not in ocr_span.attributes
    serialized_span_attributes = repr(
        [dict(span.attributes) for span in exporter.get_finished_spans()]
    )
    for sensitive_marker in (
        "test-token",
        "private-filename-marker",
        "raw-mime-marker",
        "PRIVATE_RESUME_MARKER",
        "application/pdf",
    ):
        assert sensitive_marker not in serialized_span_attributes
        assert sensitive_marker not in caplog.text


def test_extract_requires_service_authentication():
    response = TestClient(app).post(
        "/extract",
        files={
            "file": (
                "candidate.pdf",
                (FIXTURE_DIR / "digital-resume.pdf").read_bytes(),
                "application/pdf",
            )
        },
    )
    assert response.status_code == 401


@pytest.mark.parametrize(
    ("headers", "content"),
    [
        ({"X-OCR-Token": "test-token"}, b""),
        (
            {
                "X-OCR-Token": "test-token",
                "Content-Type": "multipart/form-data; boundary=broken",
            },
            b"--broken\r\ninvalid multipart body\r\n--broken--\r\n",
        ),
    ],
)
def test_missing_or_malformed_multipart_is_sanitized(headers, content):
    response = TestClient(app).post("/extract", headers=headers, content=content)

    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "invalid_request"}}
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_extract_rejects_mime_signature_mismatch_before_mock_processing():
    response = TestClient(app).post(
        "/extract",
        headers={"X-OCR-Token": "test-token"},
        files={
            "file": (
                "candidate.png",
                (FIXTURE_DIR / "digital-resume.pdf").read_bytes(),
                "image/png",
            )
        },
    )
    assert response.status_code == 415
    assert response.json() == {"detail": {"code": "mime_signature_mismatch"}}


def test_non_mock_image_extraction_returns_typed_success(monkeypatch):
    class SuccessfulProvider:
        def __init__(self):
            self.extract_calls = 0
            self.embedding_calls = 0

        async def extract_text(self, content, mime_type):
            self.extract_calls += 1
            assert content.startswith(b"\x89PNG\r\n\x1a\n")
            assert mime_type == "image/png"
            return document_processor_main.OcrProviderOutput(
                text=("Morgan Lee\nHarbor Cafe\nBarista experience from 2021 through 2024"),
                model_id="gemini-test-vision",
                finish_reason="STOP",
            )

        async def generate_embedding(self, text):
            self.embedding_calls += 1
            assert "Morgan Lee" in text
            return [0.01] * 768

    provider = SuccessfulProvider()
    monkeypatch.setattr(
        document_processor_main,
        "extraction_service",
        document_processor_main.DocumentExtractionService(provider),
    )

    response = TestClient(app).post(
        "/extract",
        headers={"X-OCR-Token": "test-token"},
        files={
            "file": (
                "candidate.png",
                b"\x89PNG\r\n\x1a\nsynthetic image bytes",
                "image/png",
            )
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "complete"
    assert body["mock"] is False
    assert body["extraction_method"] == "gemini_vision"
    assert body["text"].startswith("Morgan Lee")
    assert len(body["source_blocks"]) == 1
    assert len(body["embedding"]) == 768
    assert provider.extract_calls == 1
    assert provider.embedding_calls == 1


def test_non_mock_pdf_returns_typed_503_and_openapi_documents_both_shapes(
    monkeypatch,
):
    monkeypatch.setattr(
        document_processor_main,
        "extraction_service",
        document_processor_main.DocumentExtractionService(None),
    )

    response = TestClient(app).post(
        "/extract",
        headers={"X-OCR-Token": "test-token"},
        files={
            "file": (
                "candidate.pdf",
                (FIXTURE_DIR / "digital-resume.pdf").read_bytes(),
                "application/pdf",
            )
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "pdf_visual_validation_unavailable"}}

    openapi = app.openapi()
    unavailable_schema = openapi["paths"]["/extract"]["post"]["responses"]["503"]["content"][
        "application/json"
    ]["schema"]
    referenced_models = {
        option["$ref"].rsplit("/", 1)[-1]
        for option in unavailable_schema["anyOf"]
        if "$ref" in option
    }
    assert referenced_models == {
        "DocumentExtractionResult",
        "PdfVisualValidationUnavailableResponse",
    }
    code_schema = openapi["components"]["schemas"]["PdfVisualValidationUnavailableDetail"][
        "properties"
    ]["code"]
    assert code_schema.get("const", code_schema.get("enum", [None])[0]) == (
        "pdf_visual_validation_unavailable"
    )


@pytest.mark.parametrize(
    (
        "environment",
        "mock_mode",
        "token",
        "has_ocr_client",
        "has_embedding_client",
        "expected_status",
    ),
    [
        ("test", True, "test-token", True, True, 503),
        ("test", False, "", True, True, 503),
        ("test", False, "test-token", False, True, 503),
        ("test", False, "test-token", True, False, 503),
        ("production", False, "short", True, True, 503),
        ("test", False, "test-token", True, True, 200),
        ("production", False, "a" * 32, True, True, 200),
    ],
)
def test_readiness_is_config_only_and_fails_closed(
    monkeypatch,
    environment,
    mock_mode,
    token,
    has_ocr_client,
    has_embedding_client,
    expected_status,
):
    monkeypatch.setattr(document_processor_main, "ENVIRONMENT", environment)
    monkeypatch.setattr(document_processor_main, "MOCK_MODE", mock_mode)
    monkeypatch.setattr(document_processor_main, "OCR_SERVICE_TOKEN", token)
    monkeypatch.setattr(
        document_processor_main,
        "ocr_genai_client",
        object() if has_ocr_client else None,
    )
    monkeypatch.setattr(
        document_processor_main,
        "embedding_genai_client",
        object() if has_embedding_client else None,
    )

    response = TestClient(app).get("/ready")

    assert response.status_code == expected_status
    assert response.json() == {"status": "ready" if expected_status == 200 else "not_ready"}


def _run_boundary_middleware(headers, body_messages, *, receive_delay=0):
    downstream_called = False
    sent: list[dict[str, Any]] = []
    receive_calls = 0

    async def downstream(_scope, _receive, _send):
        nonlocal downstream_called
        downstream_called = True

    async def receive():
        nonlocal receive_calls
        if receive_delay:
            import asyncio

            await asyncio.sleep(receive_delay)
        receive_calls += 1
        return body_messages.pop(0)

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/extract",
        "headers": headers,
    }
    middleware = document_processor_main.UploadBoundaryMiddleware(downstream)
    import asyncio

    asyncio.run(middleware(scope, receive, send))
    response_start = next(message for message in sent if message["type"] == "http.response.start")
    return response_start["status"], downstream_called, receive_calls


def test_upload_boundary_rejects_auth_before_reading_any_body_bytes():
    status, downstream_called, receive_calls = _run_boundary_middleware(
        [],
        [{"type": "http.request", "body": b"private resume bytes", "more_body": False}],
    )
    assert status == 401
    assert downstream_called is False
    assert receive_calls == 0

    status, downstream_called, receive_calls = _run_boundary_middleware(
        [(b"x-ocr-token", b"\xff")],
        [{"type": "http.request", "body": b"private resume bytes", "more_body": False}],
    )
    assert status == 401
    assert downstream_called is False
    assert receive_calls == 0


def test_upload_boundary_rejects_duplicate_service_tokens_before_body_read():
    status, downstream_called, receive_calls = _run_boundary_middleware(
        [
            (b"x-ocr-token", b"test-token"),
            (b"X-OCR-Token", b"test-token"),
        ],
        [{"type": "http.request", "body": b"private resume bytes", "more_body": False}],
    )

    assert status == 401
    assert downstream_called is False
    assert receive_calls == 0


def test_upload_boundary_rejects_duplicate_content_lengths_before_body_read():
    status, downstream_called, receive_calls = _run_boundary_middleware(
        [
            (b"x-ocr-token", b"test-token"),
            (b"content-length", b"20"),
            (b"Content-Length", b"20"),
        ],
        [{"type": "http.request", "body": b"private resume bytes", "more_body": False}],
    )

    assert status == 400
    assert downstream_called is False
    assert receive_calls == 0


@pytest.mark.parametrize(
    "content_length",
    [b"", b"+20", b"-20", b" 20", b"20 ", b"2_0", b"\xff"],
)
def test_upload_boundary_rejects_noncanonical_content_length_before_body_read(
    content_length,
):
    status, downstream_called, receive_calls = _run_boundary_middleware(
        [
            (b"x-ocr-token", b"test-token"),
            (b"content-length", content_length),
        ],
        [{"type": "http.request", "body": b"private resume bytes", "more_body": False}],
    )

    assert status == 400
    assert downstream_called is False
    assert receive_calls == 0


def test_upload_boundary_rejects_chunked_oversize_before_multipart_parser():
    six_megabytes = b"x" * (6 * 1024 * 1024)
    status, downstream_called, receive_calls = _run_boundary_middleware(
        [(b"x-ocr-token", b"test-token")],
        [
            {"type": "http.request", "body": six_megabytes, "more_body": True},
            {"type": "http.request", "body": six_megabytes, "more_body": False},
        ],
    )
    assert status == 413
    assert downstream_called is False
    assert receive_calls == 2


def test_upload_boundary_times_out_slow_authenticated_body(monkeypatch):
    monkeypatch.setattr(document_processor_main, "REQUEST_BODY_TIMEOUT_SECONDS", 0.001)

    status, downstream_called, receive_calls = _run_boundary_middleware(
        [(b"x-ocr-token", b"test-token")],
        [{"type": "http.request", "body": b"x", "more_body": True}],
        receive_delay=0.02,
    )

    assert status == 408
    assert downstream_called is False
    assert receive_calls == 0


def test_provider_admission_stays_bounded_after_coroutine_cancellation():
    release_workers = threading.Event()
    two_workers_started = threading.Event()
    workers_finished = threading.Event()
    state_lock = threading.Lock()
    started: set[str] = set()
    finished: set[str] = set()

    def blocking_provider_call(label):
        with state_lock:
            started.add(label)
            if len(started) == document_processor_main.MAX_PROVIDER_CONCURRENCY:
                two_workers_started.set()
        try:
            assert release_workers.wait(timeout=2)
            return label
        finally:
            with state_lock:
                finished.add(label)
                if len(finished) == document_processor_main.MAX_PROVIDER_CONCURRENCY:
                    workers_finished.set()

    async def exercise():
        first = asyncio.create_task(
            document_processor_main._run_provider_call(lambda: blocking_provider_call("first"))
        )
        second = asyncio.create_task(
            document_processor_main._run_provider_call(lambda: blocking_provider_call("second"))
        )
        for _ in range(200):
            if two_workers_started.is_set():
                break
            await asyncio.sleep(0.005)
        assert two_workers_started.is_set()

        first.cancel()
        second.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        with pytest.raises(asyncio.CancelledError):
            await second

        third_started = False

        def unexpected_third_call():
            nonlocal third_started
            third_started = True

        with pytest.raises(
            document_processor_main.ProviderOverloadedError,
            match="provider_overloaded",
        ):
            await document_processor_main._run_provider_call(unexpected_third_call)
        assert third_started is False

        release_workers.set()
        for _ in range(200):
            if workers_finished.is_set():
                await asyncio.sleep(0.005)
                try:
                    return await document_processor_main._run_provider_call(lambda: "recovered")
                except document_processor_main.ProviderOverloadedError:
                    pass
            await asyncio.sleep(0.005)
        raise AssertionError("provider admission did not recover")

    assert asyncio.run(exercise()) == "recovered"
    assert started == {"first", "second"}
    assert finished == {"first", "second"}


def test_provider_retries_are_disabled_and_pdf_overload_is_retryable():
    source = (SERVICE_DIR / "main.py").read_text(encoding="utf-8")
    assert source.count("retry_options=HttpRetryOptions(attempts=1)") == 2

    overloaded = document_processor_main.DocumentExtractionResult.model_validate(
        {
            "schema_version": "1.0",
            "document_id": "doc-" + "a" * 64,
            "status": "failed",
            "markdown": "",
            "text": "",
            "source_blocks": [],
            "embedding": None,
            "extraction_method": "none",
            "model_id": None,
            "embedding_model_id": None,
            "content_sha256": "a" * 64,
            "mock": False,
            "warnings": ["pdf_text_overloaded"],
            "quality": {
                "assessment": "unusable",
                "character_count": 0,
                "block_count": 0,
                "page_count": 0,
                "reason_codes": ["no_source_blocks"],
            },
        }
    )
    assert document_processor_main._result_http_status(overloaded) == 503
