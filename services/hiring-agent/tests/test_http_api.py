from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from starlette.exceptions import HTTPException as StarletteHTTPException

from teamflow_hiring_agent.composition import TenantScopedHiringRuntime
from teamflow_hiring_agent.contracts import HiringAgentOutput
from teamflow_hiring_agent.http_api import (
    HiringHTTPBoundary,
    HiringHTTPConfigurationError,
    HiringHTTPSettings,
    create_hiring_app,
)
from teamflow_hiring_agent.runtime import (
    HiringWorkflowBusyError,
    HiringWorkflowDependencyError,
    HiringWorkflowExecutionError,
    HiringWorkflowRequestError,
    HiringWorkflowResultError,
    HiringWorkflowTimeoutError,
)

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
OTHER_MERCHANT_ID = "00000000-0000-0000-0000-000000000099"
TOKEN = "internal-route-token-" + ("x" * 32)
AUTH_HEADERS = {"X-Agent-Token": TOKEN}


@dataclass
class RecordingWorkflow:
    error: BaseException | None = None
    delay: float = 0.0
    calls: int = 0
    request: Any = None

    async def invoke(self, request: Any) -> HiringAgentOutput:
        self.calls += 1
        self.request = request
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return HiringAgentOutput(
            summary="Candidate evidence reviewed.",
            recommendation="Continue with a structured human interview.",
            fit_score=82,
            analysis={"evidence": ["Relevant role experience"]},
            request_id=str(request.request_id),
            tool_calls=["get_candidate"],
        )


def _reader_token(*, expires_at: int) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "role": "teamflow_hiring_reader",
                "merchant_id": MERCHANT_ID,
                "exp": expires_at,
            },
            separators=(",", ":"),
        ).encode()
    ).decode()
    return f"header.{payload.rstrip('=')}.signature"


def _runtime(
    workflow: RecordingWorkflow,
    *,
    mock_tools: bool = True,
    reader_token: str = "",
) -> TenantScopedHiringRuntime:
    return TenantScopedHiringRuntime(
        merchant_id=MERCHANT_ID,
        environment="test",
        mock_tools=mock_tools,
        workflow=workflow,
        reader_token=reader_token,
    )


def _settings(**changes: Any) -> HiringHTTPSettings:
    values = {
        "service_token": TOKEN,
        "environment": "test",
        "max_request_bytes": 4_096,
        "body_timeout_seconds": 0.1,
    }
    values.update(changes)
    return HiringHTTPSettings(**values)


def _request(app: Any, method: str, path: str, **kwargs: Any) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(send())


def _payload(*, merchant_id: str = MERCHANT_ID) -> dict[str, str]:
    return {
        "merchantId": merchant_id,
        "candidateId": "00000000-0000-0000-0000-000000000002",
        "roleId": "00000000-0000-0000-0000-000000000003",
    }


def test_valid_request_reuses_the_composed_runtime_and_stable_contract() -> None:
    workflow = RecordingWorkflow()
    app = create_hiring_app(_runtime(workflow), settings=_settings())

    first = _request(app, "POST", "/invoke", headers=AUTH_HEADERS, json=_payload())
    second = _request(app, "POST", "/invoke", headers=AUTH_HEADERS, json=_payload())

    assert first.status_code == second.status_code == 200
    assert first.json()["fit_score"] == 82
    assert first.json()["tool_calls"] == ["get_candidate"]
    assert workflow.calls == 2
    assert str(workflow.request.merchant_id) == MERCHANT_ID


def test_tenant_mismatch_is_rejected_before_models_or_tools() -> None:
    workflow = RecordingWorkflow()
    app = create_hiring_app(_runtime(workflow), settings=_settings())

    response = _request(
        app,
        "POST",
        "/invoke",
        headers=AUTH_HEADERS,
        json=_payload(merchant_id=OTHER_MERCHANT_ID),
    )

    assert response.status_code == 403
    assert response.json() == {"error": "Forbidden", "code": "tenant_scope_mismatch"}
    assert workflow.calls == 0


def test_protected_routes_require_one_exact_bearer_credential() -> None:
    workflow = RecordingWorkflow()
    app = create_hiring_app(_runtime(workflow), settings=_settings())

    missing = _request(app, "POST", "/invoke", json=_payload())
    wrong = _request(
        app,
        "POST",
        "/invoke",
        headers={"X-Agent-Token": f"{TOKEN}x"},
        json=_payload(),
    )
    duplicate = _request(
        app,
        "POST",
        "/invoke",
        headers=[
            ("X-Agent-Token", TOKEN),
            ("X-Agent-Token", TOKEN),
        ],
        json=_payload(),
    )

    assert {missing.status_code, wrong.status_code, duplicate.status_code} == {401}
    assert workflow.calls == 0


