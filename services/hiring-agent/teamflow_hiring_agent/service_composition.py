"""Explicit startup composition for every hiring-agent HTTP capability.

The process entry point passes one immutable environment snapshot here.  No module
global reads credentials, constructs a model, or starts an MCP subprocess.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .composition import TenantScopedHiringRuntime, compose_tenant_scoped_runtime
from .config import HumanReviewRuntimeSettings, Settings
from .mcp.client import MCPStdioConnection, MCPToolSessionSource
from .resume_review.hitl.runtime import HumanReviewRuntime
from .resume_review.persistence import SupabaseReviewWriter
from .resume_review.runtime import LangGraphResumeReviewWorkflow

_MCP_MODULE = "teamflow_hiring_agent.mcp.server"
_READER_CHILD_KEYS = (
    "GOOGLE_API_KEY",
    "SUPABASE_HIRING_READER_TOKEN",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_TRUSTED_ORIGIN",
    "SUPABASE_URL",
)
_OPTIONAL_CHILD_KEYS = (
    "GOOGLE_CLOUD_PROJECT",
    "OTEL_TRACES_SAMPLER_ARG",
)


class HiringServiceCompositionError(RuntimeError):
    """A sanitized service-assembly failure."""


class ToolSourceFactory(Protocol):
    def __call__(self, connection: MCPStdioConnection) -> Any: ...


class ResumeReviewWorkflowFactory(Protocol):
    def __call__(
        self,
        tool_source: Any,
        *,
        merchant_id: str,
        settings: Settings,
        review_writer: Any | None,
    ) -> Any: ...


class HumanReviewRuntimeFactory(Protocol):
    def __call__(
        self,
        settings: HumanReviewRuntimeSettings,
        *,
        analysis_runner: Any,
    ) -> HumanReviewRuntime: ...


@dataclass(frozen=True, slots=True)
class HiringServiceComponents:
    """One tenant-bound set of already-composed HTTP dependencies."""

    hiring_runtime: TenantScopedHiringRuntime
    resume_review_workflow: Any = field(repr=False)
    hitl_runtime: HumanReviewRuntime = field(repr=False)


def _configuration_error() -> HiringServiceCompositionError:
    return HiringServiceCompositionError("hiring_service_composition_invalid")


def _required(snapshot: Mapping[str, str], name: str) -> str:
    try:
        value = snapshot.get(name, "")
    except Exception:
        raise _configuration_error() from None
    if type(value) is not str or not value:
        raise _configuration_error()
    return value


def _child_environment(
    snapshot: Mapping[str, str],
    runtime: TenantScopedHiringRuntime,
) -> dict[str, str]:
    child = {
        "ENVIRONMENT": runtime.environment,
        "HIRING_AGENT_MOCK_TOOLS": "true" if runtime.mock_tools else "false",
    }
    if not runtime.mock_tools:
        child.update({name: _required(snapshot, name) for name in _READER_CHILD_KEYS})
    for name in _OPTIONAL_CHILD_KEYS:
        value = snapshot.get(name, "")
        if value:
            child[name] = _required(snapshot, name)
    return child


def _review_writer(
    snapshot: Mapping[str, str],
    runtime: TenantScopedHiringRuntime,
) -> SupabaseReviewWriter | None:
    allow_writes = snapshot.get("AGENT_ALLOW_WRITES", "false")
    writer_token = snapshot.get("SUPABASE_REVIEW_WRITER_TOKEN", "")
    if allow_writes not in {"true", "false"}:
        raise _configuration_error()
    if allow_writes == "false":
        if writer_token:
            raise _configuration_error()
        return None
    if runtime.mock_tools:
        raise _configuration_error()
    try:
        return SupabaseReviewWriter(
            url=_required(snapshot, "SUPABASE_URL"),
            trusted_origin=_required(snapshot, "SUPABASE_TRUSTED_ORIGIN"),
            api_key=_required(snapshot, "SUPABASE_PUBLISHABLE_KEY"),
            access_token=_required(snapshot, "SUPABASE_REVIEW_WRITER_TOKEN"),
            production=runtime.environment == "production",
            timeout_seconds=5.0,
        )
    except Exception:
        raise _configuration_error() from None


def compose_hiring_service(
    environ: Mapping[str, str],
    *,
    python_executable: str | Path | None = None,
    service_directory: str | Path | None = None,
    hiring_runtime_factory: Any = compose_tenant_scoped_runtime,
    tool_source_factory: ToolSourceFactory = MCPToolSessionSource,
    resume_review_workflow_factory: ResumeReviewWorkflowFactory = (LangGraphResumeReviewWorkflow),
    human_review_runtime_factory: HumanReviewRuntimeFactory = HumanReviewRuntime,
) -> HiringServiceComponents:
    """Assemble v1 and optional v2 review beside the existing hiring workflow."""

    try:
        if not isinstance(environ, Mapping):
            raise TypeError
        settings = Settings.from_env(environ)
        hiring_runtime = hiring_runtime_factory(environ)
        if not isinstance(hiring_runtime, TenantScopedHiringRuntime):
            raise TypeError
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
            environment=_child_environment(environ, hiring_runtime),
        )
        tool_source = tool_source_factory(connection)
        review_workflow = resume_review_workflow_factory(
            tool_source,
            merchant_id=hiring_runtime.merchant_id,
            settings=settings,
            review_writer=_review_writer(environ, hiring_runtime),
        )
        hitl_runtime = human_review_runtime_factory(
            HumanReviewRuntimeSettings.from_env(environ),
            analysis_runner=review_workflow,
        )
        if not isinstance(hitl_runtime, HumanReviewRuntime):
            raise TypeError
        return HiringServiceComponents(
            hiring_runtime=hiring_runtime,
            resume_review_workflow=review_workflow,
            hitl_runtime=hitl_runtime,
        )
    except HiringServiceCompositionError:
        raise
    except Exception:
        raise _configuration_error() from None


__all__ = [
    "HiringServiceComponents",
    "HiringServiceCompositionError",
    "compose_hiring_service",
]
