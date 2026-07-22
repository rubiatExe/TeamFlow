"""
TeamFlow — OpenTelemetry Setup
-------------------------------
Configures the OpenTelemetry SDK for the Python microservice.
Exports distributed traces and metrics to Google Cloud Trace/Monitoring
via the OTLP gRPC exporter.

All instrumentation uses the OpenTelemetry GenAI Semantic Conventions:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/

Environment variables:
  OTEL_EXPORTER_OTLP_ENDPOINT   OTLP collector endpoint (e.g. https://telemetry.googleapis.com)
  OTEL_SERVICE_NAME             Service name tag in Cloud Trace (default: "teamflow-python-service")
  OTEL_TRACES_EXPORTER          Set to "none" to disable trace export (useful in local dev)
"""

import os

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter

_telemetry_initialized = False


def setup_telemetry(service_name: str = "teamflow-python-service") -> None:
    """
    Initialize OpenTelemetry tracing and metrics providers.
    Safe to call multiple times — only initializes once.
    """
    global _telemetry_initialized
    if _telemetry_initialized:
        return
    _telemetry_initialized = True

    resource = Resource.create(
        {
            "service.name": os.getenv("OTEL_SERVICE_NAME", service_name),
            "service.version": "1.0.0",
            "deployment.environment": os.getenv("ENVIRONMENT", "development"),
        }
    )

    _setup_traces(resource)
    _setup_metrics(resource)

    print(f"[OTel] Telemetry initialized for service: {os.getenv('OTEL_SERVICE_NAME', service_name)}")


def _setup_traces(resource: Resource) -> None:
    """Configure the TracerProvider with OTLP + Console exporters."""
    tracer_provider = TracerProvider(resource=resource)

    otlp_endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
    traces_exporter = os.getenv("OTEL_TRACES_EXPORTER", "otlp")

    if otlp_endpoint and traces_exporter != "none":
        # Production: export spans to Google Cloud Trace via OTLP gRPC
        otlp_exporter = OTLPSpanExporter(endpoint=otlp_endpoint)
        tracer_provider.add_span_processor(BatchSpanProcessor(otlp_exporter))
        print(f"[OTel] Trace exporter → OTLP at {otlp_endpoint}")
    else:
        # Local dev: print spans to console so they're visible without a backend
        tracer_provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
        print("[OTel] Trace exporter → Console (set OTEL_EXPORTER_OTLP_ENDPOINT for Cloud Trace)")

    trace.set_tracer_provider(tracer_provider)


def _setup_metrics(resource: Resource) -> None:
    """Configure the MeterProvider with OTLP exporter for token usage metrics."""
    otlp_endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")

    if otlp_endpoint:
        # Production: export metrics to Google Cloud Monitoring via OTLP
        metric_reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=otlp_endpoint),
            export_interval_millis=30_000,  # Export every 30s
        )
        print(f"[OTel] Metric exporter → OTLP at {otlp_endpoint}")
    else:
        # Local dev: no-op metric export (metrics still recorded, just not sent)
        from opentelemetry.sdk.metrics.export import InMemoryMetricReader
        metric_reader = InMemoryMetricReader()
        print("[OTel] Metric exporter → In-memory (no Cloud Monitoring without OTLP endpoint)")

    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)
