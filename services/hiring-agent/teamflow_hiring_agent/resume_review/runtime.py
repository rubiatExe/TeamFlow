"""Bounded, tenant-bound runtime for the isolated résumé-review graph.

Credentials and process selection remain outside this module. Production activation
must inject the already-validated shared MCP source and an optional scoped writer.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from typing import Any, Protocol
from uuid import UUID

from google.genai.types import HarmBlockThreshold, HarmCategory
from langchain_google_genai import ChatGoogleGenerativeAI
from opentelemetry import trace

from ..config import Settings
from ..reliability import FailoverRunnable
from .contracts import Agent1ModelOutput, Agent2QuestionPlan
from .fingerprints import role_policy_fingerprint
from .graph import ResumeReviewDependencies, build_resume_review_graph
from .persistence import ReviewPersistenceRecord, build_review_persistence_record
from .providers import (
    MCPActiveRoleLoader,
    MCPDocumentLoader,
    select_resume_review_tools,
)
from .workflow_contracts import QuestionsStatus, ResumeReviewRequest, ResumeReviewResponse

tracer = trace.get_tracer("teamflow.resume_review.runtime", "1.0.0")

_SAFETY_SETTINGS = {
    HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
}


class ResumeReviewWorkflowBusyError(RuntimeError):
    """The per-process review concurrency budget is exhausted."""


class ResumeReviewWorkflowTimeoutError(RuntimeError):
    """The end-to-end review deadline expired."""


class ResumeReviewWorkflowRequestError(ValueError):
    """The request or tenant binding is invalid."""


class ResumeReviewWorkflowExecutionError(RuntimeError):
    """A dependency session or graph failed without a safe result."""


class ToolSessionSource(Protocol):
    def tools(self) -> AbstractAsyncContextManager[Mapping[str, Any]]: ...


class ReviewWriter(Protocol):
    async def persist(self, **kwargs: Any) -> Any: ...


class ChatModelFactory(Protocol):
    def __call__(self, **kwargs: Any) -> Any: ...


def _canonical_merchant_id(value: object) -> str:
    if type(value) is not str or value != value.strip():
        raise ResumeReviewWorkflowRequestError("resume_review_request_invalid")
    try:
        canonical = str(UUID(value))
    except (TypeError, ValueError, AttributeError):
        raise ResumeReviewWorkflowRequestError("resume_review_request_invalid") from None
    if value != canonical:
        raise ResumeReviewWorkflowRequestError("resume_review_request_invalid")
    return canonical


def _validated_output(
    state: object,
    *,
    request: ResumeReviewRequest,
) -> ResumeReviewResponse:
    try:
        if not isinstance(state, Mapping):
            raise TypeError
        output = ResumeReviewResponse.model_validate(state.get("output"))
    except Exception:
        raise ResumeReviewWorkflowExecutionError("resume_review_result_invalid") from None
    if (
        str(output.request_id) != str(request.request_id)
        or output.document_id != request.document_id
        or output.agent1_evaluation is not None
        and (not output.review_required or output.status.value != "review_required")
    ):
        raise ResumeReviewWorkflowExecutionError("resume_review_result_invalid")
    return output


class LangGraphResumeReviewWorkflow:
    """Run two structured models over one exact, read-only tool session."""

    def __init__(
        self,
        tool_source: ToolSessionSource,
        *,
        merchant_id: str,
        settings: Settings,
        review_writer: ReviewWriter | None = None,
        model_factory: ChatModelFactory = ChatGoogleGenerativeAI,
    ) -> None:
        if not settings.google_api_key:
            raise ValueError("resume_review_runtime_configuration_invalid")
        self._merchant_id = _canonical_merchant_id(merchant_id)
        self._settings = settings
        self._tool_source = tool_source
        self._review_writer = review_writer
        self._semaphore = asyncio.BoundedSemaphore(settings.max_concurrency)

        model_options = {
            "api_key": settings.google_api_key,
            "max_tokens": 4_096,
            "retries": 0,
            "request_timeout": max(2.0, settings.model_timeout_seconds / 3),
            "safety_settings": _SAFETY_SETTINGS,
        }
        primary = model_factory(model=settings.model, **model_options)
        # The pinned LangChain adapter defaults ``n`` to one and translates it to
        # Gemini's unsupported candidate_count field. Clear it before creating the
        # structured runnables so Gemini 3.x requests omit that legacy control.
        primary.n = None
        fallback = (
            model_factory(model=settings.fallback_model, **model_options)
            if settings.fallback_model and settings.fallback_model != settings.model
            else None
        )
        if fallback is not None:
            fallback.n = None
        self._agent1_model = FailoverRunnable(
            primary.with_structured_output(
                schema=Agent1ModelOutput,
                method="json_schema",
                include_raw=True,
            ),
            (
                fallback.with_structured_output(
                    schema=Agent1ModelOutput,
                    method="json_schema",
                    include_raw=True,
                )
                if fallback
                else None
            ),
            primary_model_name=settings.model,
            fallback_model_name=settings.fallback_model if fallback else None,
        )
        self._agent2_model = FailoverRunnable(
            primary.with_structured_output(
                schema=Agent2QuestionPlan,
                method="json_schema",
                include_raw=True,
            ),
            (
                fallback.with_structured_output(
                    schema=Agent2QuestionPlan,
                    method="json_schema",
                    include_raw=True,
                )
                if fallback
                else None
            ),
            primary_model_name=settings.model,
            fallback_model_name=settings.fallback_model if fallback else None,
        )

    async def _acquire(self) -> None:
        task = asyncio.create_task(self._semaphore.acquire())
        try:
            await asyncio.wait_for(
                asyncio.shield(task),
                timeout=self._settings.queue_timeout_seconds,
            )
        except BaseException:
            task.cancel()
            try:
                acquired = await task
            except asyncio.CancelledError:
                acquired = False
            if acquired:
                self._semaphore.release()
            raise

    def _validated_request(self, request: object) -> ResumeReviewRequest:
        try:
            if not isinstance(request, ResumeReviewRequest):
                raise TypeError
            validated = ResumeReviewRequest.model_validate(request.model_dump(mode="python"))
        except Exception:
            raise ResumeReviewWorkflowRequestError("resume_review_request_invalid") from None
        if str(validated.merchant_id) != self._merchant_id:
            raise ResumeReviewWorkflowRequestError("resume_review_tenant_scope_mismatch")
        if validated.persist and self._review_writer is None:
            raise ResumeReviewWorkflowRequestError("resume_review_persistence_unavailable")
        return validated

    async def _run_state(self, request: ResumeReviewRequest) -> Mapping[str, Any]:
        async with self._tool_source.tools() as catalog:
            tools = select_resume_review_tools(catalog)
            graph = build_resume_review_graph(
                ResumeReviewDependencies(
                    document_loader=MCPDocumentLoader(tools),
                    active_role_loader=MCPActiveRoleLoader(tools),
                    agent1_model=self._agent1_model,
                    agent2_model=self._agent2_model,
                    review_writer=self._review_writer,
                ),
                model_timeout_seconds=self._settings.model_timeout_seconds,
            )
            return await graph.ainvoke(
                {"request": request, "reason_codes": [], "node_trace": []},
                config={"recursion_limit": 20},
            )

    async def invoke(self, request: ResumeReviewRequest) -> ResumeReviewResponse:
        validated = self._validated_request(request)
        state = await self._execute_state(validated)
        return _validated_output(state, request=validated)

    async def _execute_state(self, request: ResumeReviewRequest) -> Mapping[str, Any]:
        """Run one graph invocation within the shared queue and deadline budget."""

        try:
            await self._acquire()
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            raise ResumeReviewWorkflowBusyError("resume_review_workflow_busy") from None
        except Exception:
            raise ResumeReviewWorkflowExecutionError("resume_review_workflow_failed") from None

        try:
            with tracer.start_as_current_span(
                "resume_review.invoke",
                record_exception=False,
                set_status_on_exception=False,
            ):
                try:
                    async with asyncio.timeout(self._settings.workflow_timeout_seconds):
                        state = await self._run_state(request)
                except asyncio.CancelledError:
                    raise
                except TimeoutError:
                    raise ResumeReviewWorkflowTimeoutError(
                        "resume_review_workflow_timeout"
                    ) from None
                except Exception:
                    raise ResumeReviewWorkflowExecutionError(
                        "resume_review_workflow_failed"
                    ) from None
                return state
        finally:
            self._semaphore.release()

    async def analyze_for_human_review(
        self,
        request: ResumeReviewRequest,
    ) -> ReviewPersistenceRecord:
        """Return a content-bound proposal without performing an external write."""

        validated = self._validated_request(request.model_copy(update={"persist": False}))
        state = await self._execute_state(validated)
        output = _validated_output(state, request=validated)
        required = (
            "agent1_evaluation",
            "role_policies",
            "extraction_summary",
            "confidence_assessment",
            "confidence_shadow_record",
            "confidence_policy_snapshot",
            "confidence_signals",
        )
        if any(not state.get(name) for name in required):
            raise ResumeReviewWorkflowExecutionError("resume_review_result_invalid")
        question_plan = (
            state.get("agent2_question_plan")
            if output.questions_status is QuestionsStatus.COMPLETE
            else None
        )
        return build_review_persistence_record(
            request=validated,
            evaluation=state["agent1_evaluation"],
            question_plan=question_plan,
            questions_status=output.questions_status,
            extraction_fingerprint=state["extraction_summary"].snapshot_sha256,
            policy_fingerprint=role_policy_fingerprint(state["role_policies"]),
            policy_snapshot=state["role_policies"],
            confidence_assessment=state["confidence_assessment"],
            confidence_shadow_record=state["confidence_shadow_record"],
            confidence_policy_snapshot=state["confidence_policy_snapshot"],
            confidence_signal_snapshot=state["confidence_signals"],
            status=output.status,
            review_required=output.review_required,
            reason_codes=output.reason_codes,
        )


__all__ = [
    "LangGraphResumeReviewWorkflow",
    "ResumeReviewWorkflowBusyError",
    "ResumeReviewWorkflowExecutionError",
    "ResumeReviewWorkflowRequestError",
    "ResumeReviewWorkflowTimeoutError",
]
