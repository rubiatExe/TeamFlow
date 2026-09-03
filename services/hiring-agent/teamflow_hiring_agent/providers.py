"""Concrete Gemini composition for the dependency-injected hiring graph.

This module configures models but deliberately does not choose a tool transport.
The service composition root must inject an invocation-scoped, read-only tool
source. That keeps provider credentials separate from MCP/Supabase wiring and lets
the bounded runtime validate the final capability inventory before graph execution.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol

from google.genai.types import HarmBlockThreshold, HarmCategory
from langchain_google_genai import ChatGoogleGenerativeAI

from .config import Settings
from .contracts import HiringAgentDraft, HiringOperation
from .graph.nodes import SEARCH_TOOLS, GraphDependencies
from .reliability import FailoverRunnable
from .runtime import HiringDependencyPlan

_GET_CANDIDATE_TOOL = "get_candidate"
_GET_JOB_REQUIREMENTS_TOOL = "get_job_requirements"
_REVIEW_TOOL_ORDER = (_GET_CANDIDATE_TOOL, _GET_JOB_REQUIREMENTS_TOOL)
_SEARCH_TOOL_ORDER = (_GET_JOB_REQUIREMENTS_TOOL, *SEARCH_TOOLS)
_MAX_MODEL_OUTPUT_TOKENS = 2_048
_MODEL_ATTEMPT_BUDGET_DIVISOR = 3.0
_MINIMUM_MODEL_ATTEMPT_SECONDS = 2.0
_MAXIMUM_TOOL_SESSION_CLEANUP_SECONDS = 2.0

_SAFETY_SETTINGS = {
    HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
}


class GeminiDependencyProviderError(RuntimeError):
    """A sanitized Gemini or injected-tool composition failure."""


class ToolSessionSource(Protocol):
    """Open one invocation-scoped mapping of candidate-data tools."""

    def tools(self) -> AbstractAsyncContextManager[Mapping[str, Any]]: ...


class ChatModelFactory(Protocol):
    """Construct a LangChain-compatible Gemini chat model."""

    def __call__(self, **kwargs: Any) -> Any: ...


@asynccontextmanager
async def _open_tool_session(
    source: ToolSessionSource,
    *,
    cleanup_timeout_seconds: float,
) -> AsyncIterator[Mapping[str, Any]]:
    """Sanitize source lifecycle failures without changing graph/body exceptions."""

    session_error: GeminiDependencyProviderError | None = None
    session: AbstractAsyncContextManager[Mapping[str, Any]] | None = None
    try:
        session = source.tools()
    except Exception:
        session_error = GeminiDependencyProviderError("hiring_tool_session_failed")
    if session_error is not None or session is None:
        raise session_error or GeminiDependencyProviderError("hiring_tool_session_failed")

    available: Mapping[str, Any] | None = None
    try:
        available = await session.__aenter__()
    except Exception:
        session_error = GeminiDependencyProviderError("hiring_tool_session_failed")
    if session_error is not None:
        raise session_error
    if available is None:
        await _close_tool_session(
            session,
            (None, None, None),
            timeout_seconds=cleanup_timeout_seconds,
        )
        raise GeminiDependencyProviderError("hiring_tool_session_failed")

    try:
        yield available
    except BaseException:
        # Never let a transport context manager suppress or replace a graph failure.
        # A simultaneous ordinary cleanup error is secondary and deliberately hidden.
        body_exception = sys.exc_info()
        await _close_tool_session(
            session,
            body_exception,
            timeout_seconds=cleanup_timeout_seconds,
        )
        raise
    else:
        closed = await _close_tool_session(
            session,
            (None, None, None),
            timeout_seconds=cleanup_timeout_seconds,
        )
        if not closed:
            session_error = GeminiDependencyProviderError("hiring_tool_session_failed")
        if session_error is not None:
            raise session_error


def _consume_cleanup_result(task: asyncio.Future[Any]) -> None:
    """Retrieve a detached cleanup result without logging transport details."""

    if task.cancelled():
        return
    try:
        task.exception()
    except BaseException:
        pass


async def _close_tool_session(
    session: AbstractAsyncContextManager[Mapping[str, Any]],
    exception: tuple[type[BaseException] | None, BaseException | None, Any],
    *,
    timeout_seconds: float,
) -> bool:
    """Bound session cleanup without letting transport failures replace the body."""

    try:
        cleanup = asyncio.ensure_future(session.__aexit__(*exception))
    except Exception:
        return False
    try:
        done, _ = await asyncio.wait({cleanup}, timeout=timeout_seconds)
    except asyncio.CancelledError:
        cleanup.cancel()
        cleanup.add_done_callback(_consume_cleanup_result)
        raise
    if not done:
        cleanup.cancel()
        cleanup.add_done_callback(_consume_cleanup_result)
        return False
    try:
        cleanup.result()
    except BaseException:
        return False
    return True


def _model_attempt_timeout(settings: Settings) -> float:
    """Reserve time for one fallback and local validation under the node deadline."""

    return max(
        _MINIMUM_MODEL_ATTEMPT_SECONDS,
        settings.model_timeout_seconds / _MODEL_ATTEMPT_BUDGET_DIVISOR,
    )


def _tool_session_cleanup_timeout(settings: Settings) -> float:
    """Reserve only a small bounded portion of the tool deadline for teardown."""

    return min(_MAXIMUM_TOOL_SESSION_CLEANUP_SECONDS, settings.tool_timeout_seconds)


def _validated_plan(plan: object) -> HiringDependencyPlan:
    if not isinstance(plan, HiringDependencyPlan):
        raise GeminiDependencyProviderError("hiring_dependency_plan_invalid")

    tool_names = plan.tool_names
    reasoning_names = plan.reasoning_tool_names
    if (
        type(plan.operation) is not HiringOperation
        or type(tool_names) is not tuple
        or type(reasoning_names) is not tuple
    ):
        raise GeminiDependencyProviderError("hiring_dependency_plan_invalid")
    if (
        any(type(name) is not str for name in (*tool_names, *reasoning_names))
        or len(tool_names) != len(set(tool_names))
        or len(reasoning_names) != len(set(reasoning_names))
    ):
        raise GeminiDependencyProviderError("hiring_dependency_plan_invalid")

    if plan.operation == HiringOperation.REVIEW_CANDIDATE:
        canonical_tools = tuple(name for name in _REVIEW_TOOL_ORDER if name in tool_names)
        valid = tool_names == canonical_tools and not reasoning_names
    elif plan.operation == HiringOperation.SEARCH_CANDIDATES:
        canonical_tools = tuple(name for name in _SEARCH_TOOL_ORDER if name in tool_names)
        valid = (
            tool_names == canonical_tools
            and tuple(name for name in tool_names if name in SEARCH_TOOLS) == tuple(SEARCH_TOOLS)
            and reasoning_names == tuple(SEARCH_TOOLS)
        )
    else:
        valid = False

    if not valid:
        raise GeminiDependencyProviderError("hiring_dependency_plan_invalid")
    return plan


def _select_tools(
    available: object,
    names: tuple[str, ...],
) -> dict[str, Any]:
    invalid = not isinstance(available, Mapping)
    selected: dict[str, Any] = {}
    if not invalid:
        try:
            for name in names:
                tool = available[name]
                declared_name = tool.name
                invocation = tool.ainvoke
                if declared_name != name or not callable(invocation):
                    invalid = True
                    break
                selected[name] = tool
        except Exception:
            invalid = True
    if invalid:
        raise GeminiDependencyProviderError("hiring_tool_inventory_invalid")
    return selected


class GeminiGraphDependencyProvider:
    """Compose bounded Gemini runnables around an injected read-only tool source."""

    def __init__(
        self,
        tool_source: ToolSessionSource,
        *,
        settings: Settings | None = None,
        model_factory: ChatModelFactory = ChatGoogleGenerativeAI,
    ) -> None:
        self._settings = settings or Settings.from_env()
        self._tool_source = tool_source
        self._model_factory = model_factory

    def _model(self, model_name: str) -> Any:
        # Gemini 3.x rejects the legacy temperature/top-p/top-k and candidate-count
        # controls. The pinned adapter correctly drops unset sampling fields but its
        # validated constructor still defaults ``n``/candidate_count to one. Clear that
        # adapter field immediately so ordinary, tool-bound, and structured runnables
        # all omit the unsupported request property. An actual request-shape test pins
        # this compatibility seam and should fail before any adapter upgrade ships.
        model = self._model_factory(
            model=model_name,
            api_key=self._settings.google_api_key,
            max_tokens=_MAX_MODEL_OUTPUT_TOKENS,
            retries=0,
            request_timeout=_model_attempt_timeout(self._settings),
            safety_settings=dict(_SAFETY_SETTINGS),
        )
        model.n = None
        return model

    def _base_models(self) -> tuple[Any, Any | None]:
        if not self._settings.google_api_key:
            raise GeminiDependencyProviderError("hiring_gemini_api_key_missing")
        configuration_error: GeminiDependencyProviderError | None = None
        primary: Any = None
        fallback: Any | None = None
        try:
            primary = self._model(self._settings.model)
            fallback = (
                self._model(self._settings.fallback_model)
                if self._settings.fallback_model
                and self._settings.fallback_model != self._settings.model
                else None
            )
        except Exception:
            configuration_error = GeminiDependencyProviderError(
                "hiring_gemini_configuration_invalid"
            )
        if configuration_error is not None:
            raise configuration_error
        return primary, fallback

    def _dependencies(
        self,
        *,
        plan: HiringDependencyPlan,
        primary: Any,
        fallback: Any | None,
        tools: Mapping[str, Any],
    ) -> GraphDependencies:
        reasoning_tools = [tools[name] for name in plan.reasoning_tool_names]
        primary_reasoning = primary.bind_tools(reasoning_tools) if reasoning_tools else primary
        fallback_reasoning = (
            fallback.bind_tools(reasoning_tools)
            if fallback is not None and reasoning_tools
            else fallback
        )
        primary_structured = primary.with_structured_output(
            schema=HiringAgentDraft,
            method="json_schema",
            include_raw=True,
        )
        fallback_structured = (
            fallback.with_structured_output(
                schema=HiringAgentDraft,
                method="json_schema",
                include_raw=True,
            )
            if fallback is not None
            else None
        )
        fallback_name = self._settings.fallback_model if fallback is not None else None
        return GraphDependencies(
            reasoning_model=FailoverRunnable(
                primary_reasoning,
                fallback_reasoning,
                primary_model_name=self._settings.model,
                fallback_model_name=fallback_name,
            ),
            structured_model=FailoverRunnable(
                primary_structured,
                fallback_structured,
                primary_model_name=self._settings.model,
                fallback_model_name=fallback_name,
            ),
            tools=tools,
        )

    def _compose_dependencies(
        self,
        *,
        plan: HiringDependencyPlan,
        primary: Any,
        fallback: Any | None,
        available_tools: object,
    ) -> GraphDependencies:
        selected_tools = _select_tools(available_tools, plan.tool_names)
        configuration_error: GeminiDependencyProviderError | None = None
        dependencies: GraphDependencies | None = None
        try:
            dependencies = self._dependencies(
                plan=plan,
                primary=primary,
                fallback=fallback,
                tools=selected_tools,
            )
        except Exception:
            configuration_error = GeminiDependencyProviderError(
                "hiring_gemini_configuration_invalid"
            )
        if configuration_error is not None or dependencies is None:
            raise configuration_error or GeminiDependencyProviderError(
                "hiring_gemini_configuration_invalid"
            )
        return dependencies

    @asynccontextmanager
    async def open(
        self,
        plan: HiringDependencyPlan,
    ) -> AsyncIterator[GraphDependencies]:
        validated_plan = _validated_plan(plan)
        primary, fallback = self._base_models()

        if not validated_plan.tool_names:
            dependencies = self._compose_dependencies(
                plan=validated_plan,
                primary=primary,
                fallback=fallback,
                available_tools={},
            )
            yield dependencies
            return

        async with _open_tool_session(
            self._tool_source,
            cleanup_timeout_seconds=_tool_session_cleanup_timeout(self._settings),
        ) as available_tools:
            dependencies = self._compose_dependencies(
                plan=validated_plan,
                primary=primary,
                fallback=fallback,
                available_tools=available_tools,
            )
            # Deliberately keep the yield outside every exception-normalization block:
            # graph/body failures must retain their type for the bounded runtime.
            yield dependencies
