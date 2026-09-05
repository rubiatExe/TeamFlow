from __future__ import annotations

import asyncio
import base64
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from teamflow_hiring_agent.composition import (
    HiringCompositionError,
    HiringRuntimeUnavailableError,
    HiringTenantScopeError,
    TenantScopedHiringRuntime,
    compose_tenant_scoped_runtime,
)
from teamflow_hiring_agent.contracts import HiringAgentOutput, HiringAgentRequest
from teamflow_hiring_agent.mcp.client import MCPStdioConnection, MCPToolSessionSource
from teamflow_hiring_agent.providers import GeminiGraphDependencyProvider
from teamflow_hiring_agent.runtime import BoundedHiringWorkflow

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
OTHER_MERCHANT_ID = "00000000-0000-0000-0000-000000000099"
PUBLISHABLE_KEY = "sb_publishable_" + ("a" * 32)
SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _reader_token(merchant_id: str = MERCHANT_ID, *, expires_at: int = 4_102_444_800) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "role": "teamflow_hiring_reader",
                "merchant_id": merchant_id,
                "exp": expires_at,
            },
            separators=(",", ":"),
        ).encode()
    ).decode()
    return f"header.{payload.rstrip('=')}.signature"


def _real_environment() -> dict[str, str]:
    return {
        "ENVIRONMENT": "test",
        "GOOGLE_API_KEY": "private-google-key",
        "HIRING_AGENT_MOCK_TOOLS": "false",
        "SUPABASE_URL": "https://project.supabase.co",
        "SUPABASE_TRUSTED_ORIGIN": "https://project.supabase.co",
        "SUPABASE_PUBLISHABLE_KEY": PUBLISHABLE_KEY,
        "SUPABASE_HIRING_READER_TOKEN": _reader_token(),
    }


def _mock_environment() -> dict[str, str]:
    return {
        "ENVIRONMENT": "test",
        "GOOGLE_API_KEY": "private-google-key",
        "HIRING_AGENT_MOCK_TOOLS": "true",
        "HIRING_AGENT_MERCHANT_ID": MERCHANT_ID,
    }


@dataclass
class RecordingWorkflow:
    provider: Any
    settings: Any
    calls: int = 0

    async def invoke(self, request: Any) -> HiringAgentOutput:
        self.calls += 1
        return HiringAgentOutput(
            summary="Evidence reviewed.",
            recommendation="Continue with structured human review.",
            analysis={},
            request_id=str(request.request_id),
        )


def test_real_composition_closes_the_dependency_chain_once() -> None:
    captured: dict[str, Any] = {}

    def source_factory(connection: MCPStdioConnection) -> object:
        captured["connection"] = connection
        return object()

    def provider_factory(source: object, *, settings: Any) -> object:
        captured["source"] = source
        captured["provider_settings"] = settings
        return object()

    def workflow_factory(provider: object, *, settings: Any) -> RecordingWorkflow:
        captured["provider"] = provider
        captured["workflow_settings"] = settings
        return RecordingWorkflow(provider, settings)

    runtime = compose_tenant_scoped_runtime(
        _real_environment(),
        python_executable=sys.executable,
        service_directory=SERVICE_ROOT,
        tool_source_factory=source_factory,
        dependency_provider_factory=provider_factory,
        workflow_factory=workflow_factory,
    )

    assert runtime.merchant_id == MERCHANT_ID
    assert runtime.ready is True
    assert runtime.environment == "test"
    assert runtime.mock_tools is False
    assert captured["provider_settings"] is captured["workflow_settings"]
    assert runtime.workflow.settings is captured["workflow_settings"]
    connection = captured["connection"]
    assert connection.command == sys.executable
    assert connection.args == ("-m", "teamflow_hiring_agent.mcp.server")
    assert connection.cwd == str(SERVICE_ROOT)
    assert connection.adapter_config()["env"] == {
        "ENVIRONMENT": "test",
        "GOOGLE_API_KEY": "private-google-key",
        "HIRING_AGENT_MOCK_TOOLS": "false",
        "SUPABASE_HIRING_READER_TOKEN": _reader_token(),
        "SUPABASE_PUBLISHABLE_KEY": PUBLISHABLE_KEY,
        "SUPABASE_TRUSTED_ORIGIN": "https://project.supabase.co",
        "SUPABASE_URL": "https://project.supabase.co",
    }
    rendered = repr(runtime) + repr(connection) + repr(captured["provider_settings"])
    assert "private-google-key" not in rendered
    assert _reader_token() not in rendered


def test_concrete_composition_is_inert_until_invocation() -> None:
    runtime = compose_tenant_scoped_runtime(_mock_environment())

    assert isinstance(runtime.workflow, BoundedHiringWorkflow)
    assert isinstance(runtime.workflow._dependency_provider, GeminiGraphDependencyProvider)
    assert isinstance(runtime.workflow._dependency_provider._tool_source, MCPToolSessionSource)
    connection = runtime.workflow._dependency_provider._tool_source._connection
    child_environment = connection.adapter_config()["env"]
    assert child_environment == {
        "ENVIRONMENT": "test",
        "HIRING_AGENT_MOCK_TOOLS": "true",
    }
    assert "private-google-key" not in repr(runtime)


