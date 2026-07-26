import os
import sys
from pathlib import Path

os.environ["ENVIRONMENT"] = "test"
os.environ["MOCK_MODE"] = "True"
os.environ["OCR_SERVICE_TOKEN"] = "test-token"
os.environ["OTEL_CONSOLE_EXPORT_ENABLED"] = "false"

SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402
from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)


def test_cloud_run_traceparent_is_reused_by_custom_ocr_span():
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
                "candidate.pdf",
                b"synthetic resume content",
                "application/pdf",
            )
        },
    )

    assert response.status_code == 200

    spans = exporter.get_finished_spans()
    ocr_span = next(span for span in spans if span.name == "ocr_extraction")
    server_span = next(
        span for span in spans if span.context.span_id == ocr_span.parent.span_id
    )

    assert f"{ocr_span.context.trace_id:032x}" == trace_id
    assert f"{server_span.context.trace_id:032x}" == trace_id
    assert server_span.parent is not None
    assert f"{server_span.parent.span_id:016x}" == upstream_span_id
    assert "file.name" not in ocr_span.attributes
    assert ocr_span.attributes["teamflow.pipeline.stage"] == "ocr"
