"""LLM outcome classification and single-fallback execution."""

import json
import re
from typing import Any

import httpx
from google.genai.errors import ServerError
from langchain_core.messages import AIMessage
from opentelemetry import trace

tracer = trace.get_tracer("teamflow.hiring_agent.model", "2.1.0")

_SAFE_MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
MAX_MODEL_MESSAGE_BYTES = 32_768
_SAFETY_FINISH_REASONS = {
    "BLOCKLIST",
    "IMAGE_PROHIBITED_CONTENT",
    "IMAGE_RECITATION",
    "IMAGE_SAFETY",
    "PROHIBITED_CONTENT",
    "RECITATION",
    "SAFETY",
    "SPII",
}
_INVALID_FINISH_REASONS = {
    "FINISH_REASON_UNSPECIFIED",
    "IMAGE_OTHER",
    "LANGUAGE",
    "MALFORMED_FUNCTION_CALL",
    "MAX_TOKENS",
    "NO_IMAGE",
    "OTHER",
    "UNEXPECTED_TOOL_CALL",
}


class ModelSafetyError(RuntimeError):
    """The provider refused content under its safety policy."""


class InvalidModelOutputError(ValueError):
    """The model completed without a usable, complete response."""


class ModelInvocationError(RuntimeError):
    """Sanitized provider failure safe to surface through graph instrumentation."""


def is_transient_model_error(exc: BaseException) -> bool:
    """Allow failover only for transport, rate-limit, and server failures."""
    if isinstance(
        exc,
        ConnectionError
        | TimeoutError
        | httpx.TimeoutException
        | httpx.TransportError
        | ServerError,
    ):
        return True
    try:
        status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
        if status is None:
            response = getattr(exc, "response", None)
            status = getattr(response, "status_code", None)
    except Exception:
        return False
    return (
        isinstance(status, int)
        and not isinstance(status, bool)
        and (status == 429 or 500 <= status <= 599)
    )


class FailoverRunnable:
    """Try a configured fallback model once, never to bypass safety."""

    def __init__(
        self,
        primary: Any,
        fallback: Any | None,
        *,
        primary_model_name: str | None = None,
        fallback_model_name: str | None = None,
    ) -> None:
        self._primary = primary
        self._fallback = fallback
        self._primary_model_name = primary_model_name
        self._fallback_model_name = fallback_model_name

    @staticmethod
    def _annotate_model_span(span: Any, model_name: str | None) -> None:
        span.set_attribute("gen_ai.system", "google_gemini")
        span.set_attribute("gen_ai.operation.name", "chat")
        if model_name and _SAFE_MODEL_NAME_RE.fullmatch(model_name):
            span.set_attribute("gen_ai.request.model", model_name)

    async def ainvoke(self, input: Any, **kwargs: Any) -> Any:
        with tracer.start_as_current_span(
            "model.primary",
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            self._annotate_model_span(span, self._primary_model_name)
            try:
                return await self._primary.ainvoke(input, **kwargs)
            except Exception as exc:
                if isinstance(exc, ModelSafetyError | InvalidModelOutputError):
                    raise
                span.set_attribute(
                    "teamflow.model.transient_failure",
                    is_transient_model_error(exc),
                )
                if self._fallback is None or not is_transient_model_error(exc):
                    raise ModelInvocationError("model invocation failed") from None

        with tracer.start_as_current_span(
            "model.fallback",
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            self._annotate_model_span(span, self._fallback_model_name)
            try:
                return await self._fallback.ainvoke(input, **kwargs)
            except (ModelSafetyError, InvalidModelOutputError):
                raise
            except Exception:
                raise ModelInvocationError("fallback model invocation failed") from None


def validate_ai_message(message: AIMessage, *, require_content: bool = True) -> None:
    """Reject safety blocks, invalid calls, truncation, and empty completions."""
    metadata = message.response_metadata or {}
    feedback = metadata.get("prompt_feedback") or {}
    block_reason = feedback.get("block_reason") if isinstance(feedback, dict) else None
    raw_finish_reason = str(metadata.get("finish_reason") or "").upper()
    finish_reason = raw_finish_reason.rsplit(".", 1)[-1]

    if block_reason not in (None, 0, "0", "BLOCK_REASON_UNSPECIFIED"):
        raise ModelSafetyError("provider safety policy blocked the request")
    if finish_reason in _SAFETY_FINISH_REASONS:
        raise ModelSafetyError("provider safety policy blocked the response")
    if finish_reason in _INVALID_FINISH_REASONS:
        raise InvalidModelOutputError("model response was incomplete")
    if finish_reason and finish_reason != "STOP":
        raise InvalidModelOutputError("model returned an unknown finish reason")
    if message.invalid_tool_calls:
        raise InvalidModelOutputError("model emitted invalid tool arguments")

    try:
        if isinstance(message.content, str):
            content_bytes = len(message.content.encode("utf-8"))
        else:
            content_bytes = len(
                json.dumps(
                    message.content,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
            )
    except (TypeError, ValueError):
        raise InvalidModelOutputError("model response content was invalid") from None
    if content_bytes > MAX_MODEL_MESSAGE_BYTES:
        raise InvalidModelOutputError("model response exceeded the safe limit")
    has_content = (
        bool(message.content.strip()) if isinstance(message.content, str) else bool(message.content)
    )
    if require_content and not message.tool_calls and not has_content:
        raise InvalidModelOutputError("model response was empty")
