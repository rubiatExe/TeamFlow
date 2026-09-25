from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

from teamflow_hiring_agent.mcp.client import (
    MCP_TOOL_NAMES,
    MCPStdioConnection,
    MCPToolSessionSource,
)
from teamflow_hiring_agent.resume_review.providers import select_resume_review_tools

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
CANDIDATE_ID = "00000000-0000-0000-0000-000000000002"
SERVICE_ROOT = Path(__file__).resolve().parents[1]


async def _exercise_stdio_boundaries() -> None:
    connection = MCPStdioConnection(
        command=sys.executable,
        args=("-m", "teamflow_hiring_agent.mcp.server"),
        cwd=SERVICE_ROOT,
        environment={
            "ENVIRONMENT": "test",
            "HIRING_AGENT_MOCK_TOOLS": "true",
        },
    )
    async with asyncio.timeout(15):
        async with MCPToolSessionSource(connection).tools() as tools:
            assert set(tools) == set(MCP_TOOL_NAMES)
            result: Any = await tools["get_candidate"].ainvoke(
                {
                    "candidate_id": CANDIDATE_ID,
                    "merchant_id": MERCHANT_ID,
                }
            )
            # The child process is deliberately mock-only in this transport test; the
            # assertion proves an actual stdio request/response, not just registration.
            assert CANDIDATE_ID in str(result)
            assert "espresso preparation" in str(result)
            review_tools = select_resume_review_tools(tools)
            assert set(review_tools) == {
                "get_resume_document",
                "load_active_role_policies",
            }


def test_real_fastmcp_stdio_handshakes_and_one_round_trip() -> None:
    asyncio.run(_exercise_stdio_boundaries())
