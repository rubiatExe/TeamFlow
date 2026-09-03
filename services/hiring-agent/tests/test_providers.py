import asyncio
import traceback
from contextlib import asynccontextmanager
from typing import Any

import pytest
from google.genai.types import HarmBlockThreshold, HarmCategory
from langchain_core.messages import HumanMessage
from langchain_core.tools import StructuredTool
from langchain_google_genai import ChatGoogleGenerativeAI

from teamflow_hiring_agent.config import Settings
from teamflow_hiring_agent.contracts import HiringAgentDraft, HiringOperation
from teamflow_hiring_agent.providers import (
    GeminiDependencyProviderError,
    GeminiGraphDependencyProvider,
    _model_attempt_timeout,
)
from teamflow_hiring_agent.reliability import FailoverRunnable
from teamflow_hiring_agent.runtime import HiringDependencyPlan


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "model": "gemini-test-primary",
        "fallback_model": "gemini-test-fallback",
        "google_api_key": "private-test-key",
        "max_tool_rounds": 2,
        "max_tool_calls_per_round": 3,
        "model_timeout_seconds": 12.0,
        "tool_timeout_seconds": 5.0,
        "workflow_timeout_seconds": 20.0,
        "max_concurrency": 2,
        "queue_timeout_seconds": 1.0,
        "max_request_bytes": 65_536,
    }
    values.update(overrides)
    return Settings(**values)


class StubTool:
    def __init__(self, name: str) -> None:
        self.name = name

    async def ainvoke(self, input: dict[str, Any], **kwargs: Any) -> Any:
        del input, kwargs
        return None


class RecordingToolSource:
    def __init__(self, tools: object) -> None:
        self.available = tools
        self.enter_count = 0
        self.exit_count = 0

    @asynccontextmanager
    async def tools(self):
        self.enter_count += 1
        try:
            yield self.available
        finally:
            self.exit_count += 1


class StubRunnable:
    async def ainvoke(self, input: Any, **kwargs: Any) -> Any:
        del input, kwargs
        return None


class RecordingModel(StubRunnable):
    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self.bound_tools: list[list[Any]] = []
        self.structured_calls: list[dict[str, Any]] = []

    def bind_tools(self, tools: list[Any], **kwargs: Any) -> StubRunnable:
        assert kwargs == {}
        self.bound_tools.append(list(tools))
        return StubRunnable()

    def with_structured_output(self, **kwargs: Any) -> StubRunnable:
        self.structured_calls.append(kwargs)
        return StubRunnable()


class RecordingModelFactory:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.models: list[RecordingModel] = []

    def __call__(self, **kwargs: Any) -> RecordingModel:
        self.calls.append(kwargs)
        model = RecordingModel(kwargs["model"])
        self.models.append(model)
        return model


def _review_plan(*names: str) -> HiringDependencyPlan:
    return HiringDependencyPlan(
        operation=HiringOperation.REVIEW_CANDIDATE,
        tool_names=names,
        reasoning_tool_names=(),
    )


def _search_plan(*, include_role: bool = False) -> HiringDependencyPlan:
    names = (
        ("get_job_requirements", "list_candidates", "semantic_search_candidates")
        if include_role
        else ("list_candidates", "semantic_search_candidates")
    )
    return HiringDependencyPlan(
        operation=HiringOperation.SEARCH_CANDIDATES,
        tool_names=names,
        reasoning_tool_names=("list_candidates", "semantic_search_candidates"),
    )


def _open(provider: GeminiGraphDependencyProvider, plan: HiringDependencyPlan):
    async def exercise():
        async with provider.open(plan) as dependencies:
            return dependencies

    return asyncio.run(exercise())


def test_models_use_only_supported_bounded_gemini_controls() -> None:
    factory = RecordingModelFactory()
    source = RecordingToolSource({})
    dependencies = _open(
        GeminiGraphDependencyProvider(
            source,
            settings=_settings(),
            model_factory=factory,
        ),
        _review_plan(),
    )

    assert source.enter_count == source.exit_count == 0
    assert isinstance(dependencies.reasoning_model, FailoverRunnable)
    assert isinstance(dependencies.structured_model, FailoverRunnable)
    assert [call["model"] for call in factory.calls] == [
        "gemini-test-primary",
        "gemini-test-fallback",
    ]
    for call in factory.calls:
        assert call == {
            "model": call["model"],
            "api_key": "private-test-key",
            "max_tokens": 2_048,
            "retries": 0,
            "request_timeout": 4.0,
            "safety_settings": {
                HarmCategory.HARM_CATEGORY_HARASSMENT: (HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE),
                HarmCategory.HARM_CATEGORY_HATE_SPEECH: (HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE),
                HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: (
                    HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
                ),
                HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: (
                    HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE
                ),
            },
        }
        assert not {"temperature", "top_p", "top_k", "candidate_count"}.intersection(call)


