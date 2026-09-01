from __future__ import annotations

import logging
import sys
from types import ModuleType
from typing import Any

import pytest
import telemetry
from opentelemetry.sdk.resources import Resource


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
    monkeypatch.setenv("OTEL_CONSOLE_EXPORT_ENABLED", "false")
    monkeypatch.delenv("DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME", raising=False)
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    monkeypatch.delenv("OTEL_TRACES_SAMPLER_ARG", raising=False)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("development", "development"),
        (" TEST ", "test"),
        ("Production", "production"),
    ],
)
def test_environment_setting_normalizes_only_allowlisted_values(
    raw: str,
    expected: str,
) -> None:
    assert telemetry._environment_setting({"ENVIRONMENT": raw}) == expected


@pytest.mark.parametrize("raw", ["", "dev", "prod", "staging", "production\nunsafe"])
def test_environment_setting_rejects_unknown_values(raw: str) -> None:
    with pytest.raises(RuntimeError, match="^ENVIRONMENT_invalid$"):
        telemetry._environment_setting({"ENVIRONMENT": raw})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("true", True), (" TRUE ", True), ("false", False), ("False", False)],
)
def test_console_export_setting_is_strict(raw: str, expected: bool) -> None:
    assert telemetry._console_export_enabled({"OTEL_CONSOLE_EXPORT_ENABLED": raw}) is expected


@pytest.mark.parametrize("raw", ["", "1", "0", "yes", "enabled", "truthy"])
def test_console_export_setting_rejects_non_boolean_values(raw: str) -> None:
    with pytest.raises(RuntimeError, match="^OTEL_CONSOLE_EXPORT_ENABLED_invalid$"):
        telemetry._console_export_enabled({"OTEL_CONSOLE_EXPORT_ENABLED": raw})


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("0", 0.0), ("0.125", 0.125), ("1", 1.0)],
)
def test_sample_ratio_accepts_only_finite_bounded_values(
    raw: str,
    expected: float,
) -> None:
    assert telemetry._bounded_sample_ratio(raw) == expected


@pytest.mark.parametrize("raw", ["nan", "inf", "-inf", "-0.1", "1.1", "bad"])
def test_sample_ratio_rejects_nonfinite_or_out_of_range_values(raw: str) -> None:
    with pytest.raises(RuntimeError, match="^OTEL_TRACES_SAMPLER_ARG_invalid$"):
        telemetry._bounded_sample_ratio(raw)


def test_service_name_uses_safe_bounded_override() -> None:
    assert (
        telemetry._service_name(
            "fallback",
            environment="test",
            environ={"DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME": "document.worker_1"},
        )
        == "document.worker_1"
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
            telemetry._STABLE_SERVICE_NAME,
            environment="test",
            environ={"DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME": value},
        )


def test_production_service_name_is_stable() -> None:
    with pytest.raises(RuntimeError, match="^OTEL_SERVICE_NAME_invalid$"):
        telemetry._service_name(
            telemetry._STABLE_SERVICE_NAME,
            environment="production",
            environ={"DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME": "another-safe-service"},
        )


def _failing_exporter_module(
    module_name: str,
    attribute_name: str,
    secret_canary: str,
) -> ModuleType:
    module = ModuleType(module_name)

    def fail() -> None:
        raise RuntimeError(secret_canary)

    setattr(module, attribute_name, fail)
    return module


