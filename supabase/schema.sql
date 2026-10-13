-- TeamFlow consolidated Supabase schema.
-- Generated from the complete ordered migration chain; historical permissive
-- demo policies are omitted so this file represents the final security boundary.

-- Fresh-project baseline for the historical 001 migration.
--
-- Existing TeamFlow projects already own these objects through the original schema
-- bootstrap. This file is a strict fresh-project baseline. Operators must verify an
-- existing project's live shape and mark version 000 applied in the migration ledger;
-- they must not replay or rewrite an already-recorded historical migration.

begin;

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- Keep a fresh database private throughout replay, before the later boundary
-- migrations explicitly grant their narrowly scoped roles.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables
  from public, anon, authenticated, service_role;
-- PostgreSQL's EXECUTE-to-PUBLIC function default is global. A schema-qualified
-- ALTER DEFAULT PRIVILEGES statement cannot remove it.
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from public, anon, authenticated, service_role;

create table public.merchants (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz default now(),
  email text unique not null,
  store_name text not null,
  square_merchant_id text unique,
  phone_number text
);

create table public.jobs (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz default now(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  title text not null,
  wage_min numeric,
  wage_max numeric,
  is_active boolean default true,
  dealbreakers jsonb default '[]'::jsonb,
  nice_to_haves jsonb default '[]'::jsonb,
  description text
);

create table public.candidates (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz default now(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  name text not null,
  email text,
  phone text,
  city text,
  status text default 'new' check (
    status in ('new', 'invited', 'interviewed', 'hired', 'rejected')
  ),
  resume_url text not null,
  resume_text text,
  fit_score integer check (fit_score between 0 and 100),
  analysis jsonb,
  red_flags jsonb default '[]'::jsonb,
  summary text,
  source text default 'upload'
);

create table public.applications (
  id uuid primary key default uuid_generate_v4(),
  candidate_id uuid references public.candidates(id) on delete set null,
  role_id text not null,
  data jsonb not null,
  submitted_at timestamptz default now()
);

create table public.audit_logs (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz default now(),
  candidate_id uuid references public.candidates(id) on delete cascade,
  merchant_id uuid references public.merchants(id),
  action text not null,
  input_data jsonb,
  output_data jsonb
);

alter table public.merchants enable row level security;
alter table public.jobs enable row level security;
alter table public.candidates enable row level security;
alter table public.applications enable row level security;
alter table public.audit_logs enable row level security;

-- Historical permissive demo policies are intentionally absent from this
-- consolidated final schema; Phase 19 installs the tenant-bound policies.

revoke all on table public.merchants, public.jobs, public.candidates,
  public.applications, public.audit_logs
  from public, anon, authenticated, service_role;

commit;

-- Migration: Add pgvector embedding column to candidates table
-- Run this against your Supabase project (SQL Editor or CLI)
-- Requires: CREATE EXTENSION IF NOT EXISTS "vector" (already in schema.sql)

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- HNSW index for fast approximate nearest-neighbor search
-- Using cosine distance (<=>) — best for text embeddings
CREATE INDEX IF NOT EXISTS candidates_embedding_idx
  ON candidates
  USING hnsw (embedding vector_cosine_ops);

-- RPC function for semantic similarity search
-- Called by mcp_server.py's semantic_search_candidates tool
CREATE OR REPLACE FUNCTION match_candidates(
  query_embedding vector(768),
  match_merchant_id UUID,
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  email TEXT,
  status TEXT,
  fit_score INTEGER,
  summary TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.email,
    c.status,
    c.fit_score,
    c.summary,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM candidates c
  WHERE
    c.merchant_id = match_merchant_id
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Phase 19: tenant-bound, read-only Data API capability for the hiring MCP.
--
-- This migration intentionally depends only on 000_teamflow_base.sql and the
-- historical 001_add_embedding_column.sql. It must remain replayable without the
-- later resume-review/HITL migrations. The service-role grants below preserve only
-- the operations exercised by the legacy server routes at this point in history.

begin;

do $preflight$
begin
  if to_regclass('public.merchants') is null
    or to_regclass('public.jobs') is null
    or to_regclass('public.candidates') is null
    or to_regclass('public.applications') is null
    or to_regclass('public.audit_logs') is null
  then
    raise exception 'teamflow_phase19_base_schema_missing'
      using errcode = '42P01';
  end if;

  if to_regprocedure(
    'public.match_candidates(vector,uuid,double precision,integer)'
  ) is null then
    raise exception 'teamflow_phase19_embedding_migration_missing'
      using errcode = '42883';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated')
    or not exists (select 1 from pg_roles where rolname = 'service_role')
    or not exists (select 1 from pg_roles where rolname = 'authenticator')
  then
    raise exception 'teamflow_phase19_supabase_roles_missing'
      using errcode = '42704';
  end if;
end
$preflight$;

do $reader_role$
begin
  if not exists (
    select 1 from pg_roles where rolname = 'teamflow_hiring_reader'
  ) then
    create role teamflow_hiring_reader nologin noinherit;
  end if;

  -- Reject a pre-provisioned privileged or directly usable role rather than
  -- silently laundering unsafe role drift into the intended capability.
  if exists (
    select 1
    from pg_roles
    where rolname = 'teamflow_hiring_reader'
      and (
        rolcanlogin or rolinherit or rolcreatedb or rolcreaterole
        or rolsuper or rolreplication or rolbypassrls
      )
  ) then
    raise exception 'teamflow_hiring_reader_has_forbidden_privileges'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from pg_class
    where relowner = (
      select oid from pg_roles where rolname = 'teamflow_hiring_reader'
    )
  ) or exists (
    select 1 from pg_proc
    where proowner = (
      select oid from pg_roles where rolname = 'teamflow_hiring_reader'
    )
  ) or exists (
    select 1 from pg_namespace
    where nspowner = (
      select oid from pg_roles where rolname = 'teamflow_hiring_reader'
    )
  ) or exists (
    select 1 from pg_database
    where datdba = (
      select oid from pg_roles where rolname = 'teamflow_hiring_reader'
    )
  ) then
    raise exception 'teamflow_hiring_reader_owns_database_objects'
      using errcode = '42501';
  end if;

  -- The reader may not inherit or SET ROLE into another capability role.
  if exists (
    select 1
    from pg_auth_members as membership
    where membership.member = (
      select oid from pg_roles where rolname = 'teamflow_hiring_reader'
    )
  ) then
    raise exception 'teamflow_hiring_reader_has_unexpected_membership'
      using errcode = '42501';
  end if;

  -- PostgreSQL 16+ records the CREATEROLE migration owner as an administrative
  -- member when it creates a role. It may administer but cannot inherit or SET
  -- the capability. Only PostgREST's authenticator may SET ROLE into the reader.
  if exists (
    select 1
    from pg_auth_members as membership
    join pg_roles as member_role on member_role.oid = membership.member
    where membership.roleid = (
      select oid from pg_roles where rolname = 'teamflow_hiring_reader'
    )
      and not (
        (
          member_role.rolname = current_user
          and membership.admin_option
          and not membership.inherit_option
          and not membership.set_option
        )
        or (
          member_role.rolname = 'authenticator'
          and not membership.admin_option
          and not membership.inherit_option
          and membership.set_option
        )
      )
  ) then
    raise exception 'teamflow_hiring_reader_has_unexpected_member'
      using errcode = '42501';
  end if;
end
$reader_role$;

alter role teamflow_hiring_reader
  nologin noinherit nocreatedb nocreaterole;
grant teamflow_hiring_reader to authenticator
  with admin false, inherit false, set true;

revoke create on schema public
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader;
grant usage on schema public to teamflow_hiring_reader;

do $extensions_schema$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    revoke create on schema extensions
      from public, anon, authenticated, service_role, authenticator,
        teamflow_hiring_reader;
    grant usage on schema extensions to teamflow_hiring_reader;
  end if;
end
$extensions_schema$;

alter table public.merchants enable row level security;
alter table public.jobs enable row level security;
alter table public.candidates enable row level security;
alter table public.applications enable row level security;
alter table public.audit_logs enable row level security;

-- Remove every allow-all policy in the committed schema. Policies without a TO
-- clause apply to PUBLIC and permissive policies combine with OR, so leaving even
-- one in place would bypass the tenant predicates below.
drop policy if exists "Enable all for users based on merchant_id"
  on public.candidates;
drop policy if exists "Enable insert for public application submission"
  on public.applications;
drop policy if exists "Enable all for users based on merchant_id"
  on public.jobs;
drop policy if exists "Enable all for users based on merchant_id"
  on public.merchants;
drop policy if exists "Allow public all on candidates" on public.candidates;
drop policy if exists "Allow public all on applications" on public.applications;
drop policy if exists "Allow public all on jobs" on public.jobs;
drop policy if exists "Allow public all on merchants" on public.merchants;
drop policy if exists "Allow public all on audit_logs" on public.audit_logs;
drop policy if exists teamflow_hiring_reader_jobs_select on public.jobs;
drop policy if exists teamflow_hiring_reader_candidates_select
  on public.candidates;

-- Unknown PUBLIC or reader policies could be permissive and therefore widen the
-- boundary. Stop for operator review rather than silently deleting policy drift.
do $policy_guard$
begin
  if exists (
    select 1
    from pg_policy as policy
    join pg_class as relation on relation.oid = policy.polrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'merchants', 'jobs', 'candidates', 'applications', 'audit_logs'
      ])
      and (
        0::oid = any(policy.polroles)
        or (
          select oid from pg_roles where rolname = 'teamflow_hiring_reader'
        ) = any(policy.polroles)
      )
  ) then
    raise exception 'teamflow_phase19_unreviewed_policy_detected'
      using errcode = '42501';
  end if;
end
$policy_guard$;

-- Postgres owns this parser; it avoids depending on grants for Supabase Auth's
-- separately owned auth.jwt(). Invalid, non-object, or oversized settings fail to
-- an empty claim object instead of turning authorization failures into SQL errors.
create or replace function public.teamflow_request_jwt_claims()
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $claims_function$
declare
  raw_claims text;
  parsed_claims jsonb;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null
    or raw_claims = ''
    or octet_length(raw_claims) > 8192
  then
    return '{}'::jsonb;
  end if;

  begin
    parsed_claims := raw_claims::jsonb;
  exception
    when invalid_text_representation then
      return '{}'::jsonb;
  end;

  if jsonb_typeof(parsed_claims) <> 'object' then
    return '{}'::jsonb;
  end if;
  return parsed_claims;
end
$claims_function$;

revoke all on function public.teamflow_request_jwt_claims()
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader;
grant execute on function public.teamflow_request_jwt_claims()
  to teamflow_hiring_reader;

revoke all on table public.merchants, public.jobs, public.candidates,
  public.applications, public.audit_logs
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader;

-- Legacy application and document-processor surface evidenced at this migration.
-- Merchant SELECT also preserves scripts/verify-supabase.mjs connectivity checks.
grant select on table public.merchants, public.jobs to service_role;
grant select, insert, update, delete on table public.candidates to service_role;
grant select, insert on table public.applications to service_role;

-- Phase 18's MCP requires only these columns. In particular, candidate name,
-- email, phone, city, raw analysis, red flags, and storage URL remain inaccessible.
grant select (
  id, merchant_id, title, description, dealbreakers, nice_to_haves, is_active
) on table public.jobs to teamflow_hiring_reader;
grant select (
  id, merchant_id, job_id, status, resume_text, created_at, embedding
) on table public.candidates to teamflow_hiring_reader;

create policy teamflow_hiring_reader_jobs_select on public.jobs
  for select to teamflow_hiring_reader
  using (
    is_active is true
    and merchant_id = (
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
  );

create policy teamflow_hiring_reader_candidates_select on public.candidates
  for select to teamflow_hiring_reader
  using (
    merchant_id = (
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
  );

create index if not exists jobs_merchant_id_idx
  on public.jobs (merchant_id, id);
create index if not exists candidates_merchant_created_id_idx
  on public.candidates (merchant_id, created_at desc, id);
create index if not exists candidates_merchant_status_created_id_idx
  on public.candidates (merchant_id, status, created_at desc, id);

-- Retain the email-bearing historical function for the legacy service only.
revoke all on function public.match_candidates(
  vector, uuid, double precision, integer
) from public, anon, authenticated, authenticator, teamflow_hiring_reader,
  service_role;
grant execute on function public.match_candidates(
  vector, uuid, double precision, integer
) to service_role;

-- The MCP RPC is deliberately narrower than the legacy result and remains RLS
-- constrained because it executes with the caller's privileges.
drop function if exists public.teamflow_match_candidates(
  vector, uuid, double precision, integer
);
do $scoped_rpc_overloads$
begin
  if exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'teamflow_match_candidates'
  ) then
    raise exception 'teamflow_phase19_unexpected_scoped_rpc_overload'
      using errcode = '42725';
  end if;
end
$scoped_rpc_overloads$;
create function public.teamflow_match_candidates(
  candidate_query vector(768),
  match_merchant_id uuid,
  match_threshold double precision default 0.5,
  match_count integer default 5
)
returns table (
  merchant_id uuid,
  similarity double precision
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, extensions, public
as $function$
begin
  if candidate_query is null
    or vector_dims(candidate_query) <> 768
    or match_merchant_id is null
    or match_threshold is null
    or not match_threshold between 0 and 1
    or match_count is null
    or not match_count between 1 and 20
  then
    return;
  end if;

  return query
  select
    candidate.merchant_id,
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
  limit case when match_count between 1 and 20 then match_count else 0 end;
end
$function$;

revoke all on function public.teamflow_match_candidates(
  vector, uuid, double precision, integer
) from public, anon, authenticated, service_role, authenticator,
  teamflow_hiring_reader;
grant execute on function public.teamflow_match_candidates(
  vector, uuid, double precision, integer
) to teamflow_hiring_reader;

-- Newly created relations/functions stay private until a later migration grants
-- an intentional capability. Keep hosted and fresh-replay behavior aligned.
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke all on tables
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader;
alter default privileges for role postgres in schema public
  revoke all on sequences
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader;
alter default privileges for role postgres in schema public
  revoke all on functions
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader;

commit;

-- Phase 27: immutable extraction snapshots and unapproved review proposals.
-- Depends on the Phase 19 tenant-claim parser and read-only hiring role.

begin;

do $preflight$
begin
  if to_regclass('public.jobs') is null
    or to_regclass('public.candidates') is null
    or to_regprocedure('public.teamflow_request_jwt_claims()') is null
    or not exists (select 1 from pg_roles where rolname = 'teamflow_hiring_reader')
    or not exists (select 1 from pg_roles where rolname = 'authenticator')
    or not exists (select 1 from pg_roles where rolname = 'service_role')
  then
    raise exception 'teamflow_phase27_prerequisite_missing' using errcode = '42P01';
  end if;
end
$preflight$;

do $writer_role$
begin
  if not exists (select 1 from pg_roles where rolname = 'teamflow_review_writer') then
    create role teamflow_review_writer nologin noinherit;
  end if;
  if exists (
    select 1 from pg_roles
    where rolname = 'teamflow_review_writer'
      and (rolcanlogin or rolinherit or rolcreatedb or rolcreaterole
        or rolsuper or rolreplication or rolbypassrls)
  ) then
    raise exception 'teamflow_review_writer_has_forbidden_privileges'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from pg_auth_members
    where member = (select oid from pg_roles where rolname = 'teamflow_review_writer')
  ) then
    raise exception 'teamflow_review_writer_has_unexpected_membership'
      using errcode = '42501';
  end if;
end
$writer_role$;

alter role teamflow_review_writer nologin noinherit nocreatedb nocreaterole;
grant teamflow_review_writer to authenticator
  with admin false, inherit false, set true;
revoke create on schema public from teamflow_review_writer;
grant usage on schema public to teamflow_review_writer;
grant execute on function public.teamflow_request_jwt_claims()
  to teamflow_review_writer;

alter table public.jobs
  add column if not exists scoring_policy_id text,
  add column if not exists scoring_policy_version text,
  add column if not exists scoring_criteria jsonb;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'jobs_scoring_policy_all_or_none'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs add constraint jobs_scoring_policy_all_or_none check (
      (scoring_policy_id is null and scoring_policy_version is null
        and scoring_criteria is null)
      or (scoring_policy_id is not null and scoring_policy_version is not null
        and scoring_criteria is not null and jsonb_typeof(scoring_criteria) = 'array'
        and jsonb_array_length(scoring_criteria) between 1 and 30)
    );
  end if;
end
$constraints$;

create unique index if not exists candidates_merchant_id_id_key
  on public.candidates (merchant_id, id);

do $candidate_constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'candidates_merchant_id_id_key'
      and conrelid = 'public.candidates'::regclass
  ) then
    alter table public.candidates
      add constraint candidates_merchant_id_id_key
      unique using index candidates_merchant_id_id_key;
  end if;
end
$candidate_constraint$;

create table public.resume_documents (
  merchant_id uuid references public.merchants(id) on delete cascade not null,
  document_id text not null check (document_id ~ '^doc-[0-9a-f]{64}$'),
  schema_version text not null check (schema_version = '1.0'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('complete', 'degraded')),
  text text not null check (char_length(text) between 1 and 100000),
  source_blocks jsonb not null check (
    jsonb_typeof(source_blocks) = 'array'
    and jsonb_array_length(source_blocks) between 1 and 512
    and pg_column_size(source_blocks) <= 2097152
  ),
  extraction_method text not null check (extraction_method in ('pdf_text', 'gemini_vision', 'google_cloud_vision')),
  model_id text not null check (char_length(model_id) between 1 and 200),
  embedding_available boolean not null,
  mock boolean not null default false check (mock = false),
  warnings jsonb not null default '[]'::jsonb check (
    jsonb_typeof(warnings) = 'array' and jsonb_array_length(warnings) <= 16
  ),
  quality jsonb not null check (
    jsonb_typeof(quality) = 'object' and pg_column_size(quality) <= 8192
  ),
  created_at timestamptz not null default now(),
  primary key (merchant_id, document_id),
  unique (merchant_id, document_id, snapshot_sha256),
  constraint resume_documents_hash_matches_id
    check (document_id = 'doc-' || content_sha256)
);

create table public.candidate_resume_documents (
  merchant_id uuid references public.merchants(id) on delete cascade not null,
  candidate_id uuid not null,
  document_id text not null,
  created_at timestamptz not null default now(),
  primary key (merchant_id, candidate_id, document_id),
  foreign key (merchant_id, candidate_id)
    references public.candidates(merchant_id, id) on delete cascade,
  foreign key (merchant_id, document_id)
    references public.resume_documents(merchant_id, document_id) on delete cascade
);

