import asyncio
from contextlib import contextmanager

import pytest
from langchain_core.messages import AIMessage

from teamflow_hiring_agent import reliability
from teamflow_hiring_agent.reliability import (
    FailoverRunnable,
    InvalidModelOutputError,
    ModelInvocationError,
    ModelSafetyError,
    is_transient_model_error,
)


class Runnable:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    async def ainvoke(self, value, **kwargs):
        self.calls += 1
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def test_transient_failure_uses_one_approved_fallback():
    primary = Runnable(ConnectionError("temporary"))
    fallback = Runnable("recovered")

    result = asyncio.run(FailoverRunnable(primary, fallback).ainvoke("input"))

    assert result == "recovered"
    assert primary.calls == 1
    assert fallback.calls == 1


def test_safety_failure_never_uses_a_fallback_model():
    primary = Runnable(ModelSafetyError("blocked"))
    fallback = Runnable("must not run")

    try:
        asyncio.run(FailoverRunnable(primary, fallback).ainvoke("input"))
    except ModelSafetyError:
        pass
    else:
        raise AssertionError("safety refusal must fail closed")

    assert primary.calls == 1
    assert fallback.calls == 0


def test_invalid_model_output_never_switches_models():
    primary = Runnable(InvalidModelOutputError("invalid"))
    fallback = Runnable("must not run")

    try:
        asyncio.run(FailoverRunnable(primary, fallback).ainvoke("input"))
    except InvalidModelOutputError:
        pass
    else:
        raise AssertionError("invalid output must remain on the approved primary model")

    assert primary.calls == 1
    assert fallback.calls == 0


class StatusError(RuntimeError):
    def __init__(self, status_code):
        super().__init__("provider error")
        self.status_code = status_code


def test_only_rate_limit_and_real_server_statuses_are_transient():
    assert is_transient_model_error(StatusError(429)) is True
    assert is_transient_model_error(StatusError(503)) is True
    assert is_transient_model_error(StatusError(400)) is False
    assert is_transient_model_error(StatusError(600)) is False
    assert is_transient_model_error(StatusError(True)) is False


def test_outer_model_cancellation_never_invokes_fallback():
    primary = Runnable(asyncio.CancelledError())
    fallback = Runnable("must not run")

    try:
        asyncio.run(FailoverRunnable(primary, fallback).ainvoke("input"))
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("cancellation must propagate")

    assert primary.calls == 1
    assert fallback.calls == 0


class RecordingSpan:
    def __init__(self):
        self.attributes = {}

    def set_attribute(self, key, value):
        self.attributes[key] = value


def test_model_span_omits_unbounded_or_secret_shaped_model_names():
    valid_span = RecordingSpan()
    FailoverRunnable._annotate_model_span(valid_span, "models/gemini-3.7-flash")
    assert valid_span.attributes["gen_ai.request.model"] == "models/gemini-3.7-flash"

    unsafe_span = RecordingSpan()
    FailoverRunnable._annotate_model_span(unsafe_span, "api_key=secret-canary")
    assert "gen_ai.request.model" not in unsafe_span.attributes
    assert "secret-canary" not in str(unsafe_span.attributes)


@pytest.mark.parametrize(
    "finish_reason",
    [
        "SAFETY",
        "IMAGE_SAFETY",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "IMAGE_PROHIBITED_CONTENT",
        "SPII",
        "RECITATION",
        "IMAGE_RECITATION",
    ],
)
def test_provider_policy_finish_reasons_are_non_retryable_refusals(finish_reason):
    with pytest.raises(ModelSafetyError):
        reliability.validate_ai_message(
            AIMessage(content="unsafe", response_metadata={"finish_reason": finish_reason})
        )


@pytest.mark.parametrize(
    "finish_reason",
    [
        "FINISH_REASON_UNSPECIFIED",
        "MAX_TOKENS",
        "LANGUAGE",
        "OTHER",
        "MALFORMED_FUNCTION_CALL",
        "UNEXPECTED_TOOL_CALL",
        "NO_IMAGE",
        "IMAGE_OTHER",
        "FUTURE_UNKNOWN_REASON",
    ],
)
def test_non_success_provider_finish_reasons_are_invalid(finish_reason):
    with pytest.raises(InvalidModelOutputError):
        reliability.validate_ai_message(
            AIMessage(content="invalid", response_metadata={"finish_reason": finish_reason})
        )


def test_only_stop_or_missing_test_double_metadata_can_succeed():
    reliability.validate_ai_message(
        AIMessage(content="complete", response_metadata={"finish_reason": "STOP"})
    )
    reliability.validate_ai_message(AIMessage(content="test-double"))


def test_model_message_content_is_bounded_before_graph_state():
    with pytest.raises(InvalidModelOutputError):
        reliability.validate_ai_message(AIMessage(content="x" * 32_769))


class RecordingTracer:
    def __init__(self):
        self.options = []

    @contextmanager
    def start_as_current_span(self, _name, **kwargs):
        self.options.append(kwargs)
        yield RecordingSpan()


def test_provider_exceptions_are_not_automatically_recorded_on_spans(monkeypatch):
    secret = "provider-body-secret-canary"
    tracer = RecordingTracer()
    monkeypatch.setattr(reliability, "tracer", tracer)
    primary = Runnable(RuntimeError(secret))

    with pytest.raises(ModelInvocationError, match="model invocation failed") as captured:
        asyncio.run(FailoverRunnable(primary, None).ainvoke("input"))

    assert secret not in str(captured.value)
    assert captured.value.__cause__ is None
    assert tracer.options == [{"record_exception": False, "set_status_on_exception": False}]
    assert secret not in str(tracer.options)


def test_fallback_provider_failure_is_sanitized_without_exception_recording(monkeypatch):
    secret = "fallback-provider-body-secret-canary"
    tracer = RecordingTracer()
    monkeypatch.setattr(reliability, "tracer", tracer)
    primary = Runnable(ConnectionError("temporary primary failure"))
    fallback = Runnable(RuntimeError(secret))

    with pytest.raises(
        ModelInvocationError,
        match="fallback model invocation failed",
    ) as captured:
        asyncio.run(FailoverRunnable(primary, fallback).ainvoke("input"))

    assert secret not in str(captured.value)
    assert captured.value.__cause__ is None
    assert tracer.options == [
        {"record_exception": False, "set_status_on_exception": False},
        {"record_exception": False, "set_status_on_exception": False},
    ]
    assert secret not in str(tracer.options)
