# TeamFlow résumé-claim evidence ledger

Last audited: 2026-09-05

This ledger separates source code, automated tests, and live deployment evidence. It is
the truth source for interview and résumé claims; aspirational documents such as
`PRD.md` are not implementation evidence.

## Evidence levels

- **PROPOSED** — a material part of the capability is absent. Partial foundations may
  exist, but the complete claim is not currently defensible.
- **IMPLEMENTED** — source or infrastructure configuration exists, but the relevant
  behavior has not been integration-tested against its external dependency.
- **TESTED** — the capability has relevant deterministic automated tests that passed
  locally in the current working tree. This does not imply a live provider, database,
  or cloud deployment was exercised.
- **INTEGRATION TESTED** — real process/service boundaries were exercised in a controlled
  environment. Phase 6 PostgreSQL lifecycle/checkpoint tests reached this level in a
  disposable local PostgreSQL 16 instance; this is not staging or production evidence.
- **DEPLOYED** — a live environment was verified with reproducible runtime evidence.
  No capability reached this level during this repository-only audit.
- **MEASURED** — a versioned run artifact reports a defined quality/latency/cost metric
  over an identified dataset or traffic window. No AI-quality claim reached this level.

## Audit boundary and baseline

The audit covers the complete release candidate on branch
`codex/reorganize-reliability-observability`: the Next.js adapters, both Python
services, ordered migrations and schema snapshot, local integration tests, and staged
deployment configuration. Only files present in the resulting commit are evidence;
local-only drafts are not.

The final local audit used Node `24.11.1`, npm `11.6.2`, Python `3.13.7`, pytest
`8.4.2`, and Ruff `0.12.9`. CI is pinned to Node 22.23.2 and Python 3.11.16, so local
success is not a substitute for a committed CI run. Database integration evidence uses
the separately identified pinned PostgreSQL 16 and Supabase PostgreSQL 17 images.

Pre-change and post-change validation should use these commands:

| Check | Phase 0 baseline |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 20 passed |
| `npm run verify:contracts` | Passed after the static model-contract gate was added |
| `npm run build` | Passed; all application routes compiled |
| `python3 -m pytest services/document-processor/tests -q` | 1 passed; one Starlette deprecation warning |
| `python3 -m pytest services/hiring-agent/tests -q` | 35 passed |
| `python3 -m ruff check services/document-processor services/hiring-agent scripts/verify-models.py` | Passed |
| `python3 -m ruff format --check` on the three Phase 0 Python files | Existing failure: `services/document-processor/main.py` would be reformatted; both hiring-agent files pass |

No live Gemini, Supabase, Cloud Run, WIF/OIDC, Cloud Trace, or browser end-to-end
test was performed. Repository configuration is not proof that those external
resources exist or match the checked-in defaults. No clean-checkout `npm ci`, Docker
image build, committed GitHub Actions run, or fresh Supabase reset was performed.

Phase 1 added an offline-only evaluation foundation. At that checkpoint, 20 Node tests,
51 hiring-agent tests, and 1 document-processor test passed. The
new corpus verifier also passed independently. These results establish deterministic
artifact integrity and failure-taxonomy behavior; they do not measure résumé-review
quality or exercise a model, database, network, or deployed service.

Phase 2 added isolated v1 résumé-review contracts and pure deterministic scoring logic.
At that checkpoint, 28 Node tests, 59 hiring-agent tests, and 1 document-processor test
passed. One shared JSON fixture is accepted and round-tripped by both
Pydantic and Zod; a second shared conformance fixture covers Unicode boundaries,
cross-runtime whitespace, and JSON integer semantics; and mirrored adversarial tests
cover the required invalid cases. This is conformance-case agreement, not a formal proof
that every possible value is treated identically by both schema engines. The new
contracts are not imported by the production graph, parser, scorer, API, persistence,
or UI.

Phase 3 added a strict Pydantic/Zod document-extraction v1 boundary, deterministic
digital-PDF extraction, bounded Gemini routing for scanned/mixed/image documents,
stable source blocks, uploaded-byte hash binding, explicit failure provenance, and a
fail-closed Next.js scoring gate. At that checkpoint, 44 Node tests, 59 hiring-agent
tests, and 41 document-processor tests passed. The checked-in PDF fixtures are
synthetic and hash-locked. Scanned routing uses a fake provider; no live Gemini OCR,
embedding, database, browser, or deployed-service request was exercised, and no OCR
accuracy metric is claimed.

Phase 4 added a separate, versioned résumé-review API and executable two-agent
LangGraph. Agent 1 produces criterion classifications and literal source references;
application code validates those references and applies configured weights; Agent 2
receives only the recommended role's validated unknown gaps. At that checkpoint, 56
Node tests and 102 hiring-agent tests passed. These tests use
scripted models, in-process tools, and HTTP mocks. No live Gemini, FastMCP stdio,
Supabase, browser, or Cloud Run execution was performed.

Phase 5 added a strict, canonical and content-hashed confidence policy to the review
graph, an identifier-free but still sensitive threshold-free shadow record, a narrow
structural conflict detector, and validation-only risk/coverage tooling. At that
checkpoint, 56 Node tests, 121 hiring-agent tests, and 41
document-processor tests. The numeric diagnostic is weighted known-criterion coverage,
not a probability or an independent multi-signal quality score. Nine zero-weight
completion, integrity, and safety gates may require review, but the number does not
control routing. Risk/coverage tests use fixture-only labels. At that checkpoint the
corpus contained 60 cases, all pending human review, and no real observation producer/run
artifact. The unsigned hashes/manifests support artifact integrity and comparability, not
external provenance attestation. No approved label set, measured curve, calibrated
threshold, or automated acceptance claim exists.

Phase 6 added the disabled-by-default authenticated human-review backend: tenant-derived
membership, a bounded pending queue and reviewer packet, an ID-only durable LangGraph
interrupt/resume lifecycle, atomic idempotent decisions and candidate revisions, and
recomputable confidence provenance. At the Phase 6 gate, 97 Node tests, 273 hiring-agent
tests with 7 environment-gated skips, and 41 document-processor tests passed. A separate
seven-test PostgreSQL 16 gate applies the actual lifecycle and checkpoint
migrations, exercises concurrency and tenant/privilege boundaries, and resumes the same
checkpoint across fresh OS processes. This is local integration evidence only: no live
Supabase Auth/Data API, Gemini, Cloud Run, browser reviewer UI, assignment lease, or
production deployment was exercised.

