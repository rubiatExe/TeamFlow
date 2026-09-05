# TeamFlow Architecture

TeamFlow is a Next.js application backed by Supabase and two independently deployable
Python services targeting Google Cloud Run. The upload path is a deterministic
document-processing pipeline; the hiring service contains a legacy generic graph and a
separate two-agent résumé-review graph backed by narrowly scoped MCP loaders. GitHub Actions is configured
to deploy both services through keyless Workload Identity Federation (WIF); live cloud
state requires separate verification.

## Repository map

```text
app/                              Next.js pages and API route handlers
components/
  candidate-application/         Candidate-facing application steps
  candidates/                    Manager candidate board and resume upload
  hiring-personas/               Role and hiring-criteria settings
  shared/                         App-wide interactive components
  ui/                             Reusable design-system primitives
lib/
  ai/                             Gemini parsing and candidate scoring
  contracts/                      Shared TypeScript types and Zod schemas
  db/                             Supabase database and storage access
  domain/                         Café roles and demo-domain data
  integrations/                   Twilio and magic-link integrations
services/document-processor/      FastAPI OCR and embedding service
services/hiring-agent/            LangGraph workflow with a private stdio MCP server
supabase/                         Database schema and ordered migrations
scripts/                          Local verification utilities
.github/workflows/                CI and Cloud Run deployment
```

## Runtime flow

1. A manager uploads a resume from `app/page.tsx`.
2. The browser sends the document to `POST /api/parser`.
3. `app/api/parser/route.ts` calls the Cloud Run document processor at `POST /extract`, including the `X-OCR-Token` header.
4. The processor validates bytes and signatures, extracts complete digital PDFs with
   deterministic `pypdf`, and uses Gemini vision for images or PDFs with an
   image-only, image-dominant, suspicious hidden-text, or insufficient-text page. It
   then makes a separate embedding call.
5. Next.js validates the strict v1 extraction result, recomputes the uploaded-byte hash,
   and stops before scoring when extraction is failed, mock, empty, or malformed.
6. `lib/ai/scorer.ts` scores the candidate against the selected role.
7. `lib/db/supabase.ts` writes the candidate from the server using `SUPABASE_SERVICE_ROLE_KEY`.
8. The dashboard reads candidates through `GET /api/candidates`; browser code does not receive the service-role key.

The legacy optional agent flow is deliberately separate:

1. The disabled-by-default private route authenticates `POST /api/parser/agent`; callers cannot supply tenant scope.
2. Next.js injects the server-owned demo merchant, validates the request, and calls `POST /invoke` with a separate `X-Agent-Token`.
3. LangGraph loads candidate and role records with resource-and-merchant predicates. Missing or wrong-tenant context stops before Gemini or persistence.
4. Review mode binds no cross-candidate tools. Explicit search mode may choose only two merchant-scoped read-only tools. Structured generation and deterministic output validation happen before any legacy explicit score request is rejected without a DB write.
5. LangChain adapts Gemini and the self-contained stdio FastMCP server. The service returns direct structured JSON that Next.js validates again before sending it to the browser.

The Phase 4 résumé-review flow is a second, versioned path. Phase 5 adds a private
shadow-only coverage diagnostic plus explicit fail-closed gates:

1. The upload route may store the already validated extraction snapshot behind
   `RESUME_REVIEW_STORE_DOCUMENTS=true`, then links its content-derived `document_id`
   to the newly created candidate. Storage is off by default.
2. A disabled-by-default private `POST /api/parser/review` request contains only
   `schemaVersion`, `documentId`, and optional `candidateId`; Next.js authenticates the route, injects
   the fixed demo tenant and persistence policy, applies a streaming 8 KiB JSON cap,
   and calls `POST /v1/resume-reviews`.
3. The workflow loads the tenant-bound extraction snapshot, enforces its candidate link
   when `candidateId` is supplied, and loads at most five
   configured role policies by selecting exactly two read-only tools from the shared
   six-tool FastMCP provider. Neither
   model receives a tool.
