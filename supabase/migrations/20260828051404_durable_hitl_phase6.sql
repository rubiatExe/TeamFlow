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
