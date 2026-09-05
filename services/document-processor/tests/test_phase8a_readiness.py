import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("MOCK_MODE", "True")
os.environ.setdefault("OTEL_CONSOLE_EXPORT_ENABLED", "false")

import main as service_main  # noqa: E402
import telemetry as service_telemetry  # noqa: E402


@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "0", "-1", "31", "bad"])
def test_ocr_deadline_parser_rejects_nonfinite_or_out_of_range_values(value: str) -> None:
    with pytest.raises(RuntimeError, match="OCR_TIMEOUT_SECONDS_invalid"):
        service_main._bounded_float_setting(
            "OCR_TIMEOUT_SECONDS",
            default=25,
            minimum=1,
            maximum=30,
            environ={"OCR_TIMEOUT_SECONDS": value},
        )


def test_mock_mode_parser_is_strict() -> None:
    with pytest.raises(RuntimeError, match="MOCK_MODE_invalid"):
        service_main._strict_bool_setting(
            "MOCK_MODE",
            default=False,
            environ={"MOCK_MODE": "yes"},
        )


@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "-0.1", "1.1", "bad"])
def test_trace_sample_ratio_is_finite_and_bounded(value: str) -> None:
    with pytest.raises(RuntimeError, match="OTEL_TRACES_SAMPLER_ARG_invalid"):
        service_telemetry._bounded_sample_ratio(value)


@pytest.mark.parametrize(
    ("token", "production", "expected"),
    [
        ("local-token", False, True),
        ("short", True, False),
        ("0123456789abcdef0123456789abcdef", True, True),
        ("0123456789abcdef0123456789abcde\n", True, False),
        ("é" * 32, True, False),
    ],
)
def test_service_token_strength_is_enforced(
    token: str,
    production: bool,
    expected: bool,
) -> None:
    assert service_main._valid_service_token(token, production=production) is expected


def test_liveness_is_minimal_and_security_headers_are_present() -> None:
    response = TestClient(service_main.app).get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "teamflow-document-processor",
    }
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_readiness_fails_closed_without_provider_or_service_token(monkeypatch) -> None:
    monkeypatch.setattr(service_main, "MOCK_MODE", False)
    monkeypatch.setattr(service_main, "OCR_SERVICE_TOKEN", "")
    monkeypatch.setattr(service_main, "ocr_genai_client", object())
    monkeypatch.setattr(service_main, "embedding_genai_client", object())

    response = TestClient(service_main.app).get("/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready"}


def test_readiness_rejects_mock_mode_even_with_initialized_dependencies(monkeypatch) -> None:
    monkeypatch.setattr(service_main, "MOCK_MODE", True)
    monkeypatch.setattr(service_main, "OCR_SERVICE_TOKEN", "service-token")
    monkeypatch.setattr(service_main, "ocr_genai_client", object())
    monkeypatch.setattr(service_main, "embedding_genai_client", object())

    response = TestClient(service_main.app).get("/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready"}


def test_readiness_succeeds_only_for_real_initialized_dependencies(monkeypatch) -> None:
    monkeypatch.setattr(service_main, "MOCK_MODE", False)
    monkeypatch.setattr(service_main, "OCR_SERVICE_TOKEN", "service-token")
    monkeypatch.setattr(service_main, "ocr_genai_client", object())
    monkeypatch.setattr(service_main, "embedding_genai_client", object())

    response = TestClient(service_main.app).get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_production_readiness_rejects_a_weak_service_token(monkeypatch) -> None:
    monkeypatch.setattr(service_main, "ENVIRONMENT", "production")
    monkeypatch.setattr(service_main, "MOCK_MODE", False)
    monkeypatch.setattr(service_main, "OCR_SERVICE_TOKEN", "short")
    monkeypatch.setattr(service_main, "ocr_genai_client", object())
    monkeypatch.setattr(service_main, "embedding_genai_client", object())

    response = TestClient(service_main.app).get("/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready"}


def test_instrumentation_never_captures_sensitive_http_headers() -> None:
    source = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")

    assert "http_capture_headers_server_request=[]" in source
    assert "http_capture_headers_server_response=[]" in source
    for header in ("authorization", "cookie", "x-ocr-token", "apikey"):
        assert f'"{header}"' in source