def test_unauthenticated_body_is_never_consumed() -> None:
    received = False
    downstream_called = False
    sent: list[dict[str, Any]] = []

    async def downstream(_scope: Any, _receive: Any, _send: Any) -> None:
        nonlocal downstream_called
        downstream_called = True

    async def receive() -> dict[str, Any]:
        nonlocal received
        received = True
        raise AssertionError("unauthenticated body was consumed")

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/invoke", "headers": []}
    asyncio.run(HiringHTTPBoundary(downstream, settings=_settings())(scope, receive, send))

    response_start = next(message for message in sent if message["type"] == "http.response.start")
    assert response_start["status"] == 401
    assert received is False
    assert downstream_called is False


@pytest.mark.parametrize(
    "headers",
    [
        [(b"x-agent-token", TOKEN.encode())],
        [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"text/plain"),
        ],
        [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"application/json"),
            (b"content-type", b"application/json"),
        ],
        [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"application/json"),
            (b"content-length", b"02"),
        ],
        [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"application/json"),
            (b"content-length", b"2"),
            (b"content-length", b"2"),
        ],
        [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"application/json"),
            (b"content-length", b"2"),
            (b"transfer-encoding", b"chunked"),
        ],
    ],
)
def test_noncanonical_body_headers_are_rejected_before_body_read(headers) -> None:
    received = False
    downstream_called = False
    sent: list[dict[str, Any]] = []

    async def downstream(_scope: Any, _receive: Any, _send: Any) -> None:
        nonlocal downstream_called
        downstream_called = True

    async def receive() -> dict[str, Any]:
        nonlocal received
        received = True
        raise AssertionError("invalid body was consumed")

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/invoke", "headers": headers}
    asyncio.run(HiringHTTPBoundary(downstream, settings=_settings())(scope, receive, send))

    response_start = next(message for message in sent if message["type"] == "http.response.start")
    expected = 400 if any(name == b"content-length" for name, _ in headers) else 415
    assert response_start["status"] == expected
    assert received is False
    assert downstream_called is False


def test_body_length_mismatch_is_rejected_before_fastapi_parsing() -> None:
    sent: list[dict[str, Any]] = []
    downstream_called = False

    async def downstream(_scope: Any, _receive: Any, _send: Any) -> None:
        nonlocal downstream_called
        downstream_called = True

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/invoke",
        "headers": [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"application/json"),
            (b"content-length", b"3"),
        ],
    }
    asyncio.run(HiringHTTPBoundary(downstream, settings=_settings())(scope, receive, send))

    response_start = next(message for message in sent if message["type"] == "http.response.start")
    assert response_start["status"] == 400
    assert downstream_called is False


def test_nonempty_frame_after_declared_length_is_rejected_immediately() -> None:
    sent: list[dict[str, Any]] = []
    downstream_called = False
    frames = [
        {"type": "http.request", "body": b"{}", "more_body": True},
        {"type": "http.request", "body": b"x", "more_body": False},
    ]

    async def downstream(_scope: Any, _receive: Any, _send: Any) -> None:
        nonlocal downstream_called
        downstream_called = True

    async def receive() -> dict[str, Any]:
        return frames.pop(0)

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/invoke",
        "headers": [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"application/json"),
            (b"content-length", b"2"),
        ],
    }
    asyncio.run(HiringHTTPBoundary(downstream, settings=_settings())(scope, receive, send))

    response_start = next(message for message in sent if message["type"] == "http.response.start")
    assert response_start["status"] == 400
    assert frames == []
    assert downstream_called is False


def test_empty_frame_flood_is_capped_and_yields_before_rejection() -> None:
    sent: list[dict[str, Any]] = []
    downstream_called = False
    frame_count = 0
    ticker_ran = False
    ticker_ran_before_response = False

    async def downstream(_scope: Any, _receive: Any, _send: Any) -> None:
        nonlocal downstream_called
        downstream_called = True

    async def receive() -> dict[str, Any]:
        nonlocal frame_count
        frame_count += 1
        return {"type": "http.request", "body": b"", "more_body": True}

    async def send(message: dict[str, Any]) -> None:
        nonlocal ticker_ran_before_response
        if message["type"] == "http.response.start":
            ticker_ran_before_response = ticker_ran
        sent.append(message)

    async def exercise() -> None:
        async def ticker() -> None:
            nonlocal ticker_ran
            await asyncio.sleep(0)
            ticker_ran = True

        ticker_task = asyncio.create_task(ticker())
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/invoke",
            "headers": [
                (b"x-agent-token", TOKEN.encode()),
                (b"content-type", b"application/json"),
            ],
        }
        await HiringHTTPBoundary(downstream, settings=_settings())(scope, receive, send)
        await ticker_task

    asyncio.run(exercise())

    response_start = next(message for message in sent if message["type"] == "http.response.start")
    assert response_start["status"] == 400
    assert frame_count == 65
    assert ticker_ran_before_response is True
    assert downstream_called is False


