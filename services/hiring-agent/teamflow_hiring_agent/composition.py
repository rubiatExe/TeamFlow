"""Tenant-bound composition root for the hiring decision workflow.

The graph runtime intentionally knows nothing about processes or credentials.  This
module closes that dependency chain once at service startup: a scoped Supabase token
is projected into an isolated MCP child process, the validated MCP catalog is bound
to Gemini, and one bounded workflow instance is retained for all HTTP invocations.

The JWT payload inspection here is only a local fail-closed routing check.  It does
not authenticate the token; Supabase verifies the token before its Data API applies
the database role and row-level policies.
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

from .config import Settings
from .contracts import HiringAgentOutput, HiringAgentRequest
from .mcp.client import MCPStdioConnection, MCPToolSessionSource
from .providers import GeminiGraphDependencyProvider
from .runtime import BoundedHiringWorkflow, HiringWorkflowRequestError, HiringWorkflowRunner
from .supabase_http import scoped_merchant_id_from_jwt, validate_supabase_origin

_MCP_MODULE = "teamflow_hiring_agent.mcp.server"
_VALID_ENVIRONMENTS = frozenset({"development", "test", "production"})
_PRIVILEGED_SUPABASE_KEYS = (
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
)
_READER_ENVIRONMENT_KEYS = (
    "SUPABASE_URL",
    "SUPABASE_TRUSTED_ORIGIN",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_HIRING_READER_TOKEN",
)
_OPTIONAL_CHILD_ENVIRONMENT_KEYS = (
    "GOOGLE_CLOUD_PROJECT",
    "OTEL_TRACES_SAMPLER_ARG",
)
_PUBLISHABLE_KEY_RE = re.compile(r"^sb_publishable_[A-Za-z0-9_-]{20,8192}$")


class HiringCompositionError(RuntimeError):
    """A sanitized startup configuration or dependency-composition failure."""


class HiringTenantScopeError(PermissionError):
    """A request attempted to cross the composed runtime's tenant boundary."""


class HiringRuntimeUnavailableError(RuntimeError):
    """The runtime's scoped data credential is no longer usable."""


class ToolSourceFactory(Protocol):
    def __call__(self, connection: MCPStdioConnection) -> Any: ...


class DependencyProviderFactory(Protocol):
    def __call__(self, tool_source: Any, *, settings: Settings) -> Any: ...


class WorkflowFactory(Protocol):
    def __call__(self, provider: Any, *, settings: Settings) -> HiringWorkflowRunner: ...


@dataclass(frozen=True, slots=True)
class TenantScopedHiringRuntime:
    """One long-lived workflow whose data authority is fixed to one merchant."""

    merchant_id: str
    environment: str
    mock_tools: bool
    workflow: HiringWorkflowRunner = field(repr=False)
    reader_token: str = field(default="", repr=False)
    _invocation: Any = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if _canonical_database_id(self.merchant_id) != self.merchant_id:
            raise HiringCompositionError("hiring_composition_configuration_invalid")
        if (
            type(self.environment) is not str
            or self.environment not in _VALID_ENVIRONMENTS
            or type(self.mock_tools) is not bool
        ):
            raise HiringCompositionError("hiring_composition_configuration_invalid")
        try:
            invocation = getattr(self.workflow, "invoke", None)
        except Exception:
            invocation = None
        if not callable(invocation):
            raise HiringCompositionError("hiring_composition_dependency_invalid")
        if self.mock_tools:
            if self.reader_token:
                raise HiringCompositionError("hiring_composition_configuration_invalid")
        else:
            try:
                token_merchant_id = scoped_merchant_id_from_jwt(
                    self.reader_token,
                    expected_role="teamflow_hiring_reader",
                )
            except ValueError:
                raise HiringCompositionError("hiring_composition_configuration_invalid") from None
            if token_merchant_id != self.merchant_id:
                raise HiringCompositionError("hiring_composition_configuration_invalid")
        object.__setattr__(self, "_invocation", invocation)

    @property
    def ready(self) -> bool:
        """Return whether this runtime still holds a usable tenant credential."""

        if self.mock_tools:
            return self.environment != "production" and not self.reader_token
        try:
            return (
                scoped_merchant_id_from_jwt(
                    self.reader_token,
                    expected_role="teamflow_hiring_reader",
                )
                == self.merchant_id
            )
        except ValueError:
            return False

    async def invoke(self, request: HiringAgentRequest) -> HiringAgentOutput:
        """Validate and bind tenant scope before the underlying workflow can run."""

        try:
            if not isinstance(request, HiringAgentRequest):
                raise TypeError
            validated = HiringAgentRequest.model_validate(request.model_dump(mode="python"))
        except Exception:
            raise HiringWorkflowRequestError("hiring_workflow_request_invalid") from None
        if not self.ready:
            raise HiringRuntimeUnavailableError("hiring_runtime_credentials_unavailable")
        if str(validated.merchant_id) != self.merchant_id:
            raise HiringTenantScopeError("hiring_tenant_scope_mismatch")
        return await self._invocation(validated)


def _configuration_error() -> HiringCompositionError:
    return HiringCompositionError("hiring_composition_configuration_invalid")


def _snapshot_environment(environ: Mapping[str, str] | None) -> dict[str, str]:
    try:
        source = os.environ if environ is None else environ
        if not isinstance(source, Mapping):
            raise TypeError
        snapshot = dict(source)
    except Exception:
        raise _configuration_error() from None
    if any(type(key) is not str or type(value) is not str for key, value in snapshot.items()):
        raise _configuration_error()
    return snapshot


