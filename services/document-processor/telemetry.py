"""
TeamFlow — OpenTelemetry Setup
-------------------------------
Configures the OpenTelemetry SDK for the document processor.

Production requires native Google Cloud Trace and Monitoring exporters to be
constructible before the application starts. Development and test environments
retain optional console traces and in-memory metrics.

Environment variables:
  ENVIRONMENT                   development, test, or production
  DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME
                                Stable service name override
  OTEL_SERVICE_NAME             Standard fallback service name override
  OTEL_TRACES_SAMPLER_ARG       Root trace sample ratio from 0.0 to 1.0
  OTEL_CONSOLE_EXPORT_ENABLED   Print local spans when true (default: true)
"""

from __future__ import annotations

import logging
import math
import os
import re
import threading
from collections.abc import Mapping
from typing import Any

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

_STABLE_SERVICE_NAME = "teamflow-document-processor"
_SERVICE_VERSION = "2.0.0"
_VALID_ENVIRONMENTS = frozenset({"development", "test", "production"})
_SERVICE_NAME_PATTERN = re.compile(r"[a-z][a-z0-9._-]{0,62}")

_telemetry_initialized = False
_telemetry_lock = threading.Lock()
logger = logging.getLogger(__name__)


def _environment_setting(
    environ: Mapping[str, str] = os.environ,
) -> str:
    value = environ.get("ENVIRONMENT", "development").strip().lower()
    if value not in _VALID_ENVIRONMENTS:
        raise RuntimeError("ENVIRONMENT_invalid")
    return value


def _console_export_enabled(
    environ: Mapping[str, str] = os.environ,
) -> bool:
    value = environ.get("OTEL_CONSOLE_EXPORT_ENABLED", "true").strip().lower()
    if value not in {"true", "false"}:
        raise RuntimeError("OTEL_CONSOLE_EXPORT_ENABLED_invalid")
    return value == "true"


def _bounded_sample_ratio(raw: str) -> float:
    try:
        value = float(raw)
    except ValueError:
        raise RuntimeError("OTEL_TRACES_SAMPLER_ARG_invalid") from None
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise RuntimeError("OTEL_TRACES_SAMPLER_ARG_invalid")
    return value


def _service_name(
    default: str,
    *,
    environment: str,
    environ: Mapping[str, str] = os.environ,
) -> str:
    value = environ.get(
        "DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME",
        environ.get("OTEL_SERVICE_NAME", default),
    )
    if not _SERVICE_NAME_PATTERN.fullmatch(value):
        raise RuntimeError("OTEL_SERVICE_NAME_invalid")
    if environment == "production" and value != _STABLE_SERVICE_NAME:
        raise RuntimeError("OTEL_SERVICE_NAME_invalid")
    return value


def _shutdown_quietly(component: Any) -> None:
    try:
        component.shutdown()
    except Exception:
        # Cleanup errors must not disclose exporter configuration or credentials.
        logger.error("OpenTelemetry component cleanup failed")


def _build_trace_provider(
    resource: Resource,
    *,
    environment: str,
    sample_ratio: float,
    console_enabled: bool,
) -> TracerProvider:
    tracer_provider = TracerProvider(
        resource=resource,
        sampler=ParentBased(TraceIdRatioBased(sample_ratio)),
    )

    if environment == "production":
        try:
            from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter

            cloud_trace_exporter = CloudTraceSpanExporter()
            tracer_provider.add_span_processor(BatchSpanProcessor(cloud_trace_exporter))
        except Exception:
            _shutdown_quietly(tracer_provider)
            logger.error("Cloud Trace exporter unavailable")
            raise RuntimeError("cloud_trace_exporter_unavailable") from None
        logger.info("Cloud Trace exporter configured")
    elif console_enabled:
        tracer_provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
        logger.info("Console trace exporter configured")
    else:
        logger.info("Trace exporter disabled")

    return tracer_provider


def _build_meter_provider(
    resource: Resource,
    *,
    environment: str,
) -> MeterProvider:
    if environment == "production":
        metric_reader: PeriodicExportingMetricReader | None = None
        try:
            from opentelemetry.exporter.cloud_monitoring import CloudMonitoringMetricsExporter

            cloud_monitoring_exporter = CloudMonitoringMetricsExporter()
            metric_reader = PeriodicExportingMetricReader(
                cloud_monitoring_exporter,
                export_interval_millis=30_000,
            )
            meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
        except Exception:
            if metric_reader is not None:
                _shutdown_quietly(metric_reader)
            logger.error("Cloud Monitoring exporter unavailable")
            raise RuntimeError("cloud_monitoring_exporter_unavailable") from None
        logger.info("Cloud Monitoring exporter configured")
        return meter_provider

    metric_reader = InMemoryMetricReader()
    logger.info("In-memory metric reader configured")
    return MeterProvider(resource=resource, metric_readers=[metric_reader])


def setup_telemetry(service_name: str = _STABLE_SERVICE_NAME) -> None:
    """Initialize tracing and metrics once, without partial production fallback."""

    global _telemetry_initialized
    with _telemetry_lock:
        if _telemetry_initialized:
            return

        environment = _environment_setting()
        console_enabled = _console_export_enabled()
        configured_service_name = _service_name(
            service_name,
            environment=environment,
        )
        default_sample_ratio = 0.1 if environment == "production" else 1.0
        sample_ratio = _bounded_sample_ratio(
            os.getenv("OTEL_TRACES_SAMPLER_ARG", str(default_sample_ratio))
        )
        resource = Resource.create(
            {
                "service.name": configured_service_name,
                "service.version": _SERVICE_VERSION,
                "deployment.environment": environment,
                "teamflow.component": "document-processor",
            }
        )

        tracer_provider = _build_trace_provider(
            resource,
            environment=environment,
            sample_ratio=sample_ratio,
            console_enabled=console_enabled,
        )
        try:
            meter_provider = _build_meter_provider(
                resource,
                environment=environment,
            )
        except BaseException:
            _shutdown_quietly(tracer_provider)
            raise

        try:
            # Both providers are fully constructed before either becomes global.
            trace.set_tracer_provider(tracer_provider)
            if trace.get_tracer_provider() is not tracer_provider:
                raise RuntimeError("tracer_provider_installation_rejected")
            metrics.set_meter_provider(meter_provider)
            if metrics.get_meter_provider() is not meter_provider:
                raise RuntimeError("meter_provider_installation_rejected")
        except Exception:
            _shutdown_quietly(meter_provider)
            _shutdown_quietly(tracer_provider)
            logger.error("OpenTelemetry provider installation failed")
            raise RuntimeError("telemetry_provider_installation_failed") from None

        _telemetry_initialized = True
        logger.info("OpenTelemetry initialized")
