"""Minimal MCP stdio fixture used to verify real child-process cleanup."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

UUID_SCHEMA = {
    "type": "string",
    "pattern": (
        r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
        r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    ),
}
ANNOTATIONS = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": False,
}
TOOLS = [
    {
        "name": "get_candidate",
        "description": "Read one scoped candidate.",
        "inputSchema": {
            "type": "object",
            "properties": {"candidate_id": UUID_SCHEMA, "merchant_id": UUID_SCHEMA},
            "required": ["candidate_id", "merchant_id"],
            "additionalProperties": False,
        },
        "annotations": ANNOTATIONS,
    },
    {
        "name": "get_job_requirements",
        "description": "Read one scoped role.",
        "inputSchema": {
            "type": "object",
            "properties": {"role_id": UUID_SCHEMA, "merchant_id": UUID_SCHEMA},
            "required": ["role_id", "merchant_id"],
            "additionalProperties": False,
        },
        "annotations": ANNOTATIONS,
    },
    {
        "name": "list_candidates",
        "description": "List scoped candidates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "merchant_id": UUID_SCHEMA,
                "status_filter": {
                    "type": "string",
                    "enum": ["", "new", "invited", "interviewed", "hired", "rejected"],
                    "default": "",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 10},
            },
            "required": ["merchant_id"],
            "additionalProperties": False,
        },
        "annotations": ANNOTATIONS,
    },
    {
        "name": "semantic_search_candidates",
        "description": "Search scoped candidates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 4000},
                "merchant_id": UUID_SCHEMA,
                "top_k": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
                "threshold": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1,
                    "default": 0.5,
                },
            },
            "required": ["query", "merchant_id"],
            "additionalProperties": False,
        },
        "annotations": ANNOTATIONS,
    },
]


def _write(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    pid_path = Path(sys.argv[1])
    environment_path = Path(sys.argv[2])
    catalog = TOOLS[:-1] if len(sys.argv) > 3 and sys.argv[3] == "invalid" else TOOLS
    pid_path.write_text(str(os.getpid()), encoding="utf-8")
    inspected = {
        name: os.environ.get(name)
        for name in (
            "GOOGLE_API_KEY",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "OTEL_RESOURCE_ATTRIBUTES",
            "PYTHONPATH",
            "SECRET_CANARY",
            "SUPABASE_SERVICE_KEY",
        )
    }
    environment_path.write_text(json.dumps(inspected, sort_keys=True), encoding="utf-8")

    for line in sys.stdin:
        message = json.loads(line)
        method = message.get("method")
        request_id = message.get("id")
        if method == "initialize":
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "protocolVersion": message["params"]["protocolVersion"],
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "phase17-fixture", "version": "1.0.0"},
                    },
                }
            )
        elif method == "tools/list":
            _write({"jsonrpc": "2.0", "id": request_id, "result": {"tools": catalog}})
        elif request_id is not None:
            _write({"jsonrpc": "2.0", "id": request_id, "result": {}})


if __name__ == "__main__":
    main()
