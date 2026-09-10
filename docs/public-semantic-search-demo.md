# Public semantic-search demo

The production entry point is a fictional small-business hiring workspace at
[https://team-floww.vercel.app/](https://team-floww.vercel.app/). It lets the owner of
Cocoa Bakery describe an open shift in everyday language and returns an ordered list of
fictional profiles with two literal résumé-block citations per result.

## Recommended three-minute walkthrough

1. Open the production URL and point out **Cocoa Bakery**, the three open sample roles,
   and the always-visible **Demo · fictional applicants** label.
2. Search for `Barista who can train new team members and open on weekends`.
3. Review the exact résumé quotations beside the first result. Each quotation is copied
   from the canonical synthetic source block identified beside it; the API checks
   literal membership before returning the response.
4. If technical detail is useful, open **Technical search numbers**. Each citation has a
   raw block cosine similarity. The candidate-level number is a deterministic evidence
   aggregate: 75% of the highest block cosine plus 25% of the second-highest. Neither
   number is a fit score or hiring recommendation.
5. Point to the runtime badge:
   - **Live Gemini embeddings** means this request used `gemini-embedding-001`, 768
     dimensions, `RETRIEVAL_QUERY` for the query, and `RETRIEVAL_DOCUMENT` for the
     source blocks.
   - **Deterministic fallback** means the provider was unavailable and the request used
     the labeled, local concept-vector fallback. Do not describe that request as a live
     Gemini call.
6. Try `young barista with latte art` to show that this directly named sensitive-trait
   query is blocked without returning profiles. This lexical safeguard is not a complete
   classifier for every sensitive attribute, proxy, language, or obfuscation.
7. Open **About the demo, safety, and technical proof** only if the reviewer wants to
   distinguish this public retrieval demo from the protected hiring-agent implementation.

## Request flow

```text
Hiring-manager query
  -> same-origin browser guard and bounded request body
  -> job-related query safety checks
  -> Gemini retrieval embedding or visibly labeled deterministic fallback
  -> cosine ranking across 24 canonical blocks from 8 fictional profiles
  -> literal citation-membership assertion
  -> strict response validation
  -> 5 ranked profiles with 2 citations each
  -> human review; no status or score mutation
```

The public route is `POST /api/demo/search` with a strict JSON body:

```json
{"query":"Early-morning baker experienced in sourdough and recipe scaling"}
```

Successful responses identify the model, dimensions, retrieval task types, corpus,
metric, `top_two_blocks_75_25` candidate aggregation, result count, request ID, latency,
warnings, and `no_hiring_decision` status.
The route is non-cacheable, checks `Origin` and Fetch Metadata, validates content framing
and response shape, bounds body read time, and applies a best-effort per-instance
public-demo request limit. The browser-origin check is a CSRF guard, not authentication
or bot protection, and the in-memory counter is not a distributed rate limit. Operational
spans exclude query text, résumé quotations, contact details, prompts, and model output.

## Truth boundary

### Executed by the public production page

- Synthetic-only source-block retrieval
- Live Gemini embeddings only when a credential is available **and** the server-only
  `TEAMFLOW_PUBLIC_DEMO_LIVE_EMBEDDINGS=true` opt-in is set
- A deterministic and visibly labeled fallback when it is not
- Block-level cosine ranking and a disclosed 75/25 top-two evidence aggregation,
  without an acceptance threshold
- Stable fictional profile and source-block identifiers
- Literal evidence citations checked against canonical source text
- Input/output schema validation, bounded request handling, and safe operational spans

### Implemented elsewhere in the repository

- The separate Python LangGraph résumé-review workflow
- Read-only, tenant-scoped FastMCP tools
- Merchant-isolated pgvector candidate retrieval
- Confidence-policy routing and durable human-review controls
- Offline golden-set and judge diagnostics
- Cloud Run release workflows using GitHub OIDC/WIF configuration

Those private-service capabilities are not invoked by the public page. Repository code
or CI configuration alone is not proof that an external database, IAM binding, Cloud Run
revision, trace backend, or model-dependent path is live.

The public release keeps live provider calls disabled by default. Before enabling them,
configure provider quota/budget alerts and a durable edge rule for
`POST /api/demo/search`, stage that rule in log mode, inspect legitimate traffic, enforce
it on a preview, and have the Vercel project owner publish it. The local in-function
counter is only defense in depth. When live mode is enabled, the submitted query is sent
to Google for embedding, so the UI tells users to enter job criteria only and never
applicant data.

## Human accountability

- The **hiring manager** reviews original evidence, confirms job relevance, interviews
  consistently, and owns the employment decision.
- The **platform owner** controls access, approved criteria, model and prompt versions,
  evaluation gates, monitoring, incident response, and rollback.
- Retrieval similarity must never be presented as quality, qualification, calibrated
  confidence, or a recommendation to hire or reject.

## Verification commands

Before presenting the demo, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:journeys:production
```

Then verify the deployed page at desktop and mobile widths, exercise one allowed query
and one directly named sensitive-trait query, confirm the runtime badge matches the response metadata,
and inspect deployment/function logs before calling the current revision production-ready.
