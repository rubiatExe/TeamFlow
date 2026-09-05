# Hiring Agent

This service contains TeamFlow's optional conversational hiring workflow.
LangGraph owns explicit state, routing, and bounded search-tool loops. Application node
wrappers own schema retry, failover, and the guarded write path. LangChain supplies the
Gemini and MCP adapters. FastMCP keeps
Supabase credentials and database details behind narrow domain tools.

The deterministic PDF extraction and structured upload scorer remain separate.
An outage here does not block résumé upload.

It also contains the isolated Phase 4 two-agent résumé-review workflow, its Phase 5
shadow coverage observer with explicit fail-closed gates, and Phase 7 offline diagnostic
judge/regression tooling. That path
classifies configured criteria with Agent 1, applies score math in application code,
and gives Agent 2 only validated unknown gaps. It is separate from the legacy
`/invoke` compatibility endpoint.

## Package layout

```text
main.py                                  Cloud Run/uvicorn bootstrap
teamflow_hiring_agent/
  http_api.py                            hardened authenticated FastAPI boundary
  service_composition.py                 immutable production dependency composition
  api.py                                 compatibility-only factory (excluded from image)
  config.py                              environment configuration
  contracts.py                           API and model Pydantic schemas
  prompts.py                             bounded model instructions
  reliability.py                         failover and model-outcome classification
  runtime.py                             production dependency composition
  security.py                            JSON bounds, PII redaction, trait filtering
  telemetry.py                           framework-independent OpenTelemetry setup
  graph/
    state.py                             typed graph state
    nodes.py                             deterministic and model-powered nodes
    routing.py                           pure routing decisions
    builder.py                           StateGraph assembly
  resume_review/
    contracts.py                        model-facing and application-owned v1 schemas
    workflow_contracts.py               private document/policy/runtime contracts
    confidence.py                       deterministic shadow confidence policy
    confidence_policy_v1.json           canonical uncalibrated policy artifact
    graph/                               Agent 1 -> validation/scoring -> Agent 2 graph
    persistence.py                       insert-only idempotent review writer
    runtime.py                           production dependency composition
  mcp/
    client.py                            LangChain MCP adapter
    server.py                            private shared six-tool FastMCP/Supabase server
  evaluation/                            offline corpus, judge, and regression contracts
tests/                                   contract, graph, API, and tool tests
evals/                                   offline synthetic corpus (excluded from image)
```

## Workflow

```text
validate request
  -> verify tenant-scoped candidate/job context deterministically
       -> unavailable: safe degraded response; no model or write
  -> Gemini reasoning
       <-> bounded merchant-scoped search (search mode only)
  -> Gemini structured response + deterministic validation/redaction
  -> reject legacy score mutation requests
  -> inject actual executed tool names
```

The default `review_candidate` operation binds no cross-candidate tools, so text in
a résumé cannot broaden data access. The explicit `search_candidates` operation may
bind only the two read-only search tools. Candidate and job lookups require the same
server-authorized `merchantId`. The legacy MCP server exposes only read operations;
`update_fit_score` has been retired and is not registered. A legacy request containing
complete score-write fields returns `write_status=failed` without invoking any tool or
issuing a database PATCH. Candidate-score mutation belongs to the authenticated Phase 6
human-decision transaction.

The Phase 4/5 review graph follows a narrower path:

```text
document_id + optional candidate_id
  -> tenant-bound extraction snapshot; candidate link required when candidate_id exists
  -> configured active-role policies (max 5 roles / 30 criteria)
  -> Agent 1 classifications and literal source references
  -> literal evidence validation + explicit-negation and structural conflict gates
  -> application-owned score math, gaps, and ranking
  -> shadow-only known-criterion coverage + explicit integrity/safety gates
  -> Agent 2 receives only unknown gaps plus an application-owned required question plan
  -> validated response
  -> optional insert-only review persistence
```

Neither Phase 4 model receives MCP tools. Agent 1 has no numeric score,
recommendation, tenant, candidate, or write fields in its model schema. Agent 2 has no
résumé text, evidence quotes, score, ranking, tool, SQL, or write fields. A hard Agent 1
failure returns `review_required`; an Agent 2 failure preserves Agent 1 with degraded
questions. Agent 2 must reproduce the application-owned wording exactly and cannot add
free-form recruiter-facing text. Literal quote membership plus the narrow explicit-
negation and criterion-overlapping verdict-language checks prove neither general
entailment nor semantic support for the criterion.

