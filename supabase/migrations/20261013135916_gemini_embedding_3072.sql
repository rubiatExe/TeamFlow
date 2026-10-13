-- Upgrade Gemini embeddings without discarding the original 768-value vectors.
-- Pause candidate writes/search during deployment, apply this migration, deploy
-- 3072-value producers/consumers, then run the resumable embedding backfill.
-- Rows become searchable again as their new embedding is populated.
begin;

set local lock_timeout = '5s';
set local search_path = pg_catalog, extensions, public;

do $embedding_prerequisites$
begin
  if to_regtype('halfvec') is null
    or to_regprocedure('vector_dims(halfvec)') is null
    or to_regprocedure('l2_norm(halfvec)') is null
  then
    raise exception 'teamflow_embedding_requires_pgvector_0_7_or_later'
      using errcode = '42704',
        hint = 'Upgrade the vector extension to an available version with halfvec support.';
  end if;
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.candidates'::regclass
      and attname = 'embedding'
      and not attisdropped
      and atttypid = 'vector'::regtype
      and atttypmod = 768
  ) then
    raise exception 'teamflow_embedding_expected_768_column'
      using errcode = '42804';
  end if;
end
$embedding_prerequisites$;

-- No truncation, padding, or float conversion can recover the missing dimensions.
-- Retain the old column and index for a deliberate rollback until rollout completes.
alter table public.candidates rename column embedding to embedding_768;
alter index public.candidates_embedding_idx rename to candidates_embedding_768_idx;
alter table public.candidates add column embedding halfvec(3072);
comment on column public.candidates.embedding is
  'gemini-embedding-001, RETRIEVAL_DOCUMENT, 3072 dimensions; NULL until re-embedded.';
comment on column public.candidates.embedding_768 is
  'Retained pre-3072 embeddings for rollback; not used by current semantic search.';
create index candidates_embedding_idx on public.candidates
  using hnsw (embedding halfvec_cosine_ops);

-- Column grants follow a renamed column. Move the reader capability to the new
-- embedding while retaining the existing tenant policies and all other grants.
revoke select (embedding_768) on public.candidates from teamflow_hiring_reader;
grant select (embedding) on public.candidates to teamflow_hiring_reader;

-- The old vector signatures must be removed: two overloads with identical JSON
-- parameter names are ambiguous to PostgREST. Unexpected overloads fail closed.
drop function public.match_candidates(vector, uuid, double precision, integer);
drop function public.teamflow_match_candidates(vector, uuid, double precision, integer);
do $embedding_rpc_overloads$
begin
  if exists (
    select 1 from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in ('match_candidates', 'teamflow_match_candidates')
  ) then
    raise exception 'teamflow_embedding_unexpected_rpc_overload'
      using errcode = '42725';
  end if;
end
$embedding_rpc_overloads$;

create function public.match_candidates(
  query_embedding halfvec(3072),
  match_merchant_id uuid,
  match_threshold double precision default 0.5,
  match_count integer default 5
)
returns table (
  id uuid, name text, email text, status text, fit_score integer,
  summary text, similarity double precision
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, extensions, public
as $function$
begin
  -- PostgreSQL function arguments do not enforce the declared type modifier.
  if query_embedding is null or vector_dims(query_embedding) <> 3072
    or l2_norm(query_embedding) = 0
    or match_merchant_id is null
    or match_threshold is null or not match_threshold between 0 and 1
    or match_count is null or not match_count between 1 and 20
  then
    return;
  end if;

  return query
  select candidate.id, candidate.name, candidate.email, candidate.status,
    candidate.fit_score, candidate.summary,
    1 - (candidate.embedding <=> query_embedding) as similarity
  from public.candidates as candidate
  where candidate.merchant_id = match_merchant_id
    and candidate.embedding is not null
    and 1 - (candidate.embedding <=> query_embedding) > match_threshold
  order by candidate.embedding <=> query_embedding
  limit match_count;
end
$function$;

create function public.teamflow_match_candidates(
  candidate_query halfvec(3072),
  match_merchant_id uuid,
  match_threshold double precision default 0.5,
  match_count integer default 5
)
returns table (merchant_id uuid, similarity double precision)
language plpgsql
stable
security invoker
set search_path = pg_catalog, extensions, public
as $function$
begin
  if candidate_query is null or vector_dims(candidate_query) <> 3072
    or l2_norm(candidate_query) = 0
    or match_merchant_id is null
    or match_threshold is null or not match_threshold between 0 and 1
    or match_count is null or not match_count between 1 and 20
  then
    return;
  end if;

  return query
  select candidate.merchant_id,
    1 - (candidate.embedding <=> candidate_query) as similarity
  from public.candidates as candidate
  where match_merchant_id = (
      select case
        when claims ->> 'role' = 'teamflow_hiring_reader'
          and coalesce(claims ->> 'merchant_id', '') ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (claims ->> 'merchant_id')::uuid
        else null
      end
      from (
        select public.teamflow_request_jwt_claims() as claims
      ) as request_context
    )
    and candidate.merchant_id = match_merchant_id
    and candidate.embedding is not null
    and 1 - (candidate.embedding <=> candidate_query) > match_threshold
  order by candidate.embedding <=> candidate_query
  limit match_count;
end
$function$;

-- This compare-and-set keeps resume text out of REST URLs and avoids replacing a
-- concurrently uploaded embedding or embedding an obsolete resume snapshot.
create function public.complete_candidate_embedding_backfill(
  candidate_id uuid,
  expected_resume_text text,
  new_embedding halfvec(3072)
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, extensions, public
as $function$
begin
  if candidate_id is null or expected_resume_text is null
    or btrim(expected_resume_text) = ''
    or new_embedding is null or vector_dims(new_embedding) <> 3072
    or l2_norm(new_embedding) = 0
  then
    raise exception 'teamflow_embedding_invalid_backfill_input'
      using errcode = '22023';
  end if;

  update public.candidates as candidate
  set embedding = new_embedding
  where candidate.id = candidate_id
    and candidate.embedding is null
    and candidate.resume_text = expected_resume_text;
  return found;
end
$function$;

revoke all on function public.match_candidates(halfvec, uuid, double precision, integer),
  public.teamflow_match_candidates(halfvec, uuid, double precision, integer),
  public.complete_candidate_embedding_backfill(uuid, text, halfvec)
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader, teamflow_review_writer,
    teamflow_hitl_service, teamflow_checkpoint_migrator, teamflow_checkpoint_runtime;
grant execute on function public.match_candidates(halfvec, uuid, double precision, integer),
  public.complete_candidate_embedding_backfill(uuid, text, halfvec)
  to service_role;
grant execute on function public.teamflow_match_candidates(
  halfvec, uuid, double precision, integer
) to teamflow_hiring_reader;

-- Earlier hardening revoked PUBLIC execution on extension functions installed in
-- public. Grant only the helpers the invoker RPCs now call, in the vector schema.
do $embedding_extension_acl$
declare
  vector_schema name;
begin
  select namespace.nspname into strict vector_schema
  from pg_extension as extension
  join pg_namespace as namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'vector';
  execute format(
    'grant usage on schema %I to service_role, teamflow_hiring_reader', vector_schema
  );
end
$embedding_extension_acl$;
grant execute on function vector_dims(halfvec), l2_norm(halfvec),
  cosine_distance(halfvec, halfvec) to service_role, teamflow_hiring_reader;

notify pgrst, 'reload schema';
commit;
