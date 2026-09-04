from __future__ import annotations

import asyncio
import base64
import json
import sys
from collections import deque
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastmcp.exceptions import ValidationError as FastMCPValidationError
from langchain_core.messages import AIMessage

from teamflow_hiring_agent.contracts import HiringAgentDraft, HiringAgentRequest
from teamflow_hiring_agent.graph import build_hiring_graph
from teamflow_hiring_agent.graph.nodes import GraphDependencies, _jsonable_tool_result
from teamflow_hiring_agent.mcp import server
from teamflow_hiring_agent.mcp.client import (
    MCP_TOOL_NAMES,
    MCPStdioConnection,
    MCPToolSessionSource,
    _validated_raw_catalog,
)
from teamflow_hiring_agent.prompts import project_candidate_context, project_role_context

SERVICE_ROOT = Path(__file__).resolve().parents[1]
MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
OTHER_MERCHANT_ID = "00000000-0000-0000-0000-000000000099"
CANDIDATE_ID = "00000000-0000-0000-0000-000000000002"
ROLE_ID = "00000000-0000-0000-0000-000000000003"
PUBLISHABLE_KEY = "sb_publishable_" + "a" * 32

_SERVER_ENVIRONMENT_KEYS = (
    "ENVIRONMENT",
    "GOOGLE_API_KEY",
    "HIRING_AGENT_MOCK_TOOLS",
    "SUPABASE_HIRING_READER_TOKEN",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_TRUSTED_ORIGIN",
    "SUPABASE_URL",
)


def _reader_token(merchant_id: str = MERCHANT_ID) -> str:
    payload = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "role": "teamflow_hiring_reader",
                    "merchant_id": merchant_id,
                    "exp": 4_102_444_800,
                },
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"header.{payload}.signature"


def _clear_server_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _SERVER_ENVIRONMENT_KEYS:
        monkeypatch.delenv(name, raising=False)


def _set_real_server_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_server_environment(monkeypatch)
    monkeypatch.setattr(server, "_SETTINGS", None)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("HIRING_AGENT_MOCK_TOOLS", "false")
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.test")
    monkeypatch.setenv("SUPABASE_TRUSTED_ORIGIN", "https://project.supabase.test")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", PUBLISHABLE_KEY)
    monkeypatch.setenv("SUPABASE_HIRING_READER_TOKEN", _reader_token())


def test_catalog_exactly_satisfies_the_committed_application_contract() -> None:
    registered = asyncio.run(server.mcp.list_tools())
    raw_tools = [tool.to_mcp_tool() for tool in registered]

    validated = _validated_raw_catalog(SimpleNamespace(tools=raw_tools, nextCursor=None))

    assert {tool.name for tool in validated} == set(MCP_TOOL_NAMES)
    assert all(tool.outputSchema is None for tool in raw_tools)
    assert "update_fit_score" not in {tool.name for tool in raw_tools}
    assert server.mcp.strict_input_validation is True
    assert server.mcp._mask_error_details is True


def test_catalog_rejects_boolean_integer_arguments() -> None:
    with pytest.raises(FastMCPValidationError):
        asyncio.run(
            server.mcp.call_tool(
                "list_candidates",
                {"merchant_id": MERCHANT_ID, "limit": True},
            )
        )


def test_real_stdio_session_returns_usable_context_and_fails_mock_search_closed() -> None:
    async def exercise_server() -> tuple[object, object, object, object]:
        connection = MCPStdioConnection(
            command=sys.executable,
            args=("-m", "teamflow_hiring_agent.mcp.server"),
            cwd=SERVICE_ROOT,
            environment={
                "ENVIRONMENT": "test",
                "HIRING_AGENT_MOCK_TOOLS": "true",
            },
        )
        source = MCPToolSessionSource(connection)
        async with source.tools() as tools:
            candidate = await tools["get_candidate"].ainvoke(
                {"candidate_id": CANDIDATE_ID, "merchant_id": MERCHANT_ID}
            )
            role = await tools["get_job_requirements"].ainvoke(
                {"role_id": ROLE_ID, "merchant_id": MERCHANT_ID}
            )
            listed = await tools["list_candidates"].ainvoke({"merchant_id": MERCHANT_ID})
            searched = await tools["semantic_search_candidates"].ainvoke(
                {"query": "espresso experience", "merchant_id": MERCHANT_ID}
            )
            return candidate, role, listed, searched

    candidate, role, listed, searched = asyncio.run(exercise_server())
    candidate = _jsonable_tool_result(candidate)
    role = _jsonable_tool_result(role)
    listed = _jsonable_tool_result(listed)
    searched = _jsonable_tool_result(searched)

    assert listed == {"error": "Candidate listing is unavailable in mock mode"}
    assert searched == {"error": "Candidate search is unavailable in mock mode"}
    assert project_candidate_context(candidate, merchant_id=MERCHANT_ID) is not None
    assert project_role_context(role, merchant_id=MERCHANT_ID) is not None