create table public.resume_review_runs (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  schema_version text not null check (schema_version = '1.0'),
  request_id uuid not null,
  merchant_id uuid references public.merchants(id) on delete cascade not null,
  document_id text not null,
  candidate_id uuid,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  extraction_snapshot_sha256 text not null check (
    extraction_snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  role_policy_snapshot jsonb not null check (
    jsonb_typeof(role_policy_snapshot) = 'array'
    and jsonb_array_length(role_policy_snapshot) between 1 and 5
  ),
  confidence_assessment jsonb not null check (jsonb_typeof(confidence_assessment) = 'object'),
  confidence_shadow_record jsonb not null check (
    jsonb_typeof(confidence_shadow_record) = 'object'
  ),
  confidence_policy_snapshot jsonb not null check (
    jsonb_typeof(confidence_policy_snapshot) = 'object'
  ),
  confidence_signal_snapshot jsonb not null check (
    jsonb_typeof(confidence_signal_snapshot) = 'array'
    and jsonb_array_length(confidence_signal_snapshot) = 10
  ),
  confidence_policy_sha256 text not null check (
    confidence_policy_sha256 ~ '^[0-9a-f]{64}$'
  ),
  confidence_threshold_applied boolean not null check (confidence_threshold_applied = false),
  status text not null check (status = 'review_required'),
  review_required boolean not null check (review_required = true),
  agent1_evaluation jsonb not null check (jsonb_typeof(agent1_evaluation) = 'object'),
  questions_status text not null check (
    questions_status in ('complete', 'degraded', 'not_required', 'skipped')
  ),
  question_plan jsonb,
  reason_codes jsonb not null check (
    jsonb_typeof(reason_codes) = 'array'
    and jsonb_array_length(reason_codes) between 1 and 20
  ),
  unique (merchant_id, request_id),
  constraint resume_review_runs_question_plan_consistent check (
    (questions_status = 'complete' and question_plan is not null
      and jsonb_typeof(question_plan) = 'object')
    or (questions_status <> 'complete' and question_plan is null)
  ),
  foreign key (merchant_id, document_id)
    references public.resume_documents(merchant_id, document_id) on delete restrict,
  foreign key (merchant_id, document_id, extraction_snapshot_sha256)
    references public.resume_documents(merchant_id, document_id, snapshot_sha256)
    on delete restrict,
  foreign key (merchant_id, candidate_id)
    references public.candidates(merchant_id, id) on delete restrict,
  foreign key (merchant_id, candidate_id, document_id)
    references public.candidate_resume_documents(merchant_id, candidate_id, document_id)
    on delete restrict
);

create index resume_review_runs_document_idx
  on public.resume_review_runs (merchant_id, document_id, created_at desc);
create index resume_review_runs_candidate_idx
  on public.resume_review_runs (merchant_id, candidate_id) where candidate_id is not null;
create index jobs_active_policy_idx
  on public.jobs (merchant_id, id) where is_active = true;
create index candidate_resume_documents_document_idx
  on public.candidate_resume_documents (merchant_id, document_id, candidate_id);

alter table public.resume_documents enable row level security;
alter table public.candidate_resume_documents enable row level security;
alter table public.resume_review_runs enable row level security;

revoke all on table public.resume_documents, public.candidate_resume_documents,
  public.resume_review_runs
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader, teamflow_review_writer;

-- The existing server-side ingestion path stores source snapshots and links only.
grant select, insert on table public.resume_documents,
  public.candidate_resume_documents to service_role;

grant select (
  id, merchant_id, title, scoring_policy_id, scoring_policy_version, scoring_criteria
) on table public.jobs to teamflow_hiring_reader;
grant select (
  merchant_id, document_id, schema_version, content_sha256, snapshot_sha256,
  status, text, source_blocks, extraction_method, model_id,
  embedding_available, mock, warnings, quality
) on table public.resume_documents to teamflow_hiring_reader;
grant select (merchant_id, candidate_id, document_id)
  on table public.candidate_resume_documents to teamflow_hiring_reader;

grant select (id, merchant_id, request_id, input_sha256)
  on table public.resume_review_runs to teamflow_review_writer;
grant insert (
  schema_version, request_id, merchant_id, document_id, candidate_id,
  input_sha256, extraction_snapshot_sha256, policy_sha256, role_policy_snapshot,
  confidence_assessment, confidence_shadow_record, confidence_policy_snapshot,
  confidence_signal_snapshot, confidence_policy_sha256,
  confidence_threshold_applied, status, review_required, agent1_evaluation,
  questions_status, question_plan, reason_codes
) on table public.resume_review_runs to teamflow_review_writer;

create policy teamflow_hiring_reader_documents_select
  on public.resume_documents for select to teamflow_hiring_reader
  using (
    merchant_id = (
      select case
        when claims ->> 'role' = 'teamflow_hiring_reader'
          and coalesce(claims ->> 'merchant_id', '') ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (claims ->> 'merchant_id')::uuid else null end
      from (select public.teamflow_request_jwt_claims() as claims) as request_context
    )
  );

create policy teamflow_hiring_reader_document_links_select
  on public.candidate_resume_documents for select to teamflow_hiring_reader
  using (
    merchant_id = (
      select case
        when claims ->> 'role' = 'teamflow_hiring_reader'
          and coalesce(claims ->> 'merchant_id', '') ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (claims ->> 'merchant_id')::uuid else null end
      from (select public.teamflow_request_jwt_claims() as claims) as request_context
    )
  );

create policy teamflow_review_writer_runs_select
  on public.resume_review_runs for select to teamflow_review_writer
  using (
    merchant_id = (
      select case
        when claims ->> 'role' = 'teamflow_review_writer'
          and coalesce(claims ->> 'merchant_id', '') ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (claims ->> 'merchant_id')::uuid else null end
      from (select public.teamflow_request_jwt_claims() as claims) as request_context
    )
  );

create policy teamflow_review_writer_runs_insert
  on public.resume_review_runs for insert to teamflow_review_writer
  with check (
    merchant_id = (
      select case
        when claims ->> 'role' = 'teamflow_review_writer'
          and coalesce(claims ->> 'merchant_id', '') ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (claims ->> 'merchant_id')::uuid else null end
      from (select public.teamflow_request_jwt_claims() as claims) as request_context
    )
  );

create function public.reject_resume_review_mutation()
returns trigger language plpgsql set search_path = pg_catalog
as $function$
begin
  raise exception 'immutable resume-review evidence rejects mutation' using errcode = '55000';
end
$function$;

revoke all on function public.reject_resume_review_mutation()
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hiring_reader, teamflow_review_writer;

create trigger resume_documents_reject_mutation
before update on public.resume_documents
for each row execute function public.reject_resume_review_mutation();
create trigger candidate_resume_documents_reject_mutation
before update on public.candidate_resume_documents
for each row execute function public.reject_resume_review_mutation();
create trigger resume_review_runs_reject_mutation
before update or delete on public.resume_review_runs
for each row execute function public.reject_resume_review_mutation();

commit;

-- Phase 6: durable, tenant-scoped human review for resume scoring.
--
-- This migration deliberately keeps public.resume_review_runs immutable. Those rows
-- remain Phase 4 evidence; the tables below own mutable workflow state and immutable
-- human decisions/candidate-score revisions. No function in this migration accepts a
-- merchant_id from its caller. Trusted services authenticate a user, pass only that
-- actor UUID, and the database derives exactly one active merchant membership.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter extension pgcrypto set schema extensions;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'teamflow_hitl_service') then
    create role teamflow_hitl_service nologin noinherit;
  end if;
  if not exists (
    select 1 from pg_roles where rolname = 'teamflow_checkpoint_migrator'
  ) then
    create role teamflow_checkpoint_migrator nologin noinherit;
  end if;
  if not exists (
    select 1 from pg_roles where rolname = 'teamflow_checkpoint_runtime'
  ) then
    create role teamflow_checkpoint_runtime nologin noinherit;
  end if;
end
$roles$;

-- PostgreSQL 16+ records a role creator with ADMIN but can leave the membership's
-- SET option disabled. Schema ownership requires SET ROLE, so make that capability
-- explicit for the migration owner before assigning the checkpoint schema. The
-- migrator itself remains NOLOGIN and the application runtime never receives it.
grant teamflow_checkpoint_migrator to postgres with set true;

create schema if not exists teamflow_private;
revoke all on schema teamflow_private from public;
-- PostgreSQL's built-in default grants EXECUTE on every new function to PUBLIC.
-- A schema-scoped default ACL is additive and cannot subtract that global default,
-- so establish the secure global default for the migration owner before creating any
-- SECURITY DEFINER function. Every callable API is granted explicitly at the end.
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema teamflow_private
  revoke execute on functions
  from public, anon, authenticated, service_role, teamflow_hitl_service;

-- LangGraph owns the DDL inside this schema. Run its pinned checkpoint migrations
-- while SET ROLE teamflow_checkpoint_migrator; the application runtime receives only
-- DML on the resulting tables. This migration intentionally does not copy LangGraph's
-- package-owned table definitions.
create schema if not exists teamflow_checkpoints
  authorization teamflow_checkpoint_migrator;
alter schema teamflow_checkpoints owner to teamflow_checkpoint_migrator;
revoke all on schema teamflow_checkpoints from public, anon, authenticated,
  service_role, teamflow_hitl_service;
grant usage, create on schema teamflow_checkpoints
  to teamflow_checkpoint_migrator;
grant usage on schema teamflow_checkpoints
  to teamflow_checkpoint_runtime;
alter default privileges for role teamflow_checkpoint_migrator
  in schema teamflow_checkpoints
  grant select, insert, update, delete on tables
  to teamflow_checkpoint_runtime;
alter default privileges for role teamflow_checkpoint_migrator
  in schema teamflow_checkpoints
  grant usage, select, update on sequences
  to teamflow_checkpoint_runtime;
alter default privileges for role teamflow_checkpoint_migrator
  in schema teamflow_checkpoints
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role teamflow_checkpoint_migrator
  revoke execute on functions from public;
alter role teamflow_checkpoint_migrator
  set search_path = teamflow_checkpoints, pg_catalog;
alter role teamflow_checkpoint_runtime
  set search_path = teamflow_checkpoints, pg_catalog;

-- These capability roles remain NOLOGIN in source control. Provision their exact names
-- out of band with ALTER ROLE ... LOGIN PASSWORD '<secret>': the runtime DSN username
-- is teamflow_checkpoint_runtime, and the deployment-only migration DSN username is
-- teamflow_checkpoint_migrator. Rotate secrets externally and return the migrator to
-- NOLOGIN outside a pinned migration window. Never reuse service_role for checkpoints.

create unique index if not exists jobs_merchant_id_id_key
  on public.jobs (merchant_id, id);
do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'jobs_merchant_id_id_key'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs
      add constraint jobs_merchant_id_id_key
      unique using index jobs_merchant_id_id_key;
  end if;
end
$constraints$;

create unique index if not exists resume_review_runs_merchant_id_id_key
  on public.resume_review_runs (merchant_id, id);
do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'resume_review_runs_merchant_id_id_key'
      and conrelid = 'public.resume_review_runs'::regclass
  ) then
    alter table public.resume_review_runs
      add constraint resume_review_runs_merchant_id_id_key
      unique using index resume_review_runs_merchant_id_id_key;
  end if;
end
$constraints$;

-- Legacy Phase 4 evidence may predate calibrated provenance and therefore remains
-- nullable as an all-or-none group. Every Phase 6 prepare call requires and validates
-- the full group; no threshold is applied while the diagnostic remains uncalibrated.
alter table public.resume_review_runs
  add column if not exists confidence_assessment jsonb,
  add column if not exists confidence_shadow_record jsonb,
  add column if not exists confidence_policy_snapshot jsonb,
  add column if not exists confidence_signal_snapshot jsonb,
  add column if not exists confidence_policy_sha256 text,
  add column if not exists confidence_threshold_applied boolean;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'resume_review_runs_policy_snapshot_size'
      and conrelid = 'public.resume_review_runs'::regclass
  ) then
    alter table public.resume_review_runs
      add constraint resume_review_runs_policy_snapshot_size
      check (octet_length(role_policy_snapshot::text) <= 1048576);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'resume_review_runs_agent1_evaluation_size'
      and conrelid = 'public.resume_review_runs'::regclass
  ) then
    alter table public.resume_review_runs
      add constraint resume_review_runs_agent1_evaluation_size
      check (octet_length(agent1_evaluation::text) <= 262144);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'resume_review_runs_question_plan_size'
      and conrelid = 'public.resume_review_runs'::regclass
  ) then
    alter table public.resume_review_runs
      add constraint resume_review_runs_question_plan_size
      check (question_plan is null or octet_length(question_plan::text) <= 262144);
  end if;
end
$constraints$;

alter table public.candidates
  add column if not exists score_version bigint not null default 0,
  add column if not exists current_score_revision_id uuid,
  add column if not exists score_updated_at timestamptz;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'candidates_score_version_bounds'
      and conrelid = 'public.candidates'::regclass
  ) then
    alter table public.candidates
      add constraint candidates_score_version_bounds
      check (score_version between 0 and 2147483647);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'candidates_score_revision_state'
      and conrelid = 'public.candidates'::regclass
  ) then
    alter table public.candidates
      add constraint candidates_score_revision_state check (
        (score_version = 0 and current_score_revision_id is null
         and score_updated_at is null)
        or
        (score_version >= 1 and current_score_revision_id is not null
         and score_updated_at is not null and fit_score is not null)
      );
  end if;
end
$constraints$;

create table public.merchant_memberships (
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'reviewer')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, user_id),
  check (updated_at >= created_at)
);

create index merchant_memberships_active_actor_idx
  on public.merchant_memberships (user_id, merchant_id, role)
  where status = 'active';
create index merchant_memberships_active_merchant_idx
  on public.merchant_memberships (merchant_id, role, user_id)
  where status = 'active';

create table public.resume_review_workflows (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  schema_version text not null default '2.0' check (schema_version = '2.0'),
  request_id uuid not null,
  thread_id text not null check (thread_id ~ '^rrh-v1-[0-9a-f]{64}$'),
  initiated_by uuid not null references auth.users(id) on delete restrict,
  analysis_run_id uuid not null,
  document_id text not null,
  candidate_id uuid not null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  analysis_input_sha256 text not null check (
    analysis_input_sha256 ~ '^[0-9a-f]{64}$'
  ),
  result_snapshot jsonb not null check (
    jsonb_typeof(result_snapshot) = 'object'
    and octet_length(result_snapshot::text) between 2 and 262144
  ),
  result_snapshot_sha256 text not null check (
    result_snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  proposed_score integer not null check (proposed_score between 0 and 100),
  proposed_role_id uuid,
  base_candidate_score_version bigint not null check (
    base_candidate_score_version between 0 and 2147483647
  ),
  status text not null check (
    status in (
      'running', 'pending_review', 'decision_recorded',
      'completed', 'rejected', 'failed'
    )
  ),
  version bigint not null default 1 check (version between 1 and 2147483647),
  reason_codes jsonb not null default '[]'::jsonb check (
    jsonb_typeof(reason_codes) = 'array'
    and jsonb_array_length(reason_codes) between 0 and 20
    and octet_length(reason_codes::text) <= 4096
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decision_recorded_at timestamptz,
  completed_at timestamptz,
  unique (merchant_id, id),
  unique (merchant_id, request_id),
  unique (thread_id),
  foreign key (merchant_id, analysis_run_id)
    references public.resume_review_runs(merchant_id, id) on delete restrict,
  foreign key (merchant_id, document_id)
    references public.resume_documents(merchant_id, document_id) on delete restrict,
  foreign key (merchant_id, candidate_id)
    references public.candidates(merchant_id, id) on delete restrict,
  foreign key (merchant_id, candidate_id, document_id)
    references public.candidate_resume_documents(merchant_id, candidate_id, document_id)
    on delete restrict,
  foreign key (merchant_id, proposed_role_id)
    references public.jobs(merchant_id, id) on delete restrict,
  constraint resume_review_workflows_terminal_timestamps check (
    (status in ('running', 'pending_review')
      and decision_recorded_at is null and completed_at is null)
    or
    (status = 'decision_recorded'
      and decision_recorded_at is not null and completed_at is null)
    or
    (status in ('completed', 'rejected')
      and decision_recorded_at is not null and completed_at is not null)
    or
    (status = 'failed' and completed_at is not null)
  ),
  check (updated_at >= created_at),
  check (completed_at is null or completed_at >= created_at),
  check (decision_recorded_at is null or decision_recorded_at >= created_at)
);

create table public.resume_reviews (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  workflow_id uuid not null,
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'edited', 'rejected')
  ),
  version bigint not null default 1 check (version between 1 and 2147483647),
  reason_codes jsonb not null check (
    jsonb_typeof(reason_codes) = 'array'
    and jsonb_array_length(reason_codes) between 0 and 20
    and octet_length(reason_codes::text) <= 4096
  ),
  decided_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (merchant_id, id),
  unique (merchant_id, workflow_id),
  foreign key (merchant_id, workflow_id)
    references public.resume_review_workflows(merchant_id, id) on delete cascade,
  constraint resume_reviews_decision_state check (
    (status = 'pending' and decided_by is null and decided_at is null)
    or
    (status <> 'pending' and decided_by is not null and decided_at is not null)
  ),
  check (updated_at >= created_at),
  check (decided_at is null or decided_at >= created_at)
);

create table public.resume_review_decisions (
  id uuid primary key,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  workflow_id uuid not null,
  review_id uuid not null,
  candidate_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('approve', 'approve_with_edits', 'reject')),
  reason_code text check (
    reason_code is null
    or reason_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
  ),
  expected_review_version bigint not null check (
    expected_review_version between 1 and 2147483647
  ),
  expected_candidate_score_version bigint not null check (
    expected_candidate_score_version between 0 and 2147483647
  ),
  client_request_sha256 text not null check (
    client_request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  resulting_review_version bigint not null check (
    resulting_review_version between 2 and 2147483647
  ),
  resulting_workflow_version bigint not null check (
    resulting_workflow_version between 3 and 2147483647
  ),
  resulting_candidate_score_version bigint check (
    resulting_candidate_score_version between 1 and 2147483647
  ),
  applied_revision_id uuid,
  created_at timestamptz not null default now(),
  unique (merchant_id, id),
  unique (merchant_id, review_id),
  foreign key (merchant_id, workflow_id)
    references public.resume_review_workflows(merchant_id, id) on delete cascade,
  foreign key (merchant_id, review_id)
    references public.resume_reviews(merchant_id, id) on delete cascade,
  foreign key (merchant_id, candidate_id)
    references public.candidates(merchant_id, id) on delete restrict,
  constraint resume_review_decisions_action_payload check (
    (action = 'approve' and reason_code is null
      and applied_revision_id is not null
      and resulting_candidate_score_version is not null)
    or
    (action = 'approve_with_edits' and reason_code is not null
      and applied_revision_id is not null
      and resulting_candidate_score_version is not null)
    or
    (action = 'reject' and reason_code is not null
      and applied_revision_id is null
      and resulting_candidate_score_version is null)
  )
);

create table public.candidate_score_revisions (
  id uuid primary key,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  candidate_id uuid not null,
  workflow_id uuid not null,
  review_id uuid not null,
  decision_id uuid not null,
  revision_kind text not null check (revision_kind in ('agent_proposal', 'reviewer_edit')),
  candidate_score_version bigint not null check (
    candidate_score_version between 1 and 2147483647
  ),
  previous_fit_score integer check (previous_fit_score between 0 and 100),
  fit_score integer not null check (fit_score between 0 and 100),
  role_id uuid,
  result_snapshot jsonb not null check (
    jsonb_typeof(result_snapshot) = 'object'
    and octet_length(result_snapshot::text) between 2 and 262144
  ),
  result_snapshot_sha256 text not null check (
    result_snapshot_sha256 ~ '^[0-9a-f]{64}$'
  ),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (merchant_id, id),
  unique (merchant_id, candidate_id, candidate_score_version),
  unique (merchant_id, decision_id),
  foreign key (merchant_id, candidate_id)
    references public.candidates(merchant_id, id) on delete restrict,
  foreign key (merchant_id, workflow_id)
    references public.resume_review_workflows(merchant_id, id) on delete cascade,
  foreign key (merchant_id, review_id)
    references public.resume_reviews(merchant_id, id) on delete cascade,
  foreign key (merchant_id, role_id)
    references public.jobs(merchant_id, id) on delete restrict,
  foreign key (merchant_id, decision_id)
    references public.resume_review_decisions(merchant_id, id)
    on delete cascade deferrable initially deferred
);

alter table public.resume_review_decisions
  add constraint resume_review_decisions_applied_revision_fk
  foreign key (merchant_id, applied_revision_id)
  references public.candidate_score_revisions(merchant_id, id)
  on delete restrict deferrable initially deferred;

alter table public.candidates
  add constraint candidates_current_score_revision_fk
  foreign key (merchant_id, current_score_revision_id)
  references public.candidate_score_revisions(merchant_id, id)
  on delete restrict deferrable initially immediate;

create table public.resume_review_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  workflow_id uuid not null,
  review_id uuid,
  decision_id uuid,
  event_sequence bigint not null check (event_sequence between 1 and 2147483647),
  event_key text not null check (
    event_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,199}$'
  ),
  event_type text not null check (
    event_type in (
      'workflow_created', 'review_created', 'decision_recorded',
      'candidate_score_revised', 'workflow_completed',
      'workflow_rejected', 'workflow_failed'
    )
  ),
  actor_user_id uuid references auth.users(id) on delete restrict,
  event_data jsonb not null default '{}'::jsonb check (
    jsonb_typeof(event_data) = 'object'
    and octet_length(event_data::text) <= 8192
  ),
  created_at timestamptz not null default now(),
  unique (merchant_id, id),
  unique (merchant_id, workflow_id, event_sequence),
  unique (merchant_id, workflow_id, event_key),
  foreign key (merchant_id, workflow_id)
    references public.resume_review_workflows(merchant_id, id) on delete cascade,
  foreign key (merchant_id, review_id)
    references public.resume_reviews(merchant_id, id) on delete cascade,
  foreign key (merchant_id, decision_id)
    references public.resume_review_decisions(merchant_id, id) on delete cascade
);

create index resume_review_workflows_candidate_idx
  on public.resume_review_workflows (merchant_id, candidate_id, created_at desc);
create index resume_review_workflows_analysis_run_idx
  on public.resume_review_workflows (merchant_id, analysis_run_id);
create index resume_review_workflows_pending_idx
  on public.resume_review_workflows (merchant_id, updated_at, id)
  where status = 'pending_review';
create index resume_review_workflows_pending_queue_idx
  on public.resume_review_workflows (merchant_id, created_at desc, id desc)
  where status = 'pending_review';
create index resume_reviews_pending_idx
  on public.resume_reviews (merchant_id, created_at, id)
  where status = 'pending';
create index resume_review_events_timeline_idx
  on public.resume_review_events (merchant_id, workflow_id, event_sequence);
create index candidate_score_revisions_candidate_idx
  on public.candidate_score_revisions (
    merchant_id, candidate_id, candidate_score_version desc
  );