Phase 7 expands `resume_review_v1` to version 1.1.0 with 30 validation, 20 locked test,
and 15 adversarial synthetic cases; all 65 remain `pending_human_review`, and the locked
test file bytes are unchanged. It also adds an isolated offline diagnostic judge with a
bounded no-retry Gemini adapter and immutable content-free caches, plus a comparable
semantic-regression consumer and CLI. Deterministic fixture and test-transport tests
exercise those contracts without a model, database, production graph, or network call.
At the Phase 7 tooling gate, 97 Node tests, 303 hiring-agent tests with 7
environment-gated skips, and 41 document-processor tests passed; the focused evaluation
foundation, risk/coverage, judge, and semantic-regression slice passed 53 tests.
No live judge cache, independently reviewed/adjudicated label set, agreement, kappa,
false-accept, false-reject, judge-error, calibration, or semantic-quality measurement
exists. The judge has no production scoring, routing, decision, persistence, or database
authority.

Phase 8A and the subsequent cross-functional hardening pass strengthen the repository
release boundary without activating the Phase 7 judge. The current local component gate
passes 144 Node tests, 800 deterministic hiring-agent tests, and 141 document-processor
tests without skips. Separately provisioned disposable databases pass 12 PostgreSQL 16
repository/restart cases and three fresh Supabase PostgreSQL 17 replay/security cases.
Static release/model contracts, Ruff lint/format, SSR journey
smokes, and a Next 16.3.3 webpack production build also pass. This is repository and local
integration evidence; no live deployment, cloud scan/provenance/SBOM, IAM, WAF, provider
canary, alert, backup/restore, or rollback was observed.

## Model and embedding contract

The canonical working-tree defaults are recorded in
[`config/ai-model-contract.json`](../config/ai-model-contract.json). The static
gate in [`scripts/verify-model-contract.mjs`](../scripts/verify-model-contract.mjs)
parses named default assignments, environment examples, isolated Cloud Run deployment
configuration, embedding call parameters, the pgvector schema, and named active
documentation. It runs through `npm run verify:contracts` and is called before either
Cloud Run deployment. The manifest and verifier are committed together with the release
configuration they constrain.

The manifest is an audit contract, not a runtime import or provider compatibility test. Each Python
Cloud Run service builds from its own subdirectory, so importing a root manifest would
break an isolated build unless deployment contexts were redesigned. Existing scorer and
hiring-agent environment overrides remain; the shared embedding identifier is fixed in
both Python services so query and document vectors cannot silently use different spaces.

| Role | Repository default |
|---|---|
| Document extraction | `gemini-3.1-pro-preview` |
| Structured scorer | `gemini-3.1-pro-preview` primary and fallback |
| LangGraph hiring workflow | `gemini-3.7-flash` primary; `gemini-3.6-flash` fallback |
| Document/query embedding | `models/gemini-embedding-001` |
| Embedding compatibility | 768 dimensions; `RETRIEVAL_DOCUMENT` for stored résumés and `RETRIEVAL_QUERY` for search |

