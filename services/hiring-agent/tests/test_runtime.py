import asyncio
import traceback
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager
from typing import Any

import pytest

import teamflow_hiring_agent.runtime as runtime_module
from teamflow_hiring_agent.config import Settings
from teamflow_hiring_agent.contracts import (
    HiringAgentAnalysis,
    HiringAgentOutput,
    HiringAgentRequest,
    HiringOperation,
)
from teamflow_hiring_agent.graph.nodes import HUMAN_REVIEW_NOTICE, GraphDependencies
from teamflow_hiring_agent.runtime import (
    BoundedHiringWorkflow,
    HiringDependencyPlan,
    HiringWorkflowBusyError,
    HiringWorkflowDependencyError,
    HiringWorkflowExecutionError,
    HiringWorkflowResultError,
    HiringWorkflowTimeoutError,
    _expected_tool_names,
)

MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
CANDIDATE_ID = "00000000-0000-0000-0000-000000000002"
ROLE_ID = "00000000-0000-0000-0000-000000000003"


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "model": "gemini-test-primary",
        "fallback_model": "gemini-test-fallback",
        "google_api_key": "test-key",
        "max_tool_rounds": 2,
        "max_tool_calls_per_round": 3,
        "model_timeout_seconds": 5.0,
        "tool_timeout_seconds": 2.0,
        "workflow_timeout_seconds": 10.0,
        "max_concurrency": 2,
        "queue_timeout_seconds": 0.1,
        "max_request_bytes": 65_536,
    }
    values.update(overrides)
    return Settings(**values)


def _request(**overrides: Any) -> HiringAgentRequest:
    values: dict[str, Any] = {"merchantId": MERCHANT_ID}
    values.update(overrides)
    return HiringAgentRequest.model_validate(values)


def _output(
    request: HiringAgentRequest,
    *,
    tool_calls: list[str] | None = None,
    write_status: str | None = None,
    recommendation: str | None = None,
) -> HiringAgentOutput:
    return HiringAgentOutput.model_validate(
        {
            "summary": "The evidence requires human review.",
            "recommendation": recommendation
            or f"Compare the evidence with the role criteria. {HUMAN_REVIEW_NOTICE}",
            "fit_score": None,
            "analysis": HiringAgentAnalysis(
                limitations=["This is an advisory assessment."],
                confidence="low",
            ),
            "status": "complete",
            "write_status": write_status
            or ("skipped" if request.has_explicit_write else "not_requested"),
            "warnings": [],
            "request_id": str(request.request_id),
            "tool_calls": tool_calls or [],
        }
    )


class StubModel:
    async def ainvoke(self, input: Any, **kwargs: Any) -> Any:
        del input, kwargs
        return None


class StubTool:
    def __init__(self, name: str) -> None:
        self.name = name

    async def ainvoke(self, input: dict[str, Any], **kwargs: Any) -> Any:
        del input, kwargs
        return None


def _dependencies(*names: str) -> GraphDependencies:
    return GraphDependencies(
        reasoning_model=StubModel(),
        structured_model=StubModel(),
        tools={name: StubTool(name) for name in names},
    )


class StubProvider:
    def __init__(self, dependencies: GraphDependencies) -> None:
        self.dependencies = dependencies
        self.plans: list[HiringDependencyPlan] = []
        self.enter_count = 0
        self.exit_count = 0

    @asynccontextmanager
    async def open(self, plan: HiringDependencyPlan):
        self.plans.append(plan)
        self.enter_count += 1
        try:
            yield self.dependencies
        finally:
            self.exit_count += 1


