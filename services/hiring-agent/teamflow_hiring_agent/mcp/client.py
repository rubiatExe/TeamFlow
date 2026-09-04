"""Validated, invocation-scoped MCP client composition.

This module deliberately does not select a TeamFlow MCP server. A later
composition root must inject an explicit stdio connection after the server and
its least-privilege data capabilities exist. Importing or constructing this
adapter never reads ambient environment variables or starts a child process.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Protocol

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import convert_mcp_tool_to_langchain_tool

_SERVER_NAME = "teamflow"
_MAXIMUM_TIMEOUT_SECONDS = 30.0
_DEFAULT_INITIALIZATION_TIMEOUT_SECONDS = 5.0
_DEFAULT_CATALOG_TIMEOUT_SECONDS = 5.0
_DEFAULT_CLEANUP_TIMEOUT_SECONDS = 5.0
_MAXIMUM_ARGUMENTS = 16
_MAXIMUM_ARGUMENT_LENGTH = 4_096
_MAXIMUM_ENVIRONMENT_VALUE_LENGTH = 8_192
_SAFE_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
_UUID_PATTERN = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

MCP_CHILD_ENVIRONMENT_KEYS = frozenset(
    {
        "ENVIRONMENT",
        "GOOGLE_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "HIRING_AGENT_MOCK_TOOLS",
        "OTEL_TRACES_SAMPLER_ARG",
        "SUPABASE_HIRING_READER_TOKEN",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_TRUSTED_ORIGIN",
        "SUPABASE_URL",
    }
)

MCP_TOOL_NAMES = (
    "get_candidate",
    "get_job_requirements",
    "list_candidates",
    "semantic_search_candidates",
)

_UUID_PROPERTY = {"type": "string", "pattern": _UUID_PATTERN}
_EXPECTED_INPUT_SCHEMAS: dict[str, dict[str, Any]] = {
    "get_candidate": {
        "type": "object",
        "properties": {
            "candidate_id": _UUID_PROPERTY,
            "merchant_id": _UUID_PROPERTY,
        },
        "required": ["candidate_id", "merchant_id"],
        "additionalProperties": False,
    },
    "get_job_requirements": {
        "type": "object",
        "properties": {
            "role_id": _UUID_PROPERTY,
            "merchant_id": _UUID_PROPERTY,
        },
        "required": ["role_id", "merchant_id"],
        "additionalProperties": False,
    },
    "list_candidates": {
        "type": "object",
        "properties": {
            "merchant_id": _UUID_PROPERTY,
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
    "semantic_search_candidates": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "minLength": 1, "maxLength": 4_000},
            "merchant_id": _UUID_PROPERTY,
            "top_k": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
            "threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.5},
        },
        "required": ["query", "merchant_id"],
        "additionalProperties": False,
    },
}
_EXPECTED_SCHEMA_JSON = {
    name: json.dumps(schema, sort_keys=True, separators=(",", ":"))
    for name, schema in _EXPECTED_INPUT_SCHEMAS.items()
}
_APPLICATION_TOOL_DESCRIPTIONS = {
    "get_candidate": "Read one merchant-scoped candidate evidence record by identifier.",
    "get_job_requirements": "Read one merchant-scoped role's hiring criteria by identifier.",
    "list_candidates": "List bounded candidate statuses within one merchant.",
    "semantic_search_candidates": "Search bounded candidate evidence within one merchant.",
}


class MCPClientConfigurationError(ValueError):
    """The injected stdio connection violated the local security contract."""


class MCPToolSessionError(RuntimeError):
    """A sanitized MCP session or catalog failure."""


class MCPClient(Protocol):
    def session(
        self,
        server_name: str,
        *,
        auto_initialize: bool = True,
    ) -> AbstractAsyncContextManager[Any]: ...


class MCPClientFactory(Protocol):
    def __call__(
        self,
        connections: dict[str, dict[str, Any]],
        *,
        handle_tool_errors: bool,
    ) -> MCPClient: ...


class MCPToolConverter(Protocol):
    def __call__(self, session: Any, tool: Any, **kwargs: Any) -> Any: ...


@dataclass(frozen=True, slots=True)
class _ApplicationAnnotations:
    """Application-owned metadata copied into converted LangChain tools."""

    readOnlyHint: bool = True
    destructiveHint: bool = False
    idempotentHint: bool = True
    openWorldHint: bool = False

    def model_dump(self) -> dict[str, bool]:
        return {
            "readOnlyHint": self.readOnlyHint,
            "destructiveHint": self.destructiveHint,
            "idempotentHint": self.idempotentHint,
            "openWorldHint": self.openWorldHint,
        }


@dataclass(frozen=True, slots=True)
class _ApplicationTool:
    """Minimal trusted view consumed by the pinned LangChain MCP converter."""

    name: str
    description: str
    inputSchema: dict[str, Any]
    annotations: _ApplicationAnnotations = _ApplicationAnnotations()
    meta: None = None


def _invalid_configuration() -> MCPClientConfigurationError:
    return MCPClientConfigurationError("mcp_client_configuration_invalid")


def _validated_timeout(value: object) -> float:
    if type(value) not in {int, float}:
        raise _invalid_configuration()
    try:
        normalized = float(value)
    except (TypeError, ValueError, OverflowError):
        raise _invalid_configuration() from None
    if not math.isfinite(normalized) or not 0.01 <= normalized <= _MAXIMUM_TIMEOUT_SECONDS:
        raise _invalid_configuration()
    return normalized


def _safe_text(value: object, *, maximum_length: int) -> str:
    if (
        type(value) is not str
        or not value
        or len(value) > maximum_length
        or not value.isprintable()
        or "\x00" in value
        or "\r" in value
        or "\n" in value
    ):
        raise _invalid_configuration()
    return value


@dataclass(frozen=True, slots=True, init=False)
class MCPStdioConnection:
    """Immutable, explicit stdio configuration with a secret-safe repr."""

    command: str
    args: tuple[str, ...]
    cwd: str
    _environment: tuple[tuple[str, str], ...] = field(repr=False)

    def __init__(
        self,
        *,
        command: str,
        args: Sequence[str],
        cwd: str | Path,
        environment: Mapping[str, str],
    ) -> None:
        normalized_command = _safe_text(command, maximum_length=_MAXIMUM_ARGUMENT_LENGTH)
        if not Path(normalized_command).is_absolute():
            raise _invalid_configuration()

        if isinstance(args, str | bytes) or not isinstance(args, Sequence):
            raise _invalid_configuration()
        if not 1 <= len(args) <= _MAXIMUM_ARGUMENTS:
            raise _invalid_configuration()
        normalized_args = tuple(
            _safe_text(argument, maximum_length=_MAXIMUM_ARGUMENT_LENGTH) for argument in args
        )

        if not isinstance(cwd, str | Path):
            raise _invalid_configuration()
        normalized_cwd = _safe_text(str(cwd), maximum_length=_MAXIMUM_ARGUMENT_LENGTH)
        if not Path(normalized_cwd).is_absolute():
            raise _invalid_configuration()

        if not isinstance(environment, Mapping):
            raise _invalid_configuration()
        if len(environment) > len(MCP_CHILD_ENVIRONMENT_KEYS):
            raise _invalid_configuration()
        normalized_environment: list[tuple[str, str]] = []
        for key, value in environment.items():
            if (
                type(key) is not str
                or _SAFE_NAME_RE.fullmatch(key) is None
                or key not in MCP_CHILD_ENVIRONMENT_KEYS
            ):
                raise _invalid_configuration()
            normalized_value = _safe_text(
                value,
                maximum_length=_MAXIMUM_ENVIRONMENT_VALUE_LENGTH,
            )
            # The adapter expands ${NAME} against the parent environment. Reject
            # expansion syntax so each child value is exactly the injected value.
            if "${" in normalized_value or any(
                character.isspace() for character in normalized_value
            ):
                raise _invalid_configuration()
            normalized_environment.append((key, normalized_value))

        environment_copy = dict(normalized_environment)
        environment_name = environment_copy.get("ENVIRONMENT")
        if environment_name is not None and environment_name not in {
            "development",
            "test",
            "production",
        }:
            raise _invalid_configuration()
        mock_mode = environment_copy.get("HIRING_AGENT_MOCK_TOOLS")
        if mock_mode is not None and mock_mode not in {"true", "false"}:
            raise _invalid_configuration()
        if environment_name == "production" and mock_mode == "true":
            raise _invalid_configuration()

        object.__setattr__(self, "command", normalized_command)
        object.__setattr__(self, "args", normalized_args)
        object.__setattr__(self, "cwd", normalized_cwd)
        object.__setattr__(self, "_environment", tuple(sorted(normalized_environment)))

    def adapter_config(self) -> dict[str, Any]:
        """Return a fresh adapter mapping so callers cannot mutate this value."""

        return {
            "transport": "stdio",
            "command": self.command,
            "args": list(self.args),
            "cwd": self.cwd,
            "env": dict(self._environment),
            "encoding": "utf-8",
            "encoding_error_handler": "strict",
        }


def _tool_annotations_are_read_only(tool: Any) -> bool:
    try:
        annotations = tool.annotations
        return (
            annotations is not None
            and annotations.readOnlyHint is True
            and annotations.destructiveHint is False
            and annotations.idempotentHint is True
            and annotations.openWorldHint is False
        )
    except Exception:
        return False


def _canonical_schema(tool: Any) -> str | None:
    try:
        schema = tool.inputSchema
        if not isinstance(schema, Mapping):
            return None
        return json.dumps(schema, sort_keys=True, separators=(",", ":"))
    except (AttributeError, TypeError, ValueError):
        return None


def _validated_raw_catalog(page: object) -> tuple[_ApplicationTool, ...]:
    try:
        page_tools = page.tools
        next_cursor = page.nextCursor
    except Exception:
        raise MCPToolSessionError("mcp_tool_catalog_invalid") from None
    if type(page_tools) is not list or len(page_tools) != len(MCP_TOOL_NAMES):
        raise MCPToolSessionError("mcp_tool_catalog_invalid")
    raw_tools = tuple(page_tools)

    names: list[str] = []
    for tool in raw_tools:
        try:
            name = tool.name
        except Exception:
            raise MCPToolSessionError("mcp_tool_catalog_invalid") from None
        if (
            type(name) is not str
            or name not in _EXPECTED_SCHEMA_JSON
            or _canonical_schema(tool) != _EXPECTED_SCHEMA_JSON[name]
            or not _tool_annotations_are_read_only(tool)
        ):
            raise MCPToolSessionError("mcp_tool_catalog_invalid")
        names.append(name)

    if (
        next_cursor not in {None, ""}
        or len(names) != len(set(names))
        or set(names) != set(MCP_TOOL_NAMES)
    ):
        raise MCPToolSessionError("mcp_tool_catalog_invalid")
    # Never bind server-authored descriptions, titles, output schemas, icons, or
    # metadata to a model. Only this application-owned, schema-pinned projection
    # crosses into the LangChain converter.
    return tuple(
        _ApplicationTool(
            name=name,
            description=_APPLICATION_TOOL_DESCRIPTIONS[name],
            inputSchema=_copy_schema(_EXPECTED_INPUT_SCHEMAS[name]),
        )
        for name in names
    )


def _copy_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """Copy a small JSON schema without accepting custom object hooks."""

    return json.loads(json.dumps(schema, separators=(",", ":")))


async def _close_session(
    manager: AbstractAsyncContextManager[Any],
    exception: tuple[type[BaseException] | None, BaseException | None, Any],
    *,
    timeout_seconds: float,
) -> bool:
    current_task = asyncio.current_task()
    cancellation_count = current_task.cancelling() if current_task is not None else 0
    try:
        async with asyncio.timeout(timeout_seconds):
            await manager.__aexit__(*exception)
    except TimeoutError:
        return False
    except asyncio.CancelledError:
        # A context manager can itself raise CancelledError. Only propagate when
        # this task received a new external cancellation while cleanup was running.
        if current_task is not None and current_task.cancelling() > cancellation_count:
            raise
        return False
    except Exception:
        return False
    return True


async def _session_owner(
    *,
    connection: MCPStdioConnection,
    ready: asyncio.Future[Mapping[str, Any] | None],
    close_requested: asyncio.Event,
    initialization_timeout_seconds: float,
    catalog_timeout_seconds: float,
    cleanup_timeout_seconds: float,
    client_factory: MCPClientFactory,
    tool_converter: MCPToolConverter,
) -> bool:
    """Own one MCP manager's enter, use, and exit in this task only."""

    manager: AbstractAsyncContextManager[Any] | None = None
    entered = False
    closed = False
    try:
        client = client_factory(
            {_SERVER_NAME: connection.adapter_config()},
            handle_tool_errors=False,
        )
        manager = client.session(_SERVER_NAME, auto_initialize=False)
        async with asyncio.timeout(initialization_timeout_seconds):
            session = await manager.__aenter__()
        entered = True
        async with asyncio.timeout(initialization_timeout_seconds):
            await session.initialize()
        async with asyncio.timeout(catalog_timeout_seconds):
            page = await session.list_tools()
        application_tools = _validated_raw_catalog(page)
        converted: dict[str, Any] = {}
        for application_tool in application_tools:
            tool = tool_converter(
                session,
                application_tool,
                server_name=_SERVER_NAME,
                tool_name_prefix=False,
                handle_tool_errors=False,
            )
            name = application_tool.name
            if (
                getattr(tool, "name", None) != name
                or not callable(getattr(tool, "ainvoke", None))
                or name in converted
            ):
                raise MCPToolSessionError("mcp_tool_catalog_invalid")
            converted[name] = tool
        ready.set_result(MappingProxyType(converted))
        await close_requested.wait()
    except asyncio.CancelledError:
        if not ready.done():
            ready.set_result(None)
    except Exception:
        if not ready.done():
            ready.set_result(None)
    finally:
        if entered and manager is not None:
            closed = await _close_session(
                manager,
                (None, None, None),
                timeout_seconds=cleanup_timeout_seconds,
            )
    return closed