The confidence policy is deliberately narrow. Its integer score is weighted
known-criterion coverage: `criteria_coverage` has weight 100, while nine explicit
completion, integrity, and safety gates have weight 0. Those gates may still set a hard
failure and require review. `met` and `not_met` criterion weights count as known;
`unknown` weights remain uncovered across the loaded role catalog. The score is therefore
not a probability, a calibrated confidence estimate, or an independent blend of ten
measured signals. It does not
accept, reject, rank, update a candidate, or control a route.

A safe hard-failure reason appears in the API response. Full signal/component detail
stays in invocation state; restricted trace attributes contain only safe aggregate fields
and policy version/hash. Both are sensitive operational metadata and neither becomes a
durable Phase 5 review ledger. A malformed canonical policy blocks workflow readiness
instead of falling back to another policy (`GET /ready` returns 503/not ready).
An unexpected confidence failure during a run fails closed to a typed
`review_required` response with `confidence_policy_failed`.

## Legacy `/invoke` security and reliability controls

- Strict UUID and JSON contracts reject unknown, oversized, deeply nested, and
  protected-characteristic analysis fields.
- Gemini uses explicit safety thresholds; incomplete, empty, malformed, or blocked
  responses fail closed. Contact details and credential-shaped output are redacted.
- Stable primary and fallback models have no hidden provider retry loop. Invalid
  schema output gets one bounded retry; safety refusals are never retried or bypassed.
- A 45-second workflow deadline, per-model timeout, tool-call budget, concurrency
  bulkhead, and 64 KB request limit bound latency and cost.
- Required-context failure skips Gemini. Legacy score-mutation requests fail closed after
  final model validation and never invoke an MCP write.
- Responses expose `status`, `warnings`, `write_status`, and `request_id`; degraded
  results cannot silently look complete.

## Phase 4 résumé-review controls

- Strict service and public contracts exclude tenant/persistence fields from the
  public request and exclude raw documents, vectors, source catalogs, and tool metadata
  from the response.
- A failed required read or Agent 1 validation returns `review_required` before Agent 2
  or persistence. Agent 2 failure preserves Agent 1 and marks questions degraded.
- Literal evidence, distinctive criterion-term overlap, configured score math, role
  ranking, and question targets are validated by application code. This is structural
  and lexical verification, not semantic entailment or calibrated accuracy.
- A known-status quote without a distinctive configured-criterion term, one that uses
  `met`/`satisfied`/similar verdict language as evidence, or a `met` quote that explicitly
  negates the criterion is rejected. This conservative rule can send legitimate
  “met requirements” wording to review. A positive top role whose met weight
  does not exceed its combined negative and unresolved weight is
  forced to human review by a zero-weight hard gate; this is a structural rule, not a
  calibrated score threshold.
- Agent 2 receives an application-owned question plan and its accepted output must match
  that plan exactly. The model cannot introduce arbitrary hiring, contact, or decision
  language into the reviewer packet.
- Optional persistence is insert-only, tenant/snapshot-scoped, candidate-linked when a
  candidate ID is supplied, and accepts only exact idempotent replay.

## Phase 5 coverage and gate controls

- The policy is strict, canonical, content-hashed, versioned, and explicitly
  `uncalibrated`/`shadow`; it contains no runtime threshold or automatic action.
- The only weighted numeric component is known-criterion coverage. The workflow,
  extraction, context, Agent 1 schema, literal grounding, evidence consistency, score
  calculation, provider completion, and safety checks are zero-weight gates. Model
  self-confidence is excluded.
- Missing or failed gates fail closed without pretending to lower a statistically
  meaningful score. A hard gate requires review even if coverage is 100.
- Before score calculation, the conflict gate detects only the same normalized criterion
  ID plus configured text classified both `met` and `not_met`. It is a structural
  invariant, not semantic contradiction detection across different criteria or claims.
- The same zero-weight gate requires review when a unique positive leader is supported
  by no more met weight than its combined negative and unresolved weight. It does not
  establish a production approval threshold or semantic correctness.
- Policy artifacts and assessments are recomputed and hash-bound rather than trusted by
  identity alone. Malformed policy configuration blocks readiness; unexpected runtime
  assessment failure produces a typed review response.
