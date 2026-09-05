# TeamFlow Two-Agent Interview Context

## How to use this document

Use this document as background context for answering technical interview questions
about Rubiat Bin Faisal's TeamFlow project and its two-agent hiring
workflow.

Important truthfulness rule:

- The current working tree contains a deterministic resume upload pipeline, a
  legacy generic LangGraph endpoint, and a separate executable Agent 1 -> Agent 2
  résumé-review graph behind a private versioned API.
- The two-agent flow is locally unit/component tested with scripted models and
  HTTP mocks. The shared exact-six-tool FastMCP stdio boundary is also tested locally,
  while the flow has no UI caller and has not been exercised with live Gemini,
  subprocess-to-live-Supabase access, or Cloud Run.
- The feature-gated Phase 6 backend now has locally tested bearer verification,
  database-derived membership, durable human review, and real PostgreSQL restart
  evidence. Do not turn that into a claim about a finished reviewer UI, assignment
  workflow, live Supabase/Auth, or deployment.
- Phase 7 adds an isolated offline diagnostic judge and comparable semantic-regression
  machinery with deterministic fixture and test-transport coverage. It has no production
  import or hiring authority, and no live judge run, independent human labels, agreement,
  kappa, false-rate measurement, calibration, database access, or routing evidence exists.
- Current repository facts and remaining design work are identified
  separately below.

## Candidate background

Rubiat Bin Faisal is a software engineer specializing in applied generative AI,
multi-agent workflows, observability, evaluation, and cloud infrastructure.

Relevant background from the supplied resume:

- Bachelor's degree in Computer Science from Lehigh University, May 2025.
- AI architecture experience includes sequential multi-agent systems, Model
  Context Protocol, RAG, and LLM-as-a-judge evaluation.
- Cloud and observability experience includes OpenTelemetry GenAI Semantic
  Conventions, Google Cloud Trace, Workload Identity Federation, PostgreSQL, and
  pgvector.
- Main engineering stack includes Python, FastAPI, FastMCP, TypeScript,
  React, and Next.js.
- TeamFlow is an AI-powered job-screening project using Python, FastMCP,
  pgvector, Gemini, and OpenTelemetry.
- Managify includes an LLM-as-a-judge evaluation harness that scores context
  relevance and groundedness against a curated golden set.
- Previous software engineering work includes React and TypeScript frontend
  ownership, secure LLM microservice integration, optimized SQL, tenant data
  isolation, Slack-based contextual retrieval, and rendering structured LLM
  output.

Do not expose the resume's phone number, email address, or other unnecessary
personal data when answering architecture questions.

## Project purpose

TeamFlow helps managers process resumes, evaluate candidates against configured
job criteria, recommend suitable positions, and collect missing job-related
information through targeted follow-up questions.

The architectural goals are:

- Keep OCR, evaluation, question generation, and persistence as explicit
  boundaries.
- Make model output structured and runtime-validated.
- Tie recommendations to configured role criteria and literal résumé evidence;
  measure semantic support separately.
- Avoid giving agents arbitrary database or SQL access.
- Preserve human control over hiring decisions.
- Make failures observable without logging resume text or personal information.

## Current Phase 4 two-agent workflow

```text
Candidate PDF or image
    |
    v
Next.js upload API (`/api/parser`)
    |
    v
FastAPI document processor (Cloud Run target)
    |
    +--> pypdf digital text or Gemini scanned/image transcription --> canonical text
    |
    +--> Gemini embedding model --> 768-dimensional document embedding
    |
    +--> optional insert-only tenant-scoped extraction snapshot
    |
    v
Private Next.js review API (`/api/parser/review`)
    |
    +--> server injects the demo tenant and persistence policy
    |
    v
LangGraph review API (`/v1/resume-reviews`)
    |
    +--> Agent 1: Candidate Evaluator and Role Matcher
    |       |
    |       +--> app loads configured role policies through read-only FastMCP
    |       +--> structured criterion classifications + literal source references
    |
    +--> deterministic validation gate
    |
    +--> Agent 2: Gap Analyzer and Question Planner
            |
            +--> reads validated Agent 1 output from typed graph state
            +--> receives only app-selected validated gaps/criteria
            +--> structured follow-up question plan
    |
    v
Application-level validation, score calculation, and deterministic JSON merge
    |
    +--> API response (no UI caller yet)
    +--> optional persistence after validation
```

## Document-processing stage

### Current repository behavior

- The Next.js parser route accepts only bounded, canonical inline Base64 data.
  Caller-controlled file URLs are rejected to avoid SSRF and unbounded downloads.
- It sends the decoded file as multipart form data to the FastAPI document
  processor at `POST /extract`.
- The request includes an `X-OCR-Token` shared-secret header.
- The processor accepts PDF, JPEG, and PNG up to 10 MiB and verifies byte
  signatures against the declared MIME type.
- Complete digital PDFs use deterministic `pypdf` extraction only when every page has
  usable text and bounded content inspection finds no image-dominant or non-painting
  text layer. Image-only, mixed, suspicious-layer PDFs and direct images route to
  Gemini multimodal extraction rather than Google Cloud Vision OCR.