class StubGraph:
    def __init__(
        self,
        result: Callable[[HiringAgentRequest], Mapping[str, Any]],
    ) -> None:
        self._result = result
        self.calls: list[tuple[Mapping[str, Any], Mapping[str, Any]]] = []

    async def ainvoke(
        self,
        input: Mapping[str, Any],
        config: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        self.calls.append((input, config))
        return self._result(input["request"])


class StubBuilder:
    def __init__(self, graph: Any) -> None:
        self.graph = graph
        self.calls: list[tuple[GraphDependencies, dict[str, Any]]] = []

    def __call__(self, dependencies: GraphDependencies, **kwargs: Any) -> Any:
        self.calls.append((dependencies, kwargs))
        return self.graph


def test_runtime_passes_every_graph_budget_and_canonical_initial_state() -> None:
    request = _request(candidateId=CANDIDATE_ID, roleId=ROLE_ID)
    provider = StubProvider(_dependencies("get_candidate", "get_job_requirements"))
    graph = StubGraph(lambda current: {"output": _output(current)})
    builder = StubBuilder(graph)
    workflow = BoundedHiringWorkflow(
        provider,
        settings=_settings(),
        graph_builder=builder,
    )

    result = asyncio.run(workflow.invoke(request))

    assert result.request_id == str(request.request_id)
    assert provider.plans == [
        HiringDependencyPlan(
            operation=HiringOperation.REVIEW_CANDIDATE,
            tool_names=("get_candidate", "get_job_requirements"),
            reasoning_tool_names=(),
        )
    ]
    assert provider.enter_count == provider.exit_count == 1
    assert len(builder.calls) == 1
    dependencies, budgets = builder.calls[0]
    assert set(dependencies.tools) == {"get_candidate", "get_job_requirements"}
    assert budgets == {
        "max_tool_rounds": 2,
        "max_tool_calls_per_round": 3,
        "model_timeout_seconds": 5.0,
        "tool_timeout_seconds": 2.0,
    }
    initial_state, config = graph.calls[0]
    assert initial_state == {
        "request": request,
        "messages": [],
        "tool_calls": [],
        "tool_rounds": 0,
        "warnings": [],
        "status": "complete",
        "write_status": "not_requested",
    }
    assert config == {"recursion_limit": 20}


@pytest.mark.parametrize(
    ("workflow_request", "expected"),
    [
        (_request(), ()),
        (_request(candidateId=CANDIDATE_ID), ("get_candidate",)),
        (_request(roleId=ROLE_ID), ("get_job_requirements",)),
        (
            _request(
                candidateId=CANDIDATE_ID,
                roleId=ROLE_ID,
                score=80,
                analysis={"evidence": ["Relevant experience."]},
            ),
            (),
        ),
        (
            _request(
                operation=HiringOperation.SEARCH_CANDIDATES,
                instructions="Find candidates with barista experience.",
            ),
            ("list_candidates", "semantic_search_candidates"),
        ),
        (
            _request(
                roleId=ROLE_ID,
                operation=HiringOperation.SEARCH_CANDIDATES,
                instructions="Find candidates matching the role.",
            ),
            (
                "get_job_requirements",
                "list_candidates",
                "semantic_search_candidates",
            ),
        ),
    ],
)
def test_expected_tool_inventory_is_operation_and_request_specific(
    workflow_request: HiringAgentRequest,
    expected: tuple[str, ...],
) -> None:
    assert _expected_tool_names(workflow_request) == expected


def test_provider_receives_only_an_identifier_free_search_capability_plan() -> None:
    instructions = "private search instructions that must stay inside the graph"
    request = _request(
        roleId=ROLE_ID,
        operation=HiringOperation.SEARCH_CANDIDATES,
        instructions=instructions,
    )
    provider = StubProvider(
        _dependencies(
            "get_job_requirements",
            "list_candidates",
            "semantic_search_candidates",
        )
    )
    workflow = BoundedHiringWorkflow(
        provider,
        settings=_settings(),
        graph_builder=StubBuilder(StubGraph(lambda current: {"output": _output(current)})),
    )

    asyncio.run(workflow.invoke(request))

    assert provider.plans == [
        HiringDependencyPlan(
            operation=HiringOperation.SEARCH_CANDIDATES,
            tool_names=(
                "get_job_requirements",
                "list_candidates",
                "semantic_search_candidates",
            ),
            reasoning_tool_names=("list_candidates", "semantic_search_candidates"),
        )
    ]
    serialized_plan = repr(provider.plans[0])
    assert MERCHANT_ID not in serialized_plan
    assert ROLE_ID not in serialized_plan
    assert instructions not in serialized_plan


@pytest.mark.parametrize(
    "actual_names",
    [
        (),
        ("get_candidate",),
        ("get_candidate", "get_job_requirements", "update_fit_score"),
        ("get_candidate", "list_candidates"),
    ],
)
def test_runtime_rejects_missing_or_extra_tool_inventory(
    actual_names: tuple[str, ...],
) -> None:
    request = _request(candidateId=CANDIDATE_ID, roleId=ROLE_ID)
    workflow = BoundedHiringWorkflow(
        StubProvider(_dependencies(*actual_names)),
        settings=_settings(),
        graph_builder=StubBuilder(StubGraph(lambda current: {"output": _output(current)})),
    )

    with pytest.raises(
        HiringWorkflowDependencyError,
        match="^hiring_workflow_tool_inventory_invalid$",
    ):
        asyncio.run(workflow.invoke(request))


def test_runtime_rejects_mapping_key_and_declared_tool_name_mismatch() -> None:
    request = _request(candidateId=CANDIDATE_ID)
    dependencies = GraphDependencies(
        reasoning_model=StubModel(),
        structured_model=StubModel(),
        tools={"get_candidate": StubTool("update_fit_score")},
    )
    workflow = BoundedHiringWorkflow(
        StubProvider(dependencies),
        settings=_settings(),
        graph_builder=StubBuilder(StubGraph(lambda current: {"output": _output(current)})),
    )

    with pytest.raises(
        HiringWorkflowDependencyError,
        match="^hiring_workflow_tool_inventory_invalid$",
    ):
        asyncio.run(workflow.invoke(request))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda result: result.__setitem__("request_id", "00000000-0000-0000-0000-000000000099"),
        lambda result: result.__setitem__("tool_calls", ["update_fit_score"]),
        lambda result: result.__setitem__("tool_calls", ["list_candidates", "list_candidates"]),
        lambda result: result.__setitem__("write_status", "succeeded"),
        lambda result: result.__setitem__("recommendation", "Hire without human review."),
        lambda result: result.__setitem__("fit_score", 82),
        lambda result: result.__setitem__("fit_score", 101),
    ],
)
def test_runtime_rejects_uncorrelated_or_unsafe_graph_results(
    mutate: Callable[[dict[str, Any]], None],
) -> None:
    request = _request(
        operation=HiringOperation.SEARCH_CANDIDATES,
        instructions="Find experienced baristas.",
    )
    raw_output = _output(request, tool_calls=["list_candidates"]).model_dump(mode="python")
    mutate(raw_output)
    graph = StubGraph(lambda current: {"output": raw_output})
    workflow = BoundedHiringWorkflow(
        StubProvider(_dependencies("list_candidates", "semantic_search_candidates")),
        settings=_settings(),
        graph_builder=StubBuilder(graph),
    )

    with pytest.raises(
        HiringWorkflowResultError,
        match="^hiring_workflow_result_invalid$",
    ):
        asyncio.run(workflow.invoke(request))