def test_bounded_frames_are_replayed_as_one_body() -> None:
    received_by_downstream: list[dict[str, Any]] = []
    frames = [
        {"type": "http.request", "body": b"{", "more_body": True},
        {"type": "http.request", "body": b"}", "more_body": False},
    ]

    async def downstream(_scope: Any, receive: Any, _send: Any) -> None:
        received_by_downstream.append(await receive())
        received_by_downstream.append(await receive())

    async def receive() -> dict[str, Any]:
        return frames.pop(0)

    async def send(_message: dict[str, Any]) -> None:
        raise AssertionError("downstream fixture does not send a response")

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/invoke",
        "headers": [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"application/json"),
            (b"content-length", b"2"),
        ],
    }
    asyncio.run(HiringHTTPBoundary(downstream, settings=_settings())(scope, receive, send))

    assert received_by_downstream == [
        {"type": "http.request", "body": b"{}", "more_body": False},
        {"type": "http.disconnect"},
    ]


def test_validation_errors_are_sanitized_and_do_not_reach_the_workflow() -> None:
    canary = "PRIVATE-CANDIDATE-CANARY"
    workflow = RecordingWorkflow()
    app = create_hiring_app(_runtime(workflow), settings=_settings())

    response = _request(
        app,
        "POST",
        "/invoke",
        headers=AUTH_HEADERS,
        json={"merchantId": "not-a-uuid", "instructions": [canary]},
    )

    assert response.status_code == 422
    assert response.json() == {"error": "Invalid request", "code": "invalid_request"}
    assert canary not in response.text
    assert workflow.calls == 0


def test_declared_and_chunked_oversized_bodies_are_rejected() -> None:
    workflow = RecordingWorkflow()
    app = create_hiring_app(_runtime(workflow), settings=_settings())
    declared = _request(
        app,
        "POST",
        "/invoke",
        headers={**AUTH_HEADERS, "Content-Length": "4097", "Content-Type": "application/json"},
        content=b"{}",
    )

    async def send_chunked() -> httpx.Response:
        async def chunks():
            yield b"{" + (b"x" * 3_000)
            yield (b"x" * 2_000) + b"}"

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/invoke",
                headers={**AUTH_HEADERS, "Content-Type": "application/json"},
                content=chunks(),
            )

    chunked = asyncio.run(send_chunked())

    assert declared.status_code == chunked.status_code == 413
    assert declared.json()["code"] == chunked.json()["code"] == "request_too_large"
    assert workflow.calls == 0


def test_slow_body_has_a_deadline_but_workflow_does_not_get_a_second_deadline() -> None:
    sent: list[dict[str, Any]] = []
    downstream_called = False

    async def downstream(_scope: Any, _receive: Any, _send: Any) -> None:
        nonlocal downstream_called
        downstream_called = True

    async def receive() -> dict[str, Any]:
        await asyncio.sleep(0.05)
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    settings = _settings(body_timeout_seconds=0.01)
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/invoke",
        "headers": [
            (b"x-agent-token", TOKEN.encode()),
            (b"content-type", b"application/json"),
        ],
    }
    asyncio.run(HiringHTTPBoundary(downstream, settings=settings)(scope, receive, send))
    response_start = next(message for message in sent if message["type"] == "http.response.start")
    assert response_start["status"] == 408
    assert downstream_called is False

    workflow = RecordingWorkflow(delay=0.03)
    app = create_hiring_app(_runtime(workflow), settings=settings)
    response = _request(app, "POST", "/invoke", headers=AUTH_HEADERS, json=_payload())
    assert response.status_code == 200
    assert workflow.calls == 1


@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        (HiringWorkflowBusyError("private"), 429, "workflow_busy"),
        (HiringWorkflowTimeoutError("private"), 504, "workflow_timeout"),
        (HiringWorkflowRequestError("private"), 422, "invalid_request"),
        (HiringWorkflowDependencyError("private"), 503, "workflow_unavailable"),
        (HiringWorkflowExecutionError("private"), 502, "workflow_failed"),
        (HiringWorkflowResultError("private"), 502, "workflow_failed"),
        (RuntimeError("private"), 500, "workflow_failed"),
    ],
)
def test_runtime_errors_are_mapped_without_private_details(
    error: BaseException,
    status_code: int,
    code: str,
) -> None:
    app = create_hiring_app(_runtime(RecordingWorkflow(error=error)), settings=_settings())

    response = _request(app, "POST", "/invoke", headers=AUTH_HEADERS, json=_payload())

    assert response.status_code == status_code
    assert response.json()["code"] == code
    assert "private" not in response.text