- Gemini is instructed to transcribe rather than summarize and its output is
  accepted only after a normal completion signal and deterministic quality checks.
- The processor then makes a separate call to `gemini-embedding-001`.
- The embedding call requests 768 output dimensions using the
  `RETRIEVAL_DOCUMENT` task type.
- The strict v1 response records status, canonical text, stable source blocks,
  extraction and embedding models, uploaded-byte SHA-256, warnings, and quality.
- Next.js recomputes the uploaded-byte hash and derives scoreability in trusted
  application code. It never trusts a processor-supplied scoreable flag.

Example response:

```json
{
  "schema_version": "1.0",
  "document_id": "doc-<64 lowercase hex characters>",
  "status": "complete",
  "markdown": "Candidate Name\n\nDocumented experience...",
  "text": "Candidate Name\n\nDocumented experience...",
  "source_blocks": [
    {
      "source_block_id": "src-<hash>-p0001-b0001-<digest>",
      "page_number": 1,
      "ordinal": 1,
      "text": "Candidate Name"
    }
  ],
  "embedding": ["768 finite numbers"],
  "extraction_method": "pdf_text",
  "model_id": "pypdf-6.16.2",
  "embedding_model_id": "models/gemini-embedding-001",
  "content_sha256": "<64 lowercase hex characters>",
  "mock": false,
  "warnings": [],
  "quality": {
    "assessment": "usable",
    "character_count": 41,
    "block_count": 1,
    "page_count": 1,
    "reason_codes": []
  }
}
```

### Important OCR limitation

Mock mode and every extraction failure now return empty, explicitly
non-scoreable results; no static résumé is substituted. Only validated
`complete` or embedding-degraded results with usable canonical text and source
blocks reach the scorer. The checked-in scanned fixture uses a fake OCR provider,
so these tests establish routing and contract behavior—not live Gemini OCR
accuracy. No CER/WER, bounding-box confidence, or measured field-survival claim
exists yet.

### Upload-size limitation

- The manager UI currently permits files up to 10 MB.
- The browser converts the file to Base64 and sends it inside JSON.
- Base64 adds approximately 33 percent size overhead.
- A 10 MB PDF becomes roughly 13.3 MB before JSON overhead.
- Vercel Functions have a smaller request-body limit than this upload path can
  support.
- The preferred production design is direct-to-storage upload followed by a
  storage reference, rather than sending large Base64 documents through the
  Next.js function.

The upload pipeline returns a content-derived `document_id` and can persist the
validated extraction snapshot when `RESUME_REVIEW_STORE_DOCUMENTS=true`. The
private review request passes only that identifier and an optional candidate ID.
The analysis workflow loads source blocks into an invocation-scoped dependency closure;
PDF bytes, Base64, embeddings, and unrestricted text are not placed in graph state. It
remains deliberately uncheckpointed. A separate minimal Phase 6 lifecycle uses a
PostgreSQL checkpointer and stores only opaque IDs, hashes, versions, statuses, and
bounded reason codes.

## Agent 1: Candidate Evaluator and Role Matcher

### Responsibility

Agent 1 classifies how the candidate's documented experience maps to configured
job requirements. Deterministic application logic—not the model—then applies
configured application-owned criterion weights, ranks roles, and recommends the best-supported
position.

### Inputs

- A tenant-scoped canonical extraction snapshot loaded by opaque `document_id`.
- Configured active roles and their criteria, retrieved through FastMCP or loaded
  deterministically by the orchestrator.
- Extraction status/warnings and the request ID stay in application state/telemetry;
  they are not sent to Agent 1.

The raw 768-number vector should not be inserted into the LLM prompt. It should
be consumed inside a retrieval tool when semantic search is needed.

### Required behavior

- Treat resume content as untrusted data, not as instructions.
- Ignore prompt-like commands embedded in the resume.
- Compare the candidate only against configured role criteria.
- Evaluate every active role when the role catalog is small.
- Classify criteria only from evidence present in the stored résumé blocks; do not
  generate points or final scores.
- Mark unsupported facts as unknown rather than guessing.
- Provide an exact quote and source-block reference for every `met` or `not_met`
  criterion; page provenance is available when encoded in that block.
- Require every known-status quote to share at least one distinctive lexical term with
  its configured criterion; otherwise route the result to review.
- Reject a `met` classification when its cited quote explicitly negates distinctive
  configured-criterion terms. This is a narrow lexical guard, not general entailment.
- Let deterministic application logic recommend a primary role only when one role is
  uniquely best supported; otherwise return no recommendation for review.
- Explain uncertainty separately from negative evidence.
- Never automatically hire or reject the candidate.
- Avoid using protected characteristics or unjustified proxies.

### Agent 1 model-output contract

The model-facing contract intentionally has no numeric score, rank,
recommendation, confidence, candidate/contact, tenant, tool, or write fields.
The following abbreviated example is classified evidence only:

```json
{
  "schema_version": "1.0",
  "role_assessments": [
    {
      "role_id": "22222222-2222-4222-8222-222222222222",
      "criterion_assessments": [
        {
          "criterion_id": "team-leadership",
          "status": "met",
          "evidence": [
            {
              "criterion_id": "team-leadership",
              "exact_quote": "Led opening shifts for a team of four.",
              "source_block_id": "src-aaaaaaaaaaaa-p0001-b0006-0123456789ab"
            }
          ]
        },
        {
          "criterion_id": "inventory-ordering",
          "status": "unknown",
          "evidence": []
        }
      ]
    }
  ],
  "limitations": []
}
```

After catalog validation, the application sums weights only for `met`
criteria, derives gaps from `not_met` and `unknown`, sorts by descending score
with a role-ID tie-break, and recommends the first role only when it has a
positive, uniquely highest score. Tied or zero-evidence leaders produce a null
recommendation. A separate zero-weight hard gate also forces human review when the
leader's met weight does not exceed its combined negative and unresolved weight. This is a structural
conservative rule, not a calibrated threshold. The Phase 4 graph executes this logic.
Model-authored limitations are discarded; the application derives bounded
unknown-criterion summaries instead.

## Agent 1 validation gate

Agent 2 must not run on unvalidated Agent 1 output.

The deterministic validation layer verifies:

- Output is valid JSON.
- Output matches a runtime schema.
- The model output contains no score, rank, or recommendation fields.
- Every role ID and criterion ID exists in the configured catalog.
- Every configured criterion is assessed exactly once.
- `met` and `not_met` have evidence; `unknown` has none.
- A `met` quote does not explicitly negate distinctive configured-criterion terms.
- Deterministic scores exactly match the configured weights.
- Role ordering and recommendation are deterministic.
- Selected protected, medical, contact, and secret patterns are rejected; the lexical
  set is not exhaustive.
- Output is not truncated and the model finish reason is complete.

Phase 3 supplies typed source blocks and a deterministic helper that verifies an exact
quote is a literal substring of its referenced block. Phase 8 adds a conservative
distinctive-term overlap requirement and explicit-negation check. These establish
provenance and a narrow lexical relation, not semantic entailment or proof that Gemini's
transcription matches the source pixels; those require human-reviewed semantic
evaluation and live OCR measurement, not the Phase 5 diagnostic policy.

If validation fails:

- Stop the workflow and return `review_required` for Agent 1 hard failure.
- Do not pass malformed evaluation data to Agent 2.

## Phase 5 coverage observer and gates

The Phase 5 policy is easier to defend when described precisely: its numeric value is
weighted known-criterion coverage. A criterion is known when Agent 1 classified it
`met` or `not_met`; `unknown` criterion weight is uncovered. In the canonical v1 policy,
`criteria_coverage` has weight 100.

Nine other application-derived signals have weight 0 and operate as explicit gates:

- Workflow completion.
- Extraction validation.
- Required-context validation.
- Agent 1 schema validation.
- Literal-grounding validation.
- Evidence consistency.
- Deterministic score-calculation validation.
- Provider completion.
- Safety validation.

A missing or failed gate can set `hard_failure=true` and require review even if numeric
coverage is high. This separation avoids presenting arbitrary gate weights as a measured
quality formula. The score is not a probability, is not calibrated, is not a threshold,
and is not an independent combination of ten quality signals. Model self-confidence is
not used.

The evidence-consistency gate is also deliberately narrow. Before score calculation it
rejects the same normalized criterion ID plus configured criterion text when Agent 1
classifies it both `met` and `not_met` across roles. It does not understand claim meaning
or detect semantic contradictions between different criteria, evidence passages, dates,
or employers. The same gate requires review when the recommended role's met weight does
not exceed its combined negative and unresolved weight; that conservative invariant is not a calibrated
acceptance threshold.

The policy file is strict, canonical, versioned, and content-hashed. Malformed policy
configuration makes `GET /ready` return 503/not ready instead of causing a silent
fallback. An unexpected confidence failure during an invocation returns a typed
`review_required` response with the safe reason `confidence_policy_failed`. A hard-gate
reason is exposed in the response, but full signals/components stay in invocation state;
restricted traces receive only safe aggregate fields plus policy version/hash. That
metadata is sensitive and Phase 5 alone does not provide a durable ledger. The
feature-gated Phase 6 path persists the canonical policy, ten bounded non-text signals,
assessment, and final shadow disposition under tenant-scoped review access so authorized
readers can recompute it.

The offline risk/coverage utility verifies the exact validation population and binds
dataset, split, run, label, input, and policy identities. It recomputes assessments from
supplied cached signals under the canonical policy rather than trusting reported scores.
The label set also binds the exact observation run and each case's Agent 1 result
fingerprint, preventing label reuse for a different cached output. These controls do not
prove that the declared runtime actually produced those signals: the hashes and unsigned
manifests provide artifact integrity/comparability, not external attestation. Equal
scores remain one atomic cutoff and hard failures are never accepted.
Fixture-only labels can exercise the implementation; an evidence-bearing report requires
a label manifest declaring human approval. Dataset `resume_review_v1` v1.1.0 now contains
30 validation, 20 locked test, and 15 adversarial cases. All 65 cases remain
`pending_human_review`, and the locked-test bytes are unchanged, so no real observation
producer/run artifact, labels, measured curve, risk value, or routing threshold exists.
A manifest declaration is auditable metadata, not independent proof that review happened.

