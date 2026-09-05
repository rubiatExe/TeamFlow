from __future__ import annotations

import logging
import sys
import threading
from types import ModuleType
from typing import Any

import pytest
from opentelemetry.sdk.resources import Resource

from teamflow_hiring_agent import telemetry


class StubProvider:
    def __init__(self, name: str) -> None:
        self.name = name
        self.shutdown_calls = 0

    def shutdown(self) -> None:
        self.shutdown_calls += 1


@pytest.fixture(autouse=True)
def reset_telemetry_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(telemetry, "_telemetry_initialized", False)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("HIRING_AGENT_OTEL_SERVICE_NAME", raising=False)
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    monkeypatch.delenv("OTEL_TRACES_SAMPLER_ARG", raising=False)
    monkeypatch.delenv("OTEL_RESOURCE_ATTRIBUTES", raising=False)
    monkeypatch.delenv("OTEL_EXPERIMENTAL_RESOURCE_DETECTORS", raising=False)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("development", "development"),
        (" TEST ", "test"),
        ("Production", "production"),
    ],
)
def test_environment_setting_normalizes_allowlisted_values(raw: str, expected: str) -> None:
    assert telemetry._environment_setting({"ENVIRONMENT": raw}) == expected


@pytest.mark.parametrize("raw", ["", "dev", "prod", "staging", "production\nunsafe"])
def test_environment_setting_rejects_unknown_values(raw: str) -> None:
    with pytest.raises(RuntimeError, match="^ENVIRONMENT_invalid$"):
        telemetry._environment_setting({"ENVIRONMENT": raw})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("0", 0.0), ("0.125", 0.125), ("1", 1.0)],
)
def test_sample_ratio_accepts_only_finite_bounded_values(raw: str, expected: float) -> None:
    assert telemetry._bounded_sample_ratio(raw) == expected


@pytest.mark.parametrize("raw", ["nan", "inf", "-inf", "-0.1", "1.1", "bad"])
def test_sample_ratio_rejects_nonfinite_or_out_of_range_values(raw: str) -> None:
    with pytest.raises(RuntimeError, match="^OTEL_TRACES_SAMPLER_ARG_invalid$"):
        telemetry._bounded_sample_ratio(raw)


def test_service_name_uses_valid_component_override() -> None:
    assert (
        telemetry._service_name(
            environment="test",
            environ={"HIRING_AGENT_OTEL_SERVICE_NAME": "hiring.worker_1"},
        )
        == "hiring.worker_1"
    )


@pytest.mark.parametrize(
    "value",
    [
        "",
        " leading-space",
        "trailing-space ",
        "Uppercase",
        "contains/slash",
        "contains:colon",
        "a" * 64,
        "service\nsecret-canary",
    ],
)
def test_service_name_rejects_unsafe_or_unbounded_values(value: str) -> None:
    with pytest.raises(RuntimeError, match="^OTEL_SERVICE_NAME_invalid$"):
        telemetry._service_name(
            environment="test",
            environ={"HIRING_AGENT_OTEL_SERVICE_NAME": value},
        )


def test_production_service_name_is_fixed() -> None:
    with pytest.raises(RuntimeError, match="^OTEL_SERVICE_NAME_invalid$"):
        telemetry._service_name(
            environment="production",
            environ={"OTEL_SERVICE_NAME": "another-safe-service"},
        )


def test_resource_has_an_exact_allowlist_despite_hostile_otel_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "OTEL_RESOURCE_ATTRIBUTES",
        "candidate.email=secret@example.test,merchant.id=tenant-secret",
    )
    monkeypatch.setenv("OTEL_SERVICE_NAME", "attacker-controlled-service")
    monkeypatch.setenv("OTEL_EXPERIMENTAL_RESOURCE_DETECTORS", "*")

    resource = telemetry._resource(
        service_name=telemetry._STABLE_SERVICE_NAME,
        environment="production",
    )

    assert dict(resource.attributes) == {
        "service.name": "teamflow-hiring-agent",
        "service.version": "2.1.0",
        "deployment.environment": "production",
        "teamflow.component": "hiring-workflow",
    }
    assert "secret@example.test" not in repr(resource.attributes)
    assert "tenant-secret" not in repr(resource.attributes)


