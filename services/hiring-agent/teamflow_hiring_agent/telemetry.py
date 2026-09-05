"""Fail-closed OpenTelemetry tracing for the hiring-agent service.

Production startup requires the native Google Cloud Trace exporter to be
constructible. Development and test processes install a local provider without
an exporter so sensitive hiring data is not written to a console by default.

Only the explicitly declared resource attributes below are attached to spans.
In particular, ``Resource.create`` is deliberately avoided because it merges
environment-provided resource attributes and optional resource detectors.
"""

from __future__ import annotations

import logging
import math
import os
import re
import threading
from collections.abc import Mapping
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

_STABLE_SERVICE_NAME = "teamflow-hiring-agent"
_SERVICE_VERSION = "2.1.0"
_VALID_ENVIRONMENTS = frozenset({"development", "test", "production"})
_SERVICE_NAME_PATTERN = re.compile(r"[a-z][a-z0-9._-]{0,62}")

_telemetry_initialized = False
_telemetry_lock = threading.Lock()
logger = logging.getLogger(__name__)


def _environment_setting(environ: Mapping[str, str] = os.environ) -> str:
    value = environ.get("ENVIRONMENT", "development")
    if not isinstance(value, str):
        raise RuntimeError("ENVIRONMENT_invalid")
    normalized = value.strip().lower()
    if normalized not in _VALID_ENVIRONMENTS:
        raise RuntimeError("ENVIRONMENT_invalid")
    return normalized


def _bounded_sample_ratio(raw: str) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError, OverflowError):
        raise RuntimeError("OTEL_TRACES_SAMPLER_ARG_invalid") from None
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise RuntimeError("OTEL_TRACES_SAMPLER_ARG_invalid")
    return value


def _service_name(
    *,
    environment: str,
    environ: Mapping[str, str] = os.environ,
) -> str:
    value = environ.get(
        "HIRING_AGENT_OTEL_SERVICE_NAME",
        environ.get("OTEL_SERVICE_NAME", _STABLE_SERVICE_NAME),
    )
    if not isinstance(value, str) or _SERVICE_NAME_PATTERN.fullmatch(value) is None:
        raise RuntimeError("OTEL_SERVICE_NAME_invalid")
    if environment == "production" and value != _STABLE_SERVICE_NAME:
        raise RuntimeError("OTEL_SERVICE_NAME_invalid")
    return value


def _shutdown_quietly(component: Any) -> None:
    try:
        component.shutdown()
    except Exception:
        # Never render exporter errors: they can contain project or credential data.
        logger.error("OpenTelemetry component cleanup failed")


def _resource(*, service_name: str, environment: str) -> Resource:
    # Direct construction is intentional. Resource.create() merges arbitrary
    # OTEL_RESOURCE_ATTRIBUTES and configured resource detectors.
    return Resource(
        {
            "service.name": service_name,
            "service.version": _SERVICE_VERSION,
            "deployment.environment": environment,
            "teamflow.component": "hiring-workflow",
        }
    )


def _build_trace_provider(
    resource: Resource,
    *,
    environment: str,
    sample_ratio: float,
) -> TracerProvider:
    provider = TracerProvider(
        resource=resource,
        sampler=ParentBased(TraceIdRatioBased(sample_ratio)),
    )

    if environment == "production":
        try:
            from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter

            exporter = CloudTraceSpanExporter()
            provider.add_span_processor(BatchSpanProcessor(exporter))
        except Exception:
            _shutdown_quietly(provider)
            logger.error("Cloud Trace exporter unavailable")
            raise RuntimeError("cloud_trace_exporter_unavailable") from None
        logger.info("Cloud Trace exporter configured")
    else:
        logger.info("Trace export disabled outside production")

    return provider


def setup_telemetry(environ: Mapping[str, str] | None = None) -> None:
    """Initialize tracing once, without a partial production fallback."""

    global _telemetry_initialized
    with _telemetry_lock:
        if _telemetry_initialized:
            return

        settings = os.environ if environ is None else environ
        environment = _environment_setting(settings)
        service_name = _service_name(environment=environment, environ=settings)
        default_sample_ratio = 0.1 if environment == "production" else 1.0
        sample_ratio = _bounded_sample_ratio(
            settings.get("OTEL_TRACES_SAMPLER_ARG", str(default_sample_ratio))
        )
        provider = _build_trace_provider(
            _resource(service_name=service_name, environment=environment),
            environment=environment,
            sample_ratio=sample_ratio,
        )

        try:
            trace.set_tracer_provider(provider)
            if trace.get_tracer_provider() is not provider:
                raise RuntimeError("tracer_provider_installation_rejected")
        except Exception:
            _shutdown_quietly(provider)
            logger.error("OpenTelemetry provider installation failed")
            raise RuntimeError("telemetry_provider_installation_failed") from None

        _telemetry_initialized = True
        logger.info("OpenTelemetry initialized")