def test_actual_adapter_omits_unsupported_fields_in_tool_and_structured_requests() -> None:
    models: list[ChatGoogleGenerativeAI] = []

    async def list_candidates(
        merchant_id: str,
        status_filter: str = "",
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        del merchant_id, status_filter, limit
        return []

    async def semantic_search_candidates(
        query: str,
        merchant_id: str,
        top_k: int = 5,
        threshold: float = 0.5,
    ) -> list[dict[str, Any]]:
        del query, merchant_id, top_k, threshold
        return []

    tools = {
        "list_candidates": StructuredTool.from_function(
            coroutine=list_candidates,
            name="list_candidates",
            description="List candidate summaries for one merchant.",
        ),
        "semantic_search_candidates": StructuredTool.from_function(
            coroutine=semantic_search_candidates,
            name="semantic_search_candidates",
            description="Search candidate summaries for one merchant.",
        ),
    }

    def factory(**kwargs: Any) -> ChatGoogleGenerativeAI:
        model = ChatGoogleGenerativeAI(**kwargs)
        models.append(model)
        return model

    dependencies = _open(
        GeminiGraphDependencyProvider(
            RecordingToolSource(tools),
            settings=_settings(
                model="gemini-3.7-flash",
                fallback_model="gemini-3.6-flash",
            ),
            model_factory=factory,
        ),
        _search_plan(),
    )

    assert [model.model for model in models] == ["gemini-3.7-flash", "gemini-3.6-flash"]
    unsupported = {
        "candidate_count",
        "temperature",
        "top_p",
        "top_k",
        "frequency_penalty",
        "presence_penalty",
        "thinking_budget",
        "thinking_config",
    }
    request_bindings = [
        dependencies.reasoning_model._primary,
        dependencies.reasoning_model._fallback,
        dependencies.structured_model._primary.first.steps__["raw"],
        dependencies.structured_model._fallback.first.steps__["raw"],
    ]
    assert all(binding is not None for binding in request_bindings)
    for index, binding in enumerate(request_bindings):
        kwargs = {
            key: value
            for key, value in binding.kwargs.items()
            if key != "ls_structured_output_format"
        }
        request = binding.bound._prepare_request(
            [HumanMessage(content="test")],
            **kwargs,
        )
        config = request["config"].model_dump(exclude_none=True)
        assert unsupported.isdisjoint(config)
        assert config["max_output_tokens"] == 2_048
        if index < 2:
            assert len(config["tools"]) == 1
            declarations = config["tools"][0]["function_declarations"]
            assert {declaration["name"] for declaration in declarations} == {
                "list_candidates",
                "semantic_search_candidates",
            }
        else:
            assert "tools" not in config


@pytest.mark.parametrize(
    ("model_timeout", "expected_attempt_timeout"),
    [(5.0, 2.0), (12.0, 4.0), (30.0, 10.0)],
)
def test_per_attempt_timeout_reserves_fallback_and_validation_budget(
    model_timeout: float,
    expected_attempt_timeout: float,
) -> None:
    assert _model_attempt_timeout(
        _settings(
            model_timeout_seconds=model_timeout,
            workflow_timeout_seconds=max(20.0, model_timeout),
        )
    ) == pytest.approx(expected_attempt_timeout)


@pytest.mark.parametrize("fallback_model", ["", "gemini-test-primary"])
def test_empty_or_duplicate_fallback_does_not_create_a_second_model(
    fallback_model: str,
) -> None:
    factory = RecordingModelFactory()
    dependencies = _open(
        GeminiGraphDependencyProvider(
            RecordingToolSource({}),
            settings=_settings(fallback_model=fallback_model),
            model_factory=factory,
        ),
        _review_plan(),
    )

    assert len(factory.calls) == 1
    assert dependencies.reasoning_model._fallback is None
    assert dependencies.structured_model._fallback is None


def test_missing_api_key_fails_before_models_or_tool_session_open() -> None:
    factory = RecordingModelFactory()
    source = RecordingToolSource({"get_candidate": StubTool("get_candidate")})
    provider = GeminiGraphDependencyProvider(
        source,
        settings=_settings(google_api_key=""),
        model_factory=factory,
    )

    with pytest.raises(
        GeminiDependencyProviderError,
        match="^hiring_gemini_api_key_missing$",
    ) as error:
        _open(provider, _review_plan("get_candidate"))

    assert factory.calls == []
    assert source.enter_count == source.exit_count == 0
    assert error.value.__cause__ is None
    assert "private-test-key" not in "".join(traceback.format_exception(error.value))


def test_review_mode_selects_deterministic_tools_without_model_tool_binding() -> None:
    factory = RecordingModelFactory()
    source = RecordingToolSource(
        {
            "get_candidate": StubTool("get_candidate"),
            "get_job_requirements": StubTool("get_job_requirements"),
            "list_candidates": StubTool("list_candidates"),
            "update_fit_score": StubTool("update_fit_score"),
        }
    )

    dependencies = _open(
        GeminiGraphDependencyProvider(
            source,
            settings=_settings(),
            model_factory=factory,
        ),
        _review_plan("get_candidate", "get_job_requirements"),
    )

    assert tuple(dependencies.tools) == ("get_candidate", "get_job_requirements")
    assert all(model.bound_tools == [] for model in factory.models)
    assert source.enter_count == source.exit_count == 1


def test_search_binds_only_read_only_search_tools_and_filters_extras() -> None:
    factory = RecordingModelFactory()
    role_tool = StubTool("get_job_requirements")
    list_tool = StubTool("list_candidates")
    semantic_tool = StubTool("semantic_search_candidates")
    source = RecordingToolSource(
        {
            "get_job_requirements": role_tool,
            "list_candidates": list_tool,
            "semantic_search_candidates": semantic_tool,
            "update_fit_score": StubTool("update_fit_score"),
        }
    )

    dependencies = _open(
        GeminiGraphDependencyProvider(
            source,
            settings=_settings(),
            model_factory=factory,
        ),
        _search_plan(include_role=True),
    )

    assert tuple(dependencies.tools) == (
        "get_job_requirements",
        "list_candidates",
        "semantic_search_candidates",
    )
    assert [model.bound_tools for model in factory.models] == [
        [[list_tool, semantic_tool]],
        [[list_tool, semantic_tool]],
    ]
    assert all(
        model.structured_calls
        == [
            {
                "schema": HiringAgentDraft,
                "method": "json_schema",
                "include_raw": True,
            }
        ]
        for model in factory.models
    )


@pytest.mark.parametrize(
    "plan",
    [
        object(),
        HiringDependencyPlan(HiringOperation.REVIEW_CANDIDATE, ("update_fit_score",), ()),
        HiringDependencyPlan(
            HiringOperation.REVIEW_CANDIDATE,
            ("get_job_requirements", "get_candidate"),
            (),
        ),
        HiringDependencyPlan(
            HiringOperation.REVIEW_CANDIDATE,
            ("get_candidate", "get_candidate"),
            (),
        ),
        HiringDependencyPlan(
            HiringOperation.REVIEW_CANDIDATE,
            ("get_candidate",),
            ("list_candidates",),
        ),
        HiringDependencyPlan(
            HiringOperation.SEARCH_CANDIDATES,
            ("list_candidates",),
            ("list_candidates",),
        ),
        HiringDependencyPlan(
            HiringOperation.SEARCH_CANDIDATES,
            ("semantic_search_candidates", "list_candidates"),
            ("list_candidates", "semantic_search_candidates"),
        ),
    ],
)
def test_invalid_capability_plans_fail_before_any_dependency_is_open(plan: object) -> None:
    factory = RecordingModelFactory()
    source = RecordingToolSource({})
    provider = GeminiGraphDependencyProvider(
        source,
        settings=_settings(),
        model_factory=factory,
    )

    with pytest.raises(
        GeminiDependencyProviderError,
        match="^hiring_dependency_plan_invalid$",
    ):
        _open(provider, plan)  # type: ignore[arg-type]

    assert factory.calls == []
    assert source.enter_count == source.exit_count == 0


@pytest.mark.parametrize(
    "available",
    [
        {},
        [],
        {"get_candidate": StubTool("update_fit_score")},
        {"get_candidate": object()},
    ],
)
def test_missing_or_malformed_tools_fail_closed_and_close_the_session(
    available: object,
) -> None:
    source = RecordingToolSource(available)
    provider = GeminiGraphDependencyProvider(
        source,
        settings=_settings(),
        model_factory=RecordingModelFactory(),
    )

    with pytest.raises(
        GeminiDependencyProviderError,
        match="^hiring_tool_inventory_invalid$",
    ) as error:
        _open(provider, _review_plan("get_candidate"))

    assert source.enter_count == source.exit_count == 1
    assert error.value.__cause__ is None
    assert error.value.__context__ is None


def test_empty_tool_session_result_fails_closed_after_cleanup() -> None:
    source = RecordingToolSource(None)
    provider = GeminiGraphDependencyProvider(
        source,
        settings=_settings(),
        model_factory=RecordingModelFactory(),
    )

    with pytest.raises(
        GeminiDependencyProviderError,
        match="^hiring_tool_session_failed$",
    ) as error:
        _open(provider, _review_plan("get_candidate"))

    assert source.enter_count == source.exit_count == 1
    assert error.value.__cause__ is None
    assert error.value.__context__ is None


@pytest.mark.parametrize("failure_stage", ["create", "enter", "exit"])
def test_tool_session_lifecycle_failures_are_sanitized(failure_stage: str) -> None:
    secret = f"private-{failure_stage}-session-secret"

    class FailingSource:
        def tools(self):
            if failure_stage == "create":
                raise RuntimeError(secret)

            @asynccontextmanager
            async def session():
                if failure_stage == "enter":
                    raise RuntimeError(secret)
                yield {"get_candidate": StubTool("get_candidate")}
                if failure_stage == "exit":
                    raise RuntimeError(secret)

            return session()

    provider = GeminiGraphDependencyProvider(
        FailingSource(),
        settings=_settings(),
        model_factory=RecordingModelFactory(),
    )

    with pytest.raises(
        GeminiDependencyProviderError,
        match="^hiring_tool_session_failed$",
    ) as error:
        _open(provider, _review_plan("get_candidate"))

    rendered = "".join(traceback.format_exception(error.value))
    assert secret not in rendered
    assert error.value.__cause__ is None
    assert error.value.__context__ is None


@pytest.mark.parametrize(
    "injected_error",
    [
        RuntimeError("private-provider-construction-secret"),
        GeminiDependencyProviderError("private-spoofed-provider-error"),
    ],
)
def test_model_factory_errors_are_sanitized_before_tool_session_open(
    injected_error: Exception,
) -> None:
    def failing_factory(**kwargs: Any) -> Any:
        del kwargs
        raise injected_error

    source = RecordingToolSource({"get_candidate": StubTool("get_candidate")})
    provider = GeminiGraphDependencyProvider(
        source,
        settings=_settings(),
        model_factory=failing_factory,
    )

    with pytest.raises(
        GeminiDependencyProviderError,
        match="^hiring_gemini_configuration_invalid$",
    ) as error:
        _open(provider, _review_plan("get_candidate"))

    rendered = "".join(traceback.format_exception(error.value))
    assert "private-" not in rendered
    assert error.value.__cause__ is None
    assert error.value.__context__ is None
    assert source.enter_count == source.exit_count == 0


def test_body_errors_retain_their_type_and_tool_session_is_closed() -> None:
    source = RecordingToolSource({"get_candidate": StubTool("get_candidate")})
    provider = GeminiGraphDependencyProvider(
        source,
        settings=_settings(),
        model_factory=RecordingModelFactory(),
    )
    body_error = LookupError("graph-private-marker")

    async def exercise() -> None:
        async with provider.open(_review_plan("get_candidate")):
            raise body_error

    with pytest.raises(LookupError) as error:
        asyncio.run(exercise())

    assert error.value is body_error
    assert source.enter_count == source.exit_count == 1


def test_body_error_is_not_replaced_by_a_simultaneous_tool_cleanup_error() -> None:
    body_error = LookupError("graph-private-marker")

    class CleanupFailingSource:
        @asynccontextmanager
        async def tools(self):
            try:
                yield {"get_candidate": StubTool("get_candidate")}
            finally:
                raise RuntimeError("private-cleanup-secret")

    provider = GeminiGraphDependencyProvider(
        CleanupFailingSource(),
        settings=_settings(),
        model_factory=RecordingModelFactory(),
    )

    async def exercise() -> None:
        async with provider.open(_review_plan("get_candidate")):
            raise body_error

    with pytest.raises(LookupError) as error:
        asyncio.run(exercise())

    assert error.value is body_error


def test_external_cancellation_propagates_and_closes_tool_session() -> None:
    source = RecordingToolSource({"get_candidate": StubTool("get_candidate")})
    provider = GeminiGraphDependencyProvider(
        source,
        settings=_settings(),
        model_factory=RecordingModelFactory(),
    )

    async def exercise() -> None:
        entered = asyncio.Event()

        async def invoke() -> None:
            async with provider.open(_review_plan("get_candidate")):
                entered.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(invoke())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(exercise())

    assert source.enter_count == source.exit_count == 1


class HangingCleanupSource:
    def __init__(self) -> None:
        self.exit_started: asyncio.Event | None = None
        self.exit_cancelled: asyncio.Event | None = None
        self.cleanup_task: asyncio.Task[None] | None = None

    @asynccontextmanager
    async def tools(self):
        try:
            yield {"get_candidate": StubTool("get_candidate")}
        finally:
            self.cleanup_task = asyncio.current_task()
            self.exit_started = asyncio.Event()
            self.exit_cancelled = asyncio.Event()
            self.exit_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.exit_cancelled.set()


def test_cancellation_is_not_blocked_by_hanging_tool_session_cleanup() -> None:
    async def exercise() -> HangingCleanupSource:
        source = HangingCleanupSource()
        provider = GeminiGraphDependencyProvider(
            source,
            settings=_settings(tool_timeout_seconds=0.05),
            model_factory=RecordingModelFactory(),
        )
        body_started = asyncio.Event()

        async def invoke() -> None:
            async with provider.open(_review_plan("get_candidate")):
                body_started.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(invoke())
        await body_started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=0.5)
        assert source.exit_cancelled is not None
        await asyncio.wait_for(source.exit_cancelled.wait(), timeout=0.2)
        return source

    source = asyncio.run(exercise())
    assert source.cleanup_task is not None
    assert source.cleanup_task.done()


