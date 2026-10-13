# Migrating candidate embeddings to 3,072 dimensions

TeamFlow uses `gemini-embedding-001` with 3,072 output dimensions for document and query embeddings. The candidate column is `halfvec(3072)` so its cosine HNSW index fits pgvector's supported index dimensions. Half precision retains all 3,072 components with lower precision per component. Existing 768-dimensional vectors cannot be expanded into equivalent 3,072-dimensional embeddings; they must be regenerated from the stored resume text. See [Google's embedding documentation](https://ai.google.dev/gemini-api/docs/embeddings) and [Supabase's vector index limits](https://supabase.com/docs/guides/ai/vector-indexes).

## Coordinated rollout

1. Schedule a maintenance window for resume ingestion and semantic candidate search. Stop the old document processor and query clients before the database change: their 768-dimensional inputs are incompatible with the new column and search signatures.
2. Apply `supabase/migrations/20261013135916_gemini_embedding_3072.sql` through the project's normal migration deployment process. The migration preserves the old column as `embedding_768`, creates an empty `embedding halfvec(3072)`, replaces the search functions and index, and adds the service-role-only backfill RPC. Historical migrations remain unchanged.
3. Deploy the updated document processor, hiring agent, and web application together so all embedding producers and consumers request 3,072 values. Keep the maintenance window active while backfilling: candidates without new vectors are absent from semantic results.
4. Run the read-only inventory below, then run bounded backfill batches. Check each JSON summary and resolve errors before continuing. The script itself does not deploy or apply migrations.
5. Verify coverage and a representative tenant-scoped search, then resume normal traffic. Preserve `embedding_768` until the rollback window has closed.

## Inventory and backfill

Use Node 22 from the repository root. Export `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`) in the operator environment. Applying requires `GOOGLE_API_KEY` too. The admin key belongs only in a trusted operator environment. The script does not load `.env` files automatically; Node's `--env-file=.env.local` can load an existing local file when appropriate.

By default the command reads up to 100 pending candidates and makes no Gemini calls or database writes:

```bash
node --experimental-strip-types scripts/backfill-candidate-embeddings.ts --limit=100
```

After reviewing that inventory, generate and save a bounded batch:

```bash
node --experimental-strip-types scripts/backfill-candidate-embeddings.ts --apply --limit=100
```

The default reads 20 rows per page, processes one embedding at a time, and waits 1 second between provider calls. Every HTTP request has a 30-second deadline and a response size limit. There are no automatic retries. `--limit` bounds scanned rows and therefore provider calls; its maximum is 10,000. Use `--batch-size=1` through `50` or `--delay-ms=0` through `60000` to adjust throughput. `--merchant-id=UUID` scopes the inventory and backfill to one merchant.

The summary contains counts, `stopReason`, and `resumeAfter`; it never prints resumes, vectors, provider error bodies, or credentials. If `stopReason` is `limit`, continue with the returned cursor, retaining the same merchant filter if used:

```bash
node --experimental-strip-types scripts/backfill-candidate-embeddings.ts --apply --limit=100 --after=RETURNED_UUID
```

`resumeAfter` is the last completed or skipped row. On a failure the script exits with code 1 and leaves the failed row before that cursor advances, so retrying from that cursor includes it. Completed rows have a non-null embedding and are skipped automatically, including after an uncertain write response or interrupted process. Restarting from the beginning is also safe. Always finish with a new scan from the beginning to catch concurrent changes or inserts whose UUID sorts before a previous cursor.

The script embeds the first 8,000 Unicode codepoints of `candidates.resume_text`, preserving whitespace and using the same prefix as the document processor. It does not re-run OCR or modify resume text. Null or whitespace-only text is counted as `skippedEmpty`; long text increments `truncated`. The database update succeeds only while the candidate still has a null embedding and its complete stored text matches the text read for that attempt. Concurrent edits, deletions, or another worker completing the vector increment `conflicts`; re-scan from the beginning to retry candidates whose text changed. Existing non-null embeddings are never overwritten.

## Verification and recovery

Check coverage using the database's administrative SQL interface:

```sql
set search_path = pg_catalog, extensions, public;

select
  count(*) as candidates,
  count(*) filter (where embedding is not null) as embedded_3072,
  count(*) filter (
    where embedding is null and resume_text is not null
      and resume_text ~ '[^[:space:]]'
  ) as pending_with_text,
  count(*) filter (
    where embedding is null
      and (resume_text is null or resume_text !~ '[^[:space:]]')
  ) as missing_text
from public.candidates;

select vector_dims(embedding) as dimensions, count(*)
from public.candidates
where embedding is not null
group by 1;
```

The only populated dimension should be 3,072; `pending_with_text` should reach zero after the final scan. If your vector extension lives outside `public` or `extensions`, add its schema to this administrative search path. Candidates without stored text require normal resume extraction before semantic retrieval can include them. A completed scan containing only `skippedEmpty` candidates is expected when those rows remain.

Run a tenant-scoped search against the updated hiring agent with known candidates and confirm its scores and ordering are reasonable. Offline backfill tests exercise preprocessing, bounded requests, restart behavior, and conditional writes:

```bash
node --test --experimental-strip-types tests/unit/embedding-backfill.test.ts
```

If rollback is necessary, keep ingestion and search paused. Restore the matching prior application releases and database search signatures, index, and grants as one coordinated change. The preserved `embedding_768` column provides the original vectors; do not cast or truncate new vectors to fabricate replacements. Candidates created after the migration need fresh 768-dimensional embeddings before an old deployment can retrieve them. Retain the new vectors until recovery is verified, and review the rollback SQL against the live schema before applying it.
