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