def test_normal_completion_fails_closed_when_tool_session_cleanup_hangs() -> None:
    async def exercise() -> HangingCleanupSource:
        source = HangingCleanupSource()
        provider = GeminiGraphDependencyProvider(
            source,
            settings=_settings(tool_timeout_seconds=0.05),
            model_factory=RecordingModelFactory(),
        )

        with pytest.raises(
            GeminiDependencyProviderError,
            match="^hiring_tool_session_failed$",
        ) as error:
            async with asyncio.timeout(0.5):
                async with provider.open(_review_plan("get_candidate")):
                    pass

        assert error.value.__cause__ is None
        assert error.value.__context__ is None
        assert source.exit_cancelled is not None
        await asyncio.wait_for(source.exit_cancelled.wait(), timeout=0.2)
        return source

    source = asyncio.run(exercise())
    assert source.cleanup_task is not None
    assert source.cleanup_task.done()


class SynchronousExitFailureSource:
    def __init__(self, secret: str) -> None:
        self.secret = secret

    def tools(self):
        secret = self.secret

        class Session:
            async def __aenter__(self):
                return {"get_candidate": StubTool("get_candidate")}

            def __aexit__(self, *exception):
                del exception
                raise RuntimeError(secret)

        return Session()


def test_synchronous_cleanup_failure_is_sanitized_on_normal_completion() -> None:
    secret = "private-synchronous-cleanup-secret"
    provider = GeminiGraphDependencyProvider(
        SynchronousExitFailureSource(secret),
        settings=_settings(),
        model_factory=RecordingModelFactory(),
    )

    with pytest.raises(
        GeminiDependencyProviderError,
        match="^hiring_tool_session_failed$",
    ) as error:
        _open(provider, _review_plan("get_candidate"))

    assert secret not in "".join(traceback.format_exception(error.value))
    assert error.value.__cause__ is None
    assert error.value.__context__ is None


def test_synchronous_cleanup_failure_cannot_replace_a_body_error() -> None:
    secret = "private-synchronous-cleanup-secret"
    body_error = LookupError("graph-private-marker")
    provider = GeminiGraphDependencyProvider(
        SynchronousExitFailureSource(secret),
        settings=_settings(),
        model_factory=RecordingModelFactory(),
    )

    async def exercise() -> None:
        async with provider.open(_review_plan("get_candidate")):
            raise body_error

    with pytest.raises(LookupError) as error:
        asyncio.run(exercise())

    assert error.value is body_error
    assert secret not in "".join(traceback.format_exception(error.value))