def _canonical_database_id(value: object) -> str:
    if type(value) is not str or not value or value != value.strip():
        raise _configuration_error()
    try:
        canonical = str(UUID(value))
    except (ValueError, AttributeError, TypeError):
        raise _configuration_error() from None
    if value != canonical:
        raise _configuration_error()
    return canonical


def _required_environment(snapshot: Mapping[str, str], name: str) -> str:
    value = snapshot.get(name, "")
    if not value or value != value.strip() or any(character.isspace() for character in value):
        raise _configuration_error()
    return value


def _runtime_environment(snapshot: Mapping[str, str]) -> str:
    value = snapshot.get("ENVIRONMENT", "development")
    if value not in _VALID_ENVIRONMENTS:
        raise _configuration_error()
    return value


def _mock_mode(snapshot: Mapping[str, str], *, environment: str) -> bool:
    value = snapshot.get("HIRING_AGENT_MOCK_TOOLS", "false")
    if value not in {"true", "false"}:
        raise _configuration_error()
    enabled = value == "true"
    if enabled and environment == "production":
        raise _configuration_error()
    return enabled


def _tenant_and_child_environment(
    snapshot: Mapping[str, str],
    *,
    environment: str,
    mock_tools: bool,
) -> tuple[str, dict[str, str]]:
    if any(snapshot.get(name, "") for name in _PRIVILEGED_SUPABASE_KEYS):
        raise _configuration_error()

    child_environment = {
        "ENVIRONMENT": environment,
        "HIRING_AGENT_MOCK_TOOLS": "true" if mock_tools else "false",
    }
    if mock_tools:
        if any(snapshot.get(name, "") for name in _READER_ENVIRONMENT_KEYS):
            raise _configuration_error()
        merchant_id = _canonical_database_id(snapshot.get("HIRING_AGENT_MERCHANT_ID", ""))
    else:
        reader_environment = {
            name: _required_environment(snapshot, name) for name in _READER_ENVIRONMENT_KEYS
        }
        reader_environment["GOOGLE_API_KEY"] = _required_environment(snapshot, "GOOGLE_API_KEY")
        if _PUBLISHABLE_KEY_RE.fullmatch(reader_environment["SUPABASE_PUBLISHABLE_KEY"]) is None:
            raise _configuration_error()
        try:
            validate_supabase_origin(
                reader_environment["SUPABASE_URL"],
                reader_environment["SUPABASE_TRUSTED_ORIGIN"],
                production=environment == "production",
            )
            merchant_id = scoped_merchant_id_from_jwt(
                reader_environment["SUPABASE_HIRING_READER_TOKEN"],
                expected_role="teamflow_hiring_reader",
            )
        except ValueError:
            raise _configuration_error() from None
        declared_merchant = snapshot.get("HIRING_AGENT_MERCHANT_ID", "")
        if declared_merchant and _canonical_database_id(declared_merchant) != merchant_id:
            raise _configuration_error()
        child_environment.update(reader_environment)

    for name in _OPTIONAL_CHILD_ENVIRONMENT_KEYS:
        value = snapshot.get(name, "")
        if value:
            child_environment[name] = _required_environment(snapshot, name)
    return merchant_id, child_environment


def compose_tenant_scoped_runtime(
    environ: Mapping[str, str] | None = None,
    *,
    python_executable: str | Path | None = None,
    service_directory: str | Path | None = None,
    tool_source_factory: ToolSourceFactory = MCPToolSessionSource,
    dependency_provider_factory: DependencyProviderFactory = GeminiGraphDependencyProvider,
    workflow_factory: WorkflowFactory = BoundedHiringWorkflow,
) -> TenantScopedHiringRuntime:
    """Build the complete workflow once from one immutable environment snapshot."""

    snapshot = _snapshot_environment(environ)
    try:
        settings = Settings.from_env(snapshot)
        if not settings.google_api_key:
            raise ValueError
        environment = _runtime_environment(snapshot)
        mock_tools = _mock_mode(snapshot, environment=environment)
        merchant_id, child_environment = _tenant_and_child_environment(
            snapshot,
            environment=environment,
            mock_tools=mock_tools,
        )

        executable = Path(sys.executable if python_executable is None else python_executable)
        root = (
            Path(__file__).resolve().parents[1]
            if service_directory is None
            else Path(service_directory)
        )
        connection = MCPStdioConnection(
            command=str(executable),
            args=("-m", _MCP_MODULE),
            cwd=root,
            environment=child_environment,
        )
    except Exception:
        raise _configuration_error() from None

    try:
        tool_source = tool_source_factory(connection)
        provider = dependency_provider_factory(tool_source, settings=settings)
        workflow = workflow_factory(provider, settings=settings)
        return TenantScopedHiringRuntime(
            merchant_id=merchant_id,
            environment=environment,
            mock_tools=mock_tools,
            workflow=workflow,
            reader_token=("" if mock_tools else child_environment["SUPABASE_HIRING_READER_TOKEN"]),
        )
    except Exception:
        raise HiringCompositionError("hiring_composition_dependency_invalid") from None


__all__ = [
    "HiringCompositionError",
    "HiringRuntimeUnavailableError",
    "HiringTenantScopeError",
    "TenantScopedHiringRuntime",
    "compose_tenant_scoped_runtime",
]
