begin;

-- Opaque candidate links are stored only as hashes. Candidate browsers never
-- receive database credentials or direct access to these tables.
create table public.candidate_application_invitations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  role_id text not null check (char_length(role_id) between 1 and 120),
  job_id uuid,
  candidate_name text check (candidate_name is null or char_length(candidate_name) between 1 and 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  submitted_application_id uuid,
  submitted_upload_id uuid,
  submitted_passed boolean,
  upload_count integer not null default 0 check (upload_count between 0 and 3),
  check (expires_at > created_at),
  check (submitted_at is null or submitted_at >= created_at),
  check (
    (submitted_at is null and submitted_application_id is null
      and submitted_upload_id is null and submitted_passed is null)
    or
    (submitted_at is not null and submitted_application_id is not null
      and submitted_upload_id is not null and submitted_passed is not null)
  )
);

-- A composite foreign key prevents an invitation from naming another
-- merchant's job. Removing a job leaves the role-only invitation intact.
create unique index if not exists jobs_id_merchant_id_unique_idx
  on public.jobs (id, merchant_id);
alter table public.candidate_application_invitations
  add constraint candidate_application_invitations_tenant_job_fk
  foreign key (job_id, merchant_id)
  references public.jobs (id, merchant_id)
  on delete set null (job_id);

create index candidate_application_invitations_merchant_expiry_idx
  on public.candidate_application_invitations (merchant_id, expires_at);

-- Registration happens before a short-lived signed Storage upload is minted.
-- The path is server-chosen, unique, and tied to exactly one invitation.
create table public.candidate_resume_uploads (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.candidate_application_invitations(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (
    char_length(file_name) between 1 and 255
    and position('/' in file_name) = 0
    and position(chr(92) in file_name) = 0
    and file_name !~ '[[:cntrl:]]'
  ),
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  preview_count integer not null default 0 check (preview_count between 0 and 3),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    storage_path ~ (
      '^candidate-invitations/' || invitation_id::text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](pdf|jpg|png)$'
    )
  )
);

create index candidate_resume_uploads_invitation_idx
  on public.candidate_resume_uploads (invitation_id, created_at desc);
create index if not exists candidates_resume_url_idx
  on public.candidates (resume_url);
create index if not exists applications_resume_storage_path_idx
  on public.applications ((data -> 'resume' ->> 'storage_path'))
  where data ? 'resume';

alter table public.candidate_application_invitations enable row level security;
alter table public.candidate_resume_uploads enable row level security;
revoke all on table public.candidate_application_invitations,
  public.candidate_resume_uploads
  from public, anon, authenticated, service_role;
grant select, insert, update (
  upload_count, submitted_at, submitted_application_id,
  submitted_upload_id, submitted_passed
)
  on table public.candidate_application_invitations to service_role;
grant select, insert, update (preview_count, revoked_at), delete
  on table public.candidate_resume_uploads to service_role;
-- Invitation issuance reads only the membership columns needed to prove that
-- the verified Auth actor manages the selected merchant.
grant select (merchant_id, user_id, role, status)
  on table public.merchant_memberships to service_role;

