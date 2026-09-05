import asyncio
from pathlib import Path

import httpx
import pytest

from teamflow_hiring_agent.api import create_app
from teamflow_hiring_agent.contracts import HiringAgentOutput
from teamflow_hiring_agent.http_api import (
    HiringHTTPBoundary,
    HiringHTTPConfigurationError,
    HiringHTTPSettings,
)
from teamflow_hiring_agent.resume_review.confidence import ConfidencePolicyError


class FakeWorkflow:
    async def invoke(self, request):
        return HiringAgentOutput(
            summary="Candidate reviewed",
            recommendation="Continue with a structured interview.",
            fit_score=80,
            analysis={},
            request_id=str(request.request_id),
            tool_calls=[],
        )


MERCHANT_ID = "00000000-0000-0000-0000-000000000001"


def request(app, method, path, **kwargs):
    async def send():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(send())


def test_health_endpoint_is_public(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    response = request(create_app(FakeWorkflow()), "GET", "/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    version = request(create_app(FakeWorkflow()), "GET", "/version")
    assert version.status_code == 200
    assert version.json() == {"service": "teamflow-hiring-agent", "version": "2.1.0"}


def test_validation_errors_never_reflect_private_input(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    canary = "PII-CANARY-DO-NOT-ECHO"

    response = request(
        create_app(FakeWorkflow()),
        "POST",
        "/invoke",
        headers={"X-Agent-Token": "test-token"},
        json={
            "candidateId": "not-a-uuid",
            "merchantId": "not-a-uuid",
            "operation": "review_candidate",
            "instructions": [canary],
        },
    )

    assert response.status_code == 422
    assert response.json() == {"error": "Invalid request", "code": "invalid_request"}
    assert canary not in response.text


def test_agent_endpoints_require_the_service_token(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    app = create_app(FakeWorkflow())

    assert request(app, "POST", "/invoke", json={"merchantId": MERCHANT_ID}).status_code == 401
    assert (
        request(
            app,
            "POST",
            "/invoke",
            headers={"X-Agent-Token": "test-token"},
            json={"merchantId": MERCHANT_ID},
        ).status_code
        == 200
    )


def test_production_fails_closed_without_a_service_token(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("HIRING_AGENT_TOKEN", raising=False)

    with pytest.raises(
        HiringHTTPConfigurationError,
        match="^hiring_http_configuration_invalid$",
    ):
        create_app(FakeWorkflow())


def test_production_readiness_rejects_weak_service_token_and_mock_tools(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    monkeypatch.setenv("SUPABASE_URL", "https://teamflow.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "test-service-key")
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "short")
    monkeypatch.setenv("HIRING_AGENT_MOCK_TOOLS", "false")

    with pytest.raises(
        HiringHTTPConfigurationError,
        match="^hiring_http_configuration_invalid$",
    ):
        create_app(FakeWorkflow())

    monkeypatch.setenv("HIRING_AGENT_TOKEN", "0" * 32)
    monkeypatch.setenv("HIRING_AGENT_MOCK_TOOLS", "true")
    mock_tools = request(create_app(FakeWorkflow()), "GET", "/ready")
    assert mock_tools.status_code == 503


def test_oversized_request_is_rejected_before_validation(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    response = request(
        create_app(FakeWorkflow()),
        "POST",
        "/invoke",
        headers={
            "X-Agent-Token": "test-token",
            "Content-Length": "70000",
            "Content-Type": "application/json",
        },
        content=b"{}",
    )

    assert response.status_code == 413


def test_chunked_oversized_request_is_rejected_before_json_parsing(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    app = create_app(FakeWorkflow())

    async def send():
        async def chunks():
            yield b"{" + (b"x" * 40_000)
            yield b"x" * 40_000 + b"}"

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/invoke",
                headers={
                    "X-Agent-Token": "test-token",
                    "Content-Type": "application/json",
                },
                content=chunks(),
            )

    response = asyncio.run(send())

    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"


def test_slow_authenticated_request_body_has_a_deadline(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    sent = []
    downstream_called = False
    receive_calls = 0

    async def downstream(_scope, _receive, _send):
        nonlocal downstream_called
        downstream_called = True

    async def receive():
        nonlocal receive_calls
        await asyncio.sleep(0.02)
        receive_calls += 1
        return {"type": "http.request", "body": b"{", "more_body": True}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/invoke",
        "headers": [
            (b"x-agent-token", b"test-token"),
            (b"content-type", b"application/json"),
        ],
    }
    middleware = HiringHTTPBoundary(
        downstream,
        settings=HiringHTTPSettings(
            service_token="test-token",
            environment="test",
            body_timeout_seconds=0.01,
        ),
    )
    asyncio.run(middleware(scope, receive, send))

    response_start = next(message for message in sent if message["type"] == "http.response.start")
    assert response_start["status"] == 408
    assert downstream_called is False
    assert receive_calls == 0


def test_readiness_fails_closed_when_confidence_policy_is_invalid(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    monkeypatch.setenv("HIRING_AGENT_MOCK_TOOLS", "true")
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")

    def fail_policy_load():
        raise ConfidencePolicyError("private policy detail")

    monkeypatch.setattr(
        "teamflow_hiring_agent.http_api.load_default_confidence_policy",
        fail_policy_load,
    )
    response = request(create_app(FakeWorkflow()), "GET", "/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready"}


def test_readiness_rejects_the_legacy_service_role_key(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    monkeypatch.setenv("HIRING_AGENT_MOCK_TOOLS", "false")
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "legacy-service-role-key")
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "0" * 32)
    monkeypatch.delenv("SUPABASE_TRUSTED_ORIGIN", raising=False)
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_HIRING_READER_TOKEN", raising=False)

    response = request(create_app(FakeWorkflow()), "GET", "/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready"}


def test_instrumentation_never_captures_sensitive_http_headers():
    source = Path(__file__).resolve().parents[1] / "teamflow_hiring_agent" / "http_api.py"
    text = source.read_text(encoding="utf-8")

    assert "http_capture_headers_server_request=[]" in text
    assert "http_capture_headers_server_response=[]" in text
    for header in ("authorization", "cookie", "x-agent-token", "apikey"):
        assert f'"{header}"' in text
