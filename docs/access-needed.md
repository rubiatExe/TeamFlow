# Access Needed for Full Verification

The local implementation can be built and linted without production credentials. The items below are still needed to verify the cloud-connected pieces end to end.

## GitHub

- Permission to push a branch and open a pull request, or permission to commit directly if that is the preferred workflow.
- Access to inspect GitHub Actions runs after the workflow files are merged or pushed.
- Repository secrets configured:
  - `WIF_PROVIDER`
  - `WIF_SERVICE_ACCOUNT`

## Google Cloud

- Project ID and target region for Cloud Run.
- IAM permission to create or update:
  - Workload Identity Pool provider for GitHub OIDC.
  - Service account IAM binding for the GitHub repository subject.
  - Cloud Run deploy permissions for the WIF service account.
- Secret Manager access for:
  - `GOOGLE_API_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`
- Cloud Run access to verify the deployed `teamflow-python-service`.
- Cloud Trace and Cloud Monitoring access to confirm OpenTelemetry spans and metrics.

## Supabase

- Supabase project URL.
- Service role key stored in Google Secret Manager, not pasted into source.
- Permission to apply or verify the pgvector migration.
- Ability to call MCP tools against real tables:
  - `get_job_requirements`
  - `get_candidate`
  - `list_candidates`
  - `update_fit_score`

## Gemini

- `GOOGLE_API_KEY` available locally or in Secret Manager for real OCR and scoring tests.
- A sample resume PDF that is safe to upload for integration testing.

## OpenTelemetry Runtime

- Confirm where the Next.js app runs in production.
- Install/configure the Node OpenTelemetry provider for that runtime if it does not already provide one.
- Set `OTEL_EXPORTER_OTLP_ENDPOINT` and service identity for Agent 2 semantic scorer export.
