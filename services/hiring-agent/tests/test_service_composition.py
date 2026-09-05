from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from teamflow_hiring_agent.composition import TenantScopedHiringRuntime
from teamflow_hiring_agent.config import HumanReviewRuntimeSettings
from teamflow_hiring_agent.mcp.client import MCPStdioConnection
from teamflow_hiring_agent.resume_review.hitl.runtime import HumanReviewRuntime
from teamflow_hiring_agent.service_composition import (
    HiringServiceCompositionError,
    compose_hiring_service,
)

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
SERVICE_ROOT = Path(__file__).resolve().parents[1]


class _HiringWorkflow:
    async def invoke(self, _request: Any) -> Any:
        raise AssertionError("composition must not invoke the hiring workflow")


class _ReviewWorkflow:
    async def invoke(self, _request: Any) -> Any:
        raise AssertionError("composition must not invoke the review workflow")


def _reader_token() -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "role": "teamflow_hiring_reader",
                "merchant_id": MERCHANT_ID,
                "exp": 4_102_444_800,
            },
            separators=(",", ":"),
        ).encode()
    ).decode()
    return f"header.{payload.rstrip('=')}.signature"


def _mock_environment() -> dict[str, str]:
    return {
        "ENVIRONMENT": "test",
        "GOOGLE_API_KEY": "private-google-key",
        "HIRING_AGENT_MERCHANT_ID": MERCHANT_ID,
        "HIRING_AGENT_MOCK_TOOLS": "true",
        "TEAMFLOW_HITL_ENABLED": "false",
    }


def _mock_runtime() -> TenantScopedHiringRuntime:
    return TenantScopedHiringRuntime(
        merchant_id=MERCHANT_ID,
        environment="test",
        mock_tools=True,
        workflow=_HiringWorkflow(),
    )


def test_explicit_composition_reuses_one_tenant_and_immutable_settings() -> None:
    captured: dict[str, Any] = {}
    environment = _mock_environment()
    runtime = _mock_runtime()

    def hiring_factory(snapshot: Any) -> TenantScopedHiringRuntime:
        captured["hiring_snapshot"] = snapshot
        return runtime

    def source_factory(connection: MCPStdioConnection) -> object:
        captured["connection"] = connection
        return object()

    def review_factory(
        source: object,
        *,
        merchant_id: str,
        settings: Any,
        review_writer: Any,
    ) -> _ReviewWorkflow:
        captured.update(
            source=source,
            merchant_id=merchant_id,
            settings=settings,
            review_writer=review_writer,
        )
        return _ReviewWorkflow()

    def hitl_factory(
        settings: HumanReviewRuntimeSettings,
        *,
        analysis_runner: Any,
    ) -> HumanReviewRuntime:
        captured["hitl_settings"] = settings
        captured["analysis_runner"] = analysis_runner
        return HumanReviewRuntime(settings, analysis_runner=analysis_runner)

    components = compose_hiring_service(
        environment,
        python_executable=sys.executable,
        service_directory=SERVICE_ROOT,
        hiring_runtime_factory=hiring_factory,
        tool_source_factory=source_factory,
        resume_review_workflow_factory=review_factory,
        human_review_runtime_factory=hitl_factory,
    )
    environment["GOOGLE_API_KEY"] = "replacement-private-key"
    environment["HIRING_AGENT_MERCHANT_ID"] = "00000000-0000-0000-0000-000000000099"

    assert components.hiring_runtime is runtime
    assert components.resume_review_workflow is captured["analysis_runner"]
    assert components.hitl_runtime.ready is True
    assert captured["merchant_id"] == MERCHANT_ID
    assert captured["settings"].google_api_key == "private-google-key"
    assert captured["review_writer"] is None
    assert captured["hitl_settings"].enabled is False
    connection = captured["connection"]
    assert connection.command == sys.executable
    assert connection.args == ("-m", "teamflow_hiring_agent.mcp.server")
    assert connection.cwd == str(SERVICE_ROOT)
    assert connection.adapter_config()["env"] == {
        "ENVIRONMENT": "test",
        "HIRING_AGENT_MOCK_TOOLS": "true",
    }
    assert "private-google-key" not in repr(components)


def test_disabled_writes_reject_a_dormant_writer_credential() -> None:
    token = _reader_token()
    environment = {
        "ENVIRONMENT": "test",
        "GOOGLE_API_KEY": "private-google-key",
        "HIRING_AGENT_MOCK_TOOLS": "false",
        "SUPABASE_URL": "https://project.supabase.test",
        "SUPABASE_TRUSTED_ORIGIN": "https://project.supabase.test",
        "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_" + "a" * 32,
        "SUPABASE_HIRING_READER_TOKEN": token,
        "SUPABASE_REVIEW_WRITER_TOKEN": "private-writer-token",
        "AGENT_ALLOW_WRITES": "false",
        "TEAMFLOW_HITL_ENABLED": "false",
    }
    runtime = TenantScopedHiringRuntime(
        merchant_id=MERCHANT_ID,
        environment="test",
        mock_tools=False,
        workflow=_HiringWorkflow(),
        reader_token=token,
    )

    with pytest.raises(
        HiringServiceCompositionError,
        match="^hiring_service_composition_invalid$",
    ) as caught:
        compose_hiring_service(
            environment,
            hiring_runtime_factory=lambda _snapshot: runtime,
            tool_source_factory=lambda _connection: object(),
            resume_review_workflow_factory=lambda *_args, **_kwargs: _ReviewWorkflow(),
        )

    assert "private-writer-token" not in str(caught.value)


def test_dependency_errors_are_sanitized_without_secret_context() -> None:
    canary = "PRIVATE-COMPOSITION-CANARY"

    def fail_source(_connection: MCPStdioConnection) -> object:
        raise RuntimeError(canary)

    with pytest.raises(
        HiringServiceCompositionError,
        match="^hiring_service_composition_invalid$",
    ) as caught:
        compose_hiring_service(
            _mock_environment(),
            hiring_runtime_factory=lambda _snapshot: _mock_runtime(),
            tool_source_factory=fail_source,
        )

    assert canary not in str(caught.value)
    assert caught.value.__suppress_context__ is True