Model availability and deployed overrides remain unverified external state. Local
prepared-request tests cover both configured Gemini 3.x models and prove the pinned
LangChain adapter omits unsupported sampling and candidate-count fields across reasoning
and structured-output paths; a live provider smoke is still required before activation. See the
[official Gemini latest-model migration guide](https://ai.google.dev/gemini-api/docs/generate-content/latest-model).

## Upload, extraction, scoring, and persistence

| Capability | Status | Implementation evidence | Test evidence | Honest deployment boundary |
|---|---|---|---|---|
| Upload byte/type boundary | TESTED | Browser and strict Next.js input contracts accept only PDF/JPEG/PNG, canonical inline Base64, safe bounded names, and at most 10 MiB decoded bytes; arbitrary URL ingestion is disabled. The FastAPI boundary authenticates and caps the multipart stream before parsing, then verifies file bytes against MIME signatures. | Node tests cover canonical Base64/type/name/size cases. Python tests cover empty, exact/over-limit, unsupported/mismatched signatures, authentication-before-body-read, malformed headers, and chunked oversize input. | Next.js still materializes JSON before Zod validation, and Base64 overhead may exceed practical Vercel limits. Direct-image validation is signature-level rather than a complete PNG/JPEG decode. Production should use an authenticated direct-to-storage flow and an infrastructure request-body limit. |
| Typed extraction and scoreability boundary | TESTED | [`contracts.py`](../services/document-processor/teamflow_document_processor/contracts.py), [`document-extraction.ts`](../lib/contracts/document-extraction.ts), and [`document-processor-client.ts`](../lib/ai/document-processor-client.ts) enforce v1 status, source blocks, models, SHA-256, warnings, quality, finite nonzero float32-compatible 768-vectors, and uploaded-byte hash equality. Application code derives scoreability. | Python and Node tests reject mock/failed/empty/malformed/contradictory responses, forged hashes/blocks, uncovered text, incomplete finishes, response-body timeouts, invalid embeddings, and different-document responses. | Component/client evidence only. No real OCR → scorer → Supabase integration was run, and the UI validates the core scorer shape rather than independently rendering all extraction provenance. |
| Deterministic PDF-first extraction | TESTED | Complete digital PDFs use pinned `pypdf`; any unusable page or bounded inspection finding of image-dominant, inline, nested-Form, tiled, cropped, or non-painting content routes the whole PDF to Gemini. Parsing runs in a killable isolated subprocess behind a two-worker admission gate; Linux applies CPU, address-space, file-descriptor, output, and wall-time bounds with cancellation cleanup. | Synthetic digital, scanned, mixed, corrupt, compressed-bomb, oversized, malformed, excessive-block, Unicode-corruption, timeout, cancellation, overload/recovery, invisible-decoy, nested-Form, inline-image, crop-box, and tiled-image cases pass. Digital critical name/contact/employer/date fields survive deterministic extraction. | The checked-in Cloud Run target now uses 1 GiB and concurrency two, but no sustained memory/load profile exists. Operating-system resource limits are strongest on Linux. Inspection closes tested image/hidden-layer bypasses but does not prove arbitrary PDF text is pixel-visible; complex layout fidelity is not measured. |
| Gemini scanned/image transcription | IMPLEMENTED | Gemini is invoked only after deterministic routing, uses a transcription-only prompt, explicit SDK/outer deadlines, no provider retries, and requires normal completion metadata. | Scanned and mixed routing plus expected-field survival are tested with a fake provider. Provider failure, timeout, refusal/truncation, empty, malformed, and corrupt-output paths are tested. | This is generative multimodal extraction, not Google Cloud Vision OCR. No live Gemini call, pixel-grounded validation, CER/WER, bounding boxes, confidence scores, or measured scanned-document accuracy exists. |
| Separate document embedding | IMPLEMENTED | The processor uses `gemini-embedding-001`, `RETRIEVAL_DOCUMENT`, 768 dimensions, a dedicated transport timeout, and explicit no-retry policy. Inputs over 8,000 characters are deterministically truncated with a typed warning; extraction text itself is retained. | Static model checks and processor tests cover dimensions, NaN/infinity, float32 overflow, zero vectors, provider failure, timeout, and explicit truncation provenance. | No live embedding response or retrieval-quality impact from truncation was measured. |
| Mock/failure provenance | TESTED | Mock mode and every extraction failure return empty typed non-scoreable results with non-2xx status. The static résumé fallback was removed; Next.js rejects invalid/non-scoreable results before the scorer. | Processor and client tests cover mock, provider outage, malformed legacy payload, invalid JSON, timeout, and status/quality contradictions. | This proves fail-closed control flow locally, not deployed behavior under a real provider outage. |
| Schema-constrained scoring | TESTED | [`lib/ai/scorer.ts`](../lib/ai/scorer.ts) uses JSON response mode, a schema, temperature zero, and bounded output. [`ParserOutputSchema`](../lib/contracts/parser.ts) validates fields and score arithmetic. | [`tests/unit/scorer-response.test.ts`](../tests/unit/scorer-response.test.ts) covers malformed/truncated output, non-STOP finishes, schema failure, score inconsistency, retry, and fallback. | Tests establish structural reliability, not semantic scoring accuracy or fairness. |
| Bounded scorer retry and fallback | TESTED | [`lib/ai/scorer-runner.ts`](../lib/ai/scorer-runner.ts) bounds retries and validates fallback output. | Retry, provider-error, fallback, and emergency-fallback cases pass in the scorer test suite. | Fallback provenance is logged but not returned or persisted, so a provisional score can appear ordinary. |
| Candidate persistence | IMPLEMENTED | [`saveCandidateToSupabase`](../lib/db/supabase.ts) stores validated candidate data, Markdown, and embedding while rejecting score, analysis, or red-flag fields outside human review. | Unit tests cover the application guard; no real database integration or transaction test. | Persistence failure is nonfatal by design. Remote table shape and applied migration state were not verified. |

## Retrieval, LangGraph, and FastMCP

| Capability | Status | Implementation evidence | Test evidence | Honest deployment boundary |
|---|---|---|---|---|
| pgvector storage and semantic RPC | INTEGRATION TESTED for fresh replay | [`supabase/schema.sql`](../supabase/schema.sql) defines `vector(768)`, an HNSW cosine index, and the email-free tenant-scoped search RPC; ordered migration `000` provides the fresh base before the immutable historical `001` embedding migration. | CI and the opt-in local test replay every ordered migration into an empty pinned Supabase PostgreSQL database, load the seed, and assert scoped-RPC/ACL state. | No live hosted RPC, query plan, or retrieval-quality measurement was verified. Existing remote projects must reconcile the new baseline ledger entry rather than replay applied history. |
| Retrieval-query embedding | IMPLEMENTED | [`mcp/server.py`](../services/hiring-agent/teamflow_hiring_agent/mcp/server.py) uses `RETRIEVAL_QUERY`, 768 dimensions, and an eight-second timeout. | Static contract coverage verifies model/task/dimension consistency. | No live embedding call was made. |
| Semantic-search bounds | TESTED | The custom MCP tool bounds query bytes, `top_k`, threshold, embedding calls, response shape, and tenant scope in [`mcp/server.py`](../services/hiring-agent/teamflow_hiring_agent/mcp/server.py). | [`test_mcp_server.py`](../services/hiring-agent/tests/test_mcp_server.py) covers unsafe/protected queries, strict numeric bounds, scoped email-free RPC calls, result validation, cancellation, timeout, and mock failure. | No live embedding/RPC call or labeled retrieval-quality evaluation was run. |
| Successful semantic retrieval and ranking | IMPLEMENTED | Query embedding and `match_candidates` RPC code exist in [`mcp/server.py`](../services/hiring-agent/teamflow_hiring_agent/mcp/server.py). | No successful-path retrieval test or labeled retrieval evaluation. | Default `top_k=5` and threshold `0.5` are uncalibrated choices. There is no Recall@K, Precision@K, MRR, hybrid retrieval, or reranking evidence. |
| FastMCP tool registration/in-process guards | TESTED | The shared FastMCP object registers exactly six TeamFlow-specific read tools; candidate score mutation is not registered. | In-process registration, schema/annotation validation, tenant predicates, review-only selection, and absence-of-write-tool tests pass. | This does not by itself prove a live backend call. |
| stdio LangChain–FastMCP boundary | TESTED locally | [`mcp/client.py`](../services/hiring-agent/teamflow_hiring_agent/mcp/client.py) opens one private shared MCP subprocess through the LangChain adapter and validates its exact application-owned catalog. | [`test_mcp_server.py`](../services/hiring-agent/tests/test_mcp_server.py) launches the real exact-six-tool FastMCP stdio server, loads the catalog through the adapter, exercises all six tools in mock mode, and verifies bounded cleanup. | This proves local process/transport compatibility, not a subprocess-to-live-Supabase or live-provider integration. |
| Typed LangGraph workflow | TESTED | [`graph/state.py`](../services/hiring-agent/teamflow_hiring_agent/graph/state.py), [`graph/builder.py`](../services/hiring-agent/teamflow_hiring_agent/graph/builder.py), and [`graph/routing.py`](../services/hiring-agent/teamflow_hiring_agent/graph/routing.py) define bounded state, nodes, and routes. | Graph tests cover required reads, tool budgets, tenant forcing, injection containment, structured failure, safety refusal, and fail-closed rejection of legacy writes. | The legacy graph state exists only for one invocation; durable human review is a separate Phase 6 lifecycle. |
| Versioned résumé-review contracts | TESTED | [`resume_review/contracts.py`](../services/hiring-agent/teamflow_hiring_agent/resume_review/contracts.py), [`workflow_contracts.py`](../services/hiring-agent/teamflow_hiring_agent/resume_review/workflow_contracts.py), and the matching TypeScript contracts define strict v1 boundaries. The model-facing Agent 1 shape has no score/rank/recommendation/tool fields. | Shared Pydantic/Zod fixtures and adversarial tests cover versions, Unicode/JSON-number boundaries, score injection, foreign references, extraction provenance, unsupported Agent 2 targets, and exact application-owned question output. | Literal membership and the narrow explicit-negation check bind evidence to canonical extracted text and close simple contradictions; they do not prove source pixels, general entailment, or semantic relevance. Cross-language fixtures cover identified edge cases rather than proving total schema equivalence. |
| Deterministic criterion-weight scoring and ranking | TESTED in the Phase 4 workflow | [`resume_review/scoring.py`](../services/hiring-agent/teamflow_hiring_agent/resume_review/scoring.py) validates the complete configured role catalog, sums weights only for `met`, derives gaps, and ranks deterministically. The model never supplies a numeric score or recommendation. | Graph tests prove score ownership, exact policy/catalog validation, stable ordering, null recommendation for tied/zero leaders, and no persistence on invalid context. | The configured policy ID/version is governance metadata, not content-addressed proof. There is no production approval actor, minimum score, top-two margin, or dealbreaker policy. The separate legacy upload scorer still asks Gemini for scores. |
| Least-privilege Agent 1 → Agent 2 handoff | TESTED in the Phase 4 workflow | Typed state passes only the recommended role's validated `unknown` gaps and an application-owned required output to Agent 2. It excludes résumé text, evidence quotes, contact data, scores, rankings, tools, SQL, and write access. The accepted plan must reproduce the required output exactly. | Tests inspect model inputs and reject forged contexts, unsupported targets, duplicate gaps, unsafe/free-form rewrites, no-recommendation handoffs, and Agent 2 attempts to alter decision fields. | The current model call is deliberately constrained and cannot demonstrate the value of generative question planning. The fixed wording has not received legal, accessibility, or human relevance evaluation. |
| Diagnostic coverage policy and gates | TESTED locally; number is shadow-only and hard gates are active | [`resume_review/confidence.py`](../services/hiring-agent/teamflow_hiring_agent/resume_review/confidence.py) loads a strict canonical policy artifact, derives only application-observable signals, applies deterministic integer arithmetic, records a content SHA-256, and emits `is_probability=false`. `criteria_coverage` has weight 100; nine explicit completion, integrity, and safety gates have weight 0 and may set `hard_failure`. Model self-confidence is excluded. | Policy and graph tests cover deterministic weighted known-criterion coverage, all nine gates, policy identity/hash, malformed policy, assessment recomputation from source signals, provider/grounding/calculation/safety failures, embedding-degraded neutrality, conflicts, sparse positive recommendations, telemetry failure, and route independence for non-hard scores. | This is not calibrated confidence or an independently weighted ten-signal quality score. No numeric threshold, auto-accept/reject action, UI field, candidate-score write, human calibration, or live-policy measurement exists. Literal membership still does not prove semantic support. |
| LangGraph extraction stage | PROPOSED | The upload pipeline is explicitly separate from the review graph. Its node named `extract_document` loads and validates an upstream stored extraction summary; it does not parse bytes or perform OCR. | Graph tests cover summary loading and validation, not document extraction inside LangGraph. | A claim that LangGraph currently performs extraction is false. |
| Deterministic confidence disposition | TESTED locally for hard gates; numeric coverage remains shadow-only | The `assess_confidence` node computes the versioned assessment. Missing or failed gates set `hard_failure=true`; hard gates require review even when known-criterion coverage remains high. The numeric score never controls `agent2_ready`, ranking, automatic acceptance, or rejection. A final node binds the same assessment to the post-Agent-2 disposition. | Tests prove low and high non-hard coverage preserve the same route, while provider, grounding, missing-signal, safety, conflict, and met-weight-not-greater-than-combined-negative-and-unknown-weight gates require review. Persistence recomputes the assessment from the stored canonical policy and ten safe signal records; the shadow record carries `is_probability=false` and `threshold_applied=false`. | The weak-support recommendation rule is structural and uncalibrated; it is not production approval authority. The Phase 6 evidence row stores sensitive diagnostic metadata under restricted access, without résumé text in the confidence signals. This is audit provenance, not permission for automated routing. |
| Structural Agent 1 conflict gate | TESTED for one narrow invariant | Before score calculation, the evidence validator rejects the same normalized criterion ID plus configured criterion text when Agent 1 classifies it both `met` and `not_met` across roles. | Graph and policy tests cover the opposing-status invariant and consistent repeated classifications. | This is not semantic contradiction detection. It does not compare different criteria, infer claim meaning, or establish entailment. |
| Durable human escalation | INTEGRATION TESTED against local PostgreSQL 16 | A feature-gated v2 API starts, inspects/lists, and decides review runs. A minimal LangGraph stores only opaque IDs/hashes/versions, separates the side-effecting review creation from the pure interrupt node, and resumes by decision ID. PostgreSQL owns tenant-scoped workflows, reviews, decisions, events, candidate revisions, and guarded candidate updates. | Unit/component tests cover contracts, auth ordering, queue/detail bounds, approval/edit/reject, stale and repeated decisions, transaction failures, and no pre-approval write. Real PostgreSQL tests apply the actual migrations, exercise concurrent exact starts and decisions, and resume the same checkpoint through separate OS processes without duplicate effects. | Controlled local integration only. The feature remains disabled in the checked-in deployment workflow; no live Supabase/Auth, reviewer browser, Cloud Run revision, assignment/lease workflow, or stale-run sweeper was verified. |
| Agent 1 evaluator → Agent 2 question planner runtime | TESTED locally | [`resume_review/graph`](../services/hiring-agent/teamflow_hiring_agent/resume_review/graph) implements load/validate → Agent 1 → deterministic evidence/scoring → Agent 2 → validation/persistence routes behind `POST /v1/resume-reviews`; Next.js exposes a separate disabled-by-default `/api/parser/review` adapter. | Graph/API/adapter component tests cover the normal path, node timeouts, Agent 1 hard failure, Agent 2 degraded partial result, unsafe output, catalog bounds, idempotent persistence, body limits, and response correlation. | This is not the legacy `/invoke` graph and is not called by the UI. No real model, MCP subprocess, database, or deployed service was exercised. |
| Phase 4 read-only FastMCP surface | TESTED in process / IMPLEMENTED over stdio | The dedicated server exposes only `get_resume_document` and `load_active_role_policies`; neither agent is given model-selectable database tools. | Tool registration, bounds, tenant predicates, candidate-document association, malformed snapshots, and catalog overflow are tested in process. | No subprocess handshake or live Supabase query was run. |
| Tenant-scoped review snapshots and append-only results | INTEGRATION TESTED for PostgreSQL 16 and fresh Supabase replay | Repository SQL defines document snapshots, candidate-document links, policy and confidence snapshots, insert-only analysis rows, lifecycle state, immutable decisions/revisions/events, and guarded score mutation. Exact replays compare content-bound inputs and changed payloads conflict. | The actual Phase 6 migration is applied in disposable PostgreSQL 16 tests, while the full ordered history is replayed from an empty application schema on pinned Supabase PostgreSQL. Tests cover tenant isolation, grants/default ACLs, malformed history, candidate/document binding, retention guards, keyset pagination, literal evidence revalidation, concurrency, rollback, and idempotent replay. | This is local integration, not remote Supabase evidence. Existing deployments need explicit ledger reconciliation for baseline `000`; active jobs need valid configured policy JSON, and administrator retention/deletion policy remains operational work. |

## Security, reliability, and tenancy

| Capability | Status | Implementation evidence | Test evidence | Honest deployment boundary |
|---|---|---|---|---|
| Strict hiring-agent contracts | TESTED | Pydantic and Zod contracts validate UUIDs, bounds, extra fields, operation modes, and complete write inputs. | Python contract/API tests and TypeScript adapter tests pass. | Applies to the untracked optional hiring-agent path, not all application routes. |
| Prompt-injection/tool isolation | TESTED | Review mode binds no search tools; graph code independently blocks unauthorized tool trajectories; the model never receives the write tool. | Graph tests cover a résumé-instruction attack, forced tenant scope, and non-model-selectable writes. | This establishes tool-policy containment, not immunity from every semantic prompt attack. |
| Fail-closed supplied resource context | TESTED | When candidate or role IDs are supplied, those records are loaded with resource-and-merchant predicates before models or writes. | A failed supplied-resource read is tested to skip both models and persistence. | Candidate and role IDs are optional for some operations; a request with neither may still invoke the model. There is no real manager identity; the server supplies one fixed demo merchant. |
| Bounded provider failure handling | TESTED | Model calls use an explicit node deadline, zero provider retries, one application-controlled schema retry, and one configured transient fallback. | Tests distinguish transient failure from safety refusal and prove safety failures do not fail over. | A primary call that consumes the full node deadline may leave no fallback budget. No live rate-limit or provider outage exercise was run. |
| Request auth and capacity bounds for the agent service | TESTED | The FastAPI service keeps constant-time service-token checks, streamed request limits and body-read deadlines, bounded admission, queue timeouts, and operation deadlines. V2 additionally verifies a Supabase bearer through the Auth user endpoint before deriving database membership. | API/runtime tests cover auth ordering, malformed/oversized/chunked/slow input, saturation, deadlines, sanitized failures, and retry after a post-commit timeout. | The outer shared token authenticates the Next service; the bearer authenticates the reviewer. The checked-in release posture requires a preprovisioned public Cloud Run invoker binding and external edge rate limiting, so both application checks remain mandatory. No live Auth call, WAF, or abuse test was run. |
| Private résumé-review boundary | TESTED at component/service level | `/api/parser/review` is disabled by default, uses constant-time route authentication, derives the demo tenant server-side, performs streaming JSON bounds, and correlates service response IDs. `/v1/resume-reviews` repeats strict validation, service-token auth, capacity control, and a workflow deadline. | Node component tests cover the shared auth helper, bounded reader, contracts, client correlation, and timeout mapping; Python API tests exercise the actual service route. | No test directly invokes the Next route handler. There is no authenticated manager-to-merchant membership, UI caller, or live end-to-end request. |
| Prompt-instruction containment for résumé review | TESTED as defense in depth | The review workflow gives neither model tools; NFKC/confusable-aware phrase checks route common document instructions to manual review, known-status evidence requires literal source membership plus distinctive criterion-term overlap, criterion-overlapping verdict language and explicit negation fail validation, Agent 1 free-form limitations are discarded, and Agent 2 must reproduce application-owned wording. | Adversarial tests cover common instruction paraphrases/confusables, tailored directive-verb substitutions, selected legitimate résumé-language false positives, unrelated literal evidence, explicit criterion negation, decision-field injection, protected/medical/contact patterns, tool absence, and no-write behavior. | Phrase and lexical checks remain bypassable and can false-positive or miss novel wording and synonyms. Legitimate “met requirements” text may be sent to review. These checks are neither prompt-injection immunity nor semantic entailment proof. |
| Tenant-scoped MCP reads | TESTED | Required MCP reads filter by resource ID and merchant ID; model-selected tenant arguments are overwritten. | Tests assert merchant predicates and the read-only tool inventory. | This component evidence does not prove deployed user-to-merchant authorization. |
| Retired legacy agent writes | TESTED | The FastMCP server has no score-mutation tool, and the legacy graph returns a failed write status without invoking a supplied tool. | Tests cover write-tool absence and fail-closed explicit requests. | Durable score mutation is only intended through the authenticated Phase 6 human-decision transaction; no deployed write is claimed. |
| Data API hardening | INTEGRATION TESTED locally | Phase 6 uses private `SECURITY DEFINER` functions with empty search paths, explicit function grants, live membership checks, row locks, RLS, and dedicated NOLOGIN capabilities. Phase 8A enables RLS on every TeamFlow public table, removes broad API grants, binds separate reader/writer JWT roles to one canonical merchant claim, exposes an email-free search RPC, and replaces the hiring service's service key with an exact-origin, no-redirect, bounded-response client. | Disposable PostgreSQL 16 tests cover ACL/RLS/default-privilege canaries, tenant denial, ambiguous membership, malformed artifacts, lock ordering, decision races, and rollback. A pinned Supabase PostgreSQL 17 image replays all ordered migrations from an empty application database, loads the seed, and proves same-tenant/demo access plus cross-tenant denial. | No live Supabase Auth/Data API/Storage request, pooler, remote migration history, hosted default ACL, backup, restore, or production token mint/rotation was inspected. JWT signatures are verified by Supabase; local routing validation only checks bounded claims before the request. |
| Authenticated manager/reviewer identity | TESTED locally; database tenant derivation INTEGRATION TESTED | V2 verifies the bearer with Supabase Auth, accepts no merchant/actor field, and has PostgreSQL derive exactly one active membership on every authorized operation. Owners/managers may start; owners/managers/reviewers may list, inspect, and decide. | Mocked Auth tests cover malformed, anonymous, invalid, unavailable, and oversized responses. Real PostgreSQL tests cover missing, suspended, wrong-tenant, cross-tenant, role, and ambiguous multi-membership cases. | No live Supabase Auth or manager UI session was exercised. Users with multiple active merchant memberships fail closed because no trusted tenant-selection context exists yet. |

## Evaluation, observability, and delivery

| Capability | Status | Implementation evidence | Test evidence | Honest deployment boundary |
|---|---|---|---|---|
| Ordinary reliability regression tests | TESTED | Node and Python suites cover contracts, deterministic graph behavior, failures, and security boundaries. | Current local component gate: 144 Node, 800 deterministic hiring-agent, and 141 document-processor tests, all without skips. Separately provisioned integration runs pass 12 PostgreSQL 16 repository/restart cases and three fresh Supabase PostgreSQL 17 replay/security cases. | These broad suites are primarily unit/component evidence; only the explicitly identified PostgreSQL cases qualify as local integration evidence. No live provider/cloud suite ran. |
| Extraction regression fixtures | TESTED for deterministic routing and field survival | Three synthetic, visibly labeled PDF fixtures cover digital text, image-only scanned input, and intentional corruption; a SHA-256 manifest locks their identity. | Tests assert digital critical-field survival, scanned/mixed OCR routing and fake-provider field survival, no scanned text layer, corrupt failure, and fixture hashes. | Do not call this measured OCR accuracy: scanned expected text is supplied by a fake provider. CER/WER and live field survival remain PROPOSED. |
| Offline evaluation foundation | TESTED | [`evaluation/`](../services/hiring-agent/teamflow_hiring_agent/evaluation/) provides strict artifacts, canonical JSON/JSONL, SHA-256 identities, bounded loading, manifest/lock verification, purpose-gated splits, failure records, metrics, aggregate-only reports, and a read-only CLI. | [`test_evaluation_foundation.py`](../services/hiring-agent/tests/test_evaluation_foundation.py) covers deterministic serialization/fingerprints, malformed artifacts, duplicates, leakage, manifest/test mutation, purpose guards, failure classes, reporting privacy, and CLI exit classes. The Phase 8A production image was built and inspected to confirm the evaluator, corpus, tests, and development lock are absent. | Offline only. FastAPI, LangGraph, MCP, and the scorer do not import it; excluding it from the image does not establish semantic quality or producer attestation. |
| Validation-only risk/coverage tooling | TESTED as offline machinery with fixture-only labels | [`evaluation/risk_coverage.py`](../services/hiring-agent/teamflow_hiring_agent/evaluation/risk_coverage.py) requires the exact verified validation population, binds dataset/split/run/label/policy identities and fingerprints, verifies per-case input fingerprints, and recomputes each assessment from supplied cached signals under the canonical policy. The label manifest binds the exact observation run/set and run-manifest fingerprints; each label binds its case's Agent 1 result fingerprint. Score ties stay atomic, hard failures remain ineligible, and output contains aggregate score-cutoff points with `threshold_selected=false`. | Offline tests exercise complete-population and manifest checks, result/run/policy/assessment tamper rejection, tie handling, hard-failure exclusion, explicit denominators, fixture-label gating, deterministic output, and the network-free CLI. These fixture labels test mechanics only. | Recomputing supplied signals does not authenticate their producer. SHA-256 values and unsigned manifests provide integrity/comparability, not external attestation. A label manifest declaration is also not proof that humans reviewed it. No real observation producer/run artifact, approved labels, saved curve, or threshold exists; the corpus remains `pending_human_review`. Test/locked data cannot be used for threshold selection. |
| Synthetic résumé-review seed corpus | TESTED for integrity only | [`resume_review_v1`](../services/hiring-agent/evals/resume_review_v1/) v1.1.0 contains 30 validation, 20 locked test, and 15 adversarial synthetic cases covering the required reliability and safety slices. All 65 cases and the manifest remain `pending_human_review`; the five-case validation expansion left the locked-test bytes unchanged. | The read-only verifier checks byte, record, input, case-ID, and schema fingerprints; counts; canonical ordering; duplicates; cross-split content/equivalence leakage; and required scenario coverage. CI invokes the verifier without network access, and a regression test preserves both the prior 25-case validation prefix and locked-test bytes. | This is not a human-reviewed benchmark, no expected numeric scores are asserted, and no model-quality result has been measured. Hash locks prevent accidental drift but cannot stop a reviewer from deliberately changing data and every lock artifact together. |
| Human-reviewed hiring benchmark | PROPOSED | The seed corpus has not been independently annotated or adjudicated. | No reviewer agreement or approval artifact exists. | Do not describe the current corpus as human reviewed or use it to claim measured model quality. |
| Offline diagnostic LLM judge | TESTED as isolated machinery; semantic quality unmeasured | [`evaluation/diagnostic_judge.py`](../services/hiring-agent/teamflow_hiring_agent/evaluation/diagnostic_judge.py) defines canonical prompt/rubric/safety/generation/tool policies, a strict one-role transient packet, three closed verdict dimensions, content-free cached input/output/run artifacts, typed failures, a fixture executor, and a no-retry Gemini adapter. The adapter has an outer deadline, provider timeout, token cap, temperature zero, structured schema, four safety settings, and no tools or database access. It is not imported by production code. | Fixture/fake-transport tests cover deterministic fingerprints and serialization, exact binding, app-derived disposition, closed reason codes, literal evidence and score math, source/payload bounds, timeout/provider/safety/token/tool/malformed failures, privacy canaries, and the concrete Gemini request configuration without making a network call. | No live Gemini judge call, cached provider run, human-approved label comparison, agreement, kappa, false-accept, or judge-error measurement exists. Test transports are labeled separately; SHA-256/manifest declarations are unsigned and the run manifest is trusted only after separate verified-population validation. Judge output is diagnostic only and cannot route, score, accept, or reject candidates. |
| Comparable semantic-regression gate | TESTED as offline machinery; human evidence unmeasured | [`evaluation/semantic_regression.py`](../services/hiring-agent/teamflow_hiring_agent/evaluation/semantic_regression.py) and the evaluator CLI bind the exact verified validation population, generator and judge identities, immutable baseline lock, cached inputs/outputs, and per-target human labels. Reports include per-dimension and overall agreement, Cohen's kappa status, false accepts/rejects, uncertainty, and explicit denominators; the policy rejects incomparable identities and non-offsetting regressions without updating a baseline or selecting a threshold. | Focused tests cover contract/linkage tampering, complete-population and 15-pass/15-fail balance requirements, fixture-only non-evidence, metric math, degenerate kappa, new failure/regression cases, privacy flags, deterministic reports, and CLI exit behavior. | No baseline or candidate live-provider cache and no independently human-approved label set exist. Therefore no evidence-bearing gate has run, no agreement/kappa/false-rate result is measured, and no production authority follows from the tooling. |
| OCR trace propagation and disabled helper safety | TESTED | Next.js OCR trace helpers and document-processor FastAPI instrumentation exist. | Tests prove W3C parentage at the OCR boundary and that disabled Next.js tracing remains safe. | No live Cloud Trace export was observed. |
| Broader OpenTelemetry instrumentation/export | IMPLEMENTED | Scorer, hiring-agent, MCP, FastAPI, and Cloud exporter code exists. Extraction spans record only safe operational metadata and mark mock/failed extraction as errors. | Processor tests verify incoming trace-parent reuse, error status, and absence of filename/content-hash attributes; no hiring-agent/MCP exporter or end-to-end trace test exists. | No deployed Cloud Trace waterfall was observed. Scorer provider spans can still complete before the outer parser validates JSON, which remains later reliability work. |
| Staged WIF/OIDC Cloud Run delivery | TESTED as repository configuration; not deployed | Both reusable workflows use full action commit SHAs, pinned tool/base/builder images, separate build/runtime identities, numeric secret versions, hash-locked dependencies, vulnerability rejection, verified provenance, SBOM generation, exact-digest zero-traffic staging, bounded resources, readiness promotion, rollback, and mandatory tag cleanup. CI gates deployment on Node/Python tests, builds, formatting, `npm audit --audit-level=high`, contracts, and fresh migration replay. | Static release-contract tests pass; both production images build locally as UID/GID `10001:10001`, exclude test/evaluation/environment artifacts, and pass `pip check`. The Next production build and high-severity npm audit gate pass; `npm audit` still reports one moderate `@humanfs/node` advisory. | No GitHub Actions run, WIF exchange, Cloud Build scan/provenance/SBOM, Secret Manager access, Cloud Run revision, IAM binding, WAF, live canary, alert, or rollback was observed. Repository configuration is not deployment evidence. |
| Static model/embedding drift gate | TESTED | [`config/ai-model-contract.json`](../config/ai-model-contract.json) and [`verify-model-contract.mjs`](../scripts/verify-model-contract.mjs) compare exact named defaults, embedding call/schema compatibility, deployment values, and selected active docs. | The current gate executes successfully through `npm run verify:contracts`; CI and both deploy workflows call it before release work. | It does not call Google, inspect deployed environment variables, or prove live model availability. |

## Known blockers that must not be hidden in interviews

1. **Local-demo service-role application routes:** candidate list/delete, invite,
   application, and parser routes still lack a real manager/candidate identity boundary.
   They now require an explicit local-only flag and fail closed in production, so the
   current UI demo is not a production access path.
2. **Broken magic-link trust boundary:** the client only decodes token-shaped input, the
   application API does not verify a signed token, invite/application routes are
   unauthenticated, signing has a known development-secret fallback, and the local demo
   returns the bearer URL. Logs no longer include the URL, message, name, or phone. The
   README labels this as a demo, not complete auth.
3. **OCR truth remains unmeasured:** the static fallback and provenance-drop defect are
   fixed, but source-block integrity proves consistency with extracted text—not fidelity
   to source pixels. Live Gemini OCR field survival, CER/WER, and complex-layout quality
   have not been measured.
4. **Non-authoritative legacy preview scores:** the local upload scorer still returns a
   model/deterministic preview to the browser, but parser/application persistence omits
   numeric score fields, the shared candidate writer rejects them, and legacy `/invoke`
   write requests fail closed. Durable score changes require the Phase 6 human-decision
   path; the preview itself is not a calibrated quality or fairness result.
5. **Deployment upload/resource boundary:** application contracts and both HTTP stacks
   enforce byte/type/signature/body-read/operation deadlines and URL ingestion is
   disabled. PDF text parsing now runs in a killable two-slot subprocess with Linux
   address-space/CPU/file-descriptor limits, cumulative decoded-text bounds, and tested
   cancellation cleanup. The Next upload transport still carries bounded Base64 JSON
   rather than a direct-to-private-storage object, so it is not the final large-file path.
6. **No production upload/reviewer UI yet:** the legacy parser, application, invite, and
   candidate routes are local-demo-only. The authenticated v2 backend derives tenancy,
   bounds requests, and exposes pending-list/detail/decision operations, but no browser
   screen currently acquires a session, starts a run, or renders the queue. Assignment,
   claim leases, reviewer notifications, quotas, and SLA handling are not implemented.
7. **Deployment remains unverified:** repository workflows now require immutable action
   and image identities, separate build/runtime service accounts, numeric secret
   versions, scans, provenance, SBOMs, zero-traffic staging, promotion/rollback, and
   resource/readiness gates. Local containers and static contracts pass, but Secret
   Manager values, WIF/IAM, public-invoker/WAF posture, Cloud Build outputs, active Cloud
   Run settings, alerts, rollback, and a live dependency request were not verified.
   Configuration and a local image build are not deployment evidence.
8. **Model-client compatibility unverified:** Gemini 3.7/3.6 identifiers are recorded,
   but the pinned LangChain adapter prepares sampling fields restricted by current model
   guidance. The TypeScript scorer also uses Google's legacy, deprecated
   `@google/generative-ai` SDK rather than `@google/genai`. See the
   [official Google GenAI libraries guidance](https://ai.google.dev/gemini-api/docs/libraries).
9. **Demo and real data provenance:** the dashboard appends demo candidates to database
   candidates without a strong visual/provenance boundary.
10. **Checkpoint privacy is narrow, not global:** the durable Phase 6 lifecycle stores
   only opaque identifiers, hashes, versions, statuses, and bounded reason codes, and a
   three-process test scans its PostgreSQL checkpoint tables for private canaries. The
   larger analysis graph still contains messages and evidence and intentionally remains
   uncheckpointed. Attaching the saver directly to that graph would reintroduce résumé
   retention risk.
11. **Hiring-policy conflict:** age, commute/location, job gaps, job hopping, personality,
    and similar criteria need an approved product/legal policy and evaluation before they
    can influence routing. RLS, regex filters, or an LLM judge do not establish legal
    compliance. Phase 4 rejects a bounded set of protected/medical/contact patterns, but
    regexes are not an exhaustive fairness or legal-policy boundary.
12. **Partial telemetry semantics:** extraction now marks mock/failed results as errors and
    tests privacy-safe trace propagation. The scorer provider span can still record success
    before the outer parser validates JSON, so end-to-end outcome telemetry is incomplete.
13. **Uncommitted mixed implementation:** the hiring-agent service, model manifest, gate,
    and workflow do not support a public résumé claim until deliberately committed
    together. Phase 0 adds `/tmp/` to `.gitignore` to protect local résumé-rendering
    artifacts, but staging still needs care: the tracked document MCP server is deleted
    while its replacement remains untracked.
14. **Semantic evidence remains unmeasured:** Phase 4 verifies that every cited quote is
    present in a named canonical source block and requires distinctive criterion-term
    overlap for known statuses. Criterion-overlapping verdict language such as “met” or
    “satisfied” is rejected as evidence, which can send legitimate wording to review.
    That conservative lexical gate is not semantic entailment; synonym evidence may be
    sent to review and a crafted overlapping quote without verdict language may still be
    unrelated. Phase 5's conflict gate only
    rejects the same normalized criterion ID and configured text when it receives opposing
    `met`/`not_met` statuses; it does not detect semantic contradictions between different
    criteria or claims. Prompt-instruction detection is heuristic, and no judge/human
    benchmark currently measures entailment, relevance, or unsupported classifications.
15. **Database integration is local, not production:** Phase 6 SQL, roles, RLS/RPCs,
    atomic decisions, checkpoints, and process restart were exercised against disposable
    PostgreSQL 16. Phase 8A also replays every ordered migration and the demo seed from an
    empty application database on a pinned Supabase PostgreSQL 17 image. No remote
    Supabase project, migration ledger reconciliation, Data/Storage API, pooler,
    backup/restore, retention job, or Cloud Run connection was tested. The demo seed
    remains configuration, not a policy-approval workflow.
16. **Review output can still contain résumé-derived personal text:** the reviewer detail
    omits raw résumé/contact columns, embeddings, prompts, checkpoints, tenant IDs, and
    internal hashes. It intentionally exposes bounded exact evidence snippets after
    literal-source and safety revalidation. Filters cover selected email, phone, secret,
    protected-trait, and medical patterns—not names, addresses, every international
    contact format, or every protected-trait synonym. Do not claim PII-free output or
    fairness compliance.
17. **Lifecycle operations are incomplete:** the backend has a shared pending queue and
    optimistic first-decision-wins concurrency, but no claim/assignment lease, stale-run
    sweeper, terminal failure transition, operator alert, or automatic reconciliation
    worker. A failed start remains safely retryable as `running`; that is not a complete
    operations model.

## Composite résumé-claim verdicts

| Résumé claim | Evidence status | Defensible wording today |
|---|---|---|
| “Stateful LangGraph workflow covering extraction, confidence routing, and human escalation” | PARTIAL, with the human-review lifecycle INTEGRATION TESTED locally | TeamFlow has a two-agent analysis graph plus a separate minimal durable lifecycle. The latter uses PostgreSQL checkpoints, `interrupt()`/resume, authenticated tenant-derived review APIs, a bounded queue/detail packet, atomic idempotent decisions, and recomputable confidence provenance. Extraction remains an upstream service, the numeric diagnostic never auto-routes, and no reviewer UI, live Supabase/Auth/model, or deployment was verified. |
| “LLM-as-a-Judge with groundedness, relevance, reasoning consistency, and a golden dataset” | PARTIAL: judge/regression machinery TESTED; human benchmark and quality MEASUREMENT absent | TeamFlow now has an isolated offline diagnostic judge for groundedness, criterion relevance, and internal consistency, immutable content-free caches, and a comparable regression gate. Only deterministic fixtures/test transports were exercised. The 30-case validation split is synthetic and pending independent review; no live judge artifact, agreement, kappa, false-rate, calibration, golden-set, production-routing, or deployment claim is defensible. |
| “FastMCP, pgvector, OpenTelemetry, and WIF/OIDC” | Mixed: TESTED / IMPLEMENTED | FastMCP catalog/tool guards and the local stdio transport are tested; pgvector schema/RLS/RPC behavior is integration-tested on disposable PostgreSQL; OCR trace propagation/helper safety have component tests; WIF/OIDC remains deployment configuration only. No live Supabase, provider, trace export, or cloud deployment is claimed. |
| “Two-agent evaluator and interview-question planner” | TESTED locally; not integration tested | TeamFlow has a real Agent 1 → deterministic validation/scoring → Agent 2 LangGraph, versioned service/Next contracts, bounded failure routes, and a least-privilege gap handoff. It is an explicit private API with fake-model/component tests; there is no UI caller or live Gemini/MCP/Supabase/deployment proof. |

## Next evidence gate

Phase 6 adds a separate, feature-gated v2 human-review boundary. Supabase Auth resolves
the bearer identity, PostgreSQL derives one current active merchant membership, and
the caller cannot supply tenant, actor, score, or checkpoint authority. A minimal
LangGraph lifecycle checkpoints only opaque IDs, hashes, versions, statuses, and reason
codes; the private analysis/evidence remains in tenant-scoped relational records. The
workflow creates a review, pauses at `interrupt()`, and resumes with only an immutable
decision ID. Approve, edited approve, and reject are atomic and idempotent; candidate
scores cannot be inserted or changed outside a validated review revision. A bounded
pending queue and detail projection give authorized reviewers the configured criteria,
deterministic score derivation, source-validated evidence excerpts, question plan, and
recomputable confidence provenance. The local PostgreSQL 16 gate applies the actual
Phase 6 migration and the real checkpointer migrations, exercises concurrency and
transaction behavior, and resumes the same checkpoint from a new OS process. This is
controlled integration evidence, not a deployed Supabase, browser, or Cloud Run run.
Fresh ordered database replay and the shared FastMCP stdio boundary are locally tested;
remote migration-ledger state, subprocess-to-live-Supabase access, live models/Auth,
reviewer UI invocation, and cloud deployment remain untested.

Phase 7 now provides the offline diagnostic judge, versioned content-free cached-output
contracts, and comparable semantic-regression tooling. The remaining evidence gate is to
obtain independent, adjudicated labels for the complete 30-case validation split—with at
least 15 resolved overall passes and 15 resolved overall failures—and then save comparable
live-provider baseline and candidate judge artifacts. All 65 synthetic cases are still
pending human review, so no human agreement, kappa, false-accept, false-reject, judge-error,
measured semantic quality, calibrated judge, or threshold claim exists. Do not make the
judge a production hiring authority or add numeric confidence routing before separately
governed evidence exists.

Phase 8A closes the repository-side release gate for the two Python services and the
server-side Next proxy: bounded/isolated parsing, sanitized telemetry and validation,
exact trusted origins, scoped tenant-bound Supabase capabilities, full fresh migration
replay, immutable dependency/image identities, hash-locked Node dependencies, and
staged exact-digest deployment workflows are locally tested. The configured high-severity
Node audit gate passes, but one moderate `@humanfs/node` advisory remains. It does not
authorize
Phase 7 or establish a live production release. Promotion remains blocked on real
Supabase migration/ACL/storage verification, CSPRNG token provisioning and rotation,
WIF/IAM review, public-edge WAF/rate limits, provider-functional canaries, alerts/SLOs,
backup/restore and rollback drills, and an observed staged Cloud Run release. The
manager and candidate pages remain production-disabled.

Later phases must update this ledger whenever a capability moves from PROPOSED →
IMPLEMENTED → TESTED → INTEGRATION TESTED → DEPLOYED, and must attach a reproducible
artifact before using MEASURED.