4. Agent 1 returns classifications and literal source references only. Application
   code verifies source membership, then checks a narrow structural invariant before
   score calculation: the same normalized criterion ID plus configured text cannot be
   classified both `met` and `not_met`. This does not detect semantic contradictions
   across different criteria or claims.
5. Application code applies configured weights, ranks roles, derives unknown gaps, and
   discards model-authored free-form limitations. The canonical confidence policy then
   records weighted known-criterion coverage. `criteria_coverage` is its only weighted
   component; nine zero-weight completion, integrity, and safety gates may independently
   require review. No numeric threshold is present or applied.
6. Agent 2 receives only the recommended role's validated unknown gaps. A failure
   preserves Agent 1's validated evaluation with a degraded question status.
7. Optional persistence is insert-only, tenant/snapshot-scoped, additionally enforces
   the candidate-document link when a candidate is supplied, and accepts only exact
   idempotent replay. It never updates the candidate fit score.

This Phase 4/5 path is locally tested with scripted models, in-process MCP tools, and HTTP
mocks. The local release gate also launches the shared exact-six-tool FastMCP stdio
subprocess and completes mock-only round trips. It has no reviewer UI and no live Gemini, Supabase, or
deployed-service evidence. Literal quote membership is not semantic entailment. The shadow score is not a
probability, a calibrated acceptance rule, or an independently weighted multi-signal
quality score; it is known-criterion coverage behind explicit gates.

A malformed canonical confidence policy makes `GET /ready` return 503/not ready instead
of silently falling back. An unexpected runtime assessment failure produces a typed
`review_required` result with a safe reason. The public response exposes that safe reason
when a hard gate changes the disposition, but not the score or component detail. Full
signal/component provenance stays out of the v1 response; restricted traces receive safe
aggregate fields plus policy version/hash. Phase 6 persists the policy, safe signals,
assessment, and final shadow disposition under restricted database access so a later
review can recompute it. This metadata remains sensitive hiring data.

The offline risk/coverage utility is deliberately separate from runtime. It requires the
exact verified validation population, recomputes assessments from supplied cached
signals under the canonical policy, and binds dataset, run, and label manifests. Each
label is tied to the exact observation run and per-case Agent 1 result fingerprint, which
prevents reuse against a different cached output. These checks detect drift inside the
artifact set but do not authenticate the signal producer;
hashes and unsigned manifests provide integrity/comparability, not external attestation.
Fixture-only labels can test arithmetic, but only a declared human-approved label set is
eligible for an evidence-bearing report. Tied scores stay atomic and hard failures are
never accepted. No real observation producer/run artifact, labels, measured curve, or
threshold exist for the current `pending_human_review` corpus. Phase 6 owns the durable
human-review queue and audit ledger; Phase 5 does not implement either.

Phase 6 is an additive, disabled-by-default v2 backend rather than a mutation of the
Phase 4 graph:

1. `POST /api/resume-review-runs` requires a strict bearer and canonical idempotency
   key, rejects caller-owned tenant/actor/score fields, and proxies to
   `POST /v2/resume-review-runs` with the private service token.
2. The hiring service verifies the bearer through Supabase Auth. PostgreSQL resolves
   exactly one current active membership; owners/managers may start a run, while
   owners/managers/reviewers may list, inspect, and decide.
3. The Phase 4 analysis runs without external persistence. One database transaction
   content-binds its extraction, configured role policies, evaluation, questions, and
   recomputable confidence provenance to a stable workflow/request identity.
4. A separate minimal LangGraph lifecycle performs `create_review`, pauses in a pure
   `await_decision` node, and applies only an opaque immutable decision ID on resume.
   Checkpoints contain IDs, hashes, versions, statuses, and bounded reason codes—not
   document bytes, résumé text, evidence quotes, prompts, vectors, or model objects.
5. `GET /api/resume-review-runs?status=pending_review` provides bounded keyset pages;
   `GET /api/resume-review-runs/{runId}` returns an allowlisted proposal. Before exact
   evidence excerpts leave the service, the repository revalidates the complete
   configured policy, deterministic score, safety constraints, and literal membership
   in the immutable source-block snapshot.