Phase 6 implements the durable backend queue and ledger: verified reviewer identity,
database-derived tenant authorization, decisions, audit events, interrupt/resume, and
retention guards. Assignment/claim leasing, reviewer notifications, and stale-run
operations are explicitly not implemented.

## Agent 2: Gap Analyzer and Question Planner

### Responsibility

Agent 2 receives Agent 1's verified unknowns plus a small application-owned set of
targeted, job-related follow-up questions and must reproduce that required output.

### Inputs

- Validated Agent 1 JSON from typed LangGraph state.
- Configured criteria for the recommended role.

Agent 2 should not need the complete resume or personal contact data when the
validated Agent 1 result contains the relevant evidence and gaps. Reducing its
input reduces PII exposure and prompt-injection risk.

### Required behavior

- Reproduce the application-owned required question for each unresolved criterion
  exactly; do not invent or rewrite recruiter-facing text.
- Link every question to a known criterion and Agent 1 gap.
- Prefer direct, answerable questions over vague personality judgments.
- Avoid duplicate questions.
- Avoid questions answered by existing evidence.
- Never ask about race, color, religion, sex, pregnancy, national origin,
  disability, genetic information, or other protected characteristics.
- Do not ask for medical details.
- Do not change Agent 1's score or recommended role.
- Do not infer that missing information is negative evidence.
- Generate exactly one question per supplied unknown gap, bounded by the v1 maximum of
  ten.

### Phase 4 least-privilege handoff and output contracts

Application code revalidates the Agent 1 evaluation against the configured role
policies, then constructs Agent 2's input from only the recommended role's
validated `unknown` gaps. It does not include scores, ranking, `not_met` gaps,
raw résumé text, contact data, or database tools. Agent 2 returns:

```json
{
  "schema_version": "1.0",
  "role_id": "22222222-2222-4222-8222-222222222222",
  "questions": [
    {
      "question": "Tell me about any inventory-ordering work you have done, including the checks you used.",
      "target_criterion_id": "inventory-ordering",
      "target_gap_status": "unknown",
      "purpose": "Verify whether the unknown gap reflects an omitted résumé detail.",
      "priority": "high"
    }
  ]
}
```

## Agent 2 validation gate

The application should verify:

- Every question references a valid Agent 1 gap.
- Every criterion belongs to the recommended role.
- Question count stays within the v1 contract limit of ten.
- No two questions target the same validated criterion gap.
- The complete plan exactly matches the application-owned required output.
- Questions do not contain protected-attribute or medical inquiries.
- Agent 2 does not alter Agent 1's scores.
- The plan contains no score, ranking, recommendation, tool, SQL, or write
  fields.

If Agent 2 fails, the system can still return Agent 1's validated evaluation
with a warning that follow-up questions require manual creation.

Phase 4 enforces these structural limits, exact application-owned wording, and bounded
lexical safety patterns. It does not prove question relevance, fairness, accessibility,
or legal appropriateness. Agent 2 failure returns the validated Agent 1 result with
`questions_status=degraded` instead of erasing the partial result.

## LangGraph and LangChain's roles

LangGraph manages explicit state, nodes, edges, and failure routes. Application node
wrappers own bounded schema retry and model failover. LangChain supplies the Gemini
integration, structured-output adapter, and MCP tool adapter. Neither framework replaces
business validation.

In the Phase 4 two-agent workflow LangGraph provides:

- Deterministic sequencing and conditional routes.
- Typed invocation state for passing validated Agent 1 output to Agent 2.
- Separate model-powered nodes with narrower prompts and schemas.
- Explicit deterministic validation nodes between probabilistic steps.
- Explicit `review_required` routes; bounded retry/failover remains application-owned.
- Inspectable node trajectories for evaluation and tracing.

Example conceptual configuration:

```python
builder = StateGraph(HiringState)
builder.add_node("evaluate_candidate", evaluate_candidate)
builder.add_node("validate_evaluation", validate_evaluation)
builder.add_node("generate_questions", generate_questions)
builder.add_node("validate_questions", validate_questions)

builder.add_edge(START, "evaluate_candidate")
builder.add_edge("evaluate_candidate", "validate_evaluation")
builder.add_conditional_edges("validate_evaluation", route_after_validation)
builder.add_edge("generate_questions", "validate_questions")
graph = builder.compile()
```

LangGraph and LangChain do not automatically guarantee:

- Factual correctness.
- Fair employment decisions.
- Evidence grounding.
- Prompt-injection resistance.
- Database authorization.
- Human review.

Those controls remain explicit application responsibilities.

## FastMCP's role

The project uses a custom FastMCP server created for TeamFlow. It does not use
Supabase's general-purpose MCP server.

FastMCP sits between the application-owned data loaders and Supabase:

```text
LangGraph dependency loader
    |
    v
TeamFlow FastMCP tool
    |
    v
validated business operation
    |
    v
Supabase REST or RPC
```

The legacy generic agent's custom FastMCP surface is read-only:

- `get_job_requirements`
- `get_candidate`
- `list_candidates`
- `semantic_search_candidates`

`update_fit_score` is retired and not registered. A legacy explicit-write request fails
closed without a database PATCH; authenticated Phase 6 human decisions own durable
candidate-score updates.

The Phase 4 review server instead exposes exactly two read operations:

- `get_resume_document`
- `load_active_role_policies`

Tool allocation should follow least privilege:

- Application code invokes the two read-only operations before model calls; neither
  Agent 1 nor Agent 2 receives a model-selectable tool.
- Application code selects the required question template before invoking Agent 2;
  Agent 2 must reproduce it exactly. Neither agent receives database tools or arbitrary
  SQL.
- A deterministic orchestrator owns insert-only persistence outside MCP.
- Writes remain disabled by default and require explicit authorization,
  validated identifiers, and validated payloads.

Typed LangGraph state, not MCP, passes Agent 1's output to Agent 2.

## FastAPI's role

FastAPI is the conventional HTTP service boundary.

It is used for:

- The document processor's health and extraction endpoints.
- The LangGraph service's externally callable HTTP interface.
- File and request handling.
- Authentication headers.
- Request validation.
- Error status codes.
- OpenTelemetry instrumentation.
- Cloud Run deployment.

FastAPI and FastMCP are complementary:

- FastAPI serves applications over HTTP.
- FastMCP serves discoverable tools to agents over MCP.

## Why use a custom MCP server instead of Supabase MCP

The custom server provides a smaller and safer business interface:

- Only allowlisted hiring operations are exposed.
- UUIDs, score ranges, status values, thresholds, and result counts are
  validated.
- Credentials and table structures remain hidden from the agents.
- Agents cannot run arbitrary SQL.
- Write permissions can be disabled globally.
- Selected tool/client boundaries are instrumented with spans; no durable MCP audit
  log or live trace is verified.
- Tools encode TeamFlow business semantics rather than generic database
  operations.

The trade-off is additional code and maintenance compared with direct database
access or a general Supabase MCP integration.

## Embedding and retrieval design

### Current implementation

- Resume Markdown is embedded with `gemini-embedding-001`.
- The output dimension is explicitly set to 768.
- Resume embeddings use `RETRIEVAL_DOCUMENT`.
- Search-query embeddings use `RETRIEVAL_QUERY`.
- Supabase stores the value in a pgvector `vector(768)` column.
- Candidate similarity uses cosine distance through a PostgreSQL RPC.
- An HNSW index accelerates approximate nearest-neighbor search.

### Why 768 dimensions

The choice balances:

- Semantic representation quality.
- Approximately 3 KB of pgvector storage per vector.
- HNSW index memory.
- Search computation.
- Compatibility with the existing database schema and RPC.

Larger 1,536- or 3,072-dimensional vectors provide more capacity but require
more storage and downstream comparison work. The choice should ultimately be
verified on labeled retrieval queries rather than treated as universally best.

All stored document embeddings and search-query embeddings must use the same
model family, dimension, and compatible task configuration.

### How retrieval should be used in the two-agent scenario

If TeamFlow has only a handful of active roles, Agent 1 should compare the
candidate against every role. RAG can reduce quality by accidentally excluding
the correct role.

RAG becomes valuable when there are:

- Hundreds or thousands of roles.
- Long policy or competency documents.
- Large approved-question libraries.
- Historical candidate searches.
- Similar-candidate or similar-experience queries.

Quality improvements include:

- Embed resume sections rather than only the entire resume.
- Preserve section, page, and candidate metadata for every chunk.
- Combine vector search with keyword search for exact certifications and
  equipment names.
- Retrieve a larger set and rerank before sending evidence to Agent 1.
- Require every retrieved claim to retain its source text.
- Tune thresholds using a labeled evaluation set instead of assuming `0.5`.
- Version the embedding model, dimension, preprocessing, and chunking strategy.
- Regenerate embeddings when those configurations change.

## Scoring safety and reliability

The separate legacy upload scorer demonstrates several useful controls:

- Role criteria are centralized in application configuration.
- Gemini is requested to return schema-constrained JSON.
- Temperature is set to zero for more consistent scoring.
- Output length is bounded.
- Empty, truncated, malformed, and schema-invalid responses are rejected.
- Numeric score ranges are enforced.
- The total score must equal the sum of its components.
- Retries are bounded.
- A conservative deterministic fallback uses only explicit term matches.
- Fallback output states that manual review is required.
- Persistence occurs only after runtime validation.
- Candidates are stored as `new`; the pipeline does not automatically hire or
  reject them.
- Operational logs use request IDs, token counts, model names, and error types
  rather than resume content.

Controls added in Phase 4, with further evaluation still required:

- Require a literal source-block quote and distinctive criterion-term overlap for every
  known-status classification before a `met` weight can be counted.