def test_runtime_never_accepts_a_successful_legacy_write_claim() -> None:
    request = _request(
        candidateId=CANDIDATE_ID,
        roleId=ROLE_ID,
        score=80,
        analysis={"evidence": ["Three years of relevant work."]},
    )
    graph = StubGraph(
        lambda current: {
            "output": _output(current, write_status="succeeded"),
        }
    )
    workflow = BoundedHiringWorkflow(
        StubProvider(_dependencies()),
        settings=_settings(),
        graph_builder=StubBuilder(graph),
    )

    with pytest.raises(
        HiringWorkflowResultError,
        match="^hiring_workflow_result_invalid$",
    ):
        asyncio.run(workflow.invoke(request))


def test_graph_failure_is_sanitized_and_provider_is_closed() -> None:
    secret = "private-provider-error-candidate-123"

    class FailingGraph:
        async def ainvoke(self, input: Any, config: Any) -> Any:
            del input, config
            raise RuntimeError(secret)

    provider = StubProvider(_dependencies())
    workflow = BoundedHiringWorkflow(
        provider,
        settings=_settings(),
        graph_builder=StubBuilder(FailingGraph()),
    )

    with pytest.raises(HiringWorkflowExecutionError) as error:
        asyncio.run(workflow.invoke(_request()))

    assert str(error.value) == "hiring_workflow_failed"
    assert error.value.__cause__ is None
    assert error.value.__context__ is None
    assert secret not in repr(error.value)
    assert secret not in "".join(traceback.format_exception(error.value))
    assert provider.enter_count == provider.exit_count == 1


def test_provider_entry_failure_is_sanitized() -> None:
    secret = "private-tool-session-token"

    class FailingProvider:
        @asynccontextmanager
        async def open(self, plan: HiringDependencyPlan):
            del plan
            raise RuntimeError(secret)
            yield _dependencies()  # pragma: no cover

    workflow = BoundedHiringWorkflow(
        FailingProvider(),
        settings=_settings(),
        graph_builder=StubBuilder(StubGraph(lambda current: {"output": _output(current)})),
    )

    with pytest.raises(HiringWorkflowExecutionError) as error:
        asyncio.run(workflow.invoke(_request()))

    assert str(error.value) == "hiring_workflow_failed"
    assert error.value.__cause__ is None
    assert error.value.__context__ is None
    assert secret not in repr(error.value)
    assert secret not in "".join(traceback.format_exception(error.value))


