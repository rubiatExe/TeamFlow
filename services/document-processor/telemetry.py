"""
TeamFlow — OpenTelemetry Setup
-------------------------------
Configures the OpenTelemetry SDK for the Python microservice.
Exports distributed traces and metrics to Google Cloud Trace/Monitoring natively.

All instrumentation uses the OpenTelemetry GenAI Semantic Conventions:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/

Environment variables:
  ENVIRONMENT                   Set to "production" to enable Cloud Trace/Monitoring
  OTEL_SERVICE_NAME             Service name tag in Cloud Trace (default: "teamflow-python-service")
  OTEL_TRACES_SAMPLER_ARG       Root trace sample ratio from 0.0 to 1.0
  OTEL_CONSOLE_EXPORT_ENABLED   Print local spans when true (default: true)
"""

import os

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

_telemetry_initialized = False


def _service_name(default: str) -> str:
    return os.getenv(
        "DOCUMENT_PROCESSOR_OTEL_SERVICE_NAME",
        os.getenv("OTEL_SERVICE_NAME", default),
    )


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
            "service.name": _service_name(service_name),
            "service.version": "1.0.0",
            "deployment.environment": os.getenv("ENVIRONMENT", "development"),
            "teamflow.component": "document-processor",
        }
    )

    _setup_traces(resource)
    _setup_metrics(resource)

    print(f"[OTel] Telemetry initialized for service: {_service_name(service_name)}")


def _setup_traces(resource: Resource) -> None:
    """Configure the TracerProvider with GCP + Console exporters."""
    environment = os.getenv("ENVIRONMENT", "development")
    default_sample_ratio = 0.1 if environment == "production" else 1.0

    try:
        configured_sample_ratio = float(
            os.getenv("OTEL_TRACES_SAMPLER_ARG", str(default_sample_ratio))
        )
    except ValueError:
        configured_sample_ratio = default_sample_ratio

    sample_ratio = min(max(configured_sample_ratio, 0.0), 1.0)
    tracer_provider = TracerProvider(
        resource=resource,
        sampler=ParentBased(TraceIdRatioBased(sample_ratio)),
    )

    if environment == "production":
        # Production: export spans to Google Cloud Trace natively
        try:
            from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
            cloud_trace_exporter = CloudTraceSpanExporter()
            tracer_provider.add_span_processor(BatchSpanProcessor(cloud_trace_exporter))
            print("[OTel] Trace exporter → Google Cloud Trace")
        except Exception as e:
            print(f"[OTel] Failed to setup Cloud Trace: {e}")
            tracer_provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
    else:
        # Local dev: optionally print spans without requiring a backend.
        console_enabled = (
            os.getenv("OTEL_CONSOLE_EXPORT_ENABLED", "true").lower() == "true"
        )
        if console_enabled:
            tracer_provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
            print("[OTel] Trace exporter → Console")
        else:
            print("[OTel] Trace exporter → Disabled")

    trace.set_tracer_provider(tracer_provider)


def _setup_metrics(resource: Resource) -> None:
    """Configure the MeterProvider with GCP exporter for token usage metrics."""
    environment = os.getenv("ENVIRONMENT", "development")

    if environment == "production":
        # Production: export metrics to Google Cloud Monitoring natively
        try:
            from opentelemetry.exporter.cloud_monitoring import CloudMonitoringMetricsExporter
            cloud_monitoring_exporter = CloudMonitoringMetricsExporter()
            metric_reader = PeriodicExportingMetricReader(
                cloud_monitoring_exporter,
                export_interval_millis=30_000,  # Export every 30s
            )
            print("[OTel] Metric exporter → Google Cloud Monitoring")
        except Exception as e:
            print(f"[OTel] Failed to setup Cloud Monitoring: {e}")
            metric_reader = InMemoryMetricReader()
    else:
        # Local dev: no-op metric export
        metric_reader = InMemoryMetricReader()
        print("[OTel] Metric exporter → In-memory")

    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)