def test_environment_is_snapshotted_and_not_re_read() -> None:
    environment = _mock_environment()
    runtime = compose_tenant_scoped_runtime(environment)

    environment["HIRING_AGENT_MERCHANT_ID"] = OTHER_MERCHANT_ID
    environment["GOOGLE_API_KEY"] = "replacement-secret"

    assert runtime.merchant_id == MERCHANT_ID
    provider = runtime.workflow._dependency_provider
    assert provider._settings.google_api_key == "private-google-key"
    assert "replacement-secret" not in repr(runtime)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda values: values.pop("GOOGLE_API_KEY"),
        lambda values: values.update(ENVIRONMENT="production"),
        lambda values: values.update(HIRING_AGENT_MERCHANT_ID="not-a-uuid"),
        lambda values: values.update(SUPABASE_URL="https://project.supabase.co"),
        lambda values: values.update(HIRING_AGENT_MAX_CONCURRENCY="9" * 5_000),
    ],
)
def test_mock_composition_rejects_incomplete_or_unsafe_configuration(mutate) -> None:
    values = _mock_environment()
    mutate(values)

    with pytest.raises(
        HiringCompositionError,
        match="^hiring_composition_configuration_invalid$",
    ):
        compose_tenant_scoped_runtime(values)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("SUPABASE_SERVICE_KEY", "forbidden"),
        ("SUPABASE_SERVICE_ROLE_KEY", "forbidden"),
        ("SUPABASE_SECRET_KEY", "forbidden"),
        ("SUPABASE_PUBLISHABLE_KEY", "sb_secret_forbidden"),
        ("SUPABASE_TRUSTED_ORIGIN", "https://other.supabase.co"),
        ("SUPABASE_HIRING_READER_TOKEN", _reader_token(OTHER_MERCHANT_ID)),
    ],
)
def test_real_composition_rejects_privilege_and_scope_confusion(name: str, value: str) -> None:
    values = _real_environment()
    values["HIRING_AGENT_MERCHANT_ID"] = MERCHANT_ID
    values[name] = value

    with pytest.raises(
        HiringCompositionError,
        match="^hiring_composition_configuration_invalid$",
    ) as caught:
        compose_tenant_scoped_runtime(values)

    assert value not in str(caught.value)


def test_real_composition_derives_scope_from_reader_token() -> None:
    values = _real_environment()
    values["SUPABASE_HIRING_READER_TOKEN"] = _reader_token(OTHER_MERCHANT_ID)

    runtime = compose_tenant_scoped_runtime(values)

    assert runtime.merchant_id == OTHER_MERCHANT_ID


def test_runtime_contract_rejects_a_non_invokable_workflow() -> None:
    with pytest.raises(
        HiringCompositionError,
        match="^hiring_composition_dependency_invalid$",
    ):
        TenantScopedHiringRuntime(
            merchant_id=MERCHANT_ID,
            environment="test",
            mock_tools=True,
            workflow=object(),
        )

    class ExplodingWorkflow:
        @property
        def invoke(self):
            raise RuntimeError("private-property-canary")

    with pytest.raises(
        HiringCompositionError,
        match="^hiring_composition_dependency_invalid$",
    ) as caught:
        TenantScopedHiringRuntime(
            merchant_id=MERCHANT_ID,
            environment="test",
            mock_tools=True,
            workflow=ExplodingWorkflow(),
        )
    assert "private-property-canary" not in str(caught.value)


def test_runtime_contract_rejects_unhashable_environment_without_leaking_type_errors() -> None:
    with pytest.raises(
        HiringCompositionError,
        match="^hiring_composition_configuration_invalid$",
    ):
        TenantScopedHiringRuntime(
            merchant_id=MERCHANT_ID,
            environment=[],  # type: ignore[arg-type]
            mock_tools=True,
            workflow=RecordingWorkflow(provider=None, settings=None),
        )


def test_dependency_factory_errors_are_reclassified_without_their_context() -> None:
    canary = "PRIVATE-FACTORY-CANARY"

    def fail_factory(_connection: MCPStdioConnection) -> object:
        raise HiringCompositionError(canary)

    with pytest.raises(
        HiringCompositionError,
        match="^hiring_composition_dependency_invalid$",
    ) as caught:
        compose_tenant_scoped_runtime(
            _mock_environment(),
            tool_source_factory=fail_factory,
        )

    assert canary not in str(caught.value)
    assert caught.value.__suppress_context__ is True


def test_runtime_rejects_cross_tenant_reuse_before_the_workflow() -> None:
    workflow = RecordingWorkflow(provider=None, settings=None)
    runtime = TenantScopedHiringRuntime(
        merchant_id=MERCHANT_ID,
        environment="test",
        mock_tools=True,
        workflow=workflow,
    )

    with pytest.raises(HiringTenantScopeError, match="^hiring_tenant_scope_mismatch$"):
        asyncio.run(runtime.invoke(HiringAgentRequest(merchantId=OTHER_MERCHANT_ID)))

    assert workflow.calls == 0


def test_expired_reader_credential_changes_readiness_and_blocks_invocation(monkeypatch) -> None:
    monkeypatch.setattr("teamflow_hiring_agent.supabase_http.time.time", lambda: 100)
    values = _real_environment()
    values["SUPABASE_HIRING_READER_TOKEN"] = _reader_token(expires_at=200)
    workflow = RecordingWorkflow(provider=None, settings=None)

    runtime = compose_tenant_scoped_runtime(
        values,
        tool_source_factory=lambda _connection: object(),
        dependency_provider_factory=lambda _source, *, settings: object(),
        workflow_factory=lambda _provider, *, settings: workflow,
    )
    assert runtime.ready is True

    monkeypatch.setattr("teamflow_hiring_agent.supabase_http.time.time", lambda: 201)

    assert runtime.ready is False
    with pytest.raises(
        HiringRuntimeUnavailableError,
        match="^hiring_runtime_credentials_unavailable$",
    ):
        asyncio.run(runtime.invoke(HiringAgentRequest(merchantId=MERCHANT_ID)))
    assert workflow.calls == 0
    assert values["SUPABASE_HIRING_READER_TOKEN"] not in repr(runtime)