@pytest.mark.parametrize(
    "injected_error",
    [
        TimeoutError("private-inner-timeout-token"),
        HiringWorkflowResultError("private-spoofed-result-error"),
        HiringWorkflowDependencyError("private-spoofed-dependency-error"),
    ],
)
def test_injected_exception_types_cannot_spoof_public_runtime_errors(
    injected_error: Exception,
) -> None:
    class FailingGraph:
        async def ainvoke(self, input: Any, config: Any) -> Any:
            del input, config
            raise injected_error

    workflow = BoundedHiringWorkflow(
        StubProvider(_dependencies()),
        settings=_settings(),
        graph_builder=StubBuilder(FailingGraph()),
    )

    with pytest.raises(HiringWorkflowExecutionError) as error:
        asyncio.run(workflow.invoke(_request()))

    assert str(error.value) == "hiring_workflow_failed"
    assert error.value.__cause__ is None
    assert error.value.__context__ is None
    assert "private-" not in "".join(traceback.format_exception(error.value))


def test_workflow_timeout_cancels_graph_closes_provider_and_releases_permit() -> None:
    class FirstCallBlocksGraph:
        def __init__(self) -> None:
            self.calls = 0
            self.cancelled = False

        async def ainvoke(self, input: Mapping[str, Any], config: Any) -> Any:
            del config
            self.calls += 1
            if self.calls == 1:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.cancelled = True
                    raise
            return {"output": _output(input["request"])}

    async def exercise() -> tuple[FirstCallBlocksGraph, StubProvider]:
        settings = _settings(max_concurrency=1)
        object.__setattr__(settings, "workflow_timeout_seconds", 0.02)
        graph = FirstCallBlocksGraph()
        provider = StubProvider(_dependencies())
        workflow = BoundedHiringWorkflow(
            provider,
            settings=settings,
            graph_builder=StubBuilder(graph),
        )
        with pytest.raises(
            HiringWorkflowTimeoutError,
            match="^hiring_workflow_timeout$",
        ):
            await workflow.invoke(_request())
        result = await workflow.invoke(_request())
        assert result.write_status == "not_requested"
        return graph, provider

    graph, provider = asyncio.run(exercise())

    assert graph.cancelled is True
    assert graph.calls == 2
    assert provider.enter_count == provider.exit_count == 2


def test_external_cancellation_propagates_and_releases_permit() -> None:
    class FirstCallBlocksGraph:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.calls = 0

        async def ainvoke(self, input: Mapping[str, Any], config: Any) -> Any:
            del config
            self.calls += 1
            if self.calls == 1:
                self.started.set()
                await asyncio.Event().wait()
            return {"output": _output(input["request"])}

    async def exercise() -> tuple[int, int]:
        graph = FirstCallBlocksGraph()
        provider = StubProvider(_dependencies())
        workflow = BoundedHiringWorkflow(
            provider,
            settings=_settings(max_concurrency=1),
            graph_builder=StubBuilder(graph),
        )
        task = asyncio.create_task(workflow.invoke(_request()))
        await graph.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        result = await workflow.invoke(_request())
        assert result.write_status == "not_requested"
        return provider.enter_count, provider.exit_count

    enter_count, exit_count = asyncio.run(exercise())

    assert enter_count == exit_count == 2


def test_concurrency_queue_timeout_is_bounded_and_does_not_leak_a_permit() -> None:
    class GatedGraph:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def ainvoke(self, input: Mapping[str, Any], config: Any) -> Any:
            del config
            if not self.release.is_set():
                self.started.set()
                await self.release.wait()
            return {"output": _output(input["request"])}

    async def exercise() -> None:
        graph = GatedGraph()
        workflow = BoundedHiringWorkflow(
            StubProvider(_dependencies()),
            settings=_settings(max_concurrency=1, queue_timeout_seconds=0.1),
            graph_builder=StubBuilder(graph),
        )
        first = asyncio.create_task(workflow.invoke(_request()))
        await graph.started.wait()
        with pytest.raises(HiringWorkflowBusyError, match="^hiring_workflow_busy$"):
            await workflow.invoke(_request())
        graph.release.set()
        await first
        assert (await workflow.invoke(_request())).write_status == "not_requested"

    asyncio.run(exercise())


def test_runtime_span_disables_automatic_exception_recording(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    class SpanContext:
        def __enter__(self) -> object:
            return object()

        def __exit__(self, *args: Any) -> None:
            del args

    class StubTracer:
        def start_as_current_span(self, name: str, **kwargs: Any) -> SpanContext:
            calls.append((name, kwargs))
            return SpanContext()

    monkeypatch.setattr(runtime_module, "tracer", StubTracer())
    request = _request()
    workflow = BoundedHiringWorkflow(
        StubProvider(_dependencies()),
        settings=_settings(),
        graph_builder=StubBuilder(StubGraph(lambda current: {"output": _output(current)})),
    )

    asyncio.run(workflow.invoke(request))

    assert calls == [
        (
            "hiring_workflow.invoke",
            {"record_exception": False, "set_status_on_exception": False},
        )
    ]
