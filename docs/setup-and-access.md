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
  - `OCR_SERVICE_TOKEN`
  - `SUPABASE_URL`
  - `SUPABASE_TRUSTED_ORIGIN`
  - `SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_HIRING_READER_TOKEN`, minted for exactly one merchant and the
    `teamflow_hiring_reader` role
  - `HIRING_AGENT_TOKEN`
  - `SUPABASE_ANON_KEY` for server-side bearer verification when Phase 6 is enabled.
  - `TEAMFLOW_HITL_DSN` for the dedicated `teamflow_hitl_service` database role.
  - `TEAMFLOW_HITL_CAPABILITY_SECRET`, bound to a numeric Secret Manager version,
    for the independent one-use actor capability key. The matching raw key must be
    provisioned separately in the private database keyring together with the exact
    canonical `SUPABASE_URL/auth/v1` issuer.
  - `TEAMFLOW_CHECKPOINT_DSN` for the dedicated
    `teamflow_checkpoint_runtime` role. The separate checkpoint-migration DSN must be
    supplied only to a controlled migration job, never to the running service.
- Next.js hosting secrets/configuration:
  - `HIRING_AGENT_ENABLED=true` only when the private route is intentionally exposed.
  - `HIRING_AGENT_ROUTE_TOKEN` for callers of `/api/parser/agent`.
  - The same token protects `/api/parser/review`; this is a service/demo boundary,
    not manager identity.
  - `RESUME_REVIEW_STORE_DOCUMENTS=false` until validated extraction snapshots should
    be stored deliberately.
  - `RESUME_REVIEW_PERSIST_RESULTS=false` until append-only review runs should be
    stored deliberately.
- Cloud Run access to verify the deployed `teamflow-python-service`.
- Cloud Run access to verify the separate `teamflow-hiring-agent` service.
- Cloud Trace and Cloud Monitoring access to confirm OpenTelemetry spans and metrics.

## Supabase

- Supabase project URL.
- A publishable key plus a short-lived/rotatable tenant-scoped hiring-reader JWT for the
  production hiring service. Never mount a Supabase service-role key into that service.
- A service-role key is needed only by the explicitly enabled local legacy Next demo or
  a controlled administration/migration process; it is not part of the production
  manager or hiring-agent authorization boundary.
- Permission to apply or verify the pgvector migration.
- Permission to apply and verify the Phase 4 document snapshot,
  candidate-document link, configured role-policy, and review-run schema.
- Permission to apply and inspect the feature-gated Phase 6 membership, workflow,
  review, revision, decision, and event migration. A staging verification must cover
  tenant isolation, role grants, exact replay, stale-version conflicts, and rollback.
- Direct TLS PostgreSQL credentials for the narrowly granted `teamflow_hitl_service`,
  `teamflow_checkpoint_migrator`, and `teamflow_checkpoint_runtime` roles. Supabase REST
  credentials are not a LangGraph checkpoint DSN.
- A controlled one-time execution of the pinned LangGraph checkpoint migrations,
  followed by the read-only checkpoint readiness check. The application deliberately
  does not run checkpoint DDL at startup.
- Confirmation that the existing tables remain exposed to the Data API. New migrations must include explicit role grants when the project disables automatic Data API exposure.
- Ability to call MCP tools against real tables:
  - `get_job_requirements`
  - `get_candidate`
  - `list_candidates`
  - `semantic_search_candidates`
  - Phase 4 `get_resume_document`
  - Phase 4 `load_active_role_policies`
- The legacy FastMCP surface is read-only; no candidate-score mutation should be tested
  through it. Candidate-score changes require the authenticated Phase 6 decision path.
  The checked-in deployment workflow also keeps optional Phase 4 result persistence
  disabled with `AGENT_ALLOW_WRITES=false`; live deployment state is unverified. See
  `docs/llm-security-reliability.md`.

The ordered migration set now begins with the idempotent `000_teamflow_base.sql`, which
supplies the schema and extensions required by historical migration `001`. CI replays
all migrations from an empty application database on a pinned Supabase PostgreSQL image
and then loads the synthetic seed. Existing databases that already recorded `001` or a
later migration must verify their base objects and explicitly reconcile `000` in the
remote migration ledger; do not blindly replay or rewrite an applied migration. Every
active job must have a valid Phase 4 policy or the complete catalog fails closed. Before
a production review, replace the seed with an authenticated policy
administration/approval process and verify the applied remote schema with live
cross-tenant and append-only-run checks.

The Phase 6 migration and capability hardening were exercised against disposable
local PostgreSQL 16 and Supabase PostgreSQL 17 servers. Enabling
`TEAMFLOW_HITL_ENABLED=true` in staging or production also requires current
Supabase Auth membership/session data, AAL2 enrollment and challenge UX, the three
dedicated database roles, both pre-migrated schemas, a separately provisioned
capability key, secrets bound to the correct process, and an authenticated smoke test
covering start, queue/detail, recent-AAL2 decision, process restart, and exact replay.
See `docs/hitl-security-and-retention.md`. Reviewer assignment/claim leases,
notifications, stale-work sweepers, and a browser reviewer UI are not implemented.

## Gemini

- `GOOGLE_API_KEY` available locally or in Secret Manager for real OCR and scoring tests.
- A sample resume PDF that is safe to upload for integration testing.

## OpenTelemetry Runtime

- Confirm where the Next.js app runs in production.
- Local Google Cloud export requires Application Default Credentials outside
  the repository and the collector setup in `ops/observability/README.md`.
- The collector identity needs `roles/telemetry.tracesWriter` and
  `roles/serviceusage.serviceUsageConsumer`.
- Set `TEAMFLOW_OTEL_ENABLED=true`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and
  `GOOGLE_CLOUD_PROJECT` only when the collector is ready.
- Leave `OTEL_SDK_DISABLED` unset when enabling tracing; set it to `true` only
  as an emergency override.
- Keep production root sampling below the local test setting of `1.0`.