-- Row locks serialize simultaneous grant requests, keeping the upload cap exact.
create function public.teamflow_register_candidate_resume_upload(
  p_invitation_id uuid,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes integer
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_invitation public.candidate_application_invitations%rowtype;
  v_upload_id uuid;
begin
  select * into v_invitation
  from public.candidate_application_invitations
  where id = p_invitation_id
  for update;

  if not found or v_invitation.submitted_at is not null
    or v_invitation.expires_at <= now()
  then
    raise exception 'teamflow_invitation_unavailable' using errcode = 'PT403';
  end if;
  if v_invitation.upload_count >= 3 then
    raise exception 'teamflow_resume_upload_limit' using errcode = 'PT429';
  end if;

  insert into public.candidate_resume_uploads (
    invitation_id, storage_path, file_name, mime_type, size_bytes
  ) values (
    p_invitation_id, p_storage_path, p_file_name, p_mime_type, p_size_bytes
  ) returning id into v_upload_id;

  update public.candidate_application_invitations
  set upload_count = upload_count + 1
  where id = p_invitation_id;
  return v_upload_id;
end
$function$;

-- A failed token mint must not burn an invitation's upload allowance. The
-- invitation lock serializes this with registration, preview, and finalization.
create function public.teamflow_release_candidate_resume_upload(
  p_invitation_id uuid,
  p_upload_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_invitation public.candidate_application_invitations%rowtype;
  v_upload public.candidate_resume_uploads%rowtype;
begin
  select * into v_invitation
  from public.candidate_application_invitations
  where id = p_invitation_id
  for update;
  if not found or v_invitation.submitted_at is not null
    or v_invitation.upload_count < 1
  then
    return false;
  end if;

  select * into v_upload
  from public.candidate_resume_uploads
  where id = p_upload_id and invitation_id = p_invitation_id
  for update;
  if not found or v_upload.preview_count <> 0 or v_upload.revoked_at is not null
    or exists (
      select 1 from public.candidates as candidate
      where candidate.resume_url = v_upload.storage_path
    )
    or exists (
      select 1 from public.applications as application
      where application.data -> 'resume' ->> 'storage_path' = v_upload.storage_path
    )
  then
    return false;
  end if;

  delete from public.candidate_resume_uploads where id = p_upload_id;
  update public.candidate_application_invitations
  set upload_count = upload_count - 1
  where id = p_invitation_id;
  return true;
end
$function$;

-- Preview reservations limit paid OCR calls even if a candidate retries the API.
create function public.teamflow_reserve_candidate_resume_preview(
  p_invitation_id uuid,
  p_upload_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_invitation public.candidate_application_invitations%rowtype;
  v_upload_id uuid;
begin
  select * into v_invitation
  from public.candidate_application_invitations
  where id = p_invitation_id
  for update;
  if not found or v_invitation.submitted_at is not null
    or v_invitation.expires_at <= now()
  then
    return false;
  end if;

  update public.candidate_resume_uploads
  set preview_count = preview_count + 1
  where id = p_upload_id
    and invitation_id = p_invitation_id
    and revoked_at is null
    and preview_count < 3
  returning id into v_upload_id;
  return v_upload_id is not null;
end
$function$;

-- One transaction binds the reviewed answers to the server-registered upload
-- and the invitation's tenant/role. A concurrent second submit waits on the
-- invitation lock and cannot create another candidate or application.
create function public.teamflow_finalize_candidate_application(
  p_invitation_id uuid,
  p_upload_id uuid,
  p_submission jsonb,
  p_resume_text text,
  p_resume_sha256 text,
  p_passed boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_invitation public.candidate_application_invitations%rowtype;
  v_upload public.candidate_resume_uploads%rowtype;
  v_basic jsonb;
  v_name text;
  v_email text;
  v_phone text;
  v_city text;
  v_candidate_id uuid;
  v_application_id uuid;
  v_data jsonb;
begin
  select * into v_invitation
  from public.candidate_application_invitations
  where id = p_invitation_id
  for update;
  if not found or v_invitation.submitted_at is not null
    or v_invitation.expires_at <= now()
  then
    raise exception 'teamflow_invitation_unavailable' using errcode = 'PT409';
  end if;

  select * into v_upload
  from public.candidate_resume_uploads
  where id = p_upload_id and invitation_id = p_invitation_id
    and revoked_at is null;
  if not found then
    raise exception 'teamflow_resume_upload_required' using errcode = 'PT400';
  end if;
  if p_resume_sha256 is null or p_resume_sha256 !~ '^[0-9a-f]{64}$'
    or p_resume_text is null or char_length(p_resume_text) > 100000
    or p_passed is null
    or jsonb_typeof(p_submission) is distinct from 'object'
    or jsonb_typeof(p_submission -> 'basic_info') is distinct from 'object'
    or jsonb_typeof(p_submission -> 'knockout_answers') is distinct from 'object'
    or jsonb_typeof(p_submission -> 'profile') is distinct from 'object'
    or jsonb_typeof(p_submission -> 'skills') is distinct from 'object'
    or jsonb_typeof(p_submission -> 'motivation') is distinct from 'object'
  then
    raise exception 'teamflow_invalid_application' using errcode = 'PT400';
  end if;

  v_basic := p_submission -> 'basic_info';
  v_name := btrim(v_basic ->> 'full_name');
  v_email := btrim(v_basic ->> 'email');
  v_phone := btrim(v_basic ->> 'phone');
  v_city := nullif(btrim(v_basic ->> 'city'), '');
  if v_name is null or char_length(v_name) not between 1 and 200
    or v_email is null or char_length(v_email) not between 3 and 320
    or v_phone is null or char_length(v_phone) not between 7 and 40
    or (v_city is not null and char_length(v_city) > 200)
  then
    raise exception 'teamflow_invalid_application_identity' using errcode = 'PT400';
  end if;

  -- A job may have been archived after invitation issuance; a cross-tenant
  -- rebind is never accepted, even if an operator changed the job meanwhile.
  if v_invitation.job_id is not null and not exists (
    select 1 from public.jobs as job
    where job.id = v_invitation.job_id
      and job.merchant_id = v_invitation.merchant_id
  ) then
    raise exception 'teamflow_invitation_job_unavailable' using errcode = 'PT409';
  end if;

  insert into public.candidates (
    merchant_id, job_id, name, email, phone, city, status,
    resume_url, resume_text, summary, source
  ) values (
    v_invitation.merchant_id, v_invitation.job_id, v_name, v_email, v_phone,
    coalesce(v_city, 'Local Area'), 'new', v_upload.storage_path,
    p_resume_text, 'Awaiting authorized human review', 'Web Form'
  ) returning id into v_candidate_id;

  v_data := jsonb_build_object(
    'candidate_id', v_candidate_id,
    'role_id', v_invitation.role_id,
    'basic_info', v_basic,
    'knockout_answers', p_submission -> 'knockout_answers',
    'profile', p_submission -> 'profile',
    'skills', p_submission -> 'skills',
    'motivation', p_submission -> 'motivation',
    'resume', jsonb_build_object(
      'file_name', v_upload.file_name,
      'mime_type', v_upload.mime_type,
      'storage_path', v_upload.storage_path,
      'content_sha256', p_resume_sha256
    )
  );
  insert into public.applications (candidate_id, role_id, data)
  values (v_candidate_id, v_invitation.role_id, v_data)
  returning id into v_application_id;

  update public.candidate_application_invitations
  set submitted_at = now(),
    submitted_application_id = v_application_id,
    submitted_upload_id = p_upload_id,
    submitted_passed = p_passed
  where id = p_invitation_id;
  return jsonb_build_object(
    'candidateId', v_candidate_id,
    'applicationId', v_application_id
  );
end
$function$;

-- Cleanup uses a three-hour floor, which outlives the signed upload token.
-- It checks both candidate and immutable application references so a retained
-- application never loses its résumé after a candidate record is removed.
create function public.teamflow_list_abandoned_resume_uploads(
  p_before timestamptz,
  p_limit integer
)
returns table (id uuid, storage_path text)
language sql
stable
security invoker
set search_path = ''
as $function$
  select upload.id, upload.storage_path
  from public.candidate_resume_uploads as upload
  join public.candidate_application_invitations as invitation
    on invitation.id = upload.invitation_id
  where p_before is not null
    and p_limit between 1 and 100
    and invitation.expires_at <= now()
    and upload.created_at < least(p_before, now() - interval '3 hours')
    and not exists (
      select 1 from public.candidates as candidate
      where candidate.resume_url = upload.storage_path
    )
    and not exists (
      select 1 from public.applications as application
      where application.data -> 'resume' ->> 'storage_path' = upload.storage_path
    )
  order by upload.created_at, upload.id
  limit p_limit;
$function$;

-- Claim and finalize lock the same invitation first. Once claimed, the grant
-- is invalid for preview and submission, while a failed Storage delete is
-- retryable on the next cleanup run.
create function public.teamflow_claim_abandoned_resume_upload(
  p_upload_id uuid
)
returns text
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_invitation_id uuid;
  v_invitation public.candidate_application_invitations%rowtype;
  v_upload public.candidate_resume_uploads%rowtype;
begin
  select invitation_id into v_invitation_id
  from public.candidate_resume_uploads
  where id = p_upload_id;
  if not found then return null; end if;

  select * into v_invitation from public.candidate_application_invitations
  where id = v_invitation_id for update;
  if not found or v_invitation.expires_at > now() then return null; end if;
  select * into v_upload from public.candidate_resume_uploads
  where id = p_upload_id and invitation_id = v_invitation_id for update;
  if not found or v_upload.created_at >= now() - interval '3 hours'
    or exists (
      select 1 from public.candidates as candidate
      where candidate.resume_url = v_upload.storage_path
    )
    or exists (
      select 1 from public.applications as application
      where application.data -> 'resume' ->> 'storage_path' = v_upload.storage_path
    )
  then
    return null;
  end if;

  update public.candidate_resume_uploads
  set revoked_at = coalesce(revoked_at, now())
  where id = p_upload_id;
  return v_upload.storage_path;
end
$function$;

create function public.teamflow_delete_abandoned_resume_upload(
  p_upload_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_invitation_id uuid;
  v_upload public.candidate_resume_uploads%rowtype;
begin
  select invitation_id into v_invitation_id
  from public.candidate_resume_uploads
  where id = p_upload_id;
  if not found then return false; end if;

  perform 1 from public.candidate_application_invitations
  where id = v_invitation_id for update;
  select * into v_upload from public.candidate_resume_uploads
  where id = p_upload_id and invitation_id = v_invitation_id for update;
  if not found or v_upload.revoked_at is null
    or exists (
      select 1 from public.candidates as candidate
      where candidate.resume_url = v_upload.storage_path
    )
    or exists (
      select 1 from public.applications as application
      where application.data -> 'resume' ->> 'storage_path' = v_upload.storage_path
    )
  then
    return false;
  end if;

  delete from public.candidate_resume_uploads where id = p_upload_id;
  return found;
end
$function$;

revoke execute on function public.teamflow_register_candidate_resume_upload(
  uuid, text, text, text, integer
), public.teamflow_release_candidate_resume_upload(uuid, uuid),
  public.teamflow_reserve_candidate_resume_preview(uuid, uuid),
  public.teamflow_finalize_candidate_application(uuid, uuid, jsonb, text, text, boolean),
  public.teamflow_list_abandoned_resume_uploads(timestamptz, integer),
  public.teamflow_claim_abandoned_resume_upload(uuid),
  public.teamflow_delete_abandoned_resume_upload(uuid)
  from public, anon, authenticated, service_role, authenticator;
grant execute on function public.teamflow_register_candidate_resume_upload(
  uuid, text, text, text, integer
), public.teamflow_release_candidate_resume_upload(uuid, uuid),
  public.teamflow_reserve_candidate_resume_preview(uuid, uuid),
  public.teamflow_finalize_candidate_application(uuid, uuid, jsonb, text, text, boolean),
  public.teamflow_list_abandoned_resume_uploads(timestamptz, integer),
  public.teamflow_claim_abandoned_resume_upload(uuid),
  public.teamflow_delete_abandoned_resume_upload(uuid)
  to service_role;

notify pgrst, 'reload schema';
commit;