def _failing_exporter_module(secret_canary: str) -> ModuleType:
    module = ModuleType("opentelemetry.exporter.cloud_trace")

    def fail() -> None:
        raise RuntimeError(secret_canary)

    module.CloudTraceSpanExporter = fail  # type: ignore[attr-defined]
    return module


def test_production_exporter_failure_is_sanitized_and_has_no_fallback(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret_canary = "trace-secret-canary-AIza-never-log"
    provider = StubProvider("trace")
    fallback_calls: list[str] = []
    module = _failing_exporter_module(secret_canary)
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setattr(telemetry, "TracerProvider", lambda **kwargs: provider)
    monkeypatch.setattr(
        telemetry,
        "BatchSpanProcessor",
        lambda exporter: fallback_calls.append("processor"),
    )
    caplog.set_level(logging.DEBUG, logger=telemetry.__name__)

    with pytest.raises(RuntimeError) as exc_info:
        telemetry._build_trace_provider(
            Resource({}),
            environment="production",
            sample_ratio=0.1,
        )

    assert str(exc_info.value) == "cloud_trace_exporter_unavailable"
    assert exc_info.value.__suppress_context__ is True
    assert secret_canary not in repr(exc_info.value)
    assert secret_canary not in caplog.text
    assert fallback_calls == []
    assert provider.shutdown_calls == 1


def test_nonproduction_never_constructs_cloud_exporter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = StubProvider("trace")
    cloud_calls: list[str] = []
    module = ModuleType("opentelemetry.exporter.cloud_trace")
    module.CloudTraceSpanExporter = lambda: cloud_calls.append("cloud")  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setattr(telemetry, "TracerProvider", lambda **kwargs: provider)

    result = telemetry._build_trace_provider(
        Resource({}),
        environment="test",
        sample_ratio=1.0,
    )

    assert result is provider
    assert cloud_calls == []


def test_setup_installs_then_marks_initialized_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    installed: dict[str, StubProvider] = {}
    provider = StubProvider("trace")
    resources: list[Resource] = []

    def build(resource: Resource, **kwargs: Any) -> StubProvider:
        events.append("build")
        resources.append(resource)
        assert kwargs == {"environment": "test", "sample_ratio": 1.0}
        return provider

    def install(candidate: StubProvider) -> None:
        events.append("install")
        assert telemetry._telemetry_initialized is False
        installed["trace"] = candidate

    monkeypatch.setattr(telemetry, "_build_trace_provider", build)
    monkeypatch.setattr(telemetry.trace, "set_tracer_provider", install)
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: installed.get("trace"))

    telemetry.setup_telemetry()
    telemetry.setup_telemetry()

    assert events == ["build", "install"]
    assert telemetry._telemetry_initialized is True
    assert dict(resources[0].attributes) == {
        "service.name": "teamflow-hiring-agent",
        "service.version": "2.1.0",
        "deployment.environment": "test",
        "teamflow.component": "hiring-workflow",
    }


def test_setup_uses_the_supplied_environment_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = StubProvider("trace")
    installed: dict[str, StubProvider] = {}
    observed: dict[str, Any] = {}
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("OTEL_TRACES_SAMPLER_ARG", "not-a-number")

    def build(resource: Resource, **kwargs: Any) -> StubProvider:
        observed["resource"] = resource
        observed.update(kwargs)
        return provider

    monkeypatch.setattr(telemetry, "_build_trace_provider", build)
    monkeypatch.setattr(
        telemetry.trace,
        "set_tracer_provider",
        lambda candidate: installed.__setitem__("trace", candidate),
    )
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: installed.get("trace"))

    telemetry.setup_telemetry(
        {
            "ENVIRONMENT": "test",
            "HIRING_AGENT_OTEL_SERVICE_NAME": "hiring.snapshot",
            "OTEL_TRACES_SAMPLER_ARG": "0.25",
        }
    )

    assert observed["environment"] == "test"
    assert observed["sample_ratio"] == 0.25
    assert dict(observed["resource"].attributes) == {
        "service.name": "hiring.snapshot",
        "service.version": "2.1.0",
        "deployment.environment": "test",
        "teamflow.component": "hiring-workflow",
    }


