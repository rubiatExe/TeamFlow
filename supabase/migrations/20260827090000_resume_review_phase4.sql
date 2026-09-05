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
  extraction_method text not null check (extraction_method in ('pdf_text', 'gemini_vision')),
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
