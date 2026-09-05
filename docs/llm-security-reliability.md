# LLM security and reliability

TeamFlow treats Gemini as an untrusted decision-support component. Service
authentication, server-owned tenant scoping, tool selection, write eligibility, output
status, and database predicates are enforced by application code rather than prompts.
The feature-gated v2 review path also verifies a reviewer bearer and derives tenant scope
from current database membership; no live deployment of that boundary is claimed.

## Trust boundaries

1. `/api/parser/agent` is disabled by default and requires
   `X-Hiring-Agent-Access-Token` when enabled.
2. The browser cannot supply `merchantId`. Next.js derives the current demo tenant from
   server-side `DEMO_MERCHANT_ID` and sends it to Cloud Run with a separate service token.
3. The Python service strictly validates UUIDs, operation mode, and JSON size/depth
   before compiling a graph invocation.
4. Every FastMCP candidate/job read filters by both resource ID and merchant ID. The
   Supabase service key remains server-only.
5. Candidate review binds no cross-candidate search tools. Search must be requested with
   `operation=search_candidates`, and the graph overwrites model-supplied tenant values.
6. `update_fit_score` is not registered with FastMCP. Even a complete legacy explicit
   write request is rejected deterministically without a tool invocation or DB PATCH.

The separate Phase 4 résumé-review boundary is narrower:

1. `/api/parser/review` is also disabled by default and protected by the private route
   token. It accepts only required `schemaVersion`, `documentId`, and optional
   `candidateId`; Next.js injects tenant
   and persistence settings.
2. The workflow loads a tenant-bound extraction snapshot, additionally enforces its
   candidate link when `candidateId` is supplied, and loads at most five configured role
   policies by selecting exactly two read-only tools from the shared six-tool FastMCP
   server.
3. Neither Agent 1 nor Agent 2 receives a model-selectable tool. Agent 1 cannot emit a
   score or recommendation; Agent 2 cannot see résumé text, evidence, score, or ranking.
4. Application code verifies literal quote membership, rejects narrow explicit
   criterion negations, calculates scores, derives gaps, and builds the only accepted
   question wording. Agent 2 must reproduce that required output exactly. Optional
   persistence is insert-only and does not update candidate fit scores.

The additive Phase 6 human-review boundary narrows write authority further:

1. Next.js and FastAPI require both the private service credential and a strict end-user
   bearer. Supabase Auth supplies only the user identity; PostgreSQL derives exactly one
   active membership and never accepts a tenant or actor from the body.
2. Owners/managers may start a review. Owners/managers/reviewers may list pending work,
   inspect an allowlisted source-validated proposal, and submit a decision. Wrong-tenant
   runs are indistinguishable from missing runs.
3. The durable LangGraph checkpoints only opaque IDs, hashes, versions, statuses, and
   reason codes. Private analysis state, evidence excerpts, prompts, vectors, document
   text, and bearer credentials are not checkpointed.
4. Approve, edited approve, and reject use immutable decision IDs and optimistic
   versions. Edited classifications/evidence are revalidated and deterministically
   rescored; the caller cannot submit a numeric score. Candidate updates, revisions,
   decisions, and events commit atomically, and exact replay produces no duplicate write.
5. PostgreSQL stores the canonical confidence policy and ten safe source signals with
   the assessment/final shadow record. Reads recompute the formula and preserve
   `is_probability=false` and `threshold_applied=false`; the number never authorizes an
   automatic candidate decision.

## Legacy `/invoke` model controls

- Retrieved records are delimited as untrusted data and cannot change graph policy.
- Gemini harassment, hate-speech, sexual, and dangerous-content filters use
  `BLOCK_MEDIUM_AND_ABOVE`.
- Unknown model fields, protected-characteristic evidence, empty output, malformed tool
  calls, truncation, and invalid structured JSON are rejected.
- The final analysis has bounded evidence, gaps, limitations, and confidence fields.
- Email addresses, phone numbers, secrets, and sensitive analysis keys are removed by a
  deterministic output filter. Raw prompts, résumés, model responses, and tool payloads
  are not logged.
- A safety refusal is never retried with the fallback model. It returns
  `status=refused`, `fit_score=null`, and `write_status=skipped`.

## Legacy `/invoke` failure behavior

| Failure | Behavior |
|---|---|
| Candidate/job missing, wrong tenant, or unavailable | Skip both model calls and writes; return a degraded result without a score |
| Invalid or truncated model output | Retry once, then return a degraded human-review result |
| Safety refusal | Do not retry or fail over; return a refused result and skip writes |
| Fast transient primary-model transport/429/5xx failure | Try the configured fallback model once; a call that consumes the full node deadline fails closed without guaranteed fallback budget |
| Search tool failure | Preserve a warning; never represent the search as successful |
| Legacy score mutation requested | Return `write_status=failed` and `fit_score=null`; invoke no write tool |
| Workflow exceeds 45 seconds | Cancel downstream work and return HTTP 504 |
| Process capacity is exhausted | Return HTTP 429 with `Retry-After` |

For Phase 4, Agent 1 failure returns `review_required` with no evaluation, questions,
or write. Agent 2 failure preserves validated Agent 1 output and marks questions
degraded. Obvious résumé instructions and unsafe generated text are routed or rejected,
but phrase filters are defense in depth—not prompt-injection immunity. Conservative
lexical checks reject unrelated evidence and simple contradictions such as "no espresso
experience." Criterion-overlapping verdict text such as "experience satisfied" is also
rejected rather than treated as proof; this can produce safe false-positive reviews.
Literal membership plus term overlap still does not establish general semantic
entailment. A positive leader with no more met weight than combined negative
and unresolved weight is routed to human review without using the shadow numeric score
as a threshold.

The timeout chain is model node ≤12 seconds, service workflow ≤45 seconds, Next.js
client ≤50 seconds, and Cloud Run/route ≤60 seconds. Cloud Run concurrency and the
application bulkhead are both initially four because each invocation owns one private
MCP subprocess.

## Important remaining boundary

The production-disabled legacy UI routes still use one fixed demo merchant and are not a
multi-user authorization path. Phase 6 adds the separate membership-backed backend and
local cross-tenant PostgreSQL tests, but no browser reviewer UI or live Supabase Auth
session has exercised it. Users with more than one active merchant membership fail
closed until a trusted tenant-selection context exists. The shared pending queue has no
assignment/claim lease, notification, or SLA ownership, and there is no stale/failure
sweeper. Exact evidence excerpts can contain names or addresses even after selected
contact/protected/secret patterns are rejected, so reviewer output is not PII-free.

The checked-in deployment workflow sets `AGENT_ALLOW_WRITES=false` for optional Phase 4
review-result persistence. That flag cannot re-enable retired MCP candidate-score writes;
live deployment state remains unverified.
`RESUME_REVIEW_STORE_DOCUMENTS` and `RESUME_REVIEW_PERSIST_RESULTS` also remain false by
default. `TEAMFLOW_HITL_ENABLED=false` keeps v2 disabled until dedicated database roles,
both PostgreSQL schemas, secrets, and a staging smoke test exist. No live Supabase Auth,
FastMCP subprocess, Gemini call, or Cloud Run review request has been verified.
