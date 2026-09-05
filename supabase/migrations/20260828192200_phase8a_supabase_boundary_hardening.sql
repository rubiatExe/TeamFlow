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