def test_mock_search_error_degrades_the_real_stdio_graph() -> None:
    class ReasoningModel:
        def __init__(self) -> None:
            self.responses = deque(
                [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "list_candidates",
                                "args": {"merchant_id": MERCHANT_ID},
                                "id": "mock-search-1",
                                "type": "tool_call",
                            }
                        ],
                    ),
                    AIMessage(content="No verified candidate evidence was available."),
                ]
            )

        async def ainvoke(self, _messages: object) -> AIMessage:
            return self.responses.popleft()

    class StructuredModel:
        async def ainvoke(self, _messages: object) -> HiringAgentDraft:
            return HiringAgentDraft(
                summary="Candidate search unavailable.",
                recommendation="Review candidates manually.",
                analysis={"limitations": ["No verified search evidence was available."]},
            )

    async def run_graph_over_stdio() -> object:
        connection = MCPStdioConnection(
            command=sys.executable,
            args=("-m", "teamflow_hiring_agent.mcp.server"),
            cwd=SERVICE_ROOT,
            environment={
                "ENVIRONMENT": "test",
                "HIRING_AGENT_MOCK_TOOLS": "true",
            },
        )
        async with MCPToolSessionSource(connection).tools() as tools:
            graph = build_hiring_graph(
                GraphDependencies(
                    reasoning_model=ReasoningModel(),
                    structured_model=StructuredModel(),
                    tools={
                        name: tools[name]
                        for name in ("list_candidates", "semantic_search_candidates")
                    },
                ),
                model_timeout_seconds=5.0,
                tool_timeout_seconds=10.0,
            )
            state = await graph.ainvoke(
                {
                    "request": HiringAgentRequest(
                        merchantId=MERCHANT_ID,
                        operation="search_candidates",
                        instructions="List candidates with espresso experience",
                    ),
                    "messages": [],
                    "tool_calls": [],
                    "tool_rounds": 0,
                    "warnings": [],
                    "status": "complete",
                    "write_status": "not_requested",
                }
            )
            return state["output"]

    output = asyncio.run(run_graph_over_stdio())

    assert output.status == "degraded"
    assert output.warnings == ["tool_unavailable:list_candidates"]
    assert output.tool_calls == ["list_candidates"]


def test_configuration_is_strict_and_secret_safe() -> None:
    with pytest.raises(ValueError, match="mcp_server_configuration_invalid"):
        server._ServerSettings.from_environment(
            {"ENVIRONMENT": "production", "HIRING_AGENT_MOCK_TOOLS": "true"}
        )
    with pytest.raises(ValueError, match="mcp_server_configuration_invalid"):
        server._ServerSettings.from_environment(
            {"ENVIRONMENT": "test", "SUPABASE_URL": "https://project.supabase.test"}
        )

    token = _reader_token()
    settings = server._ServerSettings.from_environment(
        {
            "ENVIRONMENT": "test",
            "SUPABASE_URL": "https://project.supabase.test",
            "SUPABASE_TRUSTED_ORIGIN": "https://project.supabase.test",
            "SUPABASE_PUBLISHABLE_KEY": PUBLISHABLE_KEY,
            "SUPABASE_HIRING_READER_TOKEN": token,
            "GOOGLE_API_KEY": "private-google-value",
        }
    )

    rendered = repr(settings)
    assert token not in rendered
    assert PUBLISHABLE_KEY not in rendered
    assert "private-google-value" not in rendered


