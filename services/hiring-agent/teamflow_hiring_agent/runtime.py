"""Bounded, dependency-injected execution for the hiring decision graph.

Concrete model and tool transports intentionally live outside this module. A
composition root must provide one invocation-scoped dependency session whose
tool inventory exactly matches the request. Keeping that boundary explicit
lets this runtime enforce budgets without importing credentials, provider SDKs,
or a writable connector.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Protocol

from opentelemetry import trace

from .config import Settings
from .contracts import HiringAgentOutput, HiringAgentRequest, HiringOperation
from .graph import build_hiring_graph
from .graph.nodes import HUMAN_REVIEW_NOTICE, SEARCH_TOOLS, GraphDependencies

tracer = trace.get_tracer("teamflow.hiring_agent.runtime", "2.1.0")

_GET_CANDIDATE_TOOL = "get_candidate"
_GET_JOB_REQUIREMENTS_TOOL = "get_job_requirements"
_GRAPH_RECURSION_LIMIT = 20


class HiringWorkflowBusyError(RuntimeError):
    """The per-instance concurrency budget could not be acquired in time."""


class HiringWorkflowTimeoutError(RuntimeError):
    """The invocation exceeded its configured end-to-end execution budget."""


class HiringWorkflowDependencyError(RuntimeError):
    """The injected invocation dependencies violated the runtime contract."""


class HiringWorkflowExecutionError(RuntimeError):
    """The dependency session or graph failed without a safe public result."""


class HiringWorkflowResultError(RuntimeError):
    """The graph returned an invalid or incorrectly correlated result."""


class HiringWorkflowRequestError(ValueError):
    """The caller bypassed the validated request boundary."""


class _WorkflowDeadlineExpired(TimeoutError):
    """Private marker distinguishing our deadline from a dependency timeout."""


class _DependencyContractViolation(RuntimeError):
    """Private marker that cannot be spoofed through an injected dependency."""


class _ToolInventoryViolation(_DependencyContractViolation):
    """Private marker for a non-exact or inconsistent tool inventory."""


class _ResultContractViolation(RuntimeError):
    """Private marker that cannot be spoofed through an injected graph result."""


class HiringWorkflowRunner(Protocol):
    async def invoke(self, request: HiringAgentRequest) -> HiringAgentOutput: ...


class CompiledHiringGraph(Protocol):
    async def ainvoke(
        self,
        input: Mapping[str, Any],
        config: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...


class HiringGraphBuilder(Protocol):
    def __call__(
        self,
        dependencies: GraphDependencies,
        *,
        max_tool_rounds: int,
        max_tool_calls_per_round: int,
        model_timeout_seconds: float,
        tool_timeout_seconds: float,
    ) -> CompiledHiringGraph: ...


@dataclass(frozen=True, slots=True)
class HiringDependencyPlan:
    """Identifier-free capability plan passed across the provider seam."""

    operation: HiringOperation
    tool_names: tuple[str, ...]
    reasoning_tool_names: tuple[str, ...]


class GraphDependencyProvider(Protocol):
    """Open models and exact read-only tools for an identifier-free plan."""

    def open(
        self,
        plan: HiringDependencyPlan,
    ) -> AbstractAsyncContextManager[GraphDependencies]: ...


def _expected_tool_names(request: HiringAgentRequest) -> tuple[str, ...]:
    if request.has_explicit_write:
        return ()
    names: list[str] = []
    if request.candidate_id is not None:
        names.append(_GET_CANDIDATE_TOOL)
    if request.role_id is not None:
        names.append(_GET_JOB_REQUIREMENTS_TOOL)
    if request.operation == HiringOperation.SEARCH_CANDIDATES:
        names.extend(SEARCH_TOOLS)
    return tuple(names)


def _dependency_plan(request: HiringAgentRequest) -> HiringDependencyPlan:
    return HiringDependencyPlan(
        operation=request.operation,
        tool_names=_expected_tool_names(request),
        reasoning_tool_names=(
            tuple(SEARCH_TOOLS)
            if request.operation == HiringOperation.SEARCH_CANDIDATES
            and not request.has_explicit_write
            else ()
        ),
    )


def _validated_request(request: object) -> HiringAgentRequest:
    invalid = not isinstance(request, HiringAgentRequest)
    validated: HiringAgentRequest | None = None
    if not invalid:
        try:
            validated = HiringAgentRequest.model_validate(request.model_dump(mode="python"))
        except Exception:
            invalid = True
    if invalid or validated is None:
        raise HiringWorkflowRequestError("hiring_workflow_request_invalid")
    return validated


def _validated_dependencies(
    dependencies: object,
    *,
    request: HiringAgentRequest,
) -> GraphDependencies:
    if not isinstance(dependencies, GraphDependencies):
        raise _DependencyContractViolation

    expected = _expected_tool_names(request)
    invalid_mapping = False
    try:
        tool_items = tuple(dependencies.tools.items())
    except Exception:
        invalid_mapping = True
        tool_items = ()
    if invalid_mapping:
        raise _DependencyContractViolation

    actual_names = tuple(name for name, _ in tool_items)
    if (
        len(actual_names) != len(set(actual_names))
        or set(actual_names) != set(expected)
        or any(not isinstance(name, str) for name in actual_names)
    ):
        raise _ToolInventoryViolation

    for name, tool in tool_items:
        invalid_tool = False
        try:
            declared_name = tool.name
        except Exception:
            invalid_tool = True
            declared_name = None
        try:
            invocation = getattr(tool, "ainvoke", None)
        except Exception:
            invalid_tool = True
            invocation = None
        if invalid_tool or declared_name != name or not callable(invocation):
            raise _ToolInventoryViolation

    invalid_models = False
    try:
        reasoning_invocation = getattr(dependencies.reasoning_model, "ainvoke", None)
        structured_invocation = getattr(dependencies.structured_model, "ainvoke", None)
    except Exception:
        invalid_models = True
        reasoning_invocation = None
        structured_invocation = None
    if invalid_models or not callable(reasoning_invocation) or not callable(structured_invocation):
        raise _DependencyContractViolation

    # Normalize potentially custom mappings once so graph execution observes the
    # same validated inventory for the complete invocation.
    return GraphDependencies(
        reasoning_model=dependencies.reasoning_model,
        structured_model=dependencies.structured_model,
        tools=dict(tool_items),
    )


def _initial_state(request: HiringAgentRequest) -> dict[str, Any]:
    return {
        "request": request,
        "messages": [],
        "tool_calls": [],
        "tool_rounds": 0,
        "warnings": [],
        "status": "complete",
        "write_status": "skipped" if request.has_explicit_write else "not_requested",
    }


def _validated_output(
    final_state: object,
    *,
    request: HiringAgentRequest,
) -> HiringAgentOutput:
    invalid = False
    raw_output: object = None
    if isinstance(final_state, Mapping):
        raw_output = final_state.get("output")
    else:
        invalid = True

    if isinstance(raw_output, HiringAgentOutput):
        raw_output = raw_output.model_dump(mode="python")
    try:
        output = HiringAgentOutput.model_validate(raw_output)
    except (TypeError, ValueError):
        invalid = True
        output = None

    if invalid or output is None:
        raise _ResultContractViolation

    expected_request_id = str(request.request_id)
    expected_tools = set(_expected_tool_names(request))
    tool_names = output.tool_calls
    if (
        output.request_id != expected_request_id
        or len(tool_names) != len(set(tool_names))
        or not set(tool_names).issubset(expected_tools)
        or not output.recommendation.endswith(HUMAN_REVIEW_NOTICE)
    ):
        raise _ResultContractViolation

    if output.fit_score is not None and not (
        request.operation == HiringOperation.REVIEW_CANDIDATE
        and request.candidate_id is not None
        and request.role_id is not None
        and not request.has_explicit_write
        and output.status != "refused"
    ):
        raise _ResultContractViolation

    if request.has_explicit_write:
        if (
            output.write_status not in {"failed", "skipped"}
            or output.fit_score is not None
            or output.status not in {"degraded", "refused"}
        ):
            raise _ResultContractViolation
    elif output.write_status != "not_requested":
        raise _ResultContractViolation

    return output


class BoundedHiringWorkflow:
    """Run an injected graph under queue, concurrency, and workflow budgets.

    The concurrency limit is shared by invocations of this runtime instance. A
    future service composition root must therefore construct one long-lived
    instance rather than a new instance for every request.
    """

    def __init__(
        self,
        dependency_provider: GraphDependencyProvider,
        *,
        settings: Settings | None = None,
        graph_builder: HiringGraphBuilder = build_hiring_graph,
    ) -> None:
        self._settings = settings or Settings.from_env()
        self._dependency_provider = dependency_provider
        self._graph_builder = graph_builder
        self._semaphore = asyncio.BoundedSemaphore(self._settings.max_concurrency)

    async def _acquire_permit(self) -> None:
        acquire_task = asyncio.create_task(self._semaphore.acquire())
        try:
            await asyncio.wait_for(
                asyncio.shield(acquire_task),
                timeout=self._settings.queue_timeout_seconds,
            )
        except BaseException:
            acquire_task.cancel()
            try:
                acquired = await acquire_task
            except asyncio.CancelledError:
                acquired = False
            if acquired:
                self._semaphore.release()
            raise

    async def _invoke_with_permit(self, request: HiringAgentRequest) -> HiringAgentOutput:
        deadline = asyncio.timeout(self._settings.workflow_timeout_seconds)
        deadline_expired = False
        try:
            async with deadline:
                async with self._dependency_provider.open(
                    _dependency_plan(request)
                ) as raw_dependencies:
                    dependencies = _validated_dependencies(raw_dependencies, request=request)
                    graph = self._graph_builder(
                        dependencies,
                        max_tool_rounds=self._settings.max_tool_rounds,
                        max_tool_calls_per_round=self._settings.max_tool_calls_per_round,
                        model_timeout_seconds=self._settings.model_timeout_seconds,
                        tool_timeout_seconds=self._settings.tool_timeout_seconds,
                    )
                    final_state = await graph.ainvoke(
                        _initial_state(request),
                        config={"recursion_limit": _GRAPH_RECURSION_LIMIT},
                    )
                    return _validated_output(final_state, request=request)
        except TimeoutError:
            if not deadline.expired():
                raise
            deadline_expired = True
        if deadline_expired:
            raise _WorkflowDeadlineExpired
        raise AssertionError("unreachable")  # pragma: no cover

    async def invoke(self, request: HiringAgentRequest) -> HiringAgentOutput:
        request = _validated_request(request)
        queue_error: RuntimeError | None = None
        try:
            await self._acquire_permit()
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            queue_error = HiringWorkflowBusyError("hiring_workflow_busy")
        except Exception:
            queue_error = HiringWorkflowExecutionError("hiring_workflow_failed")
        if queue_error is not None:
            raise queue_error

        invocation_error: RuntimeError | None = None
        result: HiringAgentOutput | None = None
        try:
            with tracer.start_as_current_span(
                "hiring_workflow.invoke",
                record_exception=False,
                set_status_on_exception=False,
            ):
                try:
                    result = await self._invoke_with_permit(request)
                except asyncio.CancelledError:
                    raise
                except _ToolInventoryViolation:
                    invocation_error = HiringWorkflowDependencyError(
                        "hiring_workflow_tool_inventory_invalid"
                    )
                except _DependencyContractViolation:
                    invocation_error = HiringWorkflowDependencyError(
                        "hiring_workflow_dependencies_invalid"
                    )
                except _ResultContractViolation:
                    invocation_error = HiringWorkflowResultError("hiring_workflow_result_invalid")
                except _WorkflowDeadlineExpired:
                    invocation_error = HiringWorkflowTimeoutError("hiring_workflow_timeout")
                except Exception:
                    invocation_error = HiringWorkflowExecutionError("hiring_workflow_failed")
        finally:
            self._semaphore.release()
        if invocation_error is not None:
            raise invocation_error
        if result is None:  # Defensive only; a graph cannot validly produce None.
            raise HiringWorkflowExecutionError("hiring_workflow_failed")
        return result


# Retain the service-facing name while the concrete provider composition remains
# a later, separately reviewed phase.
LangGraphHiringWorkflow = BoundedHiringWorkflow