def test_build_failure_leaves_initialization_false_and_allows_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = StubProvider("trace")
    attempts = 0
    installed: dict[str, StubProvider] = {}

    def build(*args: Any, **kwargs: Any) -> StubProvider:
        nonlocal attempts
        del args, kwargs
        attempts += 1
        if attempts == 1:
            raise RuntimeError("cloud_trace_exporter_unavailable")
        return provider

    monkeypatch.setattr(telemetry, "_build_trace_provider", build)
    monkeypatch.setattr(
        telemetry.trace,
        "set_tracer_provider",
        lambda candidate: installed.__setitem__("trace", candidate),
    )
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: installed.get("trace"))

    with pytest.raises(RuntimeError, match="^cloud_trace_exporter_unavailable$"):
        telemetry.setup_telemetry()

    assert telemetry._telemetry_initialized is False
    telemetry.setup_telemetry()
    assert attempts == 2
    assert telemetry._telemetry_initialized is True


def test_provider_install_failure_is_sanitized_cleaned_and_retryable(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret_canary = "provider-install-secret-canary"
    first = StubProvider("first")
    second = StubProvider("second")
    providers = [first, second]
    installed: dict[str, StubProvider] = {}
    attempts = 0

    monkeypatch.setattr(
        telemetry,
        "_build_trace_provider",
        lambda *args, **kwargs: providers.pop(0),
    )

    def install(provider: StubProvider) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError(secret_canary)
        installed["trace"] = provider

    monkeypatch.setattr(telemetry.trace, "set_tracer_provider", install)
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: installed.get("trace"))
    caplog.set_level(logging.DEBUG, logger=telemetry.__name__)

    with pytest.raises(RuntimeError) as exc_info:
        telemetry.setup_telemetry()

    assert str(exc_info.value) == "telemetry_provider_installation_failed"
    assert exc_info.value.__suppress_context__ is True
    assert secret_canary not in repr(exc_info.value)
    assert secret_canary not in caplog.text
    assert telemetry._telemetry_initialized is False
    assert first.shutdown_calls == 1

    telemetry.setup_telemetry()
    assert telemetry._telemetry_initialized is True


def test_silent_global_provider_rejection_is_not_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing_provider = StubProvider("existing")
    provider = StubProvider("candidate")
    monkeypatch.setattr(telemetry, "_build_trace_provider", lambda *args, **kwargs: provider)
    monkeypatch.setattr(telemetry.trace, "set_tracer_provider", lambda candidate: None)
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: existing_provider)

    with pytest.raises(RuntimeError, match="^telemetry_provider_installation_failed$"):
        telemetry.setup_telemetry()

    assert telemetry._telemetry_initialized is False
    assert provider.shutdown_calls == 1


def test_concurrent_setup_builds_and_installs_only_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = StubProvider("trace")
    installed: dict[str, StubProvider] = {}
    build_calls = 0
    install_calls = 0

    def build(*args: Any, **kwargs: Any) -> StubProvider:
        nonlocal build_calls
        del args, kwargs
        build_calls += 1
        return provider

    def install(candidate: StubProvider) -> None:
        nonlocal install_calls
        install_calls += 1
        installed["trace"] = candidate

    monkeypatch.setattr(telemetry, "_build_trace_provider", build)
    monkeypatch.setattr(telemetry.trace, "set_tracer_provider", install)
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: installed.get("trace"))
    workers = [threading.Thread(target=telemetry.setup_telemetry) for _ in range(8)]

    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()

    assert build_calls == 1
    assert install_calls == 1
    assert telemetry._telemetry_initialized is True