- The offline risk/coverage command requires an exact verified validation population,
  recomputes every assessment from its supplied cached signals and canonical policy, and
  binds run and label manifests. Labels are bound to the exact observation run and each
  case's Agent 1 result fingerprint, so they cannot be silently reused for another cached
  output. This catches assessment/policy drift and label replay; it does not prove that an
  authentic runtime produced those signals. The hashes and unsigned manifests provide
  integrity/comparability, not external attestation. Fixture-only labels can exercise the
  math but are not accepted as human evidence; a declared human-approved label manifest
  is required for an evidence-bearing run.
- Equal scores are grouped atomically, hard failures are never accepted, and the command
  emits aggregate score-cutoff points without selecting or installing a threshold.
- Dataset `resume_review_v1` v1.1.0 contains 30 validation, 20 locked test, and 15
  adversarial cases. All 65 remain `pending_human_review`; the locked-test bytes are
  unchanged. No real observation producer/run artifact, label set, curve, risk value,
  calibrated threshold, accuracy result, or automated-routing claim exists.

Phase 6 owns the durable review lifecycle: tenant-derived pending discovery, reviewer
authorization, decisions, audit events, resume, and retention guards. Assignment/claim
leasing is explicitly deferred; the pending endpoint is a discovery queue and does not
reserve work for a reviewer. Phase 5 does not provide a durable review ledger.

## Phase 7 offline semantic evaluation controls

- The diagnostic judge evaluates only groundedness, criterion relevance, and internal
  consistency from one bounded transient semantic packet. Cached artifacts contain
  fingerprints and closed outcomes, not résumé text, prompts, rationales, contact details,
  candidate/tenant identifiers, or hiring scores.
- Its concrete Gemini adapter uses one structured-output request with temperature zero,
  a token cap, provider and outer deadlines, explicit safety settings, no tools, no retry,
  and no database access. Local tests use fixtures or test transports; no live provider
  call or cached live output is claimed.
- The semantic-regression consumer binds the exact verified validation population,
  generator/judge configurations, immutable baseline lock, cached inputs/outputs, and
  per-target human labels. It reports per-dimension and overall agreement, Cohen's kappa,
  false accepts, false rejects, uncertainty, and explicit denominators.
- Human-evidence mode requires the complete 30-case validation split, human-approved
  annotations, and at least 15 resolved overall passes plus 15 resolved overall failures.
  Fixture labels remain visibly diagnostic and can never produce a passing evidence gate.
- The gate rejects incomparable identities and non-offsetting regressions, including new
  false accepts, false rejects, uncertainties, pass-to-nonpass changes, and judge
  operational/contract failures. It never selects a threshold or updates a baseline.
- Nothing in `evaluation/` is imported by the production API, graph, scorer, persistence,
  or database layers. The judge is diagnostic only and cannot score, route, accept,
  reject, or mutate a candidate.

The current corpus has enough validation cases for the intended comparison but has no
independent annotations or adjudication. No human agreement, kappa, false-accept,
false-reject, judge-error, calibration, or semantic-quality result has been measured.

