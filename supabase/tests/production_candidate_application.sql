-- Run against a disposable database after the production candidate migration.
-- The transaction deliberately rolls back all fixture data.
begin;

do $checks$
begin
  if has_table_privilege('anon', 'public.candidate_application_invitations', 'select')
    or has_table_privilege('authenticated', 'public.candidate_resume_uploads', 'select')
    or not has_column_privilege(
      'service_role', 'public.merchant_memberships', 'merchant_id', 'select'
    )
    or not has_column_privilege(
      'service_role', 'public.merchant_memberships', 'user_id', 'select'
    )
    or not has_column_privilege(
      'service_role', 'public.merchant_memberships', 'role', 'select'
    )
    or not has_column_privilege(
      'service_role', 'public.merchant_memberships', 'status', 'select'
    )
    or has_function_privilege(
      'anon',
      'public.teamflow_finalize_candidate_application(uuid,uuid,jsonb,text,text,boolean)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.teamflow_release_candidate_resume_upload(uuid,uuid)',
      'execute'
    )
  then
    raise exception 'candidate_upload_private_acl_failed';
  end if;
end
$checks$;

insert into public.merchants (id, email, store_name)
values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'production-candidate-test@example.invalid',
  'Production Candidate Test'
);
insert into public.jobs (id, merchant_id, title)
values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Barista'
);
insert into public.candidate_application_invitations (
  id, token_hash, merchant_id, role_id, job_id, expires_at
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  repeat('a', 64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'barista',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  now() + interval '1 day'
);

set local role service_role;

do $checks$
declare
  v_invitation uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_released uuid;
  v_first uuid;
  v_limited boolean := false;
  v_replayed boolean := false;
  v_result jsonb;
begin
  v_released := public.teamflow_register_candidate_resume_upload(
    v_invitation,
    'candidate-invitations/cccccccc-cccc-4ccc-8ccc-cccccccccccc/00000000-0000-4000-8000-000000000000.pdf',
    'failed-token.pdf', 'application/pdf', 8
  );
  if not public.teamflow_release_candidate_resume_upload(v_invitation, v_released) then
    raise exception 'failed_token_grant_release_failed';
  end if;
  if public.teamflow_release_candidate_resume_upload(v_invitation, v_released) then
    raise exception 'release_replay_not_idempotent';
  end if;
  if (select upload_count from public.candidate_application_invitations
      where id = v_invitation) <> 0 then
    raise exception 'release_did_not_restore_upload_allowance';
  end if;

  v_first := public.teamflow_register_candidate_resume_upload(
    v_invitation,
    'candidate-invitations/cccccccc-cccc-4ccc-8ccc-cccccccccccc/11111111-1111-4111-8111-111111111111.pdf',
    'resume.pdf', 'application/pdf', 8
  );
  if v_first is null then raise exception 'upload_grant_missing'; end if;

  for i in 1..3 loop
    if not public.teamflow_reserve_candidate_resume_preview(v_invitation, v_first) then
      raise exception 'preview_reservation_%_failed', i;
    end if;
  end loop;
  if public.teamflow_reserve_candidate_resume_preview(v_invitation, v_first) then
    raise exception 'preview_cap_failed';
  end if;
  if public.teamflow_release_candidate_resume_upload(v_invitation, v_first) then
    raise exception 'previewed_upload_released';
  end if;

  perform public.teamflow_register_candidate_resume_upload(
    v_invitation,
    'candidate-invitations/cccccccc-cccc-4ccc-8ccc-cccccccccccc/22222222-2222-4222-8222-222222222222.png',
    'other.png', 'image/png', 8
  );
  perform public.teamflow_register_candidate_resume_upload(
    v_invitation,
    'candidate-invitations/cccccccc-cccc-4ccc-8ccc-cccccccccccc/33333333-3333-4333-8333-333333333333.jpg',
    'other.jpg', 'image/jpeg', 8
  );
  begin
    perform public.teamflow_register_candidate_resume_upload(
      v_invitation,
      'candidate-invitations/cccccccc-cccc-4ccc-8ccc-cccccccccccc/44444444-4444-4444-8444-444444444444.pdf',
      'extra.pdf', 'application/pdf', 8
    );
  exception when sqlstate 'PT429' then
    v_limited := true;
  end;
  if not v_limited then raise exception 'upload_cap_failed'; end if;

  v_result := public.teamflow_finalize_candidate_application(
    v_invitation,
    v_first,
    jsonb_build_object(
      'role_id', 'attacker-role',
      'candidate_id', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      'basic_info', jsonb_build_object(
        'full_name', 'Resume Applicant',
        'email', 'applicant@example.invalid',
        'phone', '555-222-3344',
        'city', 'Raleigh'
      ),
      'knockout_answers', '{}'::jsonb,
      'profile', '{}'::jsonb,
      'skills', '{}'::jsonb,
      'motivation', '{}'::jsonb,
      'resume', jsonb_build_object('storage_path', 'attacker-path')
    ),
    'Verified resume text',
    repeat('b', 64),
    true
  );
  if v_result ->> 'candidateId' is null
    or v_result ->> 'applicationId' is null
  then
    raise exception 'finalize_result_missing';
  end if;
  if not exists (
    select 1 from public.candidates as candidate
    where candidate.id = (v_result ->> 'candidateId')::uuid
      and candidate.merchant_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and candidate.job_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      and candidate.resume_url = 'candidate-invitations/cccccccc-cccc-4ccc-8ccc-cccccccccccc/11111111-1111-4111-8111-111111111111.pdf'
  ) then
    raise exception 'candidate_tenant_or_resume_binding_failed';
  end if;
  if not exists (
    select 1 from public.applications as application
    where application.id = (v_result ->> 'applicationId')::uuid
      and application.candidate_id = (v_result ->> 'candidateId')::uuid
      and application.role_id = 'barista'
      and application.data -> 'resume' ->> 'content_sha256' = repeat('b', 64)
      and application.data -> 'resume' ->> 'storage_path' = 'candidate-invitations/cccccccc-cccc-4ccc-8ccc-cccccccccccc/11111111-1111-4111-8111-111111111111.pdf'
  ) then
    raise exception 'application_authority_binding_failed';
  end if;
  if not exists (
    select 1 from public.candidate_application_invitations as invitation
    where invitation.id = v_invitation
      and invitation.submitted_application_id = (v_result ->> 'applicationId')::uuid
      and invitation.submitted_upload_id = v_first
      and invitation.submitted_passed is true
      and invitation.submitted_at is not null
  ) then
    raise exception 'submission_receipt_binding_failed';
  end if;
  if public.teamflow_release_candidate_resume_upload(v_invitation, v_first) then
    raise exception 'submitted_upload_released';
  end if;

  begin
    perform public.teamflow_finalize_candidate_application(
      v_invitation, v_first, '{}'::jsonb, '', repeat('b', 64), false
    );
  exception when sqlstate 'PT409' then
    v_replayed := true;
  end;
  if not v_replayed then raise exception 'one_time_submission_failed'; end if;
end
$checks$;

reset role;
update public.candidate_resume_uploads
set created_at = now() - interval '4 hours'
where invitation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
set local role service_role;

do $checks$
declare
  v_unused_id uuid;
begin
  if (
    select count(*)
    from public.teamflow_list_abandoned_resume_uploads(now(), 50)
  ) <> 0 then
    raise exception 'unexpired_invitation_upload_listed';
  end if;
  select id into v_unused_id from public.candidate_resume_uploads
  where invitation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    and storage_path like '%.png';
  if public.teamflow_claim_abandoned_resume_upload(v_unused_id) is not null then
    raise exception 'unexpired_invitation_upload_claimed';
  end if;
end
$checks$;

reset role;
update public.candidate_application_invitations
set created_at = now() - interval '2 days', expires_at = now() - interval '1 hour'
where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
update public.candidate_resume_uploads
set created_at = now()
where invitation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
set local role service_role;

do $checks$
declare
  v_unused_id uuid;
begin
  if (
    select count(*)
    from public.teamflow_list_abandoned_resume_uploads(now(), 50)
  ) <> 0 then
    raise exception 'signed_token_grace_not_enforced';
  end if;
  select id into v_unused_id from public.candidate_resume_uploads
  where invitation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    and storage_path like '%.png';
  if public.teamflow_claim_abandoned_resume_upload(v_unused_id) is not null then
    raise exception 'signed_token_grace_claimed';
  end if;
end
$checks$;

reset role;
update public.candidate_resume_uploads
set created_at = now() - interval '4 hours'
where invitation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
set local role service_role;

do $checks$
declare
  v_unused_id uuid;
  v_path text;
begin
  if (
    select count(*)
    from public.teamflow_list_abandoned_resume_uploads(now(), 50)
  ) <> 2 then
    raise exception 'abandoned_upload_listing_failed';
  end if;
  select id into v_unused_id
  from public.teamflow_list_abandoned_resume_uploads(now(), 50)
  limit 1;
  v_path := public.teamflow_claim_abandoned_resume_upload(v_unused_id);
  if v_path is null then raise exception 'abandoned_upload_claim_failed'; end if;
  if not public.teamflow_delete_abandoned_resume_upload(v_unused_id) then
    raise exception 'abandoned_upload_delete_failed';
  end if;
  if (
    select count(*)
    from public.teamflow_list_abandoned_resume_uploads(now(), 50)
  ) <> 1 then
    raise exception 'referenced_upload_preservation_failed';
  end if;
end
$checks$;

rollback;