def _consume_owner_result(task: asyncio.Future[bool]) -> None:
    if task.cancelled():
        return
    try:
        task.exception()
    except BaseException:
        pass


async def _wait_for_owner(
    owner: asyncio.Task[bool],
    *,
    timeout_seconds: float,
) -> bool:
    """Wait for the owner without moving its AnyIO cancel scopes to this task."""

    try:
        async with asyncio.timeout(timeout_seconds):
            return await asyncio.shield(owner)
    except asyncio.CancelledError:
        owner.add_done_callback(_consume_owner_result)
        raise
    except Exception:
        owner.cancel()
        owner.add_done_callback(_consume_owner_result)
        return False


class MCPToolSessionSource:
    """Load one exact, read-only MCP tool catalog for each invocation."""

    def __init__(
        self,
        connection: MCPStdioConnection,
        *,
        initialization_timeout_seconds: float = _DEFAULT_INITIALIZATION_TIMEOUT_SECONDS,
        catalog_timeout_seconds: float = _DEFAULT_CATALOG_TIMEOUT_SECONDS,
        cleanup_timeout_seconds: float = _DEFAULT_CLEANUP_TIMEOUT_SECONDS,
        client_factory: MCPClientFactory = MultiServerMCPClient,
        tool_converter: MCPToolConverter = convert_mcp_tool_to_langchain_tool,
    ) -> None:
        if not isinstance(connection, MCPStdioConnection):
            raise _invalid_configuration()
        self._connection = connection
        self._initialization_timeout_seconds = _validated_timeout(initialization_timeout_seconds)
        self._catalog_timeout_seconds = _validated_timeout(catalog_timeout_seconds)
        self._cleanup_timeout_seconds = _validated_timeout(cleanup_timeout_seconds)
        self._client_factory = client_factory
        self._tool_converter = tool_converter

    @asynccontextmanager
    async def tools(self) -> AsyncIterator[Mapping[str, Any]]:
        """Open, validate, and close one non-shared MCP session."""

        loop = asyncio.get_running_loop()
        ready: asyncio.Future[Mapping[str, Any] | None] = loop.create_future()
        close_requested = asyncio.Event()
        owner = asyncio.create_task(
            _session_owner(
                connection=self._connection,
                ready=ready,
                close_requested=close_requested,
                initialization_timeout_seconds=self._initialization_timeout_seconds,
                catalog_timeout_seconds=self._catalog_timeout_seconds,
                cleanup_timeout_seconds=self._cleanup_timeout_seconds,
                client_factory=self._client_factory,
                tool_converter=self._tool_converter,
            ),
            name="teamflow-mcp-session-owner",
        )

        open_timeout = (
            (self._initialization_timeout_seconds * 2) + self._catalog_timeout_seconds + 0.25
        )
        try:
            async with asyncio.timeout(open_timeout):
                catalog = await asyncio.shield(ready)
        except asyncio.CancelledError:
            owner.cancel()
            await _wait_for_owner(
                owner,
                timeout_seconds=self._cleanup_timeout_seconds + 0.25,
            )
            raise
        except (TimeoutError, Exception):
            owner.cancel()
            await _wait_for_owner(
                owner,
                timeout_seconds=self._cleanup_timeout_seconds + 0.25,
            )
            catalog = None

        if catalog is None:
            await _wait_for_owner(
                owner,
                timeout_seconds=self._cleanup_timeout_seconds + 0.25,
            )
            raise MCPToolSessionError("mcp_tool_session_failed")

        try:
            yield catalog
        except BaseException:
            close_requested.set()
            await _wait_for_owner(
                owner,
                timeout_seconds=self._cleanup_timeout_seconds + 0.25,
            )
            raise
        else:
            close_requested.set()
            closed = await _wait_for_owner(
                owner,
                timeout_seconds=self._cleanup_timeout_seconds + 0.25,
            )
            if not closed:
                raise MCPToolSessionError("mcp_tool_session_failed")


__all__ = [
    "MCP_CHILD_ENVIRONMENT_KEYS",
    "MCP_TOOL_NAMES",
    "MCPClientConfigurationError",
    "MCPStdioConnection",
    "MCPToolSessionError",
    "MCPToolSessionSource",
]
