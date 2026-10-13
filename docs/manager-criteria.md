# Manager-approved additional criteria

Smart Search offers a separate **Draft criteria → review weights → approve and assess** workflow. Search alone does not change scores. This is decision support, not a hiring decision, and managers should confirm unknown evidence with candidates.

The browser sends only a role, up to twenty candidate IDs and a job-related manager request. It never supplies base scores, résumé text, tenant IDs, provider tokens or tool permissions. A server-signed, 15-minute proposal binds the candidate/role/workspace scope, criterion wording, base scores and canonical document snapshots. Managers may adjust proposed weights (positive integers totaling 100) and the added-criteria share (1–50%). A wording change requires a fresh proposal.

After approval, met criteria earn their full weight; not-met and unknown criteria earn zero. Unknown is explicitly distinguished from evidence-backed not-met. The server recalculates:

`combined = round(base × (100 − added share) / 100 + additional × added share / 100)`

An unavailable approved base stays null; it is never replaced by zero. Original approved scores and policies are never overwritten. Results are session-only and are not written to candidates, role policies, browser storage or a durable approval ledger.

## Sample versus connected mode

- Sample mode is public and uses only the fixed fictional corpus. Drafting uses an explicit supported job-skill catalog, not an LLM. Literal fictional passages support each match. The UI labels these illustrative scores and asks managers to check whether the draft captures their whole request.
- Connected mode remains behind `TEAMFLOW_ENABLE_LEGACY_DEMO_ROUTES=true` **and** `NODE_ENV=development|test`. It is not a production authorization mechanism. The server injects `DEMO_MERCHANT_ID`; callers cannot select another tenant. Production connected usage requires an authenticated manager/tenant boundary and a durable approval design before enabling it.
- Connected candidates require a current role association, validated approved base projection (or a null base), and exactly one immutable linked canonical résumé. Missing or ambiguous links fail explicitly. The loader scopes every read by merchant; it never uses arbitrary browser document IDs.
- Agent 1's private `/v1/manager-criteria/propose` and `/evaluate` endpoints use the existing `HIRING_AGENT_URL`, exact `HIRING_AGENT_TRUSTED_ORIGIN`, and `HIRING_AGENT_TOKEN` (`X-Agent-Token`). They retain existing tenant-scoped, read-only MCP document/policy access. No unrestricted shell, write, external-profile enrichment or unrelated MCP access is granted.
- The Next adapter independently checks literal citations, candidate and criterion scope, and additional-score arithmetic. It reloads snapshots before and after evaluation and rejects stale approvals.

## Runtime configuration and limits

Set `MANAGER_CRITERIA_SIGNING_SECRET` to a dedicated random secret of 32–512 characters, identical across Next instances. It is **required in production**, including public sample mode, and is never exposed to the browser. Do not reuse a database or model credential. Without it, development/test uses a per-process random key; restarting or hot-reloading the server may require a fresh proposal. Rotating the key invalidates all pending proposals.

The public adapter requires a same-origin request, limits JSON bodies to 24 KiB with a three-second read deadline, and uses a process-local 20-request/minute client limiter. The private service call has a 49-second deadline, propagates browser cancellation, and has a 2 MiB response cap. Database reads are bounded to the selected candidates and have a five-second abort signal. The route duration budget is 70 seconds, including both snapshot reads. Horizontal production operation should replace the process-local rate limiter with a trusted shared/edge limiter. The endpoint never logs manager text, candidate names, résumé passages or credentials.

The current connected assessment uses canonical résumé evidence only. Application completeness is displayed separately, not silently added as a qualification score, and application answers are not supplied to Agent 1 by this flow.

## Verification

`node --test --experimental-strip-types tests/unit/manager-criteria.test.ts tests/unit/manager-criteria-loading.test.ts`

These tests cover explicit approval, tampering/expiry/scope, protected-trait and injection rejection, unknown evidence, score math, origin/framing/deadlines, private service trust, canonical snapshot integrity and tenant-scoped database reads. Python service tests exercise the live Agent 1 boundary separately with deterministic provider fixtures.