- Treat resume content as untrusted, with no model-selectable tools and heuristic
  instruction detection that routes obvious attacks to review.
- Agent 1 still receives complete canonical source blocks; prompts and deterministic
  filters forbid or reject selected protected/medical uses rather than removing every
  sensitive attribute from the input.
- Avoid scoring based on names, photos, race, religion, sex, disability, or
  other protected attributes.
- Reconsider city-based commute estimates, employment-gap penalties, and
  personality judgments because they can create unfair proxies.
- Use `review_required` as an enforced API state for Agent 1/context failure.
- Run bias and consistency evaluations across model and prompt versions.
- Keep the final employment decision with a manager.

## Failure behavior

Implemented Phase 4 behavior:

- Missing, failed, or invalid stored extraction: return `review_required` before either
  model runs.
- Embedding-unavailable but otherwise usable extraction: continue literal-evidence
  scoring with `embedding_unavailable`; Phase 4 performs no semantic retrieval.
- Agent 1 failure: do not run Agent 2; return `review_required` without a score.
- Agent 1 validation failure: stop and return `review_required`.
- Structural conflict: reject the same normalized criterion ID plus configured text with
  opposing `met`/`not_met` statuses before score calculation; do not describe this as
  general semantic contradiction detection.
- Missing or failed confidence gate: return `review_required` regardless of the numeric
  known-criterion coverage. Coverage itself never routes.
- Malformed canonical confidence policy: block workflow readiness; do not substitute a
  fallback policy (`GET /ready` returns 503/not ready). Unexpected runtime confidence
  failure returns `confidence_policy_failed` in a typed review response.
- Agent 2 failure: return the validated Agent 1 output with
  `questions_status=degraded` and no generated plan.
- MCP read failure: do not invent job criteria; fail closed to `review_required`.
- Persistence failure: return the validated result with a persistence warning
  while retaining the request ID for an explicit retry policy.
- Never turn infrastructure failure into fabricated candidate information.

## Observability

The code instruments selected boundaries across:

- Next.js request handling.
- Document-processor request.
- OCR extraction.
- Embedding generation.
- Agent 1 evaluation.
- MCP role-criteria calls.
- Agent 2 question generation.

There are not yet dedicated spans for every deterministic validation node or the
Phase 4 persistence writer, and no deployed distributed trace was verified. Phase 5
places the coverage score, hard-failure flag, policy version/hash, and shadow marker on
the invocation trace. Phase 6 additionally stores the canonical confidence policy, ten
safe source signals, assessment, and final shadow disposition so the result can be
recomputed during authorized review. This is sensitive hiring metadata, not calibration.

Safe span attributes include:

- Request ID.
- Agent or tool name.
- Model name.
- Attempt number.
- Token usage.
- Duration.
- Output validation status.
- Retrieval result count.
- Embedding dimension.

Do not attach:

- Resume text.
- Names, email addresses, or phone numbers.
- Prompts or model responses.
- Database keys or credentials.

## Cloud deployment and security

The repository is configured and packaged for this direction; no live deployment was
verified:

- Next.js is the application and API layer.
- Python document processing and the LangGraph workflow run as independently deployable
  services on Google Cloud Run.
- GitHub Actions uses Workload Identity Federation.
- GitHub obtains a short-lived OIDC token.
- Google Cloud validates repository identity and permits service-account
  impersonation.
- Long-lived service-account JSON keys are not stored in the repository.
- Runtime secrets are supplied through environment configuration or Secret
  Manager.
- The FastMCP server runs privately as a stdio subprocess inside the LangGraph service.

Benefits:

- Narrow service responsibilities.
- Independent scaling and deployment.
- Reduced credential exposure.
- Private MCP transport with no additional public port.
- Clear trace boundaries.

Trade-offs:

- More services and contracts to maintain.
- Cross-language TypeScript and Python schemas must stay aligned.
- Two LLM agents increase latency and model cost.
- LangGraph, LangChain, FastAPI, and FastMCP add framework and version-management overhead.

## Why two agents instead of one

Benefits:

- Agent 1 specializes in evidence-based evaluation and role comparison.
- Agent 2 specializes in converting verified uncertainty into questions.
- Each agent has a smaller prompt and a narrower output schema.
- Each stage can be evaluated independently.
- Agent 2 cannot silently influence Agent 1's recommendation when contracts are
  enforced.
- Agent 2 receives less PII and less raw untrusted resume content.
- Failure of question generation does not destroy a valid evaluation.

Trade-offs:

- Additional model latency and cost.
- More orchestration and validation code.
- More failure states.
- Shared-state contracts must be versioned.
- For very simple criteria, deterministic application code may be better than a
  second LLM agent.

## Why LangGraph, LangChain, FastAPI, and FastMCP

### LangGraph and LangChain

Chosen for:

- Explicit typed state and inspectable graph routing.
- Clear separation between deterministic nodes and model-powered nodes.
- Bounded tool loops and node-level retries.
- Gemini structured output through LangChain's provider adapter.
- Reuse of TeamFlow's FastMCP server through the LangChain MCP adapter.
- Testable trajectories and dependency injection at node boundaries.

