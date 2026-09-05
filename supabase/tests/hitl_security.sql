-- Run with `supabase test db` after applying all migrations.
-- The test is transactional and proves the direct-DB actor boundary and
-- inventory-only retention posture.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select plan(37);

select has_table(
  'teamflow_private', 'hitl_capability_keys',
  'private capability keyring exists'
);
select has_table(
  'teamflow_private', 'hitl_consumed_capabilities',
  'one-time capability ledger exists'
);
select has_table(
  'teamflow_private', 'resume_review_retention_policies',
  'private retention policy inventory exists'
);
select has_table(
  'teamflow_private', 'resume_review_legal_holds',
  'private legal hold inventory exists'
);
select ok(
  to_regprocedure(
    'teamflow_private.execute_hitl_actor_operation(uuid,text,uuid,text,bigint,text,text,text,bigint,uuid,text,text)'
  ) is not null,
  'capability dispatcher exists'
);
select ok(
  has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.execute_hitl_actor_operation(uuid,text,uuid,text,bigint,text,text,text,bigint,uuid,text,text)',
    'EXECUTE'
  ),
  'HITL service can execute only the capability dispatcher'
);
select ok(
  not has_function_privilege(
    'anon',
    'teamflow_private.execute_hitl_actor_operation(uuid,text,uuid,text,bigint,text,text,text,bigint,uuid,text,text)',
    'EXECUTE'
  ),
  'Data API anonymous role cannot execute the direct-DB dispatcher'
);
select ok(
  has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.attest_hitl_runtime(text,text)',
    'EXECUTE'
  ),
  'HITL service can run startup attestation'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.consume_hitl_capability(uuid,text,uuid,text,bigint,text,text,bigint,uuid,text,text,boolean)',
    'EXECUTE'
  ),
  'HITL service cannot bypass the dispatcher to consume arbitrary capabilities'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.resolve_active_membership(uuid)',
    'EXECUTE'
  ),
  'HITL service cannot pass a guessed actor to membership resolution'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.prepare_resume_review_workflow(uuid,uuid,uuid,uuid,text,text,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,boolean,text,boolean,jsonb,text,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'HITL service cannot pass a guessed actor to workflow preparation'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.authorize_resume_review_decision(uuid,uuid,uuid,bigint)',
    'EXECUTE'
  ),
  'HITL service cannot call decision authorization directly'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.recover_resume_review_decision(uuid,uuid,uuid,uuid,bigint,text)',
    'EXECUTE'
  ),
  'HITL service cannot call decision recovery directly'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.record_resume_review_decision(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,text)',
    'EXECUTE'
  ),
  'HITL service cannot record a decision directly'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.inspect_resume_review(uuid,uuid)',
    'EXECUTE'
  ),
  'HITL service cannot inspect by guessed actor directly'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.list_pending_resume_reviews(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  ),
  'HITL service cannot list a guessed actor queue directly'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.inspect_resume_review_detail(uuid,uuid)',
    'EXECUTE'
  ),
  'HITL service cannot inspect detail by guessed actor directly'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.load_resume_review_edit_context(uuid,uuid,uuid,bigint)',
    'EXECUTE'
  ),
  'HITL service cannot load edit context directly'
);
select ok(
  not has_table_privilege(
    'teamflow_hitl_service', 'teamflow_private.hitl_capability_keys', 'SELECT'
  ),
  'HITL service cannot read the server-side capability keyring'
);
select ok(
  not has_table_privilege(
    'teamflow_hitl_service',
    'teamflow_private.hitl_consumed_capabilities',
    'INSERT'
  ),
  'HITL service cannot forge replay-ledger entries'
);
select ok(
  to_regprocedure(
    'teamflow_private.cleanup_expired_hitl_capabilities(timestamptz,integer)'
  ) is not null,
  'bounded expired-capability cleanup exists'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.cleanup_expired_hitl_capabilities(timestamptz,integer)',
    'EXECUTE'
  ),
  'HITL runtime cannot execute operator capability cleanup'
);
select ok(
  not has_table_privilege(
    'teamflow_hitl_service',
    'teamflow_private.hitl_consumed_capabilities',
    'DELETE'
  ),
  'HITL runtime cannot delete replay-ledger evidence directly'
);
select ok(
  not has_table_privilege(
    'teamflow_hitl_service', 'auth.sessions', 'SELECT'
  ),
  'HITL runtime cannot inspect Auth sessions directly'
);
select ok(
  not has_schema_privilege('teamflow_hitl_service', 'auth', 'USAGE'),
  'HITL runtime cannot call routines in the Auth schema directly'
);
select ok(
  not exists (
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
  ),
  'HITL runtime has no non-system sequence privileges'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname not in ('pg_catalog', 'information_schema')
      and namespace.nspname !~ '^pg_(toast|temp)'
      and procedure.prosecdef
      and has_schema_privilege(
        'teamflow_hitl_service', namespace.oid, 'USAGE'
      )
      and has_function_privilege(
        'teamflow_hitl_service', procedure.oid, 'EXECUTE'
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
      ])
  ),
  'HITL runtime has no non-allowlisted callable SECURITY DEFINER routine'
);
select ok(
  not has_table_privilege(
    'teamflow_hitl_service',
    'teamflow_private.resume_review_retention_policies',
    'SELECT'
  ),
  'application service cannot read retention policy inventory'
);
select ok(
  not has_function_privilege(
    'teamflow_hitl_service',
    'teamflow_private.resume_review_retention_due_inventory(timestamptz)',
    'EXECUTE'
  ),
  'application service cannot run privileged retention inventory'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid =
      'teamflow_private.resume_review_retention_policies'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%purge_enabled = false%'
  ),
  'retention policy structurally forbids purge activation'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'teamflow_private'
      and procedure.proname ~ 'resume_review.*(purge|delete)|(purge|delete).*resume_review'
  ),
  'no destructive resume-review purge function exists'
);

