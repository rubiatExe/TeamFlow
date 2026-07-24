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
"""

import os

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader, InMemoryMetricReader
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
    """Configure the TracerProvider with GCP + Console exporters."""
    tracer_provider = TracerProvider(resource=resource)
    environment = os.getenv("ENVIRONMENT", "development")

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
        # Local dev: print spans to console so they're visible without a backend
        tracer_provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
        print("[OTel] Trace exporter → Console")

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