Trade-off:

- Framework dependencies and additional operational complexity. A simple pair
  of model calls should stay ordinary application code until branching,
  recovery, or inspection makes the graph valuable.

### FastAPI

Chosen for:

- Python-native asynchronous HTTP services.
- Typed validation.
- File uploads and status codes.
- Automatic OpenAPI documentation.
- Straightforward Cloud Run deployment.
- Easy observability instrumentation.

Trade-off:

- Separate Python service contracts alongside the TypeScript application.

### FastMCP

Chosen for:

- Fast creation of typed MCP tools from Python functions.
- Standard tool discovery and invocation.
- Private stdio operation.
- Compatibility with LangChain's MCP adapters.
- Reusable, domain-specific tool boundary.

Trade-off:

- Additional protocol, subprocess, and tool-contract maintenance.

If there were only one in-process consumer, direct typed Python functions would
be simpler. FastMCP is justified when tool reuse, process isolation,
interoperability, and least-privilege boundaries matter.

## Evaluation strategy

Evaluate each stage separately.

### OCR evaluation

- Representative digital, scanned, rotated, blurry, and multi-column resumes.
- Known expected names, employers, job titles, dates, and certifications.
- Character and word error rates where full ground truth is available.
- Critical-field preservation rate.
- Never update a golden baseline merely to make a failing test pass.

### Retrieval evaluation

- Labeled search queries with known relevant candidates or role criteria.
- Recall@K.
- Precision@K.
- Mean reciprocal rank.
- Missing-qualified-candidate rate.
- Hybrid versus vector-only comparison.

### Agent 1 evaluation

- Criterion-level evidence accuracy.
- Unsupported-point rate.
- Role-ranking accuracy.
- Score consistency across equivalent resumes.
- Prompt-injection resistance.
- Protected-attribute invariance tests.

### Agent 2 evaluation

- Percentage of questions linked to real Agent 1 gaps.
- Duplicate-question rate.
- Already-answered-question rate.
- Protected or irrelevant question rate.
- Human reviewer usefulness rating.

### End-to-end evaluation

- Correct workflow trajectory.
- Schema-validation success rate.
- Groundedness.
- Manual correction rate.
- Latency and token cost.
- Percentage routed to manual review.

## Current repository versus remaining work

### Implemented or substantially present

- Next.js resume upload route.
- FastAPI document processor.
- Deterministic digital-PDF extraction plus bounded Gemini fallback for scanned,
  mixed, and image documents.
- Separate Gemini embedding call.
- 768-dimensional pgvector storage.
- Retrieval query/document task-type separation.
- HNSW cosine-similarity search.
- Schema-constrained scoring and runtime validation.
- Bounded retry and conservative fallback.
- Custom FastMCP server with TeamFlow-specific Supabase tools.
- LangGraph service connected to FastMCP over stdio through LangChain.
- Review/search operation separation so résumé text cannot broaden candidate access.
- Tenant-scoped candidate/job reads and writes at both graph and MCP boundaries.
- Gemini safety settings, deterministic PII redaction, strict bounded output, and typed
  complete/degraded/refused execution status.
- Primary/fallback model budget, per-model and workflow deadlines, concurrency bulkhead,
  and fail-closed required-context handling.
- Final structured validation before any guarded persistence attempt.
- Strict, shared Pydantic/Zod v1 contracts for criterion evidence, deterministic role
  matches, question plans, and diagnostic confidence.
- A canonical, versioned, content-hashed confidence policy that runs inside the graph
  in threshold-free shadow mode. Its number is weighted known-criterion coverage;
  nine zero-weight completion, integrity, and safety gates can require review. The
  coverage score does not accept, reject, or route candidates.
- A pre-score structural gate for the same normalized criterion ID plus configured text
  receiving opposing `met`/`not_met` statuses. This is not semantic contradiction
  detection.
- Validation-only risk/coverage tooling that requires an exact manifest-bound validation
  population, recomputes policy assessments from supplied cached signals, groups ties,
  and excludes hard failures. Unsigned artifacts do not attest to their producer.
  Fixture-only labels test mechanics; no real observation run, human-approved labels, or
  measured curve exists.
- Dataset `resume_review_v1` v1.1.0 with 30 validation, 20 byte-unchanged locked test, and
  15 adversarial synthetic cases. All 65 expected behaviors remain pending human review.
- An offline diagnostic judge for groundedness, criterion relevance, and internal
  consistency. Its bounded Gemini adapter, closed result/failure contracts, and immutable
  content-free caches are locally covered with fixtures and test transports; no live call
  or provider output is claimed.
- An offline comparable semantic-regression gate that verifies the exact validation
  population, immutable baseline and run identities, human-label bindings, class balance,
  agreement/kappa denominators, and non-offsetting failure conditions. Fixture labels can
  test the mechanics but can never produce evidence or a passing human gate.
- Pure application logic that scores configured weighted criteria, derives gaps, ranks
  roles deterministically, and constructs a least-privilege Agent 2 handoff.