create temp table hitl_capability_fixture (
  actor_id uuid not null,
  other_actor_id uuid not null,
  auth_issuer text not null,
  operation text not null,
  resource_sha256 text not null,
  other_resource_sha256 text not null,
  expires_at bigint not null,
  nonce uuid not null,
  key_id text not null,
  secret bytea not null,
  signature text
) on commit drop;

insert into hitl_capability_fixture (
  actor_id, other_actor_id, auth_issuer, operation, resource_sha256,
  other_resource_sha256, expires_at, nonce, key_id, secret
)
select
  'a2000000-0000-4000-8000-000000000001'::uuid,
  'a2000000-0000-4000-8000-000000000002'::uuid,
  'https://project.example.test/auth/v1',
  'resolve_membership',
  encode(
    digest(
      convert_to('{}', 'UTF8'),
      'sha256'
    ),
    'hex'
  ),
  encode(
    digest(
      convert_to('{}', 'UTF8'),
      'sha256'
    ),
    'hex'
  ),
  floor(extract(epoch from clock_timestamp()))::bigint + 29,
  'a2000000-0000-4000-8000-000000000003'::uuid,
  encode(digest(decode(repeat('11', 32), 'hex'), 'sha256'), 'hex'),
  decode(repeat('11', 32), 'hex');

update hitl_capability_fixture
set signature = encode(
  hmac(
    convert_to(
      'teamflow-hitl-capability-v2' || chr(10)
      || key_id || chr(10)
      || auth_issuer || chr(10)
      || actor_id::text || chr(10)
      || '-' || chr(10)
      || '-' || chr(10)
      || '-' || chr(10)
      || operation || chr(10)
      || resource_sha256 || chr(10)
      || expires_at::text || chr(10)
      || nonce::text,
      'UTF8'
    ),
    secret,
    'sha256'
  ),
  'hex'
);

insert into teamflow_private.hitl_capability_keys (key_id, secret, auth_issuer)
select key_id, secret, auth_issuer
from hitl_capability_fixture;

