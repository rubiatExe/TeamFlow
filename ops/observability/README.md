# Local Google Cloud tracing

The Next.js server exports OTLP traces to a local Google-built OpenTelemetry
Collector. The collector authenticates with Application Default Credentials
(ADC) and forwards traces to the Google Cloud Telemetry API.

Tracing is disabled by default. Resume parsing continues normally when the
collector is absent.

## One-time setup

1. Create local ADC and set its quota project:

   ```bash
   gcloud auth application-default login
   gcloud auth application-default set-quota-project YOUR_PROJECT_ID
   ```

2. Ensure the authenticated identity has:

   - `roles/telemetry.tracesWriter`
   - `roles/serviceusage.serviceUsageConsumer`

3. Export the non-secret runtime settings:

   ```bash
   export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
   export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/application_default_credentials.json
   ```

Never copy the ADC file into this repository.

## Start tracing

Start the collector:

```bash
docker compose -f ops/observability/docker-compose.yml up
```

Set these values in `.env.local` and restart Next.js:

```dotenv
TEAMFLOW_OTEL_ENABLED=true
NEXT_OTEL_SERVICE_NAME=teamflow-next-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_PROPAGATORS=tracecontext,baggage
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=1.0
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
```

For production, use a lower root sampling ratio such as `0.1`.

## Expected trace

A successful upload should produce one trace containing:

1. Next.js `/api/parser`
2. `ocr_agent.extract`
3. Cloud Run `/extract`
4. FastAPI request span
5. `ocr_extraction`
6. `embedding_generation`
7. `score_resume`
8. `supabase.persist_candidate`

No resume content, candidate contact information, or file name is attached to
the custom spans.