See [LLM security and reliability](../../docs/llm-security-reliability.md) for the
threat model, failure behavior, and the remaining production-auth requirement.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --only-binary=:all: --require-hashes -r requirements-dev.lock
uvicorn main:app --reload --port 8080
```

Set `GOOGLE_API_KEY`, `SUPABASE_URL`, the exact matching `SUPABASE_TRUSTED_ORIGIN`,
`SUPABASE_PUBLISHABLE_KEY`, a scoped `SUPABASE_HIRING_READER_TOKEN`, and
`HIRING_AGENT_TOKEN`. Never provide `SUPABASE_SERVICE_KEY`. The production rollout keeps
`AGENT_ALLOW_WRITES=false` and does not mount `SUPABASE_REVIEW_WRITER_TOKEN`;
`AGENT_ALLOW_WRITES` remains a defense-in-depth gate for optional append-only Phase 4
review-result persistence and cannot re-enable retired MCP candidate score mutations.
`HIRING_AGENT_MODEL` and `HIRING_AGENT_FALLBACK_MODEL` may override the defaults
recorded in [`config/ai-model-contract.json`](../../config/ai-model-contract.json).
The embedding model remains fixed so document and query vectors cannot silently use
different embedding spaces.

`SUPABASE_HIRING_READER_TOKEN` is deliberately snapshotted once at process startup and
passed explicitly to each MCP child; it is not hot-reloaded. After its JWT expiry,
`/ready` returns not-ready while `/health` remains live and protected work fails closed.
Operators must publish a new numeric secret version and redeploy before expiry. The
checked-in project does not automate that overlapping rotation, so live user traffic is
not production-ready until the rotation/redeployment runbook is exercised.

Durable v2 human review is separately gated by `TEAMFLOW_HITL_ENABLED=false`.
Enabling it requires the server-only `SUPABASE_ANON_KEY`, a direct SSL PostgreSQL
`TEAMFLOW_HITL_DSN` authenticated exactly as `teamflow_hitl_service`, and a separate
SSL `TEAMFLOW_CHECKPOINT_DSN` authenticated exactly as
`teamflow_checkpoint_runtime`. The service only checks the pre-migrated checkpoint
schema during startup; it never applies checkpoint DDL. Apply the pinned checkpoint
migrations from a controlled job with `TEAMFLOW_CHECKPOINT_MIGRATION_DSN` and then run
the read-only check before enabling the service:

```bash
python -m teamflow_hiring_agent.resume_review.hitl.checkpoint_admin migrate --allow-migrate
python -m teamflow_hiring_agent.resume_review.hitl.checkpoint_admin check
```

The migration DSN must use `teamflow_checkpoint_migrator` and must not be mounted into
the running service. Production deployment remains disabled in the checked-in workflow
until those roles, secrets, migrations, and a staging smoke test have been provisioned.
The production v2 service also owns a dedicated concurrency gate and separate start,
decision, and inspection deadlines. The default one-second queue plus 45-second start
deadline remains below the 50-second Next.js caller and 60-second Cloud Run limits;
capacity and deadline failures return a sanitized retryable service-unavailable result.

In the Next.js adapter, keep `RESUME_REVIEW_PERSIST_RESULTS=false` unless insert-only
review-run persistence is explicitly required. The matching Next upload snapshot flag is
`RESUME_REVIEW_STORE_DOCUMENTS=false` by default. The checked-in seed is synthetic
local/demo configuration, not a production role-policy approval process.

The service exposes:

- `GET /health`, `GET /ready`, and `GET /version` without service authentication.
  Readiness requires model/data-source configuration and a valid canonical confidence
  policy.
- Legacy `POST /invoke` with direct `HiringAgentRequest` JSON and an
  `X-Agent-Token` header.
- Phase 4/5 `POST /v1/resume-reviews` with a strict internal request and the same
  service header. Next.js supplies tenant and persistence fields; they are not public
  browser inputs.
- Feature-gated Phase 6 `POST /v2/resume-review-runs`,
  `GET /v2/resume-review-runs?status=pending_review`,
  `GET /v2/resume-review-runs/{run_id}`, and
  `PUT /v2/resume-review-runs/{run_id}/decision`. These require both the service
  header and a bearer identity verified by Supabase Auth; merchant ownership is resolved
  from current database membership rather than accepted from the request. Pending pages
  are keyset-paginated and bounded to 50 items. Detail responses expose only the strict
  reviewer proposal plus a persisted shadow-confidence diagnostic explicitly marked as
  non-probabilistic with `threshold_applied=false`; raw résumé blocks, embeddings,
  tenant/thread/checkpoint authority, and internal role/extraction hashes remain
  server-side.

Missing Supabase configuration fails closed. Synthetic MCP responses are
available only when `HIRING_AGENT_MOCK_TOOLS=true`, and every synthetic response
is labeled `mock=true`.

FastAPI requests and MCP operations emit OpenTelemetry spans. Production configuration
targets sampled Google Cloud Trace export without relying on ADK-specific telemetry;
live export has not been verified from repository evidence.

Run the private shared MCP server directly only for tool debugging:

```bash
python -m teamflow_hiring_agent.mcp.server
```

Repository tests use scripted models, in-process MCP calls, HTTP mocks, and a real local
stdio handshake with the shared exact-six-tool FastMCP subprocess. The review runtime
selects only `get_resume_document` and `load_active_role_policies`. No live Gemini,
subprocess-to-Supabase, Cloud Run, or browser integration has been verified.

## Verification

```bash
ruff check .
pytest
```