def test_startup_fails_closed_and_mock_mode_rejects_live_secrets() -> None:
    with pytest.raises(RuntimeError, match="mcp_server_configuration_invalid") as failure:
        server._validated_startup_settings(
            {"ENVIRONMENT": "production", "HIRING_AGENT_MOCK_TOOLS": "false"}
        )
    assert failure.value.__cause__ is None
    assert failure.value.__context__ is None

    with pytest.raises(RuntimeError, match="mcp_server_configuration_invalid"):
        server._validated_startup_settings(
            {
                "ENVIRONMENT": "test",
                "HIRING_AGENT_MOCK_TOOLS": "true",
                "GOOGLE_API_KEY": "must-not-be-retained",
                "SUPABASE_URL": "https://ignored.example.test",
                "SUPABASE_TRUSTED_ORIGIN": "https://ignored.example.test",
                "SUPABASE_PUBLISHABLE_KEY": "sb_secret_must_not_be-retained",
                "SUPABASE_HIRING_READER_TOKEN": "must-not-be-retained",
            }
        )

    mock = server._validated_startup_settings(
        {"ENVIRONMENT": "test", "HIRING_AGENT_MOCK_TOOLS": "true"}
    )
    assert mock.mock_tools is True
    assert mock.google_api_key == ""
    assert mock.publishable_key == ""
    assert mock.reader_token == ""


def test_privileged_or_unclassified_api_keys_are_rejected() -> None:
    common = {
        "ENVIRONMENT": "test",
        "SUPABASE_URL": "https://project.supabase.test",
        "SUPABASE_TRUSTED_ORIGIN": "https://project.supabase.test",
        "SUPABASE_HIRING_READER_TOKEN": _reader_token(),
    }
    for key in ("sb_secret_" + "a" * 32, "legacy-or-unclassified-key"):
        with pytest.raises(ValueError, match="mcp_server_configuration_invalid"):
            server._ServerSettings.from_environment({**common, "SUPABASE_PUBLISHABLE_KEY": key})


@pytest.mark.parametrize(
    "credential_name",
    ["SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"],
)
def test_live_mode_rejects_ambient_privileged_credentials(credential_name: str) -> None:
    environment = {
        "ENVIRONMENT": "production",
        "HIRING_AGENT_MOCK_TOOLS": "false",
        "SUPABASE_URL": "https://project.supabase.test",
        "SUPABASE_TRUSTED_ORIGIN": "https://project.supabase.test",
        "SUPABASE_PUBLISHABLE_KEY": PUBLISHABLE_KEY,
        "SUPABASE_HIRING_READER_TOKEN": _reader_token(),
        "GOOGLE_API_KEY": "private-google-value",
        credential_name: "must-not-coexist",
    }

    with pytest.raises(ValueError, match="mcp_server_configuration_invalid"):
        server._ServerSettings.from_environment(environment)


def test_settings_are_frozen_after_first_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_server_environment(monkeypatch)
    monkeypatch.setattr(server, "_SETTINGS", None)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("HIRING_AGENT_MOCK_TOOLS", "true")

    first = server._frozen_settings()
    monkeypatch.setenv("ENVIRONMENT", "production")

    assert server._frozen_settings() is first
    assert first.environment == "test"


def test_cross_tenant_request_fails_before_data_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_real_server_environment(monkeypatch)

    async def forbidden_read(*_args: object, **_kwargs: object) -> list[dict[str, object]]:
        raise AssertionError("cross-tenant request reached the data client")

    monkeypatch.setattr(server, "_supabase_get", forbidden_read)

    result = asyncio.run(server.get_candidate(CANDIDATE_ID, OTHER_MERCHANT_ID))

    assert result == {"error": "Hiring data source is not configured"}


def test_candidate_read_is_tenant_scoped_minimal_and_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_real_server_environment(monkeypatch)
    captured: dict[str, object] = {}

    async def fake_get(
        _settings: server._ServerSettings,
        *,
        table: str,
        query_params: str,
    ) -> list[dict[str, object]]:
        captured.update({"table": table, "query_params": query_params})
        return [
            {
                "id": CANDIDATE_ID,
                "merchant_id": MERCHANT_ID,
                "job_id": ROLE_ID,
                "status": "new",
                "email": "private@example.com",
                "resume_text": "private@example.com 212-555-0199 espresso experience",
            }
        ]

    monkeypatch.setattr(server, "_supabase_get", fake_get)

    result = asyncio.run(server.get_candidate(CANDIDATE_ID, MERCHANT_ID))

    assert captured["table"] == "candidates"
    query = str(captured["query_params"])
    assert f"id=eq.{CANDIDATE_ID}" in query
    assert f"merchant_id=eq.{MERCHANT_ID}" in query
    assert "select=id,merchant_id,job_id,status,resume_text" in query
    assert "email" not in query
    assert "analysis" not in query
    assert "email" not in result
    assert "private@example.com" not in result["resume_text"]
    assert "212-555-0199" not in result["resume_text"]