def test_production_trace_exporter_failure_is_sanitized_and_has_no_fallback(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret_canary = "trace-secret-canary-AIza-never-log"
    fallback_calls: list[str] = []
    module = _failing_exporter_module(
        "opentelemetry.exporter.cloud_trace",
        "CloudTraceSpanExporter",
        secret_canary,
    )
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setattr(
        telemetry,
        "ConsoleSpanExporter",
        lambda: fallback_calls.append("console"),
    )
    caplog.set_level(logging.DEBUG, logger=telemetry.__name__)

    with pytest.raises(RuntimeError) as exc_info:
        telemetry._build_trace_provider(
            Resource.create({}),
            environment="production",
            sample_ratio=0.1,
            console_enabled=True,
        )

    assert type(exc_info.value) is RuntimeError
    assert str(exc_info.value) == "cloud_trace_exporter_unavailable"
    assert exc_info.value.__suppress_context__ is True
    assert secret_canary not in repr(exc_info.value)
    assert secret_canary not in caplog.text
    assert fallback_calls == []


def test_production_metric_exporter_failure_is_sanitized_and_has_no_fallback(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret_canary = "monitoring-secret-canary-private-project"
    fallback_calls: list[str] = []
    module = _failing_exporter_module(
        "opentelemetry.exporter.cloud_monitoring",
        "CloudMonitoringMetricsExporter",
        secret_canary,
    )
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setattr(
        telemetry,
        "InMemoryMetricReader",
        lambda: fallback_calls.append("in-memory"),
    )
    caplog.set_level(logging.DEBUG, logger=telemetry.__name__)

    with pytest.raises(RuntimeError) as exc_info:
        telemetry._build_meter_provider(
            Resource.create({}),
            environment="production",
        )

    assert type(exc_info.value) is RuntimeError
    assert str(exc_info.value) == "cloud_monitoring_exporter_unavailable"
    assert exc_info.value.__suppress_context__ is True
    assert secret_canary not in repr(exc_info.value)
    assert secret_canary not in caplog.text
    assert fallback_calls == []


def test_local_trace_and_metric_behavior_is_preserved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    trace_providers: list[Any] = []
    meter_calls: list[tuple[Any, list[Any]]] = []
    console_exporter = object()
    in_memory_reader = object()

    class LocalTraceProvider(StubProvider):
        def __init__(self, *, resource: Resource, sampler: Any) -> None:
            super().__init__("local-trace")
            self.resource = resource
            self.sampler = sampler
            self.processors: list[Any] = []
            trace_providers.append(self)

        def add_span_processor(self, processor: Any) -> None:
            self.processors.append(processor)

    def local_meter_provider(*, resource: Resource, metric_readers: list[Any]) -> StubProvider:
        meter_calls.append((resource, metric_readers))
        return StubProvider("local-meter")

    monkeypatch.setattr(telemetry, "TracerProvider", LocalTraceProvider)
    monkeypatch.setattr(telemetry, "ConsoleSpanExporter", lambda: console_exporter)
    monkeypatch.setattr(telemetry, "BatchSpanProcessor", lambda exporter: ("batch", exporter))
    monkeypatch.setattr(telemetry, "InMemoryMetricReader", lambda: in_memory_reader)
    monkeypatch.setattr(telemetry, "MeterProvider", local_meter_provider)
    resource = Resource.create({})

    enabled = telemetry._build_trace_provider(
        resource,
        environment="development",
        sample_ratio=1.0,
        console_enabled=True,
    )
    disabled = telemetry._build_trace_provider(
        resource,
        environment="test",
        sample_ratio=1.0,
        console_enabled=False,
    )
    meter = telemetry._build_meter_provider(resource, environment="test")

    assert enabled is trace_providers[0]
    assert enabled.processors == [("batch", console_exporter)]
    assert disabled is trace_providers[1]
    assert disabled.processors == []
    assert isinstance(meter, StubProvider)
    assert meter_calls == [(resource, [in_memory_reader])]


def test_setup_builds_both_providers_before_install_and_normalizes_resource(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    resources: list[Resource] = []
    installed: dict[str, StubProvider] = {}
    tracer_provider = StubProvider("trace")
    meter_provider = StubProvider("meter")
    monkeypatch.setenv("ENVIRONMENT", " TEST ")

    def build_trace(resource: Resource, **kwargs: Any) -> StubProvider:
        events.append("build-trace")
        resources.append(resource)
        assert kwargs == {
            "environment": "test",
            "sample_ratio": 1.0,
            "console_enabled": False,
        }
        return tracer_provider

    def build_meter(resource: Resource, **kwargs: Any) -> StubProvider:
        events.append("build-meter")
        assert resource is resources[0]
        assert kwargs == {"environment": "test"}
        return meter_provider

    def install_trace(provider: StubProvider) -> None:
        events.append("install-trace")
        assert provider is tracer_provider
        assert events[:2] == ["build-trace", "build-meter"]
        installed["trace"] = provider

    def install_meter(provider: StubProvider) -> None:
        events.append("install-meter")
        assert provider is meter_provider
        installed["meter"] = provider

    monkeypatch.setattr(telemetry, "_build_trace_provider", build_trace)
    monkeypatch.setattr(telemetry, "_build_meter_provider", build_meter)
    monkeypatch.setattr(telemetry.trace, "set_tracer_provider", install_trace)
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: installed.get("trace"))
    monkeypatch.setattr(telemetry.metrics, "set_meter_provider", install_meter)
    monkeypatch.setattr(telemetry.metrics, "get_meter_provider", lambda: installed.get("meter"))

    telemetry.setup_telemetry()

    assert events == ["build-trace", "build-meter", "install-trace", "install-meter"]
    assert telemetry._telemetry_initialized is True
    attributes = resources[0].attributes
    assert attributes["service.name"] == "teamflow-document-processor"
    assert attributes["service.version"] == "2.0.0"
    assert attributes["deployment.environment"] == "test"
    assert attributes["teamflow.component"] == "document-processor"


def test_second_provider_failure_cleans_up_and_allows_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    installed: dict[str, StubProvider] = {}
    trace_providers: list[StubProvider] = []
    meter_provider = StubProvider("meter")
    meter_attempts = 0

    def build_trace(resource: Resource, **kwargs: Any) -> StubProvider:
        del resource, kwargs
        provider = StubProvider(f"trace-{len(trace_providers) + 1}")
        trace_providers.append(provider)
        events.append("build-trace")
        return provider

    def build_meter(resource: Resource, **kwargs: Any) -> StubProvider:
        nonlocal meter_attempts
        del resource, kwargs
        meter_attempts += 1
        events.append("build-meter")
        if meter_attempts == 1:
            raise RuntimeError("cloud_monitoring_exporter_unavailable")
        return meter_provider

    monkeypatch.setattr(telemetry, "_build_trace_provider", build_trace)
    monkeypatch.setattr(telemetry, "_build_meter_provider", build_meter)

    def install_trace(provider: StubProvider) -> None:
        installed["trace"] = provider
        events.append(f"install-{provider.name}")

    def install_meter(provider: StubProvider) -> None:
        installed["meter"] = provider
        events.append(f"install-{provider.name}")

    monkeypatch.setattr(telemetry.trace, "set_tracer_provider", install_trace)
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: installed.get("trace"))
    monkeypatch.setattr(telemetry.metrics, "set_meter_provider", install_meter)
    monkeypatch.setattr(telemetry.metrics, "get_meter_provider", lambda: installed.get("meter"))

    with pytest.raises(RuntimeError, match="^cloud_monitoring_exporter_unavailable$"):
        telemetry.setup_telemetry()

    assert telemetry._telemetry_initialized is False
    assert trace_providers[0].shutdown_calls == 1
    assert not any(event.startswith("install-") for event in events)

    telemetry.setup_telemetry()
    telemetry.setup_telemetry()

    assert telemetry._telemetry_initialized is True
    assert len(trace_providers) == 2
    assert meter_attempts == 2
    assert events[-2:] == ["install-trace-2", "install-meter"]


def test_provider_install_failure_keeps_initialization_false_and_cleans_both(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret_canary = "provider-install-secret-canary"
    tracer_provider = StubProvider("trace")
    meter_provider = StubProvider("meter")
    installed: dict[str, StubProvider] = {}
    monkeypatch.setattr(telemetry, "_build_trace_provider", lambda *args, **kwargs: tracer_provider)
    monkeypatch.setattr(telemetry, "_build_meter_provider", lambda *args, **kwargs: meter_provider)
    monkeypatch.setattr(
        telemetry.trace,
        "set_tracer_provider",
        lambda provider: installed.__setitem__("trace", provider),
    )
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: installed.get("trace"))

    def fail_install(provider: StubProvider) -> None:
        del provider
        raise RuntimeError(secret_canary)

    monkeypatch.setattr(telemetry.metrics, "set_meter_provider", fail_install)
    caplog.set_level(logging.DEBUG, logger=telemetry.__name__)

    with pytest.raises(RuntimeError) as exc_info:
        telemetry.setup_telemetry()

    assert str(exc_info.value) == "telemetry_provider_installation_failed"
    assert secret_canary not in repr(exc_info.value)
    assert secret_canary not in caplog.text
    assert telemetry._telemetry_initialized is False
    assert tracer_provider.shutdown_calls == 1
    assert meter_provider.shutdown_calls == 1


def test_silent_global_provider_rejection_is_not_treated_as_initialized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing_provider = StubProvider("existing")
    tracer_provider = StubProvider("trace")
    meter_provider = StubProvider("meter")
    meter_install_calls: list[StubProvider] = []
    monkeypatch.setattr(telemetry, "_build_trace_provider", lambda *args, **kwargs: tracer_provider)
    monkeypatch.setattr(telemetry, "_build_meter_provider", lambda *args, **kwargs: meter_provider)
    monkeypatch.setattr(telemetry.trace, "set_tracer_provider", lambda provider: None)
    monkeypatch.setattr(telemetry.trace, "get_tracer_provider", lambda: existing_provider)
    monkeypatch.setattr(
        telemetry.metrics,
        "set_meter_provider",
        lambda provider: meter_install_calls.append(provider),
    )

    with pytest.raises(RuntimeError, match="^telemetry_provider_installation_failed$"):
        telemetry.setup_telemetry()

    assert telemetry._telemetry_initialized is False
    assert meter_install_calls == []
    assert tracer_provider.shutdown_calls == 1
    assert meter_provider.shutdown_calls == 1
