# Public semantic-search demo

The production entry point is a fictional small-business hiring workspace at
[https://team-floww.vercel.app/](https://team-floww.vercel.app/). It lets the owner of
Cocoa Bakery describe an open shift in everyday language and returns an ordered list of
fictional profiles with two literal résumé-block citations per result. After retrieving
up to five profiles, the backend reranks those profiles with a bounded, query-specific evidence
score. That 0–100 number describes relevance to the current query, not candidate fitness.

## Recommended three-minute walkthrough

1. Open the production URL and point out **Cocoa Bakery**, the three open sample roles,
   and the always-visible **Demo · fictional applicants** label.
2. Select **Barista**, open **Smart Search**, and search for
   `Weekend barista who knows latte art`. Leo appears before Noah because Leo's profile
   and quotations document coffee experience, latte art, and Saturday shifts; Noah's
   first-cafe-role aspiration does not establish coffee experience.
3. Review the exact résumé quotations beside the first result. Each quotation is copied
   from the canonical synthetic source block identified beside it; the API checks
   literal membership before returning the response.
4. Treat the query-match score only as a navigation aid for this search. It is an
   uncalibrated blend of retrieval relevance and recognized job-concept coverage in the
   result's visible profile fields and citations. It is recomputed for every query and
   is not a fit score, pass line, or recommendation.
5. Review the quoted evidence and topic labels. The board and search share the same
   eight canonical fictional profiles. Search respects the selected role, visible
   board filters, and removed sample profiles; the scope and count appear above it.
   An empty role or filtered board yields no results. Browser-local demo edits persist
   in that browser and do not contact or change real applicants.
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
  -> restrict canonical corpus by optional role and visible fictional-profile IDs
  -> cosine retrieval across the scoped canonical blocks
  -> choose up to two citations to cover query concepts; break ties by quote coverage and cosine
  -> require positive concept evidence, or literal token overlap for an unrecognized query
  -> select up to 5 using each profile's 75/25 cited-block aggregate
  -> deterministic evidence-coverage rescore and rerank of those profiles
  -> literal citation-membership assertion
  -> strict response and content-derived scoring validation
  -> up to 5 ranked profiles with 2 citations each; no evidence can yield zero results
  -> human review; no status or score mutation
```

The public route is `POST /api/demo/search` with a strict JSON body:

```json
{"query":"Weekend barista who knows latte art","roleId":"barista","candidateRefs":["SYN-CAND-002","SYN-CAND-007"]}
```

`roleId` and `candidateRefs` are optional, so query-only callers retain an all-corpus
search. Provided filters intersect the server-owned corpus and never supply profile
content. An explicit empty `candidateRefs` array means an empty scope. Unknown role
IDs return an empty scope; empty role strings and unknown profile IDs are rejected.
`corpus_size` reports the scoped count before the relevance filter.

Successful responses identify the model, dimensions, retrieval task types, corpus,
metric, `query_covering_two_blocks_75_25` candidate aggregation,
`positive_concept_or_token_overlap` relevance filter, result count, request ID, latency,
warnings, and `no_hiring_decision` status. The separate strict `scoring` metadata fixes
the method to `query_evidence_rescore_v2`, the scope to the retrieval top five and
returned evidence, the weights to 35% retrieval and 65% concept coverage, and both
`calibrated` and `threshold_applied` to `false`.

Every result includes `weighted_evidence_similarity`, `query_concepts_recognized`,
`query_concepts_matched`, `query_concept_coverage`, and the integer
`query_match_score`. Recognized concepts come from a bounded, job-relevant vocabulary.
A concept counts as matched only when one of its terms appears in a positive assertion
in the result's returned headline, skills, evidence-topic labels, or literal citation
text. Evidence clauses containing explicit negation or aspiration are conservatively
excluded; an entry-level aspiration may establish entry-level intent, but not a skill.
This lexical rule is not a complete language-understanding system. Query intent such
as “I want a barista” is not treated as negative evidence. Milk texture and drink
presentation are not aliases for latte art. The contract requires:

```text
coverage = round(100 * matched / recognized)
score    = round(0.35 * clamp(similarity, 0, 1) * 100 + 0.65 * coverage)
```

When the query contains no recognized concept, a result needs a positive literal
non-stop-word overlap and its score is `round(clamp(similarity, 0, 1) * 100)`.
Unrelated queries do not receive profiles from hash collisions. This is a relevance
filter, not an applicant acceptance threshold. Results are reranked by score, then retrieval
similarity, then stable fictional candidate ID. In addition to arithmetic schema checks,
the route recomputes concept counts and scores from the submitted query and returned
evidence, so internally consistent but invented scoring signals are rejected. Profile
fields, topics, and citations are checked against the canonical corpus; the route also
rejects responses outside the requested role/profile subset.
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
- A deterministic and always visibly labeled `teamflow-concept-vector-v2` fallback
  when it is not, with the actual off/unavailable reason from the response
- Block-level cosine retrieval and a documented 75/25 aggregation of the two selected
  evidence blocks; citation selection maximizes visible concept coverage, then literal
  quote coverage, then similarity, without an applicant acceptance threshold
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
