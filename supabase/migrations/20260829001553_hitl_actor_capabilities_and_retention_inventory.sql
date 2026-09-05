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