6. `PUT /api/resume-review-runs/{runId}/decision` accepts approve, reject, or edited
   classifications/evidence—never a reviewer-authored numeric score. Edited evidence is
   revalidated and rescored. The decision, revision, candidate update, and audit events
   are atomic and idempotent; no candidate score exists before approval.

The local integration gate applies the actual Phase 6 and pinned LangGraph checkpoint
migrations to PostgreSQL 16, exercises concurrent starts/decisions and rollback, then
pauses in one OS process and resumes/replays from two newly constructed processes. It
does not establish live Supabase/Auth, UI, Cloud Run, backup, or pooler behavior. The
backend has a shared pending queue but no reviewer assignment/claim lease, notification,
stale-run sweeper, or terminal failure operator path. `TEAMFLOW_HITL_ENABLED=false`
remains the checked-in deployment default.

The LangGraph service is not part of resume upload. If it is unavailable, managers can still upload, parse, score, and persist candidates.

## Integration contracts

| Boundary | Contract that must remain stable |
|---|---|
| Browser/server caller → Next.js | Local-demo-only `/api/parser`, `/api/candidates`, `/api/application`, `/api/invite`, and simulated `/api/square/labor` require `TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES=true` and remain closed in production; private `/api/parser/review`; legacy private `/api/parser/agent`; authenticated v2 `/api/resume-review-runs` list/start/detail/decision proxy; `RESUME_REVIEW_STORE_DOCUMENTS` and `RESUME_REVIEW_PERSIST_RESULTS` are Next-only flags |
| Next.js → Cloud Run | `OCR_SERVICE_URL`, `POST /extract`, `X-OCR-Token` |
| Next.js → LangGraph Cloud Run | `HIRING_AGENT_URL`, legacy `POST /invoke`, Phase 4 `POST /v1/resume-reviews`, Phase 6 `/v2/resume-review-runs`, `X-Agent-Token`, and the verified end-user bearer for v2 |
| Cloud Run runtime | `GOOGLE_API_KEY`, `OCR_SERVICE_TOKEN`, `MOCK_MODE`, `ENVIRONMENT`, `OTEL_SERVICE_NAME` |
| LangGraph runtime | `GOOGLE_API_KEY`, `SUPABASE_URL`, exact `SUPABASE_TRUSTED_ORIGIN`, `SUPABASE_PUBLISHABLE_KEY`, one-merchant `SUPABASE_HIRING_READER_TOKEN`, `HIRING_AGENT_TOKEN`, and model/deadline/tool budgets; it rejects the legacy service-role key. Optional Phase 6 uses `TEAMFLOW_HITL_ENABLED`, the Supabase public/anon Auth key, a dedicated direct HITL PostgreSQL DSN, and a separately migrated checkpoint-runtime DSN; `AGENT_ALLOW_WRITES` gates optional Phase 4 result persistence, not MCP score mutation |
| Next.js → Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, server-only `SUPABASE_SERVICE_ROLE_KEY` |
| GitHub → Google Cloud | `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`, `permissions.id-token: write` |
| Cloud Run deployment | Services `teamflow-python-service` and `teamflow-hiring-agent`, region `us-central1` |

Repository model defaults, embedding task types, and the 768-dimensional storage
contract are recorded in [`config/ai-model-contract.json`](../config/ai-model-contract.json).
The scorer and hiring-agent model identifiers retain their existing environment
overrides, while the shared embedding model stays fixed. The command
`npm run verify:model-contract` prevents checked-in services, workflows, schema, and
named active documentation from silently drifting apart.

## Supabase boundary

`lib/db/supabase.ts` lazily creates the legacy demo Supabase client. Its server-only
service-role path is quarantined behind the development/test-only legacy route gate; the
browser can use only the public key. The production hiring service instead uses its
tenant-scoped reader capability and refuses a service-role key.

Database history is maintained under `supabase/migrations/`. Reorganizing TypeScript or Python source files must not rewrite applied migrations or change table/RPC names.

