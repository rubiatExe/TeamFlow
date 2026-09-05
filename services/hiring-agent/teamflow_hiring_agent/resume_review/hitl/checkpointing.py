"""Privacy-safe configuration for durable human-review checkpoints.

This module deliberately does not run ``AsyncPostgresSaver.setup()``. Checkpoint
schema changes are a controlled deployment migration, not an application-startup
side effect.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qs, urlsplit

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

HITL_GRAPH_VERSION = "1.0.0"
CHECKPOINT_SCHEMA = "teamflow_checkpoints"
CHECKPOINT_SEARCH_PATH = f"{CHECKPOINT_SCHEMA},pg_catalog"
CHECKPOINT_SEARCH_PATH_OPTION = f"-csearch_path={CHECKPOINT_SEARCH_PATH}"
CHECKPOINT_MIGRATOR_ROLE = "teamflow_checkpoint_migrator"
CHECKPOINT_RUNTIME_ROLE = "teamflow_checkpoint_runtime"
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SEMANTIC_VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_PRODUCTION_SSL_MODE = "verify-full"


class CheckpointConfigurationError(ValueError):
    """A sanitized, deterministic checkpoint configuration failure."""


def _require_uuid(value: str, *, field_name: str) -> str:
    if not isinstance(value, str) or not _UUID_RE.fullmatch(value):
        raise CheckpointConfigurationError(f"{field_name} must be a canonical UUID")
    return value


def stable_thread_id(
    *,
    merchant_id: str,
    request_id: str,
    graph_version: str = HITL_GRAPH_VERSION,
) -> str:
    """Derive a stable, opaque thread key from server-owned request identity."""

    merchant = _require_uuid(merchant_id, field_name="merchant_id")
    request = _require_uuid(request_id, field_name="request_id")
    if not isinstance(graph_version, str) or not _SEMANTIC_VERSION_RE.fullmatch(graph_version):
        raise CheckpointConfigurationError("graph_version must be a semantic version")
    canonical = f"teamflow:resume-review-hitl:{graph_version}:{merchant}:{request}"
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    major = graph_version.split(".", maxsplit=1)[0]
    return f"rrh-v{major}-{digest}"


def checkpoint_config(
    *,
    merchant_id: str,
    request_id: str,
    graph_version: str = HITL_GRAPH_VERSION,
) -> dict[str, Any]:
    """Build the only LangGraph config accepted by the lifecycle runner."""

    return {
        "configurable": {
            "thread_id": stable_thread_id(
                merchant_id=merchant_id,
                request_id=request_id,
                graph_version=graph_version,
            )
        },
        "recursion_limit": 10,
    }


def strict_checkpoint_serializer() -> JsonPlusSerializer:
    """Return a serializer with no pickle fallback and a strict symbol allowlist."""

    return JsonPlusSerializer(
        pickle_fallback=False,
        allowed_json_modules=(),
        allowed_msgpack_modules=(),
    )


def validate_checkpoint_dsn(
    dsn: str,
    *,
    production: bool,
    expected_username: str | None = None,
) -> str:
    """Validate a URI-form PostgreSQL DSN without exposing its credentials."""

    if not isinstance(dsn, str) or not dsn or dsn != dsn.strip():
        raise CheckpointConfigurationError("checkpoint DSN is required")
    malformed = False
    try:
        parsed = urlsplit(dsn)
        port = parsed.port
    except ValueError:
        malformed = True
        parsed = None
        port = None
    if malformed or parsed is None:
        raise CheckpointConfigurationError("checkpoint DSN is malformed")
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise CheckpointConfigurationError("checkpoint DSN must use PostgreSQL")
    if not parsed.hostname or not parsed.username or not parsed.path.removeprefix("/"):
        raise CheckpointConfigurationError(
            "checkpoint DSN must identify a host, user, and database"
        )
    if port is not None and not 1 <= port <= 65_535:
        raise CheckpointConfigurationError("checkpoint DSN port is invalid")
    if parsed.fragment:
        raise CheckpointConfigurationError("checkpoint DSN must not contain a fragment")
    if expected_username is not None and parsed.username != expected_username:
        raise CheckpointConfigurationError(
            "checkpoint DSN must authenticate as its dedicated database role"
        )

    malformed_query = False
    try:
        query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        malformed_query = True
        query = {}
    if malformed_query:
        raise CheckpointConfigurationError("checkpoint DSN query is malformed")
    normalized_query = {key.lower(): values for key, values in query.items()}
    if len(normalized_query) != len(query):
        raise CheckpointConfigurationError("checkpoint DSN query keys must be unique")
    ssl_modes = normalized_query.get("sslmode", [])
    if len(ssl_modes) > 1:
        raise CheckpointConfigurationError("checkpoint DSN sslmode must be unique")
    if production and (not ssl_modes or ssl_modes[0].lower() != _PRODUCTION_SSL_MODE):
        raise CheckpointConfigurationError("production checkpoint DSN requires sslmode=verify-full")
    return dsn


@asynccontextmanager
async def open_postgres_checkpointer(
    dsn: str,
    *,
    production: bool,
    min_pool_size: int = 1,
    max_pool_size: int = 2,
) -> AsyncIterator[BaseCheckpointSaver[Any]]:
    """Open a lifespan-scoped production saver without performing schema DDL."""

    validated_dsn = validate_checkpoint_dsn(
        dsn,
        production=production,
        expected_username=CHECKPOINT_RUNTIME_ROLE if production else None,
    )
    if not 1 <= min_pool_size <= max_pool_size <= 8:
        raise CheckpointConfigurationError("checkpoint pool size is invalid")

    # Imports remain local so deterministic unit tests do not need a running database.
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    pool = AsyncConnectionPool(
        conninfo=validated_dsn,
        min_size=min_pool_size,
        max_size=max_pool_size,
        open=False,
        kwargs={
            "autocommit": True,
            # Compatible with direct Postgres and transaction/session poolers.
            "prepare_threshold": None,
            "row_factory": dict_row,
            # Never allow a DSN- or role-provided path to move checkpoint data.
            "options": CHECKPOINT_SEARCH_PATH_OPTION,
        },
    )
    await pool.open(wait=True)
    try:
        yield AsyncPostgresSaver(pool, serde=strict_checkpoint_serializer())
    finally:
        await pool.close()