insert into auth.users (id)
select actor_id from hitl_capability_fixture;
insert into public.merchants (id, email, store_name) values (
  'b2000000-0000-4000-8000-000000000001',
  'hitl-security-pgtap@example.test',
  'HITL security pgTAP'
);
insert into public.merchant_memberships (merchant_id, user_id, role)
select
  'b2000000-0000-4000-8000-000000000001'::uuid,
  actor_id,
  'manager'
from hitl_capability_fixture;

select throws_ok($sql$
  select count(*)
  from teamflow_private.execute_hitl_actor_operation(
    (select actor_id from hitl_capability_fixture),
    (select auth_issuer from hitl_capability_fixture),
    null,
    null,
    null,
    (select operation from hitl_capability_fixture),
    (select resource_sha256 from hitl_capability_fixture),
    '{"unexpected":true}'::text,
    (select expires_at from hitl_capability_fixture),
    (select nonce from hitl_capability_fixture),
    (select key_id from hitl_capability_fixture),
    (select signature from hitl_capability_fixture)
  )
$sql$, 'PT403', 'teamflow_hitl_capability_invalid',
  'a capability cannot be moved to a different payload');

select lives_ok($sql$
  select count(*)
  from teamflow_private.execute_hitl_actor_operation(
    (select actor_id from hitl_capability_fixture),
    (select auth_issuer from hitl_capability_fixture),
    null,
    null,
    null,
    (select operation from hitl_capability_fixture),
    (select resource_sha256 from hitl_capability_fixture),
    '{}'::text,
    (select expires_at from hitl_capability_fixture),
    (select nonce from hitl_capability_fixture),
    (select key_id from hitl_capability_fixture),
    (select signature from hitl_capability_fixture)
  )
$sql$, 'a valid short-lived capability executes');
select is(
  (select count(*) from teamflow_private.hitl_consumed_capabilities),
  1::bigint,
  'successful capability use writes exactly one replay-ledger row'
);
select throws_ok($sql$
  select count(*)
  from teamflow_private.execute_hitl_actor_operation(
    (select actor_id from hitl_capability_fixture),
    (select auth_issuer from hitl_capability_fixture),
    null,
    null,
    null,
    (select operation from hitl_capability_fixture),
    (select resource_sha256 from hitl_capability_fixture),
    '{}'::text,
    (select expires_at from hitl_capability_fixture),
    (select nonce from hitl_capability_fixture),
    (select key_id from hitl_capability_fixture),
    (select signature from hitl_capability_fixture)
  )
$sql$, 'PT403', 'teamflow_hitl_capability_replayed',
  'a successful capability cannot be replayed');
select throws_ok($sql$
  select count(*)
  from teamflow_private.execute_hitl_actor_operation(
    (select other_actor_id from hitl_capability_fixture),
    (select auth_issuer from hitl_capability_fixture),
    null,
    null,
    null,
    (select operation from hitl_capability_fixture),
    (select other_resource_sha256 from hitl_capability_fixture),
    '{}'::text,
    (select expires_at from hitl_capability_fixture),
    gen_random_uuid(),
    (select key_id from hitl_capability_fixture),
    (select signature from hitl_capability_fixture)
  )
$sql$, 'PT403', 'teamflow_hitl_capability_invalid',
  'a capability signature cannot cross actors');
select throws_ok($sql$
  select count(*)
  from teamflow_private.execute_hitl_actor_operation(
    (select actor_id from hitl_capability_fixture),
    (select auth_issuer from hitl_capability_fixture),
    null,
    null,
    null,
    (select operation from hitl_capability_fixture),
    (select resource_sha256 from hitl_capability_fixture),
    '{}'::text,
    floor(extract(epoch from clock_timestamp()))::bigint - 1,
    gen_random_uuid(),
    (select key_id from hitl_capability_fixture),
    repeat('0', 64)
  )
$sql$, 'PT403', 'teamflow_hitl_capability_invalid',
  'an expired capability fails closed');

select * from finish();
rollback;