The ordered migration history now has an idempotent fresh-project baseline:
`000_teamflow_base.sql` supplies the tables and extensions required by the immutable
historical `001_add_embedding_column.sql`. CI replays the full ordered set into an empty
pinned Supabase PostgreSQL database and then loads the synthetic demo seed. Existing
projects that already recorded `001` or later must reconcile `000` in their remote
migration ledger after verifying the base objects; they must not blindly replay or
rewrite applied history. The seed is not a production policy-approval workflow.

PostgreSQL enforces that policy columns are all present or all absent and that criteria
are stored as an array. Strict semantic-version, count, unique-ID, weight-sum, and lexical
safety validation is application-owned when the complete active catalog is loaded.
Configured job policy fields remain mutable, so each persisted review snapshots and
hash-binds the exact catalog used.

Phase 6 adds live membership rows plus private lifecycle/RPC tables. Authenticated users
can select only their own active membership; review payload tables are not directly
selectable. Private empty-search-path functions derive the tenant from the actor, lock
workflow/review/candidate rows in a fixed order, and explicitly grant only the supported
operations to the dedicated HITL role. Candidate score writes require a matching
immutable approved revision. The checkpointer has separate migrator/runtime roles and a
private schema; runtime startup checks the pinned schema but never applies DDL.

## WIF and Cloud Run deployment

Every successful `main` release queues both reusable workflows: `.github/workflows/deploy-python-service.yml` deploys the document processor and `.github/workflows/deploy-hiring-agent.yml` independently deploys the LangGraph service. Releasing the complete tested snapshot avoids losing a service update after an earlier failed or cancelled deployment.

The workflow:

1. Checks out the repository.
2. Requests a GitHub OIDC token through `id-token: write`.
3. Exchanges it through the provider stored in `WIF_PROVIDER`.
4. Impersonates the service account stored in `WIF_SERVICE_ACCOUNT`.
5. Builds and deploys each service directory from the same tested repository snapshot to
   its dedicated Cloud Run service.

Both workflows reuse the same WIF provider and deployer service account, but each service has its own source directory, runtime variables, and Secret Manager bindings. WIF secret names and Cloud Run service identities are intentionally independent of repository folder names.

## Observability

`services/document-processor/telemetry.py` configures OpenTelemetry for Google Cloud Trace and Monitoring. Cloud Run uses its attached service account through Application Default Credentials; no service-account JSON key belongs in this repository.

Cloud Run supplies a W3C `traceparent` header for incoming requests. FastAPI
instrumentation extracts that context so `ocr_extraction` and
`embedding_generation` appear beneath the Cloud Run request instead of as a
separate trace.

When local Next.js trace export is enabled, root `instrumentation.ts` registers
the Node.js SDK. Only the OCR fetch explicitly propagates its context to Cloud
Run; third-party Gemini and Supabase requests do not receive tracing headers.
The local collector configuration lives under `ops/observability/` and export
is disabled by default so observability can never block resume processing.

Do not attach file names, resume text, candidate contact details, prompts, or
model responses to spans. See `ops/observability/README.md` for local setup.

## Local entry points

```bash
npm install
cp .env.example .env.local
npm run dev
```

In separate terminals:

```bash
cd services/document-processor
uvicorn main:app --reload --port 8000

cd ../hiring-agent
HIRING_AGENT_TOKEN=local-dev-token \
  AGENT_ALLOW_WRITES=false \
  uvicorn main:app --reload --port 8080
```

Set `HIRING_AGENT_ENABLED=true`, `HIRING_AGENT_ROUTE_TOKEN`,
`HIRING_AGENT_URL=http://localhost:8080`, and the same service
`HIRING_AGENT_TOKEN` in `.env.local` to exercise the legacy private path. The service
launches private MCP subprocesses for the relevant workflow; no public MCP port is
required. Set `TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES=true` only in a non-production local
environment to exercise the unauthenticated dashboard upload, candidate, invite,
application, and simulated Square demo routes. The Phase 4 review route uses the same route/service authentication plus
`RESUME_REVIEW_PERSIST_RESULTS=false` and `RESUME_REVIEW_STORE_DOCUMENTS=false` by
default. See `docs/llm-security-reliability.md` for the current demo-only tenant boundary.

See `docs/setup-and-access.md` for the production access required to perform an end-to-end verification.