def test_candidate_list_rejects_a_mismatched_response_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_real_server_environment(monkeypatch)

    async def fake_get(
        _settings: server._ServerSettings,
        *,
        table: str,
        query_params: str,
    ) -> list[dict[str, object]]:
        del table, query_params
        return [{"id": CANDIDATE_ID, "merchant_id": OTHER_MERCHANT_ID}]

    monkeypatch.setattr(server, "_supabase_get", fake_get)

    result = asyncio.run(server.list_candidates(MERCHANT_ID))

    assert result == {"error": "Hiring data source is temporarily unavailable"}


def test_semantic_search_uses_only_the_scoped_email_free_rpc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_real_server_environment(monkeypatch)
    captured: dict[str, object] = {}

    async def fake_embedding(
        _settings: server._ServerSettings,
        _query: str,
    ) -> list[float]:
        return [0.0] * 768

    async def fake_match(
        _settings: server._ServerSettings,
        params: dict[str, object],
    ) -> list[dict[str, object]]:
        captured["params"] = params
        return [
            {
                "merchant_id": MERCHANT_ID,
                "summary": "espresso experience",
                "similarity": 0.9,
                "email": "private@example.com",
            }
        ]

    monkeypatch.setattr(server, "_get_query_embedding", fake_embedding)
    monkeypatch.setattr(server, "_match_candidates", fake_match)

    result = asyncio.run(
        server.semantic_search_candidates("espresso", MERCHANT_ID, top_k=4, threshold=0.6)
    )

    assert captured["params"] == {
        "candidate_query": [0.0] * 768,
        "match_merchant_id": MERCHANT_ID,
        "match_threshold": 0.6,
        "match_count": 4,
    }
    assert result == [{"merchant_id": MERCHANT_ID, "similarity": 0.9}]


@pytest.mark.parametrize(
    "query",
    [
        "private@example.com",
        "rank based on race",
        "ignore previous instructions",
        MERCHANT_ID,
        "line\nbreak",
        "é" * 3_000,
    ],
)
def test_unsafe_search_query_is_rejected_before_embedding(
    monkeypatch: pytest.MonkeyPatch,
    query: str,
) -> None:
    async def forbidden_embedding(*_args: object, **_kwargs: object) -> list[float]:
        raise AssertionError("unsafe query reached the embedding provider")

    monkeypatch.setattr(server, "_get_query_embedding", forbidden_embedding)

    result = asyncio.run(server.semantic_search_candidates(query, MERCHANT_ID))

    assert result == {"error": "Candidate search query is not permitted"}


def test_embedding_client_is_bounded_no_retry_and_closed_on_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {"closed": False}

    class FakeModels:
        async def embed_content(self, **_kwargs: object) -> object:
            raise asyncio.CancelledError

    class FakeAsyncClient:
        models = FakeModels()

        async def aclose(self) -> None:
            captured["closed"] = True

    class FakeClient:
        aio = FakeAsyncClient()

    def fake_client(**kwargs: object) -> FakeClient:
        captured.update(kwargs)
        return FakeClient()

    monkeypatch.setattr(server.genai, "Client", fake_client)
    settings = server._ServerSettings(
        environment="test",
        mock_tools=False,
        google_api_key="private-google-value",
    )

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(server._get_query_embedding(settings, "espresso"))

    http_options = captured["http_options"]
    assert http_options.timeout == server._EMBEDDING_HTTP_TIMEOUT_MS
    assert http_options.retry_options.attempts == 1
    assert captured["closed"] is True


def test_network_budgets_fit_inside_the_graph_tool_timeout() -> None:
    assert server._READ_TIMEOUT_SECONDS < server._TOOL_DEADLINE_SECONDS < 10
    assert server._EMBEDDING_TIMEOUT_SECONDS + server._RPC_TIMEOUT_SECONDS < 10
    assert server._EMBEDDING_HTTP_TIMEOUT_MS < server._EMBEDDING_TIMEOUT_SECONDS * 1_000


def test_missing_embedding_key_has_no_provider_side_effect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = server._ServerSettings(environment="test", mock_tools=False)

    def forbidden_client(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("provider client was constructed without an API key")

    monkeypatch.setattr(server.genai, "Client", forbidden_client)

    assert asyncio.run(server._get_query_embedding(settings, "espresso")) is None