create or replace function teamflow_private.valid_reason_codes(p_codes jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    jsonb_typeof(p_codes) = 'array'
    and jsonb_array_length(p_codes) between 0 and 20
    and octet_length(p_codes::text) <= 4096
    and not exists (
      select 1
      from jsonb_array_elements(p_codes) as item(value)
      where jsonb_typeof(item.value) <> 'string'
         or not ((item.value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$')
    )
    and (
      select count(*) = count(distinct item.value #>> '{}')
      from jsonb_array_elements(p_codes) as item(value)
    ),
    false
  );
$function$;

create or replace function teamflow_private.valid_confidence_provenance(
  p_assessment jsonb,
  p_shadow jsonb,
  p_policy_snapshot jsonb,
  p_signal_snapshot jsonb,
  p_policy_sha256 text,
  p_threshold_applied boolean,
  p_status text,
  p_review_required boolean
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_policy_component jsonb;
  v_assessment_component jsonb;
  v_signal jsonb;
  v_ordinal bigint;
  v_reason text;
  v_policy_ids text[] := array[]::text[];
  v_expected_reasons text[] := array[]::text[];
  v_allowed_ids constant text[] := array[
    'workflow_completion_gate', 'extraction_validation_gate',
    'context_validation_gate', 'agent1_schema_gate',
    'literal_grounding_gate', 'criteria_coverage',
    'evidence_consistency_gate', 'score_calculation_gate',
    'provider_completion_gate', 'safety_validation_gate'
  ];
  v_weighted_total bigint := 0;
  v_weight_total integer := 0;
  v_expected_hard_failure boolean := false;
  v_canonical_components text := '';
  v_policy_canonical text;
  v_computed_policy_sha256 text;
  v_assessment_keys constant text[] := array[
    'schema_version', 'score', 'is_probability', 'hard_failure',
    'components', 'reason_codes', 'policy_identity'
  ];
  v_shadow_keys constant text[] := array[
    'schema_version', 'mode', 'score', 'is_probability', 'hard_failure',
    'threshold_applied', 'review_required', 'status', 'reason_codes',
    'policy_identity', 'policy_sha256'
  ];
  v_policy_keys constant text[] := array[
    'schema_version', 'policy_id', 'policy_version', 'mode', 'status', 'components'
  ];
  v_signal_keys constant text[] := array[
    'component_id', 'score', 'hard_failure', 'reason_codes'
  ];
begin
  if p_policy_snapshot is null
     or jsonb_typeof(p_policy_snapshot) <> 'object'
     or octet_length(p_policy_snapshot::text) > 65536
     or not (p_policy_snapshot ?& v_policy_keys)
     or p_policy_snapshot - v_policy_keys <> '{}'::jsonb
     or jsonb_typeof(p_policy_snapshot -> 'schema_version') <> 'string'
     or p_policy_snapshot ->> 'schema_version' <> '1.0'
     or jsonb_typeof(p_policy_snapshot -> 'policy_id') <> 'string'
     or coalesce(p_policy_snapshot ->> 'policy_id', '')
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
     or jsonb_typeof(p_policy_snapshot -> 'policy_version') <> 'string'
     or coalesce(p_policy_snapshot ->> 'policy_version', '')
          !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     or jsonb_typeof(p_policy_snapshot -> 'mode') <> 'string'
     or p_policy_snapshot ->> 'mode' <> 'shadow'
     or jsonb_typeof(p_policy_snapshot -> 'status') <> 'string'
     or p_policy_snapshot ->> 'status' <> 'uncalibrated'
     or jsonb_typeof(p_policy_snapshot -> 'components') <> 'array'
     or jsonb_array_length(p_policy_snapshot -> 'components') <> 10
     or p_signal_snapshot is null
     or jsonb_typeof(p_signal_snapshot) <> 'array'
     or jsonb_array_length(p_signal_snapshot) <> 10
     or octet_length(p_signal_snapshot::text) > 65536 then
    return false;
  end if;

  if (
    select count(*) <> count(distinct item.value ->> 'component_id')
    from jsonb_array_elements(p_signal_snapshot) as item(value)
  ) then
    return false;
  end if;

  if p_assessment is null
     or jsonb_typeof(p_assessment) <> 'object'
     or octet_length(p_assessment::text) > 65536
     or not (p_assessment ?& v_assessment_keys)
     or p_assessment - v_assessment_keys <> '{}'::jsonb
     or jsonb_typeof(p_assessment -> 'schema_version') <> 'string'
     or p_assessment ->> 'schema_version' <> '1.0'
     or jsonb_typeof(p_assessment -> 'score') <> 'number'
     or coalesce(p_assessment ->> 'score', '') !~ '^(0|[1-9][0-9]{0,2})$'
     or (p_assessment ->> 'score')::integer not between 0 and 100
     or p_assessment -> 'is_probability' <> 'false'::jsonb
     or jsonb_typeof(p_assessment -> 'hard_failure') <> 'boolean'
     or jsonb_typeof(p_assessment -> 'components') <> 'array'
     or jsonb_array_length(p_assessment -> 'components') not between 1 and 20
     or not teamflow_private.valid_reason_codes(p_assessment -> 'reason_codes')
     or jsonb_typeof(p_assessment -> 'policy_identity') <> 'object'
     or not ((p_assessment -> 'policy_identity') ?& array['policy_id', 'policy_version'])
     or (p_assessment -> 'policy_identity') - array['policy_id', 'policy_version']
          <> '{}'::jsonb
     or jsonb_typeof(p_assessment -> 'policy_identity' -> 'policy_id') <> 'string'
     or coalesce(p_assessment -> 'policy_identity' ->> 'policy_id', '')
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
     or jsonb_typeof(p_assessment -> 'policy_identity' -> 'policy_version') <> 'string'
     or coalesce(p_assessment -> 'policy_identity' ->> 'policy_version', '')
          !~ '^[0-9]+\.[0-9]+\.[0-9]+$' then
    return false;
  end if;

  if jsonb_array_length(p_assessment -> 'components') <> 10 then
    return false;
  end if;

  for v_policy_component, v_ordinal in
    select item.value, item.ordinality
    from jsonb_array_elements(p_policy_snapshot -> 'components')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if jsonb_typeof(v_policy_component) <> 'object'
       or not (v_policy_component ?& array['component_id', 'weight'])
       or v_policy_component - array['component_id', 'weight'] <> '{}'::jsonb
       or jsonb_typeof(v_policy_component -> 'component_id') <> 'string'
       or not ((v_policy_component ->> 'component_id') = any(v_allowed_ids))
       or jsonb_typeof(v_policy_component -> 'weight') <> 'number'
       or coalesce(v_policy_component ->> 'weight', '') !~ '^(0|[1-9][0-9]{0,2})$'
       or (v_policy_component ->> 'weight')::integer not between 0 and 100 then
      return false;
    end if;

    v_policy_ids := array_append(v_policy_ids, v_policy_component ->> 'component_id');
    v_weight_total := v_weight_total + (v_policy_component ->> 'weight')::integer;
    if v_ordinal > 1 then
      v_canonical_components := v_canonical_components || ',';
    end if;
    v_canonical_components := v_canonical_components
      || '{"component_id":"' || (v_policy_component ->> 'component_id')
      || '","weight":' || (v_policy_component ->> 'weight') || '}';

    select item.value into v_signal
    from jsonb_array_elements(p_signal_snapshot) as item(value)
    where item.value ->> 'component_id' = v_policy_component ->> 'component_id';
    if not found
       or jsonb_typeof(v_signal) <> 'object'
       or not (v_signal ?& v_signal_keys)
       or v_signal - v_signal_keys <> '{}'::jsonb
       or jsonb_typeof(v_signal -> 'component_id') <> 'string'
       or jsonb_typeof(v_signal -> 'hard_failure') <> 'boolean'
       or not teamflow_private.valid_reason_codes(v_signal -> 'reason_codes') then
      return false;
    end if;
    if v_signal -> 'score' <> 'null'::jsonb
       and (
         jsonb_typeof(v_signal -> 'score') <> 'number'
         or coalesce(v_signal ->> 'score', '') !~ '^(0|[1-9][0-9]{0,2})$'
         or (v_signal ->> 'score')::integer not between 0 and 100
       ) then
      return false;
    end if;
    if (v_signal ->> 'hard_failure')::boolean
       and jsonb_array_length(v_signal -> 'reason_codes') = 0 then
      return false;
    end if;
    if (v_signal -> 'score') = 'null'::jsonb
       and not (v_signal ->> 'hard_failure')::boolean then
      return false;
    end if;

    v_assessment_component := p_assessment -> 'components' -> ((v_ordinal - 1)::integer);
    if jsonb_typeof(v_assessment_component) <> 'object'
       or not (v_assessment_component ?& array['component_id', 'score', 'reason_codes'])
       or v_assessment_component - array['component_id', 'score', 'reason_codes']
            <> '{}'::jsonb
       or jsonb_typeof(v_assessment_component -> 'component_id') <> 'string'
       or v_assessment_component ->> 'component_id'
            <> v_policy_component ->> 'component_id'
       or jsonb_typeof(v_assessment_component -> 'score') <> 'number'
       or coalesce(v_assessment_component ->> 'score', '')
            !~ '^(0|[1-9][0-9]{0,2})$'
       or (v_assessment_component ->> 'score')::integer not between 0 and 100
       or not teamflow_private.valid_reason_codes(
            v_assessment_component -> 'reason_codes'
          )
       or (v_assessment_component ->> 'score')::integer
            <> coalesce((v_signal ->> 'score')::integer, 0)
       or v_assessment_component -> 'reason_codes' <> v_signal -> 'reason_codes' then
      return false;
    end if;

    v_weighted_total := v_weighted_total
      + (v_policy_component ->> 'weight')::integer
        * coalesce((v_signal ->> 'score')::integer, 0);
    v_expected_hard_failure := v_expected_hard_failure
      or (v_signal ->> 'hard_failure')::boolean
      or (v_signal -> 'score') = 'null'::jsonb;
    for v_reason in
      select item.value
      from jsonb_array_elements_text(v_signal -> 'reason_codes')
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if not (v_reason = any(v_expected_reasons)) then
        v_expected_reasons := array_append(v_expected_reasons, v_reason);
      end if;
    end loop;
  end loop;

  if cardinality(v_policy_ids) <> cardinality(v_allowed_ids)
     or cardinality(v_policy_ids) <> (
       select count(distinct value) from unnest(v_policy_ids) as item(value)
     )
     or not (v_policy_ids @> v_allowed_ids and v_policy_ids <@ v_allowed_ids)
     or v_weight_total <> 100
     or (p_assessment ->> 'score')::integer <> (v_weighted_total + 50) / 100
     or (p_assessment ->> 'hard_failure')::boolean <> v_expected_hard_failure
     or p_assessment -> 'reason_codes' <> to_jsonb(v_expected_reasons)
     or p_assessment -> 'policy_identity' <> jsonb_build_object(
       'policy_id', p_policy_snapshot ->> 'policy_id',
       'policy_version', p_policy_snapshot ->> 'policy_version'
     ) then
    return false;
  end if;

  v_policy_canonical := '{"components":[' || v_canonical_components
    || '],"mode":"shadow","policy_id":"' || (p_policy_snapshot ->> 'policy_id')
    || '","policy_version":"' || (p_policy_snapshot ->> 'policy_version')
    || '","schema_version":"1.0","status":"uncalibrated"}';
  v_computed_policy_sha256 := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_policy_canonical, 'UTF8'), 'sha256'),
    'hex'
  );

  if p_shadow is null
     or jsonb_typeof(p_shadow) <> 'object'
     or octet_length(p_shadow::text) > 16384
     or not (p_shadow ?& v_shadow_keys)
     or p_shadow - v_shadow_keys <> '{}'::jsonb
     or jsonb_typeof(p_shadow -> 'schema_version') <> 'string'
     or p_shadow ->> 'schema_version' <> '1.0'
     or jsonb_typeof(p_shadow -> 'mode') <> 'string'
     or p_shadow ->> 'mode' <> 'shadow'
     or jsonb_typeof(p_shadow -> 'score') <> 'number'
     or coalesce(p_shadow ->> 'score', '') !~ '^(0|[1-9][0-9]{0,2})$'
     or (p_shadow ->> 'score')::integer not between 0 and 100
     or p_shadow -> 'is_probability' <> 'false'::jsonb
     or jsonb_typeof(p_shadow -> 'hard_failure') <> 'boolean'
     or p_shadow -> 'threshold_applied' <> 'false'::jsonb
     or jsonb_typeof(p_shadow -> 'review_required') <> 'boolean'
     or jsonb_typeof(p_shadow -> 'status') <> 'string'
     or p_shadow ->> 'status' not in ('complete', 'degraded', 'review_required')
     or not teamflow_private.valid_reason_codes(p_shadow -> 'reason_codes')
     or jsonb_typeof(p_shadow -> 'policy_identity') <> 'object'
     or not ((p_shadow -> 'policy_identity') ?& array['policy_id', 'policy_version'])
     or (p_shadow -> 'policy_identity') - array['policy_id', 'policy_version']
          <> '{}'::jsonb
     or jsonb_typeof(p_shadow -> 'policy_identity' -> 'policy_id') <> 'string'
     or coalesce(p_shadow -> 'policy_identity' ->> 'policy_id', '')
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
     or jsonb_typeof(p_shadow -> 'policy_identity' -> 'policy_version') <> 'string'
     or coalesce(p_shadow -> 'policy_identity' ->> 'policy_version', '')
          !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     or jsonb_typeof(p_shadow -> 'policy_sha256') <> 'string'
     or coalesce(p_shadow ->> 'policy_sha256', '') !~ '^[0-9a-f]{64}$'
     or p_policy_sha256 is null
     or p_policy_sha256 !~ '^[0-9a-f]{64}$'
     or p_policy_sha256 <> v_computed_policy_sha256
     or p_threshold_applied is distinct from false
     or p_status not in ('complete', 'degraded', 'review_required')
     or p_review_required is null then
    return false;
  end if;

  if p_assessment -> 'score' <> p_shadow -> 'score'
     or p_assessment -> 'hard_failure' <> p_shadow -> 'hard_failure'
     or p_assessment -> 'reason_codes' <> p_shadow -> 'reason_codes'
     or p_assessment -> 'policy_identity' <> p_shadow -> 'policy_identity'
     or p_shadow ->> 'policy_sha256' <> p_policy_sha256
     or p_shadow ->> 'status' <> p_status
     or (p_shadow ->> 'review_required')::boolean <> p_review_required
     or p_review_required <> (p_status = 'review_required') then
    return false;
  end if;
  if (p_assessment ->> 'hard_failure')::boolean
     and (
       jsonb_array_length(p_assessment -> 'reason_codes') = 0
       or not p_review_required
     ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$function$;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'resume_review_runs_confidence_provenance'
      and conrelid = 'public.resume_review_runs'::regclass
  ) then
    alter table public.resume_review_runs
      add constraint resume_review_runs_confidence_provenance check (
        (
          confidence_assessment is null
          and confidence_shadow_record is null
          and confidence_policy_snapshot is null
          and confidence_signal_snapshot is null
          and confidence_policy_sha256 is null
          and confidence_threshold_applied is null
        )
        or
        (
          confidence_assessment is not null
          and confidence_shadow_record is not null
          and confidence_policy_snapshot is not null
          and confidence_signal_snapshot is not null
          and confidence_policy_sha256 is not null
          and confidence_threshold_applied is not null
          and teamflow_private.valid_confidence_provenance(
            confidence_assessment,
            confidence_shadow_record,
            confidence_policy_snapshot,
            confidence_signal_snapshot,
            confidence_policy_sha256,
            confidence_threshold_applied,
            status,
            review_required
          )
        )
      );
  end if;
end
$constraints$;

create or replace function teamflow_private.valid_resume_review_proposal_artifacts(
  p_role_policies jsonb,
  p_evaluation jsonb,
  p_question_plan jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_policy jsonb;
  v_match jsonb;
  v_policy_roles text[] := array[]::text[];
  v_match_roles text[] := array[]::text[];
  v_top_role_id text;
  v_top_score integer;
  v_second_score integer;
  v_recommended_type text;
  v_previous_role_id text;
  v_previous_score integer;
begin
  if jsonb_typeof(p_role_policies) <> 'array'
     or jsonb_array_length(p_role_policies) not between 1 and 5
     or octet_length(p_role_policies::text) > 1048576
     or jsonb_typeof(p_evaluation) <> 'object'
     or p_evaluation ->> 'schema_version' <> '1.0'
     or octet_length(p_evaluation::text) > 262144
     or jsonb_typeof(p_evaluation -> 'ranked_roles') <> 'array'
     or jsonb_array_length(p_evaluation -> 'ranked_roles')
          <> jsonb_array_length(p_role_policies)
     or jsonb_typeof(p_evaluation -> 'limitations') <> 'array'
     or jsonb_array_length(p_evaluation -> 'limitations') > 20
     or (
       p_question_plan is not null
       and (
         jsonb_typeof(p_question_plan) <> 'object'
         or octet_length(p_question_plan::text) > 262144
       )
     ) then
    return false;
  end if;

  for v_policy in
    select item.value from jsonb_array_elements(p_role_policies) as item(value)
  loop
    if jsonb_typeof(v_policy) <> 'object'
       or v_policy ->> 'schema_version' <> '1.0'
       or coalesce(v_policy ->> 'role_id', '') !~ v_uuid_pattern
       or jsonb_typeof(v_policy -> 'role_title') <> 'string'
       or char_length(v_policy ->> 'role_title') not between 1 and 1000
       or jsonb_typeof(v_policy -> 'policy_identity') <> 'object'
       or coalesce(v_policy -> 'policy_identity' ->> 'policy_id', '')
            !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
       or coalesce(v_policy -> 'policy_identity' ->> 'policy_version', '')
            !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
       or jsonb_typeof(v_policy -> 'criteria') <> 'array'
       or jsonb_array_length(v_policy -> 'criteria') not between 1 and 30 then
      return false;
    end if;
    v_policy_roles := array_append(v_policy_roles, v_policy ->> 'role_id');
  end loop;
  if cardinality(v_policy_roles) <>
     (select count(distinct role_id) from unnest(v_policy_roles) as role_id) then
    return false;
  end if;

  for v_match in
    select item.value
    from jsonb_array_elements(p_evaluation -> 'ranked_roles') as item(value)
  loop
    if jsonb_typeof(v_match) <> 'object'
       or coalesce(v_match ->> 'role_id', '') !~ v_uuid_pattern
       or coalesce(v_match ->> 'deterministic_score', '') !~ '^[0-9]{1,3}$'
       or (v_match ->> 'deterministic_score')::integer not between 0 and 100
       or jsonb_typeof(v_match -> 'scoring_policy') <> 'object'
       or jsonb_typeof(v_match -> 'criterion_assessments') <> 'array'
       or jsonb_array_length(v_match -> 'criterion_assessments') not between 1 and 30
       or jsonb_typeof(v_match -> 'gaps') <> 'array'
       or jsonb_array_length(v_match -> 'gaps') > 30 then
      return false;
    end if;
    if v_previous_score is not null and (
      v_previous_score < (v_match ->> 'deterministic_score')::integer
      or (
        v_previous_score = (v_match ->> 'deterministic_score')::integer
        and v_previous_role_id > (v_match ->> 'role_id')
      )
    ) then
      return false;
    end if;
    v_previous_score := (v_match ->> 'deterministic_score')::integer;
    v_previous_role_id := v_match ->> 'role_id';
    v_match_roles := array_append(v_match_roles, v_match ->> 'role_id');
  end loop;
  if cardinality(v_match_roles) <>
     (select count(distinct role_id) from unnest(v_match_roles) as role_id) then
    return false;
  end if;
  if exists (
    (select unnest(v_policy_roles) except select unnest(v_match_roles))
    union all
    (select unnest(v_match_roles) except select unnest(v_policy_roles))
  ) then
    return false;
  end if;

  v_top_role_id := p_evaluation -> 'ranked_roles' -> 0 ->> 'role_id';
  v_top_score := (p_evaluation -> 'ranked_roles' -> 0 ->> 'deterministic_score')::integer;
  v_second_score := case
    when jsonb_array_length(p_evaluation -> 'ranked_roles') > 1
    then (p_evaluation -> 'ranked_roles' -> 1 ->> 'deterministic_score')::integer
    else null
  end;
  if v_top_role_id !~ v_uuid_pattern
     or v_top_score not between 0 and 100
     or (
       select count(*)
       from jsonb_array_elements(p_role_policies) as item(value)
       where item.value ->> 'role_id' = v_top_role_id
     ) <> 1 then
    return false;
  end if;

  if not (p_evaluation ? 'recommended_role_id') then
    return false;
  end if;
  v_recommended_type := jsonb_typeof(p_evaluation -> 'recommended_role_id');
  if v_recommended_type not in ('null', 'string')
     or (
       v_recommended_type = 'string'
       and coalesce(p_evaluation ->> 'recommended_role_id', '') !~ v_uuid_pattern
     )
     or (
       (v_top_score = 0 or v_second_score = v_top_score)
       and v_recommended_type <> 'null'
     )
     or (
       v_top_score > 0
       and v_second_score is distinct from v_top_score
       and (
         v_recommended_type <> 'string'
         or p_evaluation ->> 'recommended_role_id' <> v_top_role_id
       )
     ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function teamflow_private.jsonb_sha256(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $function$
  select encode(
    extensions.digest(convert_to(p_value::text, 'UTF8'), 'sha256'),
    'hex'
  );
$function$;

create or replace function teamflow_private.resume_review_thread_id(
  p_merchant_id uuid,
  p_request_id uuid
)
returns text
language sql
immutable
strict
set search_path = ''
as $function$
  select 'rrh-v1-' || encode(
    extensions.digest(
      convert_to(
        'teamflow:resume-review-hitl:1.0.0:'
        || p_merchant_id::text || ':' || p_request_id::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$function$;

create or replace function teamflow_private.resolve_active_membership(
  p_actor_id uuid
)
returns table (merchant_id uuid, membership_role text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_merchant_id uuid;
  v_role text;
begin
  if p_actor_id is null then
    raise exception 'teamflow_actor_required' using errcode = 'PT403';
  end if;

  select count(*)
  into v_count
  from public.merchant_memberships as m
  where m.user_id = p_actor_id
    and m.status = 'active';

  if v_count = 0 then
    raise exception 'teamflow_active_membership_required' using errcode = 'PT403';
  end if;
  if v_count <> 1 then
    raise exception 'teamflow_active_membership_ambiguous' using errcode = 'PT409';
  end if;

  select m.merchant_id, m.role
  into v_merchant_id, v_role
  from public.merchant_memberships as m
  where m.user_id = p_actor_id
    and m.status = 'active';

  return query select v_merchant_id, v_role;
end;
$function$;

create or replace function teamflow_private.append_resume_review_event(
  p_merchant_id uuid,
  p_workflow_id uuid,
  p_event_key text,
  p_event_type text,
  p_actor_id uuid,
  p_review_id uuid default null,
  p_decision_id uuid default null,
  p_event_data jsonb default '{}'::jsonb
)
returns table (event_id uuid, event_sequence bigint, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.resume_review_events%rowtype;
  v_sequence bigint;
  v_id uuid;
begin
  if p_event_key is null
     or p_event_key !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,199}$'
     or p_event_type not in (
       'workflow_created', 'review_created', 'decision_recorded',
       'candidate_score_revised', 'workflow_completed',
       'workflow_rejected', 'workflow_failed'
     )
     or p_event_data is null
     or jsonb_typeof(p_event_data) <> 'object'
     or octet_length(p_event_data::text) > 8192 then
    raise exception 'teamflow_invalid_event' using errcode = '22023';
  end if;

  perform 1
  from public.resume_review_workflows as w
  where w.merchant_id = p_merchant_id and w.id = p_workflow_id
  for update;
  if not found then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;

  select e.* into v_existing
  from public.resume_review_events as e
  where e.merchant_id = p_merchant_id
    and e.workflow_id = p_workflow_id
    and e.event_key = p_event_key;

  if found then
    if v_existing.event_type <> p_event_type
       or v_existing.actor_user_id is distinct from p_actor_id
       or v_existing.review_id is distinct from p_review_id
       or v_existing.decision_id is distinct from p_decision_id
       or v_existing.event_data <> p_event_data then
      raise exception 'teamflow_event_idempotency_conflict' using errcode = 'PT409';
    end if;
    return query select v_existing.id, v_existing.event_sequence, true;
    return;
  end if;

  select coalesce(max(e.event_sequence), 0) + 1
  into v_sequence
  from public.resume_review_events as e
  where e.merchant_id = p_merchant_id and e.workflow_id = p_workflow_id;
  v_id := gen_random_uuid();

  insert into public.resume_review_events (
    id, merchant_id, workflow_id, review_id, decision_id,
    event_sequence, event_key, event_type, actor_user_id, event_data
  ) values (
    v_id, p_merchant_id, p_workflow_id, p_review_id, p_decision_id,
    v_sequence, p_event_key, p_event_type, p_actor_id, p_event_data
  );

  return query select v_id, v_sequence, false;
end;
$function$;

create or replace function teamflow_private.create_resume_review_workflow(
  p_actor_id uuid,
  p_workflow_id uuid,
  p_request_id uuid,
  p_analysis_run_id uuid,
  p_document_id text,
  p_candidate_id uuid,
  p_request_sha256 text,
  p_reason_codes jsonb default '[]'::jsonb
)
returns table (
  workflow_id uuid,
  thread_id text,
  workflow_status text,
  workflow_version bigint,
  analysis_input_sha256 text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
  v_run public.resume_review_runs%rowtype;
  v_candidate_version bigint;
  v_snapshot jsonb;
  v_snapshot_sha256 text;
  v_proposed_score integer;
  v_proposed_role_id uuid;
  v_thread_id text;
  v_existing public.resume_review_workflows%rowtype;
  v_inserted_workflow_id uuid;
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager') then
    raise exception 'teamflow_manager_role_required' using errcode = 'PT403';
  end if;
  if p_workflow_id is null or p_request_id is null or p_analysis_run_id is null
     or p_candidate_id is null
     or p_document_id is null
     or p_document_id !~ '^doc-[0-9a-f]{64}$'
     or p_request_sha256 is null
     or p_request_sha256 !~ '^[0-9a-f]{64}$'
     or not teamflow_private.valid_reason_codes(p_reason_codes) then
    raise exception 'teamflow_invalid_workflow_identity' using errcode = '22023';
  end if;

  select r.* into v_run
  from public.resume_review_runs as r
  where r.merchant_id = v_merchant_id and r.id = p_analysis_run_id;
  if not found then
    raise exception 'teamflow_analysis_run_not_found' using errcode = 'PT404';
  end if;
  if v_run.request_id <> p_request_id
     or v_run.document_id <> p_document_id
     or v_run.candidate_id is distinct from p_candidate_id then
    raise exception 'teamflow_workflow_input_mismatch' using errcode = 'PT409';
  end if;
  if not teamflow_private.valid_confidence_provenance(
    v_run.confidence_assessment,
    v_run.confidence_shadow_record,
    v_run.confidence_policy_snapshot,
    v_run.confidence_signal_snapshot,
    v_run.confidence_policy_sha256,
    v_run.confidence_threshold_applied,
    v_run.status,
    v_run.review_required
  ) then
    raise exception 'teamflow_confidence_provenance_invalid' using errcode = '22023';
  end if;

  v_snapshot := v_run.agent1_evaluation;
  if jsonb_typeof(v_snapshot) <> 'object'
     or octet_length(v_snapshot::text) > 262144
     or jsonb_typeof(v_snapshot -> 'ranked_roles') <> 'array'
     or jsonb_array_length(v_snapshot -> 'ranked_roles') < 1
     or coalesce(v_snapshot -> 'ranked_roles' -> 0 ->> 'deterministic_score', '')
          !~ '^[0-9]{1,3}$' then
    raise exception 'teamflow_analysis_snapshot_invalid' using errcode = '22023';
  end if;
  v_proposed_score := (v_snapshot -> 'ranked_roles' -> 0 ->> 'deterministic_score')::integer;
  if v_proposed_score not between 0 and 100 then
    raise exception 'teamflow_analysis_score_invalid' using errcode = '22023';
  end if;
  begin
    v_proposed_role_id := nullif(v_snapshot ->> 'recommended_role_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'teamflow_analysis_role_invalid' using errcode = '22023';
  end;
  if v_proposed_role_id is not null and not exists (
    select 1 from public.jobs as j
    where j.merchant_id = v_merchant_id
      and j.id = v_proposed_role_id
      and j.is_active = true
  ) then
    raise exception 'teamflow_analysis_role_unavailable' using errcode = '22023';
  end if;

  v_snapshot_sha256 := teamflow_private.jsonb_sha256(v_snapshot);
  v_thread_id := teamflow_private.resume_review_thread_id(v_merchant_id, p_request_id);

  if exists (
    select 1
    from public.resume_review_workflows as w
    where w.id = p_workflow_id
      and (w.merchant_id <> v_merchant_id or w.request_id <> p_request_id)
  ) then
    raise exception 'teamflow_workflow_idempotency_conflict' using errcode = 'PT409';
  end if;

  -- Replay takes the workflow lock before touching candidate state, matching the
  -- workflow -> review -> candidate order used by the decision transaction.
  select w.* into v_existing
  from public.resume_review_workflows as w
  where w.merchant_id = v_merchant_id and w.request_id = p_request_id
  for update;
  if found then
    if v_existing.id <> p_workflow_id
       or v_existing.thread_id <> v_thread_id
       or v_existing.initiated_by <> p_actor_id
       or v_existing.analysis_run_id <> p_analysis_run_id
       or v_existing.document_id <> p_document_id
       or v_existing.candidate_id <> p_candidate_id
       or v_existing.request_sha256 <> p_request_sha256
       or v_existing.analysis_input_sha256 <> v_run.input_sha256
       or v_existing.result_snapshot_sha256 <> v_snapshot_sha256
       or v_existing.proposed_score <> v_proposed_score
       or v_existing.proposed_role_id is distinct from v_proposed_role_id
       or v_existing.reason_codes <> p_reason_codes then
      raise exception 'teamflow_workflow_idempotency_conflict' using errcode = 'PT409';
    end if;
    if not exists (
      select 1 from public.resume_review_events as e
      where e.merchant_id = v_merchant_id
        and e.workflow_id = v_existing.id
        and e.event_key = 'workflow:created'
    ) then
      perform * from teamflow_private.append_resume_review_event(
        v_merchant_id, v_existing.id, 'workflow:created', 'workflow_created',
        p_actor_id, null, null, jsonb_build_object('workflow_version', 1)
      );
    end if;
    return query select
      v_existing.id, v_existing.thread_id, v_existing.status,
      v_existing.version, v_existing.analysis_input_sha256, true;
    return;
  end if;

  -- A non-locking existence read supplies the insert value. Once this transaction
  -- owns the new workflow row it locks the candidate and refreshes the base version.
  select c.score_version into v_candidate_version
  from public.candidates as c
  where c.merchant_id = v_merchant_id and c.id = p_candidate_id;
  if not found then
    raise exception 'teamflow_candidate_not_found' using errcode = 'PT404';
  end if;

  insert into public.resume_review_workflows (
    id, merchant_id, request_id, thread_id, initiated_by,
    analysis_run_id, document_id,
    candidate_id, request_sha256, analysis_input_sha256,
    result_snapshot, result_snapshot_sha256,
    proposed_score, proposed_role_id, base_candidate_score_version,
    status, version, reason_codes
  ) values (
    p_workflow_id, v_merchant_id, p_request_id, v_thread_id, p_actor_id,
    p_analysis_run_id, p_document_id, p_candidate_id,
    p_request_sha256, v_run.input_sha256,
    v_snapshot, v_snapshot_sha256, v_proposed_score, v_proposed_role_id,
    v_candidate_version, 'running', 1, p_reason_codes
  )
  on conflict do nothing
  returning id into v_inserted_workflow_id;

  select w.* into v_existing
  from public.resume_review_workflows as w
  where w.merchant_id = v_merchant_id and w.request_id = p_request_id
  for update;
  if not found then
    raise exception 'teamflow_workflow_idempotency_conflict' using errcode = 'PT409';
  end if;

  if v_inserted_workflow_id is not null then
    select c.score_version into v_candidate_version
    from public.candidates as c
    where c.merchant_id = v_merchant_id and c.id = p_candidate_id
    for share;
    update public.resume_review_workflows as target
    set base_candidate_score_version = v_candidate_version
    where target.merchant_id = v_merchant_id and target.id = v_existing.id
    returning target.* into v_existing;
  end if;

  if v_existing.id <> p_workflow_id
     or v_existing.thread_id <> v_thread_id
     or v_existing.initiated_by <> p_actor_id
     or v_existing.analysis_run_id <> p_analysis_run_id
     or v_existing.document_id <> p_document_id
     or v_existing.candidate_id <> p_candidate_id
     or v_existing.request_sha256 <> p_request_sha256
     or v_existing.analysis_input_sha256 <> v_run.input_sha256
     or v_existing.result_snapshot_sha256 <> v_snapshot_sha256
     or v_existing.proposed_score <> v_proposed_score
     or v_existing.proposed_role_id is distinct from v_proposed_role_id
     or v_existing.reason_codes <> p_reason_codes
     then
    raise exception 'teamflow_workflow_idempotency_conflict' using errcode = 'PT409';
  end if;

  if not exists (
    select 1 from public.resume_review_events as e
    where e.merchant_id = v_merchant_id
      and e.workflow_id = v_existing.id
      and e.event_key = 'workflow:created'
  ) then
    perform * from teamflow_private.append_resume_review_event(
      v_merchant_id,
      v_existing.id,
      'workflow:created',
      'workflow_created',
      p_actor_id,
      null,
      null,
      jsonb_build_object('workflow_version', 1)
    );
    return query select
      v_existing.id, v_existing.thread_id, v_existing.status,
      v_existing.version, v_existing.analysis_input_sha256,
      v_inserted_workflow_id is null;
  else
    return query select
      v_existing.id, v_existing.thread_id, v_existing.status,
      v_existing.version, v_existing.analysis_input_sha256,
      v_inserted_workflow_id is null;
  end if;
end;
$function$;

create or replace function teamflow_private.prepare_resume_review_workflow(
  p_actor_id uuid,
  p_workflow_id uuid,
  p_analysis_run_id uuid,
  p_request_id uuid,
  p_request_sha256 text,
  p_document_id text,
  p_candidate_id uuid,
  p_analysis_input_sha256 text,
  p_extraction_snapshot_sha256 text,
  p_policy_sha256 text,
  p_role_policy_snapshot jsonb,
  p_confidence_assessment jsonb,
  p_confidence_shadow_record jsonb,
  p_confidence_policy_snapshot jsonb,
  p_confidence_signal_snapshot jsonb,
  p_confidence_policy_sha256 text,
  p_confidence_threshold_applied boolean,
  p_analysis_status text,
  p_review_required boolean,
  p_agent1_evaluation jsonb,
  p_questions_status text,
  p_question_plan jsonb,
  p_reason_codes jsonb,
  p_workflow_reason_codes jsonb
)
returns table (
  workflow_id uuid,
  analysis_run_id uuid,
  merchant_id uuid,
  request_id uuid,
  request_sha256 text,
  analysis_input_sha256 text,
  thread_id text,
  workflow_status text,
  workflow_version bigint,
  reason_codes jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
  v_run public.resume_review_runs%rowtype;
  v_inserted_run_id uuid;
  v_workflow_id uuid;
  v_thread_id text;
  v_workflow_status text;
  v_workflow_version bigint;
  v_derived_analysis_sha256 text;
  v_workflow_replayed boolean;
  v_source_replayed boolean;
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager') then
    raise exception 'teamflow_manager_role_required' using errcode = 'PT403';
  end if;
  if p_analysis_run_id is null
     or p_analysis_input_sha256 !~ '^[0-9a-f]{64}$'
     or p_extraction_snapshot_sha256 !~ '^[0-9a-f]{64}$'
     or p_policy_sha256 !~ '^[0-9a-f]{64}$'
     or p_analysis_status not in ('complete', 'degraded', 'review_required')
     or p_questions_status not in ('complete', 'degraded', 'not_required', 'skipped')
     or jsonb_typeof(p_role_policy_snapshot) <> 'array'
     or jsonb_array_length(p_role_policy_snapshot) not between 1 and 5
     or jsonb_typeof(p_agent1_evaluation) <> 'object'
     or not teamflow_private.valid_resume_review_proposal_artifacts(
       p_role_policy_snapshot,
       p_agent1_evaluation,
       p_question_plan
     )
     or not teamflow_private.valid_confidence_provenance(
       p_confidence_assessment,
       p_confidence_shadow_record,
       p_confidence_policy_snapshot,
       p_confidence_signal_snapshot,
       p_confidence_policy_sha256,
       p_confidence_threshold_applied,
       p_analysis_status,
       p_review_required
     )
     or not teamflow_private.valid_reason_codes(p_reason_codes)
     or not teamflow_private.valid_reason_codes(p_workflow_reason_codes)
     or (p_analysis_status = 'review_required') <> p_review_required
     or (
       p_questions_status = 'complete'
       and (p_question_plan is null or jsonb_typeof(p_question_plan) <> 'object')
     )
     or (p_questions_status <> 'complete' and p_question_plan is not null) then
    raise exception 'teamflow_analysis_artifact_invalid' using errcode = '22023';
  end if;

  insert into public.resume_review_runs (
    id, schema_version, request_id, merchant_id, document_id, candidate_id,
    input_sha256, extraction_snapshot_sha256, policy_sha256,
    role_policy_snapshot,
    confidence_assessment, confidence_shadow_record,
    confidence_policy_snapshot, confidence_signal_snapshot,
    confidence_policy_sha256, confidence_threshold_applied,
    status, review_required, agent1_evaluation,
    questions_status, question_plan, reason_codes
  ) values (
    p_analysis_run_id, '1.0', p_request_id, v_merchant_id,
    p_document_id, p_candidate_id, p_analysis_input_sha256,
    p_extraction_snapshot_sha256, p_policy_sha256,
    p_role_policy_snapshot,
    p_confidence_assessment, p_confidence_shadow_record,
    p_confidence_policy_snapshot, p_confidence_signal_snapshot,
    p_confidence_policy_sha256, p_confidence_threshold_applied,
    p_analysis_status, p_review_required,
    p_agent1_evaluation, p_questions_status, p_question_plan, p_reason_codes
  )
  on conflict do nothing
  returning id into v_inserted_run_id;
  v_source_replayed := v_inserted_run_id is null;

  select r.* into v_run
  from public.resume_review_runs as r
  where r.merchant_id = v_merchant_id and r.request_id = p_request_id;
  if not found then
    raise exception 'teamflow_analysis_idempotency_conflict' using errcode = 'PT409';
  end if;
  if v_run.document_id <> p_document_id
     or v_run.candidate_id is distinct from p_candidate_id
     or v_run.input_sha256 <> p_analysis_input_sha256
     or v_run.extraction_snapshot_sha256 <> p_extraction_snapshot_sha256
     or v_run.policy_sha256 <> p_policy_sha256
     or v_run.role_policy_snapshot <> p_role_policy_snapshot
     or v_run.confidence_assessment <> p_confidence_assessment
     or v_run.confidence_shadow_record <> p_confidence_shadow_record
     or v_run.confidence_policy_snapshot <> p_confidence_policy_snapshot
     or v_run.confidence_signal_snapshot <> p_confidence_signal_snapshot
     or v_run.confidence_policy_sha256 <> p_confidence_policy_sha256
     or v_run.confidence_threshold_applied <> p_confidence_threshold_applied
     or v_run.status <> p_analysis_status
     or v_run.review_required <> p_review_required
     or v_run.agent1_evaluation <> p_agent1_evaluation
     or v_run.questions_status <> p_questions_status
     or v_run.question_plan is distinct from p_question_plan
     or v_run.reason_codes <> p_reason_codes then
    raise exception 'teamflow_analysis_idempotency_conflict' using errcode = 'PT409';
  end if;

  select c.workflow_id, c.thread_id, c.workflow_status, c.workflow_version,
         c.analysis_input_sha256, c.replayed
  into v_workflow_id, v_thread_id, v_workflow_status, v_workflow_version,
       v_derived_analysis_sha256, v_workflow_replayed
  from teamflow_private.create_resume_review_workflow(
    p_actor_id,
    p_workflow_id,
    p_request_id,
    v_run.id,
    p_document_id,
    p_candidate_id,
    p_request_sha256,
    p_workflow_reason_codes
  ) as c;

  if v_derived_analysis_sha256 <> p_analysis_input_sha256 then
    raise exception 'teamflow_analysis_idempotency_conflict' using errcode = 'PT409';
  end if;

  return query select
    v_workflow_id,
    v_run.id,
    v_merchant_id,
    p_request_id,
    p_request_sha256,
    v_derived_analysis_sha256,
    v_thread_id,
    v_workflow_status,
    v_workflow_version,
    p_workflow_reason_codes,
    (v_source_replayed or v_workflow_replayed);
end;
$function$;

create or replace function teamflow_private.create_resume_review(
  p_workflow_id uuid,
  p_request_id uuid,
  p_request_sha256 text,
  p_analysis_run_id uuid,
  p_reason_codes jsonb
)
returns table (
  review_id uuid,
  review_version bigint,
  review_status text,
  workflow_version bigint,
  merchant_id uuid,
  request_sha256 text,
  analysis_input_sha256 text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_workflow public.resume_review_workflows%rowtype;
  v_review public.resume_reviews%rowtype;
  v_review_id uuid;
begin
  if not teamflow_private.valid_reason_codes(p_reason_codes) then
    raise exception 'teamflow_invalid_reason_codes' using errcode = '22023';
  end if;

  select w.* into v_workflow
  from public.resume_review_workflows as w
  where w.id = p_workflow_id
  for update;
  if not found then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;
  -- The external create-workflow transaction already captured an authorized
  -- owner/manager as initiated_by. This internal durable-node transition must not
  -- strand a running workflow if that membership is revoked before graph execution.
  v_merchant_id := v_workflow.merchant_id;
  if v_workflow.request_id <> p_request_id
     or v_workflow.request_sha256 <> p_request_sha256
     or v_workflow.analysis_run_id <> p_analysis_run_id
     or v_workflow.reason_codes <> p_reason_codes
     or not exists (
       select 1
       from public.resume_review_runs as ar
       where ar.merchant_id = v_workflow.merchant_id
         and ar.id = p_analysis_run_id
         and ar.input_sha256 = v_workflow.analysis_input_sha256
     ) then
    raise exception 'teamflow_review_idempotency_conflict' using errcode = 'PT409';
  end if;

  select r.* into v_review
  from public.resume_reviews as r
  where r.merchant_id = v_merchant_id and r.workflow_id = p_workflow_id;
  if found then
    if v_review.reason_codes <> p_reason_codes then
      raise exception 'teamflow_review_idempotency_conflict' using errcode = 'PT409';
    end if;
    return query select
      v_review.id, v_review.version, v_review.status,
      v_workflow.version, v_workflow.merchant_id,
      v_workflow.request_sha256, v_workflow.analysis_input_sha256, true;
    return;
  end if;

  if v_workflow.status <> 'running' or v_workflow.version <> 1 then
    raise exception 'teamflow_workflow_not_reviewable' using errcode = 'PT409';
  end if;

  v_review_id := gen_random_uuid();
  insert into public.resume_reviews (
    id, merchant_id, workflow_id, status, version, reason_codes
  ) values (
    v_review_id, v_merchant_id, p_workflow_id, 'pending', 1, p_reason_codes
  )
  returning * into v_review;

  update public.resume_review_workflows as target
  set status = 'pending_review', version = 2, reason_codes = p_reason_codes,
      updated_at = now()
  where target.merchant_id = v_merchant_id and target.id = p_workflow_id
  returning target.* into v_workflow;

  perform * from teamflow_private.append_resume_review_event(
    v_merchant_id,
    p_workflow_id,
    'review:created',
    'review_created',
    v_workflow.initiated_by,
    v_review_id,
    null,
    jsonb_build_object('review_version', 1, 'workflow_version', 2)
  );

  return query select
    v_review.id, v_review.version, v_review.status,
    v_workflow.version, v_workflow.merchant_id,
    v_workflow.request_sha256, v_workflow.analysis_input_sha256, false;
end;
$function$;

create or replace function teamflow_private.decide_resume_review(
  p_actor_id uuid,
  p_workflow_id uuid,
  p_review_id uuid,
  p_decision_id uuid,
  p_expected_review_version bigint,
  p_expected_candidate_score_version bigint,
  p_action text,
  p_client_request_sha256 text,
  p_replacement_result_snapshot jsonb default null,
  p_replacement_score integer default null,
  p_replacement_role_id uuid default null,
  p_reason_code text default null
)
returns table (
  decision_id uuid,
  review_status text,
  review_version bigint,
  workflow_status text,
  workflow_version bigint,
  candidate_score_version bigint,
  applied_revision_id uuid,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
  v_workflow public.resume_review_workflows%rowtype;
  v_review public.resume_reviews%rowtype;
  v_candidate public.candidates%rowtype;
  v_existing public.resume_review_decisions%rowtype;
  v_payload jsonb;
  v_payload_sha256 text;
  v_snapshot jsonb;
  v_snapshot_sha256 text;
  v_score integer;
  v_role_id uuid;
  v_review_status text;
  v_revision_kind text;
  v_revision_id uuid;
  v_resulting_candidate_version bigint;
  v_now timestamptz := now();
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager', 'reviewer') then
    raise exception 'teamflow_review_role_required' using errcode = 'PT403';
  end if;

  if p_workflow_id is null or p_review_id is null or p_decision_id is null
     or p_expected_review_version not between 1 and 2147483647
     or p_expected_candidate_score_version not between 0 and 2147483647
     or p_action not in ('approve', 'approve_with_edits', 'reject')
     or p_client_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'teamflow_invalid_decision' using errcode = '22023';
  end if;

  if p_action = 'approve' and (
    p_replacement_result_snapshot is not null
    or p_replacement_score is not null
    or p_replacement_role_id is not null
    or p_reason_code is not null
  ) then
    raise exception 'teamflow_approve_payload_invalid' using errcode = '22023';
  elsif p_action = 'approve_with_edits' and (
    p_replacement_result_snapshot is null
    or p_replacement_score is null
    or p_reason_code is null
    or p_reason_code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
  ) then
    raise exception 'teamflow_edit_payload_invalid' using errcode = '22023';
  elsif p_action = 'reject' and (
    p_replacement_result_snapshot is not null
    or p_replacement_score is not null
    or p_replacement_role_id is not null
    or p_reason_code is null
    or p_reason_code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
  ) then
    raise exception 'teamflow_reject_payload_invalid' using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'schema_version', '2.0',
    'actor_id', p_actor_id,
    'workflow_id', p_workflow_id,
    'review_id', p_review_id,
    'decision_id', p_decision_id,
    'expected_review_version', p_expected_review_version,
    'expected_candidate_score_version', p_expected_candidate_score_version,
    'action', p_action,
    'client_request_sha256', p_client_request_sha256,
    'replacement_result_snapshot', p_replacement_result_snapshot,
    'replacement_score', p_replacement_score,
    'replacement_role_id', p_replacement_role_id,
    'reason_code', p_reason_code
  );
  v_payload_sha256 := teamflow_private.jsonb_sha256(v_payload);

  -- A decision UUID is a global idempotency identity. Serialize it before taking
  -- tenant workflow/review row locks so two workflows cannot race the primary-key
  -- check and leak a raw 23505 from the eventual insert.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('teamflow:decision:' || p_decision_id::text, 0)
  );

  select w.* into v_workflow
  from public.resume_review_workflows as w
  where w.merchant_id = v_merchant_id and w.id = p_workflow_id
  for update;
  if not found then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;

  select r.* into v_review
  from public.resume_reviews as r
  where r.merchant_id = v_merchant_id
    and r.id = p_review_id
    and r.workflow_id = p_workflow_id
  for update;
  if not found then
    raise exception 'teamflow_review_not_found' using errcode = 'PT404';
  end if;

  select d.* into v_existing
  from public.resume_review_decisions as d
  where d.id = p_decision_id;
  if found then
    if v_existing.merchant_id <> v_merchant_id
       or v_existing.workflow_id <> p_workflow_id
       or v_existing.review_id <> p_review_id
       or v_existing.actor_user_id <> p_actor_id
       or v_existing.payload_sha256 <> v_payload_sha256 then
      raise exception 'teamflow_decision_id_conflict' using errcode = 'PT409';
    end if;
    return query select
      v_existing.id,
      v_review.status,
      v_existing.resulting_review_version,
      'decision_recorded'::text,
      v_existing.resulting_workflow_version,
      coalesce(
        v_existing.resulting_candidate_score_version,
        v_existing.expected_candidate_score_version
      ),
      v_existing.applied_revision_id,
      true;
    return;
  end if;

  if v_review.status <> 'pending' or v_workflow.status <> 'pending_review' then
    raise exception 'teamflow_review_already_decided' using errcode = 'PT409';
  end if;
  if v_review.version <> p_expected_review_version then
    raise exception 'teamflow_stale_review_version' using errcode = 'PT409';
  end if;
  if v_workflow.base_candidate_score_version
       <> p_expected_candidate_score_version then
    raise exception 'teamflow_stale_candidate_version' using errcode = 'PT409';
  end if;

  if p_action = 'reject' then
    select c.* into v_candidate
    from public.candidates as c
    where c.merchant_id = v_merchant_id and c.id = v_workflow.candidate_id;
  else
    select c.* into v_candidate
    from public.candidates as c
    where c.merchant_id = v_merchant_id and c.id = v_workflow.candidate_id
    for update;
  end if;
  if not found then
    raise exception 'teamflow_candidate_not_found' using errcode = 'PT404';
  end if;
  if p_action <> 'reject'
     and v_candidate.score_version <> p_expected_candidate_score_version then
    raise exception 'teamflow_stale_candidate_version' using errcode = 'PT409';
  end if;

  if p_action = 'approve' then
    v_snapshot := v_workflow.result_snapshot;
    v_score := v_workflow.proposed_score;
    v_role_id := v_workflow.proposed_role_id;
    v_review_status := 'approved';
    v_revision_kind := 'agent_proposal';
  elsif p_action = 'approve_with_edits' then
    v_snapshot := p_replacement_result_snapshot;
    v_score := p_replacement_score;
    v_role_id := p_replacement_role_id;
    v_review_status := 'edited';
    v_revision_kind := 'reviewer_edit';
  else
    v_snapshot := null;
    v_score := null;
    v_role_id := null;
    v_review_status := 'rejected';
    v_revision_kind := null;
  end if;

  if p_action <> 'reject' then
    if jsonb_typeof(v_snapshot) <> 'object'
       or octet_length(v_snapshot::text) > 262144
       or jsonb_typeof(v_snapshot -> 'ranked_roles') <> 'array'
       or jsonb_array_length(v_snapshot -> 'ranked_roles') < 1
       or coalesce(v_snapshot -> 'ranked_roles' -> 0 ->> 'deterministic_score', '')
            !~ '^[0-9]{1,3}$'
       or (v_snapshot -> 'ranked_roles' -> 0 ->> 'deterministic_score')::integer
            is distinct from v_score
       or coalesce(v_snapshot ->> 'recommended_role_id', '')
            <> coalesce(v_role_id::text, '')
       or v_score not between 0 and 100 then
      raise exception 'teamflow_decision_result_invalid' using errcode = '22023';
    end if;
    if v_role_id is not null and not exists (
      select 1 from public.jobs as j
      where j.merchant_id = v_merchant_id
        and j.id = v_role_id
        and j.is_active = true
    ) then
      raise exception 'teamflow_decision_role_unavailable' using errcode = '22023';
    end if;

    v_snapshot_sha256 := teamflow_private.jsonb_sha256(v_snapshot);
    v_revision_id := gen_random_uuid();
    v_resulting_candidate_version := v_candidate.score_version + 1;

    insert into public.candidate_score_revisions (
      id, merchant_id, candidate_id, workflow_id, review_id, decision_id,
      revision_kind, candidate_score_version, previous_fit_score, fit_score,
      role_id, result_snapshot, result_snapshot_sha256, actor_user_id, created_at
    ) values (
      v_revision_id, v_merchant_id, v_candidate.id, p_workflow_id,
      p_review_id, p_decision_id, v_revision_kind,
      v_resulting_candidate_version, v_candidate.fit_score, v_score,
      v_role_id, v_snapshot, v_snapshot_sha256, p_actor_id, v_now
    );
  else
    v_revision_id := null;
    v_resulting_candidate_version := null;
  end if;

  insert into public.resume_review_decisions (
    id, merchant_id, workflow_id, review_id, candidate_id, actor_user_id,
    action, reason_code, expected_review_version,
    expected_candidate_score_version, client_request_sha256, payload_sha256,
    resulting_review_version, resulting_workflow_version,
    resulting_candidate_score_version,
    applied_revision_id, created_at
  ) values (
    p_decision_id, v_merchant_id, p_workflow_id, p_review_id,
    v_candidate.id, p_actor_id, p_action, p_reason_code,
    p_expected_review_version, p_expected_candidate_score_version,
    p_client_request_sha256, v_payload_sha256,
    v_review.version + 1, v_workflow.version + 1,
    v_resulting_candidate_version,
    v_revision_id, v_now
  );

  if p_action <> 'reject' then
    update public.candidates
    set fit_score = v_score,
        analysis = v_snapshot,
        score_version = v_resulting_candidate_version,
        current_score_revision_id = v_revision_id,
        score_updated_at = v_now
    where merchant_id = v_merchant_id and id = v_candidate.id;
  end if;

  update public.resume_reviews
  set status = v_review_status,
      version = v_review.version + 1,
      decided_by = p_actor_id,
      decided_at = v_now,
      updated_at = v_now
  where merchant_id = v_merchant_id and id = p_review_id;

  update public.resume_review_workflows as target
  set status = 'decision_recorded',
      version = v_workflow.version + 1,
      decision_recorded_at = v_now,
      updated_at = v_now
  where target.merchant_id = v_merchant_id and target.id = p_workflow_id;

  perform * from teamflow_private.append_resume_review_event(
    v_merchant_id,
    p_workflow_id,
    'decision:' || p_decision_id::text || ':recorded',
    'decision_recorded',
    p_actor_id,
    p_review_id,
    p_decision_id,
    jsonb_build_object(
      'action', p_action,
      'review_version', v_review.version + 1,
      'workflow_version', v_workflow.version + 1
    )
  );

  if p_action <> 'reject' then
    perform * from teamflow_private.append_resume_review_event(
      v_merchant_id,
      p_workflow_id,
      'decision:' || p_decision_id::text || ':score-revised',
      'candidate_score_revised',
      p_actor_id,
      p_review_id,
      p_decision_id,
      jsonb_build_object(
        'candidate_score_version', v_resulting_candidate_version,
        'revision_id', v_revision_id
      )
    );
  end if;

  return query select
    p_decision_id,
    v_review_status,
    v_review.version + 1,
    'decision_recorded'::text,
    v_workflow.version + 1,
    coalesce(v_resulting_candidate_version, p_expected_candidate_score_version),
    v_revision_id,
    false;
end;
$function$;

create or replace function teamflow_private.complete_resume_review_workflow(
  p_workflow_id uuid,
  p_decision_id uuid,
  p_review_id uuid,
  p_expected_review_version bigint
)
returns table (
  review_status text,
  review_version bigint,
  workflow_status text,
  workflow_version bigint,
  merchant_id uuid,
  request_id uuid,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_workflow public.resume_review_workflows%rowtype;
  v_decision public.resume_review_decisions%rowtype;
  v_review public.resume_reviews%rowtype;
  v_target_status text;
  v_event_type text;
  v_now timestamptz := now();
begin
  select w.* into v_workflow
  from public.resume_review_workflows as w
  where w.id = p_workflow_id
  for update;
  if not found then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;

  select d.* into v_decision
  from public.resume_review_decisions as d
  where d.merchant_id = v_workflow.merchant_id
    and d.workflow_id = p_workflow_id
    and d.id = p_decision_id;
  if not found then
    raise exception 'teamflow_decision_not_found' using errcode = 'PT404';
  end if;
  if v_decision.review_id <> p_review_id
     or v_decision.expected_review_version <> p_expected_review_version then
    raise exception 'teamflow_decision_reference_conflict' using errcode = 'PT409';
  end if;
  -- Authorization was committed with the immutable decision. Reconciliation must
  -- finish even if the actor is suspended after the candidate write commits.
  v_merchant_id := v_workflow.merchant_id;
  select r.* into v_review
  from public.resume_reviews as r
  where r.merchant_id = v_merchant_id and r.id = v_decision.review_id;

  if v_decision.action = 'reject' then
    v_target_status := 'rejected';
    v_event_type := 'workflow_rejected';
  else
    v_target_status := 'completed';
    v_event_type := 'workflow_completed';
  end if;

  if v_workflow.status = v_target_status then
    return query select
      v_review.status, v_review.version,
      v_workflow.status, v_workflow.version,
      v_workflow.merchant_id, v_workflow.request_id, true;
    return;
  end if;
  if v_workflow.status <> 'decision_recorded' then
    raise exception 'teamflow_workflow_not_reconcilable' using errcode = 'PT409';
  end if;

  update public.resume_review_workflows as target
  set status = v_target_status,
      version = v_workflow.version + 1,
      completed_at = v_now,
      updated_at = v_now
  where target.merchant_id = v_merchant_id and target.id = p_workflow_id
  returning target.* into v_workflow;

  perform * from teamflow_private.append_resume_review_event(
    v_merchant_id,
    p_workflow_id,
    'decision:' || p_decision_id::text || ':reconciled',
    v_event_type,
    v_decision.actor_user_id,
    v_decision.review_id,
    p_decision_id,
    jsonb_build_object('workflow_version', v_workflow.version)
  );

  return query select
    v_review.status, v_review.version,
    v_workflow.status, v_workflow.version,
    v_workflow.merchant_id, v_workflow.request_id, false;
end;
$function$;

create or replace function teamflow_private.inspect_resume_review(
  p_actor_id uuid,
  p_workflow_id uuid
)
returns table (
  schema_version text,
  workflow_id uuid,
  request_id uuid,
  document_id text,
  workflow_status text,
  workflow_version bigint,
  review_id uuid,
  review_version bigint,
  reason_codes jsonb,
  decision_id uuid,
  decision_action text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;

  if not exists (
    select 1 from public.resume_review_workflows as w
    where w.merchant_id = v_merchant_id and w.id = p_workflow_id
  ) then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;

  return query
  select
    w.schema_version,
    w.id,
    w.request_id,
    w.document_id,
    w.status,
    w.version,
    r.id,
    r.version,
    w.reason_codes,
    d.id,
    d.action
  from public.resume_review_workflows as w
  left join public.resume_reviews as r
    on r.merchant_id = w.merchant_id and r.workflow_id = w.id
  left join public.resume_review_decisions as d
    on d.merchant_id = w.merchant_id and d.review_id = r.id
  where w.merchant_id = v_merchant_id and w.id = p_workflow_id;
end;
$function$;

-- Reviewer discovery is keyset-paginated and tenant-derived. The extra candidate in
-- the internal CTE is used only to compute has_more and never crosses the RPC.
create or replace function teamflow_private.list_pending_resume_reviews(
  p_actor_id uuid,
  p_limit integer default 50,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  workflow_id uuid,
  candidate_id uuid,
  created_at timestamptz,
  workflow_version bigint,
  review_id uuid,
  review_version bigint,
  reason_codes jsonb,
  top_role_id uuid,
  top_role_title text,
  top_role_score integer,
  recommended_role_id uuid,
  has_more boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
begin
  if p_limit is null
     or p_limit not between 1 and 50
     or (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'teamflow_invalid_pending_review_cursor' using errcode = '22023';
  end if;

  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager', 'reviewer') then
    raise exception 'teamflow_reviewer_role_required' using errcode = 'PT403';
  end if;

  if exists (
    select 1
    from public.resume_review_workflows as w
    left join public.resume_reviews as r
      on r.merchant_id = w.merchant_id
     and r.workflow_id = w.id
     and r.status = 'pending'
    left join public.resume_review_runs as ar
      on ar.merchant_id = w.merchant_id
     and ar.id = w.analysis_run_id
     and ar.input_sha256 = w.analysis_input_sha256
    where w.merchant_id = v_merchant_id
      and w.status = 'pending_review'
      and (
        r.id is null
        or ar.id is null
        or w.result_snapshot is distinct from ar.agent1_evaluation
        or not teamflow_private.valid_resume_review_proposal_artifacts(
          ar.role_policy_snapshot,
          ar.agent1_evaluation,
          ar.question_plan
        )
        or not teamflow_private.valid_confidence_provenance(
          ar.confidence_assessment,
          ar.confidence_shadow_record,
          ar.confidence_policy_snapshot,
          ar.confidence_signal_snapshot,
          ar.confidence_policy_sha256,
          ar.confidence_threshold_applied,
          ar.status,
          ar.review_required
        )
      )
  ) then
    raise exception 'teamflow_pending_review_projection_invalid' using errcode = '22023';
  end if;

  return query
  with pending as materialized (
    select
      w.id as workflow_id,
      w.candidate_id,
      w.created_at,
      w.version as workflow_version,
      r.id as review_id,
      r.version as review_version,
      w.reason_codes,
      (top_role.value ->> 'role_id')::uuid as top_role_id,
      policy.value ->> 'role_title' as top_role_title,
      (top_role.value ->> 'deterministic_score')::integer as top_role_score,
      nullif(ar.agent1_evaluation ->> 'recommended_role_id', '')::uuid
        as recommended_role_id
    from public.resume_review_workflows as w
    join public.resume_reviews as r
      on r.merchant_id = w.merchant_id
     and r.workflow_id = w.id
     and r.status = 'pending'
    join public.resume_review_runs as ar
      on ar.merchant_id = w.merchant_id
     and ar.id = w.analysis_run_id
     and ar.input_sha256 = w.analysis_input_sha256
    cross join lateral jsonb_array_elements(
      ar.agent1_evaluation -> 'ranked_roles'
    ) with ordinality as top_role(value, position)
    cross join lateral jsonb_array_elements(
      ar.role_policy_snapshot
    ) as policy(value)
    where w.merchant_id = v_merchant_id
      and w.status = 'pending_review'
      and top_role.position = 1
      and policy.value ->> 'role_id' = top_role.value ->> 'role_id'
      and (
        p_before_created_at is null
        or (w.created_at, w.id) < (p_before_created_at, p_before_id)
      )
    order by w.created_at desc, w.id desc
    limit p_limit + 1
  )
  select
    p.workflow_id,
    p.candidate_id,
    p.created_at,
    p.workflow_version,
    p.review_id,
    p.review_version,
    p.reason_codes,
    p.top_role_id,
    p.top_role_title,
    p.top_role_score,
    p.recommended_role_id,
    (select count(*) > p_limit from pending)
  from pending as p
  order by p.created_at desc, p.workflow_id desc
  limit p_limit;
end;
$function$;

-- One authenticated snapshot supplies lifecycle metadata and immutable proposal
-- inputs. The service validates both stored v1 contracts and emits a smaller v2
-- allowlist. The private RPC includes the bounded, hash-bound extraction solely so the
-- repository can re-prove literal quote membership; that document is discarded before
-- HTTP serialization. Contact fields, thread IDs, and checkpoint state are absent.
create or replace function teamflow_private.inspect_resume_review_detail(
  p_actor_id uuid,
  p_workflow_id uuid
)
returns table (
  schema_version text,
  workflow_id uuid,
  request_id uuid,
  document_id text,
  workflow_status text,
  workflow_version bigint,
  review_id uuid,
  review_version bigint,
  reason_codes jsonb,
  candidate_id uuid,
  created_at timestamptz,
  extraction_snapshot_sha256 text,
  policy_sha256 text,
  role_policy_snapshot jsonb,
  agent1_evaluation jsonb,
  question_plan jsonb,
  analysis_status text,
  analysis_review_required boolean,
  confidence_assessment jsonb,
  confidence_shadow_record jsonb,
  confidence_policy_snapshot jsonb,
  confidence_signal_snapshot jsonb,
  confidence_policy_sha256 text,
  confidence_threshold_applied boolean,
  document_snapshot jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager', 'reviewer') then
    raise exception 'teamflow_reviewer_role_required' using errcode = 'PT403';
  end if;

  if not exists (
    select 1
    from public.resume_review_workflows as w
    where w.merchant_id = v_merchant_id and w.id = p_workflow_id
  ) then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;

  if not exists (
    select 1
    from public.resume_review_workflows as w
    join public.resume_review_runs as ar
      on ar.merchant_id = w.merchant_id
     and ar.id = w.analysis_run_id
     and ar.input_sha256 = w.analysis_input_sha256
    join public.resume_documents as d
      on d.merchant_id = w.merchant_id
     and d.document_id = w.document_id
     and d.snapshot_sha256 = ar.extraction_snapshot_sha256
    where w.merchant_id = v_merchant_id and w.id = p_workflow_id
  ) then
    raise exception 'teamflow_proposal_source_not_found' using errcode = 'PT404';
  end if;

  if exists (
    select 1
    from public.resume_review_workflows as w
    join public.resume_review_runs as ar
      on ar.merchant_id = w.merchant_id
     and ar.id = w.analysis_run_id
     and ar.input_sha256 = w.analysis_input_sha256
    join public.resume_documents as d
      on d.merchant_id = w.merchant_id
     and d.document_id = w.document_id
     and d.snapshot_sha256 = ar.extraction_snapshot_sha256
    where w.merchant_id = v_merchant_id
      and w.id = p_workflow_id
      and (
        w.result_snapshot is distinct from ar.agent1_evaluation
        or not teamflow_private.valid_resume_review_proposal_artifacts(
          ar.role_policy_snapshot,
          ar.agent1_evaluation,
          ar.question_plan
        )
        or not teamflow_private.valid_confidence_provenance(
          ar.confidence_assessment,
          ar.confidence_shadow_record,
          ar.confidence_policy_snapshot,
          ar.confidence_signal_snapshot,
          ar.confidence_policy_sha256,
          ar.confidence_threshold_applied,
          ar.status,
          ar.review_required
        )
        or octet_length(d.text) > 400000
        or octet_length(d.source_blocks::text) > 1048576
      )
  ) then
    raise exception 'teamflow_review_proposal_invalid' using errcode = '22023';
  end if;

  return query
  select
    w.schema_version,
    w.id,
    w.request_id,
    w.document_id,
    w.status,
    w.version,
    r.id,
    r.version,
    w.reason_codes,
    w.candidate_id,
    w.created_at,
    ar.extraction_snapshot_sha256,
    ar.policy_sha256,
    ar.role_policy_snapshot,
    ar.agent1_evaluation,
    ar.question_plan,
    ar.status,
    ar.review_required,
    ar.confidence_assessment,
    ar.confidence_shadow_record,
    ar.confidence_policy_snapshot,
    ar.confidence_signal_snapshot,
    ar.confidence_policy_sha256,
    ar.confidence_threshold_applied,
    jsonb_build_object(
      'schema_version', d.schema_version,
      'merchant_id', d.merchant_id,
      'document_id', d.document_id,
      'content_sha256', d.content_sha256,
      'snapshot_sha256', d.snapshot_sha256,
      'status', d.status,
      'text', d.text,
      'source_blocks', d.source_blocks,
      'extraction_method', d.extraction_method,
      'model_id', d.model_id,
      'embedding_available', d.embedding_available,
      'mock', d.mock,
      'warnings', d.warnings,
      'quality', d.quality
    )
  from public.resume_review_workflows as w
  join public.resume_review_runs as ar
    on ar.merchant_id = w.merchant_id
   and ar.id = w.analysis_run_id
   and ar.input_sha256 = w.analysis_input_sha256
  join public.resume_documents as d
    on d.merchant_id = w.merchant_id
   and d.document_id = w.document_id
   and d.snapshot_sha256 = ar.extraction_snapshot_sha256
  left join public.resume_reviews as r
    on r.merchant_id = w.merchant_id and r.workflow_id = w.id
  where w.merchant_id = v_merchant_id and w.id = p_workflow_id;
end;
$function$;

create or replace function teamflow_private.lookup_resume_review_workflow(
  p_actor_id uuid,
  p_request_id uuid,
  p_request_sha256 text,
  p_document_id text,
  p_candidate_id uuid
)
returns table (
  workflow_id uuid,
  analysis_run_id uuid,
  merchant_id uuid,
  request_id uuid,
  request_sha256 text,
  analysis_input_sha256 text,
  reason_codes jsonb,
  workflow_status text,
  replayed boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
  v_workflow public.resume_review_workflows%rowtype;
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager') then
    raise exception 'teamflow_manager_role_required' using errcode = 'PT403';
  end if;

  select w.* into v_workflow
  from public.resume_review_workflows as w
  where w.merchant_id = v_merchant_id and w.request_id = p_request_id;
  if not found then
    return;
  end if;
  if v_workflow.request_sha256 <> p_request_sha256
     or v_workflow.document_id <> p_document_id
     or v_workflow.candidate_id <> p_candidate_id then
    raise exception 'teamflow_workflow_idempotency_conflict' using errcode = 'PT409';
  end if;

  return query select
    v_workflow.id,
    v_workflow.analysis_run_id,
    v_workflow.merchant_id,
    v_workflow.request_id,
    v_workflow.request_sha256,
    v_workflow.analysis_input_sha256,
    v_workflow.reason_codes,
    v_workflow.status,
    true;
end;
$function$;

create or replace function teamflow_private.authorize_resume_review_decision(
  p_actor_id uuid,
  p_workflow_id uuid,
  p_review_id uuid,
  p_expected_review_version bigint
)
returns table (
  workflow_id uuid,
  merchant_id uuid,
  request_id uuid,
  review_id uuid,
  review_version bigint,
  membership_role text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
  v_workflow public.resume_review_workflows%rowtype;
  v_review public.resume_reviews%rowtype;
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager', 'reviewer') then
    raise exception 'teamflow_review_role_required' using errcode = 'PT403';
  end if;

  select w.* into v_workflow
  from public.resume_review_workflows as w
  where w.merchant_id = v_merchant_id and w.id = p_workflow_id;
  if not found then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;
  select r.* into v_review
  from public.resume_reviews as r
  where r.merchant_id = v_merchant_id
    and r.workflow_id = p_workflow_id
    and r.id = p_review_id;
  if not found then
    raise exception 'teamflow_review_not_found' using errcode = 'PT404';
  end if;

  if v_review.status = 'pending' then
    if v_review.version <> p_expected_review_version then
      raise exception 'teamflow_stale_review_version' using errcode = 'PT409';
    end if;
  elsif not exists (
    select 1
    from public.resume_review_decisions as d
    where d.merchant_id = v_merchant_id
      and d.review_id = p_review_id
      and d.expected_review_version = p_expected_review_version
  ) then
    raise exception 'teamflow_review_already_decided' using errcode = 'PT409';
  end if;

  return query select
    v_workflow.id,
    v_workflow.merchant_id,
    v_workflow.request_id,
    v_review.id,
    p_expected_review_version,
    v_membership_role;
end;
$function$;

create or replace function teamflow_private.record_resume_review_decision(
  p_actor_id uuid,
  p_workflow_id uuid,
  p_review_id uuid,
  p_decision_id uuid,
  p_expected_review_version bigint,
  p_client_request_sha256 text,
  p_action text,
  p_edited_evaluation jsonb default null,
  p_reason_code text default null
)
returns table (
  decision_id uuid,
  merchant_id uuid,
  request_id uuid,
  replayed boolean,
  requires_resume boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
  v_workflow public.resume_review_workflows%rowtype;
  v_replacement_score integer;
  v_replacement_role_id uuid;
  v_decision_replayed boolean;
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager', 'reviewer') then
    raise exception 'teamflow_review_role_required' using errcode = 'PT403';
  end if;
  select w.* into v_workflow
  from public.resume_review_workflows as w
  where w.merchant_id = v_merchant_id and w.id = p_workflow_id;
  if not found then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;

  if p_action = 'approve_with_edits' then
    if jsonb_typeof(p_edited_evaluation) <> 'object'
       or jsonb_typeof(p_edited_evaluation -> 'ranked_roles') <> 'array'
       or jsonb_array_length(p_edited_evaluation -> 'ranked_roles') < 1
       or coalesce(
         p_edited_evaluation -> 'ranked_roles' -> 0 ->> 'deterministic_score', ''
       ) !~ '^[0-9]{1,3}$' then
      raise exception 'teamflow_edit_payload_invalid' using errcode = '22023';
    end if;
    v_replacement_score := (
      p_edited_evaluation -> 'ranked_roles' -> 0 ->> 'deterministic_score'
    )::integer;
    begin
      v_replacement_role_id := nullif(
        p_edited_evaluation ->> 'recommended_role_id', ''
      )::uuid;
    exception when invalid_text_representation then
      raise exception 'teamflow_edit_payload_invalid' using errcode = '22023';
    end;
  elsif p_edited_evaluation is not null then
    raise exception 'teamflow_invalid_decision' using errcode = '22023';
  end if;

  select d.replayed
  into v_decision_replayed
  from teamflow_private.decide_resume_review(
    p_actor_id,
    p_workflow_id,
    p_review_id,
    p_decision_id,
    p_expected_review_version,
    v_workflow.base_candidate_score_version,
    p_action,
    p_client_request_sha256,
    p_edited_evaluation,
    v_replacement_score,
    v_replacement_role_id,
    p_reason_code
  ) as d;

  -- Finish the authoritative database lifecycle in the same transaction as the
  -- immutable decision and candidate revision. A process crash (or reviewer
  -- suspension) after COMMIT can therefore leave only the LangGraph checkpoint to
  -- reconcile; it can never strand a database row in decision_recorded.
  perform *
  from teamflow_private.complete_resume_review_workflow(
    p_workflow_id,
    p_decision_id,
    p_review_id,
    p_expected_review_version
  );

  return query select
    p_decision_id,
    v_merchant_id,
    v_workflow.request_id,
    v_decision_replayed,
    true;
end;
$function$;

-- Recover only an already-committed decision made by the same authenticated user.
-- This is intentionally not a new-decision authorization path: an exact public
-- request hash must match the immutable ledger row, and no score write is possible.
-- It lets an offboarded reviewer finish a checkpoint after a post-COMMIT crash.
create or replace function teamflow_private.recover_resume_review_decision(
  p_actor_id uuid,
  p_workflow_id uuid,
  p_review_id uuid,
  p_decision_id uuid,
  p_expected_review_version bigint,
  p_client_request_sha256 text
)
returns table (
  decision_id uuid,
  merchant_id uuid,
  request_id uuid,
  replayed boolean,
  requires_resume boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_decision public.resume_review_decisions%rowtype;
  v_workflow public.resume_review_workflows%rowtype;
begin
  if p_actor_id is null
     or p_workflow_id is null
     or p_review_id is null
     or p_decision_id is null
     or p_expected_review_version not between 1 and 2147483647
     or p_client_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'teamflow_invalid_decision_recovery' using errcode = '22023';
  end if;

  select d.* into v_decision
  from public.resume_review_decisions as d
  where d.id = p_decision_id
    and d.actor_user_id = p_actor_id;
  if not found then
    return;
  end if;
  if v_decision.workflow_id <> p_workflow_id
     or v_decision.review_id <> p_review_id
     or v_decision.expected_review_version <> p_expected_review_version
     or v_decision.client_request_sha256 <> p_client_request_sha256 then
    raise exception 'teamflow_decision_id_conflict' using errcode = 'PT409';
  end if;

  select w.* into v_workflow
  from public.resume_review_workflows as w
  where w.merchant_id = v_decision.merchant_id
    and w.id = v_decision.workflow_id;
  if not found then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;

  perform *
  from teamflow_private.complete_resume_review_workflow(
    v_decision.workflow_id,
    v_decision.id,
    v_decision.review_id,
    v_decision.expected_review_version
  );

  return query select
    v_decision.id,
    v_decision.merchant_id,
    v_workflow.request_id,
    true,
    true;
end;
$function$;

-- The application service uses this projection only after an externally authorized
-- edit request. It returns the immutable Phase 3 source snapshot and the exact Phase 4
-- policy snapshot that produced the proposal; it never reads the mutable current job
-- catalog. This pre-commit read rederives current actor membership and tenant scope;
-- unlike post-commit reconciliation, failing closed here cannot strand a decision.
create or replace function teamflow_private.load_resume_review_edit_context(
  p_actor_id uuid,
  p_workflow_id uuid,
  p_review_id uuid,
  p_expected_review_version bigint
)
returns table (
  merchant_id uuid,
  extraction_snapshot_sha256 text,
  policy_sha256 text,
  document_snapshot jsonb,
  role_policy_snapshot jsonb,
  original_evaluation jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_merchant_id uuid;
  v_membership_role text;
  v_workflow public.resume_review_workflows%rowtype;
  v_review public.resume_reviews%rowtype;
  v_run public.resume_review_runs%rowtype;
  v_document public.resume_documents%rowtype;
begin
  select m.merchant_id, m.membership_role
  into v_merchant_id, v_membership_role
  from teamflow_private.resolve_active_membership(p_actor_id) as m;
  if v_membership_role not in ('owner', 'manager', 'reviewer') then
    raise exception 'teamflow_review_role_required' using errcode = 'PT403';
  end if;

  if p_workflow_id is null
     or p_review_id is null
     or p_expected_review_version not between 1 and 2147483647 then
    raise exception 'teamflow_invalid_edit_context' using errcode = '22023';
  end if;

  select w.* into v_workflow
  from public.resume_review_workflows as w
  where w.merchant_id = v_merchant_id
    and w.id = p_workflow_id;
  if not found then
    raise exception 'teamflow_workflow_not_found' using errcode = 'PT404';
  end if;

  select r.* into v_review
  from public.resume_reviews as r
  where r.merchant_id = v_workflow.merchant_id
    and r.workflow_id = v_workflow.id
    and r.id = p_review_id;
  if not found then
    raise exception 'teamflow_review_not_found' using errcode = 'PT404';
  end if;
  if v_review.status <> 'pending' then
    raise exception 'teamflow_review_already_decided' using errcode = 'PT409';
  end if;
  if v_review.version <> p_expected_review_version then
    raise exception 'teamflow_stale_review_version' using errcode = 'PT409';
  end if;

  select ar.* into v_run
  from public.resume_review_runs as ar
  where ar.merchant_id = v_workflow.merchant_id
    and ar.id = v_workflow.analysis_run_id
    and ar.input_sha256 = v_workflow.analysis_input_sha256;
  if not found then
    raise exception 'teamflow_analysis_run_not_found' using errcode = 'PT404';
  end if;

  select d.* into v_document
  from public.resume_documents as d
  where d.merchant_id = v_workflow.merchant_id
    and d.document_id = v_workflow.document_id
    and d.snapshot_sha256 = v_run.extraction_snapshot_sha256;
  if not found then
    raise exception 'teamflow_document_snapshot_not_found' using errcode = 'PT404';
  end if;

  return query select
    v_workflow.merchant_id,
    v_run.extraction_snapshot_sha256,
    v_run.policy_sha256,
    jsonb_build_object(
      'schema_version', v_document.schema_version,
      'merchant_id', v_document.merchant_id,
      'document_id', v_document.document_id,
      'content_sha256', v_document.content_sha256,
      'snapshot_sha256', v_document.snapshot_sha256,
      'status', v_document.status,
      'text', v_document.text,
      'source_blocks', v_document.source_blocks,
      'extraction_method', v_document.extraction_method,
      'model_id', v_document.model_id,
      'embedding_available', v_document.embedding_available,
      'mock', v_document.mock,
      'warnings', v_document.warnings,
      'quality', v_document.quality
    ),
    v_run.role_policy_snapshot,
    v_run.agent1_evaluation;
end;
$function$;

create or replace function teamflow_private.reject_immutable_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'teamflow_immutable_record_rejects_update'
    using errcode = '55000';
end;
$function$;

create or replace function teamflow_private.guard_candidate_score_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_revision public.candidate_score_revisions%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.fit_score is not null
       or new.analysis is not null
       or new.score_version <> 0
       or new.current_score_revision_id is not null
       or new.score_updated_at is not null then
      raise exception 'teamflow_candidate_score_requires_review'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if new.fit_score is not distinct from old.fit_score
     and new.analysis is not distinct from old.analysis
     and new.score_version is not distinct from old.score_version
     and new.current_score_revision_id is not distinct from old.current_score_revision_id
     and new.score_updated_at is not distinct from old.score_updated_at then
    return new;
  end if;

  if new.score_version <> old.score_version + 1
     or new.current_score_revision_id is null
     or new.score_updated_at is null
     or new.fit_score is null then
    raise exception 'teamflow_candidate_score_revision_required'
      using errcode = '55000';
  end if;

  select r.* into v_revision
  from public.candidate_score_revisions as r
  where r.merchant_id = new.merchant_id
    and r.candidate_id = new.id
    and r.id = new.current_score_revision_id
    and r.candidate_score_version = new.score_version;
  if not found
     or v_revision.fit_score <> new.fit_score
     or v_revision.result_snapshot is distinct from new.analysis
     or v_revision.created_at <> new.score_updated_at then
    raise exception 'teamflow_candidate_score_revision_mismatch'
      using errcode = '55000';
  end if;

  return new;
end;
$function$;

create or replace function teamflow_private.guard_merchant_review_retention()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.resume_review_workflows as w
    where w.merchant_id = old.id
  ) or exists (
    select 1
    from public.resume_review_runs as r
    where r.merchant_id = old.id
  ) then
    raise exception 'teamflow_merchant_has_retained_review_records'
      using errcode = '55000';
  end if;
  return old;
end;
$function$;

create trigger resume_review_decisions_reject_update
before update on public.resume_review_decisions
for each row execute function teamflow_private.reject_immutable_update();
create trigger candidate_score_revisions_reject_update
before update on public.candidate_score_revisions
for each row execute function teamflow_private.reject_immutable_update();
create trigger resume_review_events_reject_update
before update on public.resume_review_events
for each row execute function teamflow_private.reject_immutable_update();
create trigger candidates_guard_score_insert_or_update
before insert or update on public.candidates
for each row execute function teamflow_private.guard_candidate_score_write();
create trigger merchants_guard_review_retention
before delete on public.merchants
for each row execute function teamflow_private.guard_merchant_review_retention();

alter table public.merchant_memberships enable row level security;
alter table public.resume_review_workflows enable row level security;
alter table public.resume_reviews enable row level security;
alter table public.resume_review_decisions enable row level security;
alter table public.candidate_score_revisions enable row level security;
alter table public.resume_review_events enable row level security;

create policy merchant_memberships_select_own_active
  on public.merchant_memberships
  for select to authenticated
  using (user_id = (select auth.uid()) and status = 'active');
revoke all on table public.merchant_memberships,
  public.resume_review_workflows, public.resume_reviews,
  public.resume_review_decisions, public.candidate_score_revisions,
  public.resume_review_events
  from public, anon, authenticated, service_role, teamflow_hitl_service;
grant select on table public.merchant_memberships to authenticated;
grant select on table public.merchant_memberships,
  public.resume_review_workflows, public.resume_reviews,
  public.resume_review_decisions, public.candidate_score_revisions,
  public.resume_review_events
  to service_role;
grant select, insert, update on table public.merchant_memberships to service_role;

revoke all on all functions in schema teamflow_private
  from public, anon, authenticated, service_role, teamflow_hitl_service;
grant usage on schema teamflow_private
  to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.resolve_active_membership(uuid)
  to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.prepare_resume_review_workflow(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text,
  jsonb, jsonb, jsonb, jsonb, jsonb, text, boolean, text, boolean, jsonb, text,
  jsonb, jsonb, jsonb
) to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.create_resume_review(
  uuid, uuid, text, uuid, jsonb
) to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.lookup_resume_review_workflow(
  uuid, uuid, text, text, uuid
) to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.authorize_resume_review_decision(
  uuid, uuid, uuid, bigint
) to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.record_resume_review_decision(
  uuid, uuid, uuid, uuid, bigint, text, text, jsonb, text
) to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.recover_resume_review_decision(
  uuid, uuid, uuid, uuid, bigint, text
) to teamflow_hitl_service;
grant execute on function teamflow_private.load_resume_review_edit_context(
  uuid, uuid, uuid, bigint
) to teamflow_hitl_service;
grant execute on function teamflow_private.complete_resume_review_workflow(
  uuid, uuid, uuid, bigint
) to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.inspect_resume_review(uuid, uuid)
  to service_role, teamflow_hitl_service;
grant execute on function teamflow_private.list_pending_resume_reviews(
  uuid, integer, timestamptz, uuid
) to teamflow_hitl_service;
grant execute on function teamflow_private.inspect_resume_review_detail(uuid, uuid)
  to teamflow_hitl_service;

-- Lifecycle/evidence rows are employment-decision records. There is deliberately no
-- application DELETE grant or automatic purge here. Configure a documented privileged
-- retention job to remove an entire workflow aggregate only after the legal retention
-- period and after clearing any candidate.current_score_revision_id reference. Database
-- backups must follow the same retention schedule.

-- Phase 8A: production-boundary hardening that is independent of the Phase 7
-- semantic evidence gate. This migration does not enable automatic hiring decisions,
-- confidence routing, or judge authority.
--
-- The existing application uses the Supabase service role for the legacy server-only
-- candidate/Phase 4 paths and a separate direct PostgreSQL role for Phase 6 HITL.
-- Re-state those boundaries explicitly so a service-key compromise cannot call the
-- actor-parameterized Phase 6 RPCs or provision reviewer memberships.

begin;

do $api_roles$
begin
  -- Phase 19 owns the reader capability and its narrow semantic-search RPC. Treat a
  -- missing dependency as migration-order drift instead of silently rebuilding a
  -- weaker approximation here.
  if not exists (
    select 1 from pg_roles where rolname = 'teamflow_hiring_reader'
  ) or to_regprocedure('public.teamflow_request_jwt_claims()') is null
    or to_regprocedure(
      'public.teamflow_match_candidates(vector,uuid,double precision,integer)'
    ) is null
  then
    raise exception 'teamflow_phase8a_phase19_boundary_missing'
      using errcode = '42883';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'teamflow_review_writer') then
    create role teamflow_review_writer nologin noinherit;
  end if;

  -- Reject a pre-provisioned login/privileged writer rather than normalizing unsafe
  -- drift into a PostgREST capability. The role must also be unable to inherit or
  -- SET ROLE into any other database role.
  if exists (
    select 1
    from pg_roles
    where rolname = 'teamflow_review_writer'
      and (
        rolcanlogin or rolinherit or rolcreatedb or rolcreaterole
        or rolsuper or rolreplication or rolbypassrls
      )
  ) then
    raise exception 'teamflow_review_writer_has_forbidden_privileges'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_auth_members as membership
    where membership.member = (
      select oid from pg_roles where rolname = 'teamflow_review_writer'
    )
  ) then
    raise exception 'teamflow_review_writer_has_unexpected_membership'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from pg_auth_members as membership
    join pg_roles as member_role on member_role.oid = membership.member
    where membership.roleid = (
      select oid from pg_roles where rolname = 'teamflow_review_writer'
    )
      and not (
        (
          member_role.rolname = current_user
          and membership.admin_option
          and not membership.inherit_option
          and not membership.set_option
        )
        or (
          member_role.rolname = 'authenticator'
          and not membership.admin_option
          and not membership.inherit_option
          and membership.set_option
        )
      )
  ) then
    raise exception 'teamflow_review_writer_has_unexpected_member'
      using errcode = '42501';
  end if;
end
$api_roles$;

alter role teamflow_review_writer
  nologin noinherit nocreatedb nocreaterole;
grant teamflow_review_writer to authenticator
  with admin false, inherit false, set true;

alter table public.merchants enable row level security;
alter table public.jobs enable row level security;
alter table public.candidates enable row level security;
alter table public.applications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.resume_documents enable row level security;
alter table public.candidate_resume_documents enable row level security;
alter table public.resume_review_runs enable row level security;
alter table public.merchant_memberships enable row level security;
alter table public.resume_review_workflows enable row level security;
alter table public.resume_reviews enable row level security;
alter table public.resume_review_decisions enable row level security;
alter table public.candidate_score_revisions enable row level security;
alter table public.resume_review_events enable row level security;

revoke create on schema public
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;

revoke all on table public.merchants, public.jobs, public.candidates,
  public.applications, public.audit_logs, public.resume_documents,
  public.candidate_resume_documents, public.resume_review_runs,
  public.merchant_memberships, public.resume_review_workflows,
  public.resume_reviews, public.resume_review_decisions,
  public.candidate_score_revisions, public.resume_review_events
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;

-- Preserve Phase 19's least-privilege legacy service surface, then add only the
-- Phase 4 evidence relations used by the server-side extraction flow. In particular,
-- service_role does not gain merchant/job writes, audit-log access, or direct HITL
-- state access.
grant select on table public.merchants, public.jobs to service_role;
grant select, insert, update, delete on table public.candidates to service_role;
grant select, insert on table public.applications to service_role;
grant select, insert on table public.resume_documents,
  public.candidate_resume_documents, public.resume_review_runs
  to service_role;

-- The only direct browser-readable TeamFlow relation is the caller's own active
-- membership. Its existing RLS policy supplies the row authorization predicate.
grant select on table public.merchant_memberships to authenticated;

-- The Python service never receives service_role. Its read and optional append paths
-- use separate short-lived JWT roles plus a publishable API key. RLS remains enabled;
-- these policies expose only the explicitly granted relations/columns.
revoke execute on all functions in schema public
  from public, anon, authenticated, authenticator, teamflow_hiring_reader,
    teamflow_review_writer;
grant usage on schema public to teamflow_hiring_reader, teamflow_review_writer;
grant execute on function public.teamflow_request_jwt_claims()
  to teamflow_hiring_reader, teamflow_review_writer;
-- The append-only writer relies on a table default owned by the schema migration.
-- Grant only that zero-argument UUID generator (wherever the extension is installed),
-- rather than restoring blanket execution on public extension functions.
do $uuid_generator_acl$
declare
  uuid_generator record;
  generator_count integer := 0;
begin
  for uuid_generator in
    select namespace.nspname, procedure.proname
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where procedure.proname = 'uuid_generate_v4'
      and procedure.pronargs = 0
      and namespace.nspname in ('public', 'extensions')
  loop
    execute format(
      'grant execute on function %I.%I() to service_role, teamflow_review_writer',
      uuid_generator.nspname,
      uuid_generator.proname
    );
    generator_count := generator_count + 1;
  end loop;
  if generator_count = 0 then
    raise exception 'teamflow_phase8a_uuid_generator_missing'
      using errcode = '42883';
  end if;
end
$uuid_generator_acl$;
grant select (
  id, merchant_id, title, description, dealbreakers, nice_to_haves, is_active,
  scoring_policy_id, scoring_policy_version, scoring_criteria
) on table public.jobs to teamflow_hiring_reader;
grant select (
  id, merchant_id, job_id, status, resume_text, created_at, embedding
) on table public.candidates to teamflow_hiring_reader;
grant select (
  merchant_id, document_id, schema_version, content_sha256, snapshot_sha256,
  status, text, source_blocks, extraction_method, model_id,
  embedding_available, mock, warnings, quality
) on table public.resume_documents to teamflow_hiring_reader;
grant select (merchant_id, candidate_id, document_id)
  on table public.candidate_resume_documents to teamflow_hiring_reader;
grant select (id, merchant_id, request_id, input_sha256)
  on table public.resume_review_runs to teamflow_review_writer;
grant insert (
  schema_version, request_id, merchant_id, document_id, candidate_id,
  input_sha256, extraction_snapshot_sha256, policy_sha256,
  role_policy_snapshot, confidence_assessment, confidence_shadow_record,
  confidence_policy_snapshot, confidence_signal_snapshot,
  confidence_policy_sha256, confidence_threshold_applied, status,
  review_required, agent1_evaluation, questions_status, question_plan,
  reason_codes
) on table public.resume_review_runs to teamflow_review_writer;

-- Phase 19 continues to own the jobs/candidates policies. Do not drop or recreate
-- them here: they require an active job, the exact reader role claim, a bounded JWT
-- parser, and the tenant UUID. New Phase 4 relations use the same claim discipline.
drop policy if exists teamflow_hiring_reader_documents_select
  on public.resume_documents;
create policy teamflow_hiring_reader_documents_select on public.resume_documents
  for select to teamflow_hiring_reader using (
    merchant_id = (
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
  );
drop policy if exists teamflow_hiring_reader_document_links_select
  on public.candidate_resume_documents;
create policy teamflow_hiring_reader_document_links_select
  on public.candidate_resume_documents
  for select to teamflow_hiring_reader using (
    merchant_id = (
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
  );
drop policy if exists teamflow_review_writer_runs_select
  on public.resume_review_runs;
create policy teamflow_review_writer_runs_select on public.resume_review_runs
  for select to teamflow_review_writer using (
    merchant_id = (
      select case
        when claims ->> 'role' = 'teamflow_review_writer'
          and coalesce(claims ->> 'merchant_id', '') ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (claims ->> 'merchant_id')::uuid
        else null
      end
      from (
        select public.teamflow_request_jwt_claims() as claims
      ) as request_context
    )
  );
drop policy if exists teamflow_review_writer_runs_insert
  on public.resume_review_runs;
create policy teamflow_review_writer_runs_insert on public.resume_review_runs
  for insert to teamflow_review_writer with check (
    merchant_id = (
      select case
        when claims ->> 'role' = 'teamflow_review_writer'
          and coalesce(claims ->> 'merchant_id', '') ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (claims ->> 'merchant_id')::uuid
        else null
      end
      from (
        select public.teamflow_request_jwt_claims() as claims
      ) as request_context
    )
  );

-- Preserve Phase 18/19's exact `(merchant_id, similarity)` RPC signature. Replacing
-- the body with a different TABLE return type is invalid PostgreSQL DDL and would
-- also disclose candidate identity/model-output columns to the reader.
revoke execute on function public.teamflow_match_candidates(
  vector, uuid, double precision, integer
) from public, anon, authenticated, service_role, authenticator,
  teamflow_hitl_service, teamflow_checkpoint_migrator,
  teamflow_checkpoint_runtime, teamflow_review_writer;
grant execute on function public.teamflow_match_candidates(
  vector, uuid, double precision, integer
) to teamflow_hiring_reader;

-- Phase 6 is reachable only through the dedicated direct-Postgres capability role.
-- In particular, service_role is not an alternate actor-impersonation path.
revoke all on schema teamflow_private from public, anon, authenticated,
  service_role, teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
  teamflow_hiring_reader, teamflow_review_writer;
grant usage on schema teamflow_private
  to teamflow_hitl_service, teamflow_review_writer;
revoke all on all functions in schema teamflow_private
  from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;

-- PostgreSQL evaluates CHECK constraints with the inserting role's privileges.
-- Expose only the immutable validators required by resume_review_runs; every actor,
-- lifecycle, decision, and retention function remains unavailable to the writer.
grant execute on function teamflow_private.valid_reason_codes(jsonb)
  to teamflow_review_writer;
grant execute on function teamflow_private.valid_confidence_provenance(
  jsonb, jsonb, jsonb, jsonb, text, boolean, text, boolean
) to teamflow_review_writer;
do $confidence_digest_acl$
begin
  if to_regprocedure('extensions.digest(bytea,text)') is not null then
    grant usage on schema extensions to teamflow_review_writer;
    grant execute on function extensions.digest(bytea, text)
      to teamflow_review_writer;
  else
    raise exception 'teamflow_phase8a_pgcrypto_digest_missing'
      using errcode = '42883';
  end if;
end
$confidence_digest_acl$;

grant execute on function teamflow_private.resolve_active_membership(uuid)
  to teamflow_hitl_service;
grant execute on function teamflow_private.prepare_resume_review_workflow(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text,
  jsonb, jsonb, jsonb, jsonb, jsonb, text, boolean, text, boolean, jsonb, text,
  jsonb, jsonb, jsonb
) to teamflow_hitl_service;
grant execute on function teamflow_private.create_resume_review(
  uuid, uuid, text, uuid, jsonb
) to teamflow_hitl_service;
grant execute on function teamflow_private.lookup_resume_review_workflow(
  uuid, uuid, text, text, uuid
) to teamflow_hitl_service;
grant execute on function teamflow_private.authorize_resume_review_decision(
  uuid, uuid, uuid, bigint
) to teamflow_hitl_service;
grant execute on function teamflow_private.record_resume_review_decision(
  uuid, uuid, uuid, uuid, bigint, text, text, jsonb, text
) to teamflow_hitl_service;
grant execute on function teamflow_private.recover_resume_review_decision(
  uuid, uuid, uuid, uuid, bigint, text
) to teamflow_hitl_service;
grant execute on function teamflow_private.load_resume_review_edit_context(
  uuid, uuid, uuid, bigint
) to teamflow_hitl_service;
grant execute on function teamflow_private.complete_resume_review_workflow(
  uuid, uuid, uuid, bigint
) to teamflow_hitl_service;
grant execute on function teamflow_private.inspect_resume_review(uuid, uuid)
  to teamflow_hitl_service;
grant execute on function teamflow_private.list_pending_resume_reviews(
  uuid, integer, timestamptz, uuid
) to teamflow_hitl_service;
grant execute on function teamflow_private.inspect_resume_review_detail(uuid, uuid)
  to teamflow_hitl_service;

-- A hosted Supabase migration owner is intentionally not SUPERUSER and PostgreSQL
-- forbids it from issuing even the negative SUPERUSER/REPLICATION/BYPASSRLS options.
-- Fail closed if an operator provisioned a privileged capability role, then enforce
-- the attributes a CREATEROLE migration owner is allowed to manage.
do $capability_role_attributes$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = any(array[
      'teamflow_hitl_service',
      'teamflow_checkpoint_migrator',
      'teamflow_checkpoint_runtime',
      'teamflow_hiring_reader',
      'teamflow_review_writer'
    ])
      and (rolsuper or rolreplication or rolbypassrls)
  ) then
    raise exception 'teamflow_capability_role_has_forbidden_privileges'
      using errcode = '42501';
  end if;
end
$capability_role_attributes$;

alter role teamflow_hitl_service
  nocreatedb nocreaterole noinherit;
alter role teamflow_checkpoint_migrator
  nocreatedb nocreaterole noinherit;
alter role teamflow_checkpoint_runtime
  nocreatedb nocreaterole noinherit;
alter role teamflow_hiring_reader
  nocreatedb nocreaterole noinherit;
alter role teamflow_review_writer
  nocreatedb nocreaterole noinherit;

-- The current API cannot select a merchant when an identity belongs to more than one
-- tenant. Encode its existing fail-closed invariant at write time instead of allowing
-- an ambiguous authorization state to accumulate.
do $memberships$
begin
  if exists (
    select 1
    from public.merchant_memberships
    where status = 'active'
    group by user_id
    having count(*) > 1
  ) then
    raise exception 'teamflow_multiple_active_memberships_require_remediation'
      using errcode = 'PT409';
  end if;
end
$memberships$;

create unique index if not exists merchant_memberships_one_active_per_user_idx
  on public.merchant_memberships (user_id)
  where status = 'active';

-- PostgreSQL does not automatically index foreign-key columns. These indexes bound
-- tenant deletion/restrict checks and the operator-only retention inventory on growing
-- hiring datasets.
create index if not exists candidates_job_id_idx
  on public.candidates (job_id) where job_id is not null;
create index if not exists candidates_current_score_revision_idx
  on public.candidates (merchant_id, current_score_revision_id)
  where current_score_revision_id is not null;
create index if not exists applications_candidate_id_idx
  on public.applications (candidate_id) where candidate_id is not null;
create index if not exists audit_logs_candidate_id_idx
  on public.audit_logs (candidate_id) where candidate_id is not null;
create index if not exists audit_logs_merchant_created_idx
  on public.audit_logs (merchant_id, created_at desc)
  where merchant_id is not null;
create index if not exists merchant_memberships_user_id_idx
  on public.merchant_memberships (user_id);
create index if not exists merchant_memberships_created_by_idx
  on public.merchant_memberships (created_by) where created_by is not null;
create index if not exists candidate_resume_documents_document_idx
  on public.candidate_resume_documents (merchant_id, document_id);
create index if not exists resume_review_runs_document_idx
  on public.resume_review_runs (merchant_id, document_id);
create index if not exists resume_review_runs_document_snapshot_idx
  on public.resume_review_runs (
    merchant_id, document_id, extraction_snapshot_sha256
  );
create index if not exists resume_review_runs_candidate_idx
  on public.resume_review_runs (merchant_id, candidate_id)
  where candidate_id is not null;
create index if not exists resume_review_runs_candidate_document_idx
  on public.resume_review_runs (merchant_id, candidate_id, document_id)
  where candidate_id is not null;
create index if not exists resume_review_workflows_initiated_by_idx
  on public.resume_review_workflows (initiated_by);
create index if not exists resume_review_workflows_document_idx
  on public.resume_review_workflows (merchant_id, document_id);
create index if not exists resume_review_workflows_candidate_document_idx
  on public.resume_review_workflows (merchant_id, candidate_id, document_id);
create index if not exists resume_review_workflows_role_idx
  on public.resume_review_workflows (merchant_id, proposed_role_id)
  where proposed_role_id is not null;
create index if not exists resume_reviews_decided_by_idx
  on public.resume_reviews (decided_by) where decided_by is not null;
create index if not exists resume_review_decisions_candidate_idx
  on public.resume_review_decisions (merchant_id, candidate_id);
create index if not exists resume_review_decisions_workflow_idx
  on public.resume_review_decisions (merchant_id, workflow_id);
create index if not exists resume_review_decisions_applied_revision_idx
  on public.resume_review_decisions (merchant_id, applied_revision_id)
  where applied_revision_id is not null;
create index if not exists resume_review_decisions_actor_idx
  on public.resume_review_decisions (actor_user_id);
create index if not exists candidate_score_revisions_workflow_idx
  on public.candidate_score_revisions (merchant_id, workflow_id);
create index if not exists candidate_score_revisions_review_idx
  on public.candidate_score_revisions (merchant_id, review_id);
create index if not exists candidate_score_revisions_role_idx
  on public.candidate_score_revisions (merchant_id, role_id)
  where role_id is not null;
create index if not exists candidate_score_revisions_actor_idx
  on public.candidate_score_revisions (actor_user_id);
create index if not exists resume_review_events_review_idx
  on public.resume_review_events (merchant_id, review_id)
  where review_id is not null;
create index if not exists resume_review_events_decision_idx
  on public.resume_review_events (merchant_id, decision_id)
  where decision_id is not null;
create index if not exists resume_review_events_actor_idx
  on public.resume_review_events (actor_user_id)
  where actor_user_id is not null;
create index if not exists resume_review_workflows_retention_idx
  on public.resume_review_workflows (completed_at, merchant_id, id)
  where completed_at is not null
    and status in ('completed', 'rejected', 'failed');

drop trigger if exists applications_reject_update on public.applications;
create trigger applications_reject_update
before update on public.applications
for each row execute function teamflow_private.reject_immutable_update();

drop trigger if exists audit_logs_reject_update on public.audit_logs;
create trigger audit_logs_reject_update
before update on public.audit_logs
for each row execute function teamflow_private.reject_immutable_update();

-- Read-only, owner-operated retention inventory. No application role may execute it,
-- and it deliberately performs no deletion because the legal cutoff, hold rules, and
-- backup expiry must be selected and verified outside a source migration.
create or replace function teamflow_private.resume_review_retention_inventory(
  p_before timestamptz
)
returns table (
  merchant_id uuid,
  workflow_id uuid,
  workflow_status text,
  completed_at timestamptz,
  analysis_run_id uuid,
  document_id text,
  candidate_id uuid,
  current_revision_referenced boolean
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    w.merchant_id,
    w.id,
    w.status,
    w.completed_at,
    w.analysis_run_id,
    w.document_id,
    w.candidate_id,
    exists (
      select 1
      from public.candidate_score_revisions as revision
      join public.candidates as candidate
        on candidate.merchant_id = revision.merchant_id
       and candidate.id = revision.candidate_id
       and candidate.current_score_revision_id = revision.id
      where revision.merchant_id = w.merchant_id
        and revision.workflow_id = w.id
    )
  from public.resume_review_workflows as w
  where p_before is not null
    and w.completed_at is not null
    and w.completed_at < p_before
    and w.status in ('completed', 'rejected', 'failed')
  order by w.completed_at, w.merchant_id, w.id;
$function$;

revoke execute on function teamflow_private.resume_review_retention_inventory(timestamptz)
  from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;

-- A private, size-limited Storage bucket is safe to provision ahead of activation. The
-- current upload path remains server-side and does not depend on direct client Storage
-- access. A restrictive policy keeps this bucket private even if another permissive
-- storage.objects policy is added for a different bucket.
do $storage$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (
      id, name, public, file_size_limit, allowed_mime_types
    ) values (
      'resumes', 'resumes', false, 10485760,
      array['application/pdf', 'image/jpeg', 'image/png']::text[]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists teamflow_resumes_client_deny on storage.objects';
    execute $policy$
      create policy teamflow_resumes_client_deny
      on storage.objects
      as restrictive
      for all
      to anon, authenticated
      using (bucket_id <> 'resumes')
      with check (bucket_id <> 'resumes')
    $policy$;
  end if;
end
$storage$;

-- Match current Supabase opt-in Data API defaults. Every future TeamFlow object must
-- carry its explicit grant in the same migration as its RLS/policy setup.
alter default privileges for role postgres in schema public
  revoke all on tables
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hitl_service, teamflow_checkpoint_migrator,
    teamflow_checkpoint_runtime, teamflow_hiring_reader,
    teamflow_review_writer;
alter default privileges for role postgres in schema public
  revoke all on sequences
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hitl_service, teamflow_checkpoint_migrator,
    teamflow_checkpoint_runtime, teamflow_hiring_reader,
    teamflow_review_writer;
alter default privileges for role postgres in schema public
  revoke all on functions
  from public, anon, authenticated, service_role, authenticator,
    teamflow_hitl_service, teamflow_checkpoint_migrator,
    teamflow_checkpoint_runtime, teamflow_hiring_reader,
    teamflow_review_writer;
alter default privileges for role postgres
  revoke execute on functions from public;

commit;

-- Close the Phase 6 actor-impersonation boundary for the direct PostgreSQL
-- service role. Possession of TEAMFLOW_HITL_DSN is no longer sufficient to call an
-- actor-parameterized function: the only granted actor entry point consumes a
-- short-lived, one-time HMAC capability minted after Supabase Auth verification.
--
-- This migration deliberately does not provision the HMAC key. A release operator
-- must insert the same independently generated 32-64 byte secret that is supplied to
-- the service as TEAMFLOW_HITL_CAPABILITY_SECRET and bind it to the canonical
-- Supabase Auth issuer. Until that row exists, startup attestation fails and
-- TEAMFLOW_HITL_ENABLED must remain false.

create table if not exists teamflow_private.hitl_capability_keys (
  key_id text primary key check (key_id ~ '^[0-9a-f]{64}$'),
  secret bytea not null check (octet_length(secret) between 32 and 64),
  auth_issuer text not null check (
    octet_length(auth_issuer) between 16 and 512
    and auth_issuer ~ '^https?://[^[:space:]/?#]+/auth/v1$'
  ),
  activated_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > activated_at),
  check (revoked_at is null or revoked_at >= activated_at)
);

create table if not exists teamflow_private.hitl_consumed_capabilities (
  key_id text not null references teamflow_private.hitl_capability_keys(key_id)
    on delete restrict,
  nonce uuid not null,
  actor_id uuid not null,
  operation text not null check (
    operation in (
      'resolve_membership', 'lookup_request', 'prepare_workflow',
      'authorize_decision', 'recover_decision', 'record_decision',
      'inspect', 'list_pending', 'inspect_detail', 'load_edit_context'
    )
  ),
  resource_sha256 text not null check (resource_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now(),
  primary key (key_id, nonce)
);

create index if not exists hitl_consumed_capabilities_expiry_idx
  on teamflow_private.hitl_consumed_capabilities (expires_at, key_id, nonce);

revoke all on table teamflow_private.hitl_capability_keys,
  teamflow_private.hitl_consumed_capabilities
  from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;

create or replace function teamflow_private.consume_hitl_capability(
  p_actor_id uuid,
  p_auth_issuer text,
  p_session_id uuid,
  p_assurance_level text,
  p_authenticated_at bigint,
  p_operation text,
  p_resource_sha256 text,
  p_expires_at bigint,
  p_nonce uuid,
  p_key_id text,
  p_signature text,
  p_require_decision_assurance boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now_epoch bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_secret bytea;
  v_message text;
  v_expected_signature bytea;
begin
  if p_actor_id is null
     or p_auth_issuer is null
     or octet_length(p_auth_issuer) not between 16 and 512
     or p_auth_issuer !~ '^https?://[^[:space:]/?#]+/auth/v1$'
     or p_operation is null
     or p_operation not in (
       'resolve_membership', 'lookup_request', 'prepare_workflow',
       'authorize_decision', 'recover_decision', 'record_decision',
       'inspect', 'list_pending', 'inspect_detail', 'load_edit_context'
     )
     or p_resource_sha256 is null
     or p_resource_sha256 !~ '^[0-9a-f]{64}$'
     or p_key_id is null
     or p_key_id !~ '^[0-9a-f]{64}$'
     or p_signature is null
     or p_signature !~ '^[0-9a-f]{64}$'
     or p_nonce is null
     or p_expires_at is null
     or p_expires_at <= v_now_epoch
     or p_expires_at > v_now_epoch + 30 then
    raise exception 'teamflow_hitl_capability_invalid' using errcode = 'PT403';
  end if;

  if p_require_decision_assurance then
    if p_session_id is null
       or p_assurance_level <> 'aal2'
       or p_authenticated_at is null
       or p_authenticated_at > v_now_epoch + 30
       or p_authenticated_at < v_now_epoch - 600
       or not exists (
         select 1
         from auth.sessions as session
         where session.id = p_session_id
           and session.user_id = p_actor_id
       ) then
      raise exception 'teamflow_recent_aal2_session_required' using errcode = 'PT403';
    end if;
  elsif p_session_id is not null
        or p_assurance_level is not null
        or p_authenticated_at is not null then
    -- Non-decision capabilities do not accept partially trusted session material.
    raise exception 'teamflow_hitl_capability_invalid' using errcode = 'PT403';
  end if;

  select key.secret
  into v_secret
  from teamflow_private.hitl_capability_keys as key
  where key.key_id = p_key_id
    and key.auth_issuer = p_auth_issuer
    and key.activated_at <= clock_timestamp()
    and (key.expires_at is null or key.expires_at > clock_timestamp())
    and key.revoked_at is null;
  if not found then
    raise exception 'teamflow_hitl_capability_invalid' using errcode = 'PT403';
  end if;

  v_message := 'teamflow-hitl-capability-v2' || chr(10)
    || p_key_id || chr(10)
    || p_auth_issuer || chr(10)
    || p_actor_id::text || chr(10)
    || coalesce(p_session_id::text, '-') || chr(10)
    || coalesce(p_assurance_level, '-') || chr(10)
    || coalesce(p_authenticated_at::text, '-') || chr(10)
    || p_operation || chr(10)
    || p_resource_sha256 || chr(10)
    || p_expires_at::text || chr(10)
    || p_nonce::text;
  v_expected_signature := extensions.hmac(
    convert_to(v_message, 'UTF8'),
    v_secret,
    'sha256'
  );
  if decode(p_signature, 'hex') <> v_expected_signature then
    raise exception 'teamflow_hitl_capability_invalid' using errcode = 'PT403';
  end if;

  begin
    insert into teamflow_private.hitl_consumed_capabilities (
      key_id, nonce, actor_id, operation, resource_sha256, expires_at
    ) values (
      p_key_id,
      p_nonce,
      p_actor_id,
      p_operation,
      p_resource_sha256,
      to_timestamp(p_expires_at)
    );
  exception when unique_violation then
    raise exception 'teamflow_hitl_capability_replayed' using errcode = 'PT403';
  end;
end;
$function$;

-- One deliberately narrow dispatcher is the complete actor-authorized direct-DB
-- surface. p_resource_sha256 is re-derived from the exact canonical payload text
-- before the capability is consumed, so every operation argument is signed.
create or replace function teamflow_private.execute_hitl_actor_operation(
  p_actor_id uuid,
  p_auth_issuer text,
  p_session_id uuid,
  p_assurance_level text,
  p_authenticated_at bigint,
  p_operation text,
  p_resource_sha256 text,
  p_payload text,
  p_expires_at bigint,
  p_nonce uuid,
  p_key_id text,
  p_signature text
)
returns setof jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_payload jsonb;
  v_expected_resource_sha256 text;
  v_requires_decision_assurance boolean := p_operation in (
    'authorize_decision', 'recover_decision', 'record_decision',
    'load_edit_context'
  );
begin
  if p_payload is null or octet_length(p_payload) not between 2 and 1048576 then
    raise exception 'teamflow_hitl_capability_invalid' using errcode = 'PT403';
  end if;
  begin
    v_payload := p_payload::jsonb;
  exception when others then
    raise exception 'teamflow_hitl_capability_invalid' using errcode = 'PT403';
  end;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'teamflow_hitl_capability_invalid' using errcode = 'PT403';
  end if;
  v_expected_resource_sha256 := encode(
    extensions.digest(convert_to(p_payload, 'UTF8'), 'sha256'),
    'hex'
  );
  if p_resource_sha256 is distinct from v_expected_resource_sha256 then
    raise exception 'teamflow_hitl_capability_invalid' using errcode = 'PT403';
  end if;

  perform teamflow_private.consume_hitl_capability(
    p_actor_id, p_auth_issuer, p_session_id, p_assurance_level, p_authenticated_at,
    p_operation, p_resource_sha256, p_expires_at, p_nonce, p_key_id,
    p_signature, v_requires_decision_assurance
  );

  case p_operation
    when 'resolve_membership' then
      return query
      select to_jsonb(result)
      from teamflow_private.resolve_active_membership(p_actor_id) as result;
    when 'lookup_request' then
      return query
      select to_jsonb(result)
      from teamflow_private.lookup_resume_review_workflow(
        p_actor_id,
        (v_payload ->> 'request_id')::uuid,
        v_payload ->> 'request_sha256',
        v_payload ->> 'document_id',
        (v_payload ->> 'candidate_id')::uuid
      ) as result;
    when 'prepare_workflow' then
      return query
      select to_jsonb(result)
      from teamflow_private.prepare_resume_review_workflow(
        p_actor_id,
        (v_payload ->> 'workflow_id')::uuid,
        (v_payload ->> 'analysis_run_id')::uuid,
        (v_payload ->> 'request_id')::uuid,
        v_payload ->> 'request_sha256',
        v_payload ->> 'document_id',
        (v_payload ->> 'candidate_id')::uuid,
        v_payload ->> 'analysis_input_sha256',
        v_payload ->> 'extraction_snapshot_sha256',
        v_payload ->> 'policy_sha256',
        v_payload -> 'role_policy_snapshot',
        v_payload -> 'confidence_assessment',
        v_payload -> 'confidence_shadow_record',
        v_payload -> 'confidence_policy_snapshot',
        v_payload -> 'confidence_signal_snapshot',
        v_payload ->> 'confidence_policy_sha256',
        (v_payload ->> 'confidence_threshold_applied')::boolean,
        v_payload ->> 'analysis_status',
        (v_payload ->> 'review_required')::boolean,
        v_payload -> 'agent1_evaluation',
        v_payload ->> 'questions_status',
        case
          when v_payload -> 'question_plan' = 'null'::jsonb then null
          else v_payload -> 'question_plan'
        end,
        v_payload -> 'reason_codes',
        v_payload -> 'workflow_reason_codes'
      ) as result;
    when 'authorize_decision' then
      return query
      select to_jsonb(result)
      from teamflow_private.authorize_resume_review_decision(
        p_actor_id,
        (v_payload ->> 'workflow_id')::uuid,
        (v_payload ->> 'review_id')::uuid,
        (v_payload ->> 'expected_review_version')::bigint
      ) as result;
    when 'recover_decision' then
      return query
      select to_jsonb(result)
      from teamflow_private.recover_resume_review_decision(
        p_actor_id,
        (v_payload ->> 'workflow_id')::uuid,
        (v_payload ->> 'review_id')::uuid,
        (v_payload ->> 'decision_id')::uuid,
        (v_payload ->> 'expected_review_version')::bigint,
        v_payload ->> 'client_request_sha256'
      ) as result;
    when 'record_decision' then
      return query
      select to_jsonb(result)
      from teamflow_private.record_resume_review_decision(
        p_actor_id,
        (v_payload ->> 'workflow_id')::uuid,
        (v_payload ->> 'review_id')::uuid,
        (v_payload ->> 'decision_id')::uuid,
        (v_payload ->> 'expected_review_version')::bigint,
        v_payload ->> 'client_request_sha256',
        v_payload ->> 'action',
        case
          when v_payload -> 'edited_evaluation' = 'null'::jsonb then null
          else v_payload -> 'edited_evaluation'
        end,
        nullif(v_payload ->> 'reason_code', '')
      ) as result;
    when 'inspect' then
      return query
      select to_jsonb(result)
      from teamflow_private.inspect_resume_review(
        p_actor_id, (v_payload ->> 'workflow_id')::uuid
      ) as result;
    when 'list_pending' then
      return query
      select to_jsonb(result)
      from teamflow_private.list_pending_resume_reviews(
        p_actor_id,
        (v_payload ->> 'limit')::integer,
        nullif(v_payload ->> 'before_created_at', '')::timestamptz,
        nullif(v_payload ->> 'before_id', '')::uuid
      ) as result;
    when 'inspect_detail' then
      return query
      select to_jsonb(result)
      from teamflow_private.inspect_resume_review_detail(
        p_actor_id, (v_payload ->> 'workflow_id')::uuid
      ) as result;
    when 'load_edit_context' then
      return query
      select to_jsonb(result)
      from teamflow_private.load_resume_review_edit_context(
        p_actor_id,
        (v_payload ->> 'workflow_id')::uuid,
        (v_payload ->> 'review_id')::uuid,
        (v_payload ->> 'expected_review_version')::bigint
      ) as result;
  end case;
end;
$function$;

-- Startup checks the actual login session, role memberships, complete table/function
-- ACL allowlists, key material, and the Auth issuer bound to that key.
create or replace function teamflow_private.attest_hitl_runtime(
  p_key_id text,
  p_auth_issuer text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role_safe boolean;
  v_role_membership_safe boolean;
  v_schema_acl_safe boolean;
  v_table_acl_safe boolean;
  v_sequence_acl_safe boolean;
  v_key_ready boolean;
  v_unexpected_execute_count integer;
begin
  select
    not role.rolsuper
    and not role.rolcreatedb
    and not role.rolcreaterole
    and not role.rolinherit
    and not role.rolreplication
    and not role.rolbypassrls
    and has_schema_privilege(
      'teamflow_hitl_service', 'teamflow_private', 'USAGE'
    )
    and not has_schema_privilege(
      'teamflow_hitl_service', 'teamflow_private', 'CREATE'
    )
    and has_function_privilege(
      'teamflow_hitl_service',
      'teamflow_private.execute_hitl_actor_operation(uuid,text,uuid,text,bigint,text,text,text,bigint,uuid,text,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'teamflow_hitl_service',
      'teamflow_private.create_resume_review(uuid,uuid,text,uuid,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'teamflow_hitl_service',
      'teamflow_private.complete_resume_review_workflow(uuid,uuid,uuid,bigint)',
      'EXECUTE'
    )
    and has_function_privilege(
      'teamflow_hitl_service',
      'teamflow_private.attest_hitl_runtime(text,text)',
      'EXECUTE'
    )
  into v_role_safe
  from pg_roles as role
  where role.rolname = 'teamflow_hitl_service';

  select not exists (
    select 1
    from pg_auth_members as membership
    join pg_roles as role on role.rolname = 'teamflow_hitl_service'
    where membership.member = role.oid or membership.roleid = role.oid
  ) into v_role_membership_safe;

  select not exists (
    select 1
    from pg_namespace as namespace
    where namespace.nspname not in ('pg_catalog', 'information_schema')
      and namespace.nspname !~ '^pg_(toast|temp)'
      and (
        has_schema_privilege(
          'teamflow_hitl_service', namespace.oid, 'CREATE'
        )
        or (
          has_schema_privilege(
            'teamflow_hitl_service', namespace.oid, 'USAGE'
          )
          and namespace.nspname not in ('public', 'teamflow_private')
        )
      )
  ) into v_schema_acl_safe;

  select not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) as privilege(name)
    where namespace.nspname not in ('pg_catalog', 'information_schema')
      and namespace.nspname !~ '^pg_(toast|temp)'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege(
        'teamflow_hitl_service', relation.oid, privilege.name
      )
  ) into v_table_acl_safe;

  select not exists (
    select 1
    from pg_class as sequence
    join pg_namespace as namespace on namespace.oid = sequence.relnamespace
    cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as privilege(name)
    where namespace.nspname not in ('pg_catalog', 'information_schema')
      and namespace.nspname !~ '^pg_(toast|temp)'
      and sequence.relkind = 'S'
      and has_sequence_privilege(
        'teamflow_hitl_service', sequence.oid, privilege.name
      )
  ) into v_sequence_acl_safe;

  select exists (
    select 1
    from teamflow_private.hitl_capability_keys as key
    where key.key_id = p_key_id
      and key.auth_issuer = p_auth_issuer
      and octet_length(key.secret) between 32 and 64
      and key.activated_at <= clock_timestamp()
      and (key.expires_at is null or key.expires_at > clock_timestamp())
      and key.revoked_at is null
  ) into v_key_ready;

  select count(*)
  into v_unexpected_execute_count
  from pg_proc as procedure
  join pg_namespace as namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname not in ('pg_catalog', 'information_schema')
    and namespace.nspname !~ '^pg_(toast|temp)'
    and has_function_privilege(
      'teamflow_hitl_service', procedure.oid, 'EXECUTE'
    )
    and (
      namespace.nspname = 'teamflow_private'
      or (
        procedure.prosecdef
        and has_schema_privilege(
          'teamflow_hitl_service', namespace.oid, 'USAGE'
        )
      )
    )
    and procedure.oid <> all(array[
      to_regprocedure(
        'teamflow_private.execute_hitl_actor_operation(uuid,text,uuid,text,bigint,text,text,text,bigint,uuid,text,text)'
      )::oid,
      to_regprocedure(
        'teamflow_private.create_resume_review(uuid,uuid,text,uuid,jsonb)'
      )::oid,
      to_regprocedure(
        'teamflow_private.complete_resume_review_workflow(uuid,uuid,uuid,bigint)'
      )::oid,
      to_regprocedure('teamflow_private.attest_hitl_runtime(text,text)')::oid
    ]);

  return session_user = 'teamflow_hitl_service'
    and current_setting('role', true) = 'none'
    and coalesce(v_role_safe, false)
    and coalesce(v_role_membership_safe, false)
    and coalesce(v_schema_acl_safe, false)
    and coalesce(v_table_acl_safe, false)
    and coalesce(v_sequence_acl_safe, false)
    and coalesce(v_key_ready, false)
    and v_unexpected_execute_count = 0;
end;
$function$;

-- Remove the guessed-UUID path. The two lifecycle-only functions remain available to
-- the graph runner; neither accepts an actor and neither can create a decision.
revoke execute on function teamflow_private.resolve_active_membership(uuid)
  from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.lookup_resume_review_workflow(
  uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.prepare_resume_review_workflow(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text,
  jsonb, jsonb, jsonb, jsonb, jsonb, text, boolean, text, boolean, jsonb, text,
  jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.authorize_resume_review_decision(
  uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.recover_resume_review_decision(
  uuid, uuid, uuid, uuid, bigint, text
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.record_resume_review_decision(
  uuid, uuid, uuid, uuid, bigint, text, text, jsonb, text
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.inspect_resume_review(uuid, uuid)
  from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.list_pending_resume_reviews(
  uuid, integer, timestamptz, uuid
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.inspect_resume_review_detail(uuid, uuid)
  from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.load_resume_review_edit_context(
  uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;

revoke execute on function teamflow_private.consume_hitl_capability(
  uuid, text, uuid, text, bigint, text, text, bigint, uuid, text, text, boolean
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
revoke execute on function teamflow_private.execute_hitl_actor_operation(
  uuid, text, uuid, text, bigint, text, text, text, bigint, uuid, text, text
) from public, anon, authenticated, service_role,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
grant execute on function teamflow_private.execute_hitl_actor_operation(
  uuid, text, uuid, text, bigint, text, text, text, bigint, uuid, text, text
) to teamflow_hitl_service;
revoke execute on function teamflow_private.attest_hitl_runtime(text, text)
  from public, anon, authenticated, service_role,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
grant execute on function teamflow_private.attest_hitl_runtime(text, text)
  to teamflow_hitl_service;

-- Expired nonces no longer authorize anything, but retain a two-minute margin beyond
-- the 30-second capability horizon and clock skew. Only the migration-owner operator
-- can clean them, in small lock-skipping batches safe for concurrent workers.
create or replace function teamflow_private.cleanup_expired_hitl_capabilities(
  p_before timestamptz,
  p_limit integer default 1000
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deleted integer;
begin
  if p_before is null
     or p_before > clock_timestamp() - interval '2 minutes'
     or p_limit is null
     or p_limit not between 1 and 10000 then
    raise exception 'teamflow_hitl_capability_cleanup_invalid'
      using errcode = '22023';
  end if;

  with victims as materialized (
    select consumed.key_id, consumed.nonce
    from teamflow_private.hitl_consumed_capabilities as consumed
    where consumed.expires_at <= p_before
    order by consumed.expires_at, consumed.key_id, consumed.nonce
    limit p_limit
    for update skip locked
  ),
  deleted as (
    delete from teamflow_private.hitl_consumed_capabilities as consumed
    using victims
    where consumed.key_id = victims.key_id
      and consumed.nonce = victims.nonce
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;

  return v_deleted;
end;
$function$;

revoke execute on function teamflow_private.cleanup_expired_hitl_capabilities(
  timestamptz, integer
) from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;
grant execute on function teamflow_private.cleanup_expired_hitl_capabilities(
  timestamptz, integer
) to postgres;

-- Legal retention inputs are not known at build time. This is intentionally an
-- inventory-only contract: purge_enabled is structurally constrained to false, no
-- delete function exists, and no application role can read or mutate these tables.
create table if not exists teamflow_private.resume_review_retention_policies (
  merchant_id uuid primary key references public.merchants(id) on delete restrict,
  policy_version text not null check (
    policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
  ),
  retention_days integer not null check (retention_days between 1 and 3650),
  inventory_enabled boolean not null default false,
  purge_enabled boolean not null default false check (purge_enabled = false),
  approved_by uuid not null references auth.users(id) on delete restrict,
  approved_at timestamptz not null,
  legal_basis_code text not null check (
    legal_basis_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists teamflow_private.resume_review_legal_holds (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete restrict,
  scope text not null check (scope in ('merchant', 'workflow', 'candidate', 'document')),
  workflow_id uuid,
  candidate_id uuid,
  document_id text,
  reason_code text not null check (
    reason_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$'
  ),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  released_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check (released_at is null or released_at >= starts_at),
  check (
    (scope = 'merchant' and workflow_id is null and candidate_id is null and document_id is null)
    or (scope = 'workflow' and workflow_id is not null and candidate_id is null and document_id is null)
    or (scope = 'candidate' and workflow_id is null and candidate_id is not null and document_id is null)
    or (scope = 'document' and workflow_id is null and candidate_id is null and document_id is not null)
  ),
  foreign key (merchant_id, workflow_id)
    references public.resume_review_workflows(merchant_id, id) on delete restrict,
  foreign key (merchant_id, candidate_id)
    references public.candidates(merchant_id, id) on delete restrict,
  foreign key (merchant_id, document_id)
    references public.resume_documents(merchant_id, document_id) on delete restrict
);

create unique index if not exists resume_review_active_merchant_hold_idx
  on teamflow_private.resume_review_legal_holds (merchant_id)
  where scope = 'merchant' and released_at is null;
create unique index if not exists resume_review_active_workflow_hold_idx
  on teamflow_private.resume_review_legal_holds (merchant_id, workflow_id)
  where scope = 'workflow' and released_at is null;
create unique index if not exists resume_review_active_candidate_hold_idx
  on teamflow_private.resume_review_legal_holds (merchant_id, candidate_id)
  where scope = 'candidate' and released_at is null;
create unique index if not exists resume_review_active_document_hold_idx
  on teamflow_private.resume_review_legal_holds (merchant_id, document_id)
  where scope = 'document' and released_at is null;

revoke all on table teamflow_private.resume_review_retention_policies,
  teamflow_private.resume_review_legal_holds
  from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;

create or replace function teamflow_private.resume_review_retention_due_inventory(
  p_as_of timestamptz
)
returns table (
  merchant_id uuid,
  workflow_id uuid,
  workflow_status text,
  completed_at timestamptz,
  due_at timestamptz,
  policy_version text,
  legal_hold boolean,
  legal_hold_ids uuid[],
  current_revision_referenced boolean,
  purge_permitted boolean
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    workflow.merchant_id,
    workflow.id,
    workflow.status,
    workflow.completed_at,
    workflow.completed_at + make_interval(days => policy.retention_days),
    policy.policy_version,
    cardinality(hold.ids) > 0,
    hold.ids,
    exists (
      select 1
      from public.candidate_score_revisions as revision
      join public.candidates as candidate
        on candidate.merchant_id = revision.merchant_id
       and candidate.id = revision.candidate_id
       and candidate.current_score_revision_id = revision.id
      where revision.merchant_id = workflow.merchant_id
        and revision.workflow_id = workflow.id
    ),
    false
  from public.resume_review_workflows as workflow
  join teamflow_private.resume_review_retention_policies as policy
    on policy.merchant_id = workflow.merchant_id
   and policy.inventory_enabled
   and not policy.purge_enabled
  cross join lateral (
    select coalesce(array_agg(active_hold.id order by active_hold.id), array[]::uuid[]) as ids
    from teamflow_private.resume_review_legal_holds as active_hold
    where active_hold.merchant_id = workflow.merchant_id
      and active_hold.starts_at <= p_as_of
      and active_hold.released_at is null
      and (active_hold.ends_at is null or active_hold.ends_at > p_as_of)
      and (
        active_hold.scope = 'merchant'
        or (active_hold.scope = 'workflow' and active_hold.workflow_id = workflow.id)
        or (active_hold.scope = 'candidate' and active_hold.candidate_id = workflow.candidate_id)
        or (active_hold.scope = 'document' and active_hold.document_id = workflow.document_id)
      )
  ) as hold
  where p_as_of is not null
    and workflow.completed_at is not null
    and workflow.status in ('completed', 'rejected', 'failed')
    and workflow.completed_at + make_interval(days => policy.retention_days) <= p_as_of
  order by workflow.completed_at, workflow.merchant_id, workflow.id;
$function$;

revoke execute on function teamflow_private.resume_review_retention_due_inventory(timestamptz)
  from public, anon, authenticated, service_role, teamflow_hitl_service,
    teamflow_checkpoint_migrator, teamflow_checkpoint_runtime,
    teamflow_hiring_reader, teamflow_review_writer;


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
