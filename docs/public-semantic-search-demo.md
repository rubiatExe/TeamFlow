# Public semantic-search demo

The production entry point is a fictional small-business hiring workspace at
[https://team-floww.vercel.app/](https://team-floww.vercel.app/). It lets the owner of
Cocoa Bakery describe an open shift in everyday language and returns an ordered list of
fictional profiles with two literal résumé-block citations per result. After retrieving
five profiles, the backend reranks those five with a bounded, query-specific evidence
score. That 0–100 number describes relevance to the current query, not candidate fitness.

## Recommended three-minute walkthrough

1. Open the production URL and point out **Cocoa Bakery**, the three open sample roles,
   and the always-visible **Demo · fictional applicants** label.
2. Search for `Barista who can train new team members and open on weekends`.
3. Review the exact résumé quotations beside the first result. Each quotation is copied
   from the canonical synthetic source block identified beside it; the API checks
   literal membership before returning the response.
4. Treat the query-match score only as a navigation aid for this search. It is an
   uncalibrated blend of retrieval relevance and recognized job-concept coverage in the
   result's visible profile fields and citations. It is recomputed for every query and
   is not a fit score, pass line, or recommendation.
5. Use the **Manager review guide** to see how many quoted résumé examples support the
   result, then review the plain-language topic labels from those sections. The count
   organizes the visible evidence; it does not grade the person or measure how many
   requirements the applicant meets.
6. Point to the runtime badge:
   - **Google-powered matching** means this request used `gemini-embedding-001`, 768
     dimensions, `RETRIEVAL_QUERY` for the query, and `RETRIEVAL_DOCUMENT` for the
     source blocks.
   - **Built-in demo matching** means Google-powered matching was unavailable or disabled
     and the request used the labeled, local concept-vector fallback. Do not describe
     that request as a live Gemini call.
7. Try `young barista with latte art` to show that this directly named sensitive-trait
   query is blocked without returning profiles. This lexical safeguard is not a complete
   classifier for every sensitive attribute, proxy, language, or obfuscation.
8. If a technical reviewer asks about implementation, use this document and the
   repository rather than adding architecture details to the bakery-owner workflow.

## Request flow

```text
Hiring-manager query
  -> same-origin browser guard and bounded request body
  -> job-related query safety checks
  -> Gemini retrieval embedding or visibly labeled deterministic fallback
  -> cosine retrieval across 24 canonical blocks from 8 fictional profiles
  -> select the retrieval top 5 using each profile's 75/25 cited-block aggregate
  -> deterministic evidence-coverage rescore and rerank of only those 5 profiles
  -> literal citation-membership assertion
  -> strict response and content-derived scoring validation
  -> 5 ranked profiles with 2 citations each
  -> human review; no status or score mutation
```

The public route is `POST /api/demo/search` with a strict JSON body:

```json
{"query":"Early-morning baker experienced in sourdough and recipe scaling"}
```

Successful responses identify the model, dimensions, retrieval task types, corpus,
metric, `top_two_blocks_75_25` candidate aggregation, result count, request ID, latency,
warnings, and `no_hiring_decision` status. The separate strict `scoring` metadata fixes
the method to `query_evidence_rescore_v1`, the scope to the retrieval top five and
returned evidence, the weights to 35% retrieval and 65% concept coverage, and both
`calibrated` and `threshold_applied` to `false`.

Every result includes `weighted_evidence_similarity`, `query_concepts_recognized`,
`query_concepts_matched`, `query_concept_coverage`, and the integer
`query_match_score`. Recognized concepts come from a bounded, job-relevant vocabulary.
A concept counts as matched only when one of its terms appears in the result's returned
headline, skills, evidence-topic labels, or literal citation text. The contract requires:

```text
coverage = round(100 * matched / recognized)
score    = round(0.35 * clamp(similarity, 0, 1) * 100 + 0.65 * coverage)
```

When the query contains no recognized concept, the documented fallback is
`round(clamp(similarity, 0, 1) * 100)`. Results are reranked by score, then retrieval
similarity, then stable fictional candidate ID. In addition to arithmetic schema checks,
the route recomputes concept counts and scores from the submitted query and returned
evidence, so internally consistent but invented scoring signals are rejected.
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
- Block-level cosine retrieval and a documented 75/25 top-two evidence aggregation,
  without an acceptance threshold
- A deterministic second-stage rerank of the retrieval top five using returned-evidence
  concept coverage plus retrieval relevance; identical normalized fallback queries
  reproduce it, while a changed query recomputes it
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
- Retrieval similarity, concept coverage, and query-match score must never be presented
  as quality, qualification, calibrated confidence, or a recommendation to hire or reject.
- Query-match scores are not comparable hiring grades. They can change with the query or
  retrieval mode and must remain paired with the evidence and active-mode disclosure.

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