def test_health_readiness_and_version_are_public_and_hardened() -> None:
    app = create_hiring_app(_runtime(RecordingWorkflow()), settings=_settings())

    health = _request(app, "GET", "/health")
    ready = _request(app, "GET", "/ready")
    version = _request(app, "GET", "/version")

    assert health.status_code == ready.status_code == version.status_code == 200
    assert health.json() == {"status": "ok"}
    assert ready.json() == {"status": "ready"}
    assert version.json() == {"service": "teamflow-hiring-agent", "version": "2.1.0"}
    for response in (health, ready, version):
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"


def test_expired_reader_token_fails_readiness_and_invoke_without_workflow_use(monkeypatch) -> None:
    monkeypatch.setattr("teamflow_hiring_agent.supabase_http.time.time", lambda: 100)
    workflow = RecordingWorkflow()
    runtime = _runtime(
        workflow,
        mock_tools=False,
        reader_token=_reader_token(expires_at=200),
    )
    app = create_hiring_app(runtime, settings=_settings())

    monkeypatch.setattr("teamflow_hiring_agent.supabase_http.time.time", lambda: 201)
    ready = _request(app, "GET", "/ready")
    invoked = _request(app, "POST", "/invoke", headers=AUTH_HEADERS, json=_payload())

    assert ready.status_code == 503
    assert ready.json() == {"status": "not_ready"}
    assert invoked.status_code == 503
    assert invoked.json()["code"] == "workflow_unavailable"
    assert workflow.calls == 0


def test_http_settings_are_strict_and_secret_safe() -> None:
    settings = HiringHTTPSettings.from_env(
        {
            "HIRING_AGENT_TOKEN": TOKEN,
            "ENVIRONMENT": "test",
            "HIRING_AGENT_MAX_REQUEST_BYTES": "4096",
            "HIRING_AGENT_BODY_TIMEOUT_SECONDS": "0.25",
        }
    )

    assert settings.max_request_bytes == 4_096
    assert settings.environment == "test"
    assert settings.body_timeout_seconds == 0.25
    assert TOKEN not in repr(settings)

    for environment in (
        {},
        {"HIRING_AGENT_TOKEN": "short", "ENVIRONMENT": "production"},
        {"HIRING_AGENT_TOKEN": TOKEN, "HIRING_AGENT_MAX_REQUEST_BYTES": "nan"},
        {"HIRING_AGENT_TOKEN": TOKEN, "HIRING_AGENT_MAX_REQUEST_BYTES": "9" * 5_000},
        {"HIRING_AGENT_TOKEN": TOKEN, "HIRING_AGENT_BODY_TIMEOUT_SECONDS": "inf"},
    ):
        with pytest.raises(
            HiringHTTPConfigurationError,
            match="^hiring_http_configuration_invalid$",
        ):
            HiringHTTPSettings.from_env(environment)

    assert (
        HiringHTTPSettings.from_env(
            {"HIRING_AGENT_TOKEN": "local-token", "ENVIRONMENT": "development"}
        ).service_token
        == "local-token"
    )

    with pytest.raises(
        HiringHTTPConfigurationError,
        match="^hiring_http_configuration_invalid$",
    ):
        HiringHTTPSettings(
            service_token=TOKEN,
            environment="test",
            body_timeout_seconds=10**10_000,
        )


def test_http_and_runtime_environment_must_match() -> None:
    with pytest.raises(
        HiringHTTPConfigurationError,
        match="^hiring_http_configuration_invalid$",
    ):
        create_hiring_app(
            _runtime(RecordingWorkflow()),
            settings=HiringHTTPSettings(service_token=TOKEN, environment="development"),
        )


def test_app_construction_is_inert_and_does_not_retain_plaintext_token_in_repr() -> None:
    workflow = RecordingWorkflow()
    runtime = _runtime(workflow)

    app = create_hiring_app(runtime, settings=_settings())

    assert workflow.calls == 0
    assert TOKEN not in repr(app.user_middleware)
    assert app.docs_url is None
    assert app.openapi_url is None


def test_only_bad_request_http_exceptions_use_the_sanitized_envelope() -> None:
    app = create_hiring_app(_runtime(RecordingWorkflow()), settings=_settings())

    @app.get("/bad-request")
    async def bad_request() -> None:
        raise StarletteHTTPException(status_code=400, detail="PRIVATE-PARSER-CANARY")

    @app.get("/teapot")
    async def teapot() -> None:
        raise StarletteHTTPException(status_code=418, detail="teapot")

    bad = _request(app, "GET", "/bad-request", headers=AUTH_HEADERS)
    other = _request(app, "GET", "/teapot", headers=AUTH_HEADERS)

    assert bad.status_code == 400
    assert bad.json() == {"error": "Invalid request", "code": "invalid_request"}
    assert "PRIVATE-PARSER-CANARY" not in bad.text
    assert other.status_code == 418
    assert other.json() == {"detail": "teapot"}
