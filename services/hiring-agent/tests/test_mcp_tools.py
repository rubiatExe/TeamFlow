from __future__ import annotations

import asyncio
import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from teamflow_hiring_agent.mcp import server
from teamflow_hiring_agent.mcp.client import (
    MCP_CHILD_ENVIRONMENT_KEYS,
    MCP_TOOL_NAMES,
    MCPClientConfigurationError,
    MCPStdioConnection,
)
from teamflow_hiring_agent.resume_review.providers import (
    RESUME_REVIEW_TOOL_NAMES,
    select_resume_review_tools,
)

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _reader_token() -> str:
    payload = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "role": "teamflow_hiring_reader",
                    "merchant_id": MERCHANT_ID,
                    "exp": 4_102_444_800,
                },
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"header.{payload}.signature"


def test_exact_read_only_catalog_selects_only_resume_review_loaders() -> None:
    registered = asyncio.run(server.mcp.list_tools())
    names = {tool.name for tool in registered}

    assert names == set(MCP_TOOL_NAMES)
    assert "update_fit_score" not in names
    assert all(tool.annotations.readOnlyHint is True for tool in registered)

    catalog = {
        name: SimpleNamespace(name=name, ainvoke=lambda *_args, **_kwargs: None)
        for name in MCP_TOOL_NAMES
    }
    selected = select_resume_review_tools(catalog)
    assert set(selected) == set(RESUME_REVIEW_TOOL_NAMES)


def test_stdio_connection_accepts_only_explicit_allowlisted_child_environment() -> None:
    token = _reader_token()
    environment = {
        "ENVIRONMENT": "test",
        "HIRING_AGENT_MOCK_TOOLS": "false",
        "SUPABASE_URL": "https://project.supabase.test",
        "SUPABASE_TRUSTED_ORIGIN": "https://project.supabase.test",
        "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_" + "a" * 32,
        "SUPABASE_HIRING_READER_TOKEN": token,
        "GOOGLE_API_KEY": "private-google-value",
    }
    connection = MCPStdioConnection(
        command=sys.executable,
        args=("-m", "teamflow_hiring_agent.mcp.server"),
        cwd=SERVICE_ROOT,
        environment=environment,
    )

    child_environment = connection.adapter_config()["env"]
    assert child_environment == environment
    assert set(child_environment) <= MCP_CHILD_ENVIRONMENT_KEYS
    assert token not in repr(connection)

    with pytest.raises(MCPClientConfigurationError, match="mcp_client_configuration_invalid"):
        MCPStdioConnection(
            command=sys.executable,
            args=("-m", "teamflow_hiring_agent.mcp.server"),
            cwd=SERVICE_ROOT,
            environment={"SUPABASE_SERVICE_KEY": "must-not-cross-boundary"},
        )


def test_semantic_search_uses_only_the_scoped_projection_rpc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    settings = server._ServerSettings(
        environment="test",
        mock_tools=False,
        supabase_url="https://project.supabase.test",
        trusted_origin="https://project.supabase.test",
        publishable_key="sb_publishable_" + "a" * 32,
        reader_token=_reader_token(),
        google_api_key="private-google-value",
    )

    async def fake_embedding(
        _settings: server._ServerSettings,
        _query: str,
    ) -> list[float]:
        return [0.25] * 768

    async def fake_match(
        _settings: server._ServerSettings,
        params: dict[str, object],
    ) -> list[dict[str, object]]:
        captured["params"] = params
        return [{"merchant_id": MERCHANT_ID, "similarity": 0.9}]

    monkeypatch.setattr(server, "_SETTINGS", settings)
    monkeypatch.setattr(server, "_get_query_embedding", fake_embedding)
    monkeypatch.setattr(server, "_match_candidates", fake_match)

    result = asyncio.run(
        server.semantic_search_candidates(
            "espresso experience",
            MERCHANT_ID,
            top_k=4,
            threshold=0.6,
        )
    )

    assert captured["params"] == {
        "candidate_query": [0.25] * 768,
        "match_merchant_id": MERCHANT_ID,
        "match_threshold": 0.6,
        "match_count": 4,
    }
    assert result == [{"merchant_id": MERCHANT_ID, "similarity": 0.9}]