- A separate executable LangGraph résumé-review workflow with Agent 1 classifications,
  literal evidence validation, application-owned score math, and Agent 2 question
  planning.
- A versioned internal FastAPI endpoint and disabled-by-default private Next.js adapter.
- Exact selection of two read-only tools from the shared six-tool FastMCP surface for
  tenant-scoped document snapshots and at most five configured active role policies.
- Insert-only snapshot, candidate-document link, policy-snapshot, and review-run SQL,
  plus a local/demo policy seed. The SQL is exercised on disposable PostgreSQL 16 and
  Supabase PostgreSQL 17 instances, not a hosted project.
- OpenTelemetry instrumentation.
- Cloud Run deployment structure.
- Workload Identity Federation deployment authentication.

### Still proposed after the Phase 7 tooling slice

- A live manager session/UI and a production policy-approval flow.
- A UI caller for the private combined evaluation/question-plan API.
- Independent, adjudicated human labels for the complete 30-case validation split, with at
  least 15 resolved overall passes and 15 resolved overall failures.
- Live-provider baseline and candidate judge caches, measured semantic agreement, kappa,
  false-accept, false-reject, and judge-error rates, and a calibrated narrow judge.
- Human-labeled risk/coverage measurement and any separately governed routing threshold.
- Reviewer assignment/claim leases, notifications, stale/failure sweepers, and a
  production retention/backup process around the durable backend queue.
- Human/legal evaluation and governance for the current application-owned question
  template library.
- Formal bias and protected-attribute invariance testing.

## Concise interview narrative

Use this answer when asked for a high-level explanation:

> TeamFlow uses a bounded document and agent pipeline. A FastAPI document
> processor validates the upload and uses deterministic PDF text when every page
> is usable; scanned, mixed, or image documents use Gemini transcription. It then
> makes a separate embedding call for semantic retrieval. A separate private
> résumé-review API runs a real two-agent LangGraph: an evaluation node followed by a
> gap-question node. The application retrieves configured job criteria through our
> custom read-only FastMCP boundary, then Agent 1 classifies each criterion with literal
> source references. Application code—not Gemini—applies the configured weights, ranks the roles, and selects the
> best-supported position. A deterministic validation gate checks the schema,
> score math, role IDs, and quote membership before Agent 2 runs. Agent 2 receives
> only the validated gaps through
> typed graph state and generates a small set of job-related follow-up questions. The
> application validates and combines both outputs in a versioned API response. There is
> also a deterministic policy running privately in shadow mode. Its numeric value is
> weighted known-criterion coverage, while nine separate zero-weight integrity and safety
> gates can require review. The coverage value is not a probability, is not calibrated,
> and never accepts, rejects, or routes a candidate.
> There is not yet a UI caller or live-provider integration proof. FastAPI is the HTTP boundary, LangGraph manages sequencing and state, LangChain
> provides the Gemini and MCP adapters, and FastMCP is
> the least-privilege data boundary to Supabase. Literal quote checks are not semantic
> entailment. A separate feature-gated lifecycle now pauses on a PostgreSQL checkpoint,
> exposes an authenticated pending-review API, and applies idempotent human decisions
> atomically; that backend has local PostgreSQL restart evidence but no reviewer UI or
> deployment proof. Offline semantic-judge and comparable-regression mechanics now exist,
> but only fixture and test-transport behavior has been exercised. The next evidence step
> is independent human review of the complete 30-case validation split and comparable live
> judge runs—not production decision automation.

## Instructions for an AI answering questions from this context

- Answer directly and at an interview-appropriate level.
- Use the implemented Phase 4 scenario when the question says "Agent 1,"
  "Agent 2," "the workflow," or "the architecture."
- Distinguish locally tested implementation from unverified deployment when asked whether
  something is already built.
- Do not invent benchmark results, production scale, compliance certification,
  bias-audit completion, or customer usage.
- Do not expose personal contact information from the resume.
- Explain trade-offs rather than claiming that one framework is always best.
- State that the final hiring decision remains human.
- State that embedding retrieval supports evidence discovery but is not itself
  a hiring decision.
- State that Agent 2 generates questions but does not alter Agent 1's score.
- Describe the Phase 5 number as weighted known-criterion coverage, not a generic
  confidence score, probability, calibration result, or independent multi-signal blend.
- Distinguish numeric route independence from the nine explicit hard gates, which can
  require review. Describe the conflict gate only as the same normalized criterion and
  configured text receiving opposing statuses—not semantic contradiction detection.
- Do not claim a real risk/coverage curve or human-approved label set. The current corpus
  is pending review and fixture labels establish tooling behavior only. Hashes and
  unsigned manifests do not prove that an authentic runtime produced cached signals.
- State that confidence provenance is sensitive and durably recomputable in the Phase 6
  review record, while its numeric value remains shadow-only and uncalibrated.
- State that LangGraph passes Agent 1 output to Agent 2 through typed state; MCP is
  used for controlled external tools.
- State that TeamFlow uses a custom FastMCP server wrapping Supabase, not the
  general Supabase MCP server.
- If information is not covered here, say what assumption would be required
  instead of fabricating an answer.
