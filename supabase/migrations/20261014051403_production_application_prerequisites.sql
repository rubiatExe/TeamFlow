begin;

-- The existing project predates the membership model used to authorize
-- production invitation issuance. No membership is inferred from merchant
-- email or other editable data: an operator must assign real Auth users.
create table if not exists public.merchant_memberships (
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

create index if not exists merchant_memberships_active_actor_idx
  on public.merchant_memberships (user_id, merchant_id, role)
  where status = 'active';
create index if not exists merchant_memberships_active_merchant_idx
  on public.merchant_memberships (merchant_id, role, user_id)
  where status = 'active';

alter table public.merchant_memberships enable row level security;
revoke all on table public.merchant_memberships
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.merchant_memberships
  to service_role;

-- The original demo policies allow every API role to read or write hiring
-- data. Remove those policies and broad table grants before the new candidate
-- routes are enabled. The trusted server client retains database access.
alter table public.merchants enable row level security;
alter table public.jobs enable row level security;
alter table public.candidates enable row level security;
alter table public.applications enable row level security;

drop policy if exists "Allow public all on merchants" on public.merchants;
drop policy if exists "Allow public all on jobs" on public.jobs;
drop policy if exists "Allow public all on candidates" on public.candidates;
drop policy if exists "Allow public all on applications" on public.applications;

revoke all on table public.merchants, public.jobs,
  public.candidates, public.applications
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.merchants, public.jobs,
  public.candidates, public.applications
  to service_role;

-- Audit logs in older TeamFlow installations can also hold candidate PII.
do $audit$
begin
  if to_regclass('public.audit_logs') is not null then
    execute 'alter table public.audit_logs enable row level security';
    execute 'drop policy if exists "Allow public all on audit_logs" on public.audit_logs';
    execute 'revoke all on table public.audit_logs from public, anon, authenticated, service_role';
    execute 'grant select, insert, update, delete on table public.audit_logs to service_role';
  end if;
end
$audit$;

-- The browser receives a short-lived, path-specific signed upload token from
-- the server. It has no direct bucket permissions through anon/authenticated.
do $storage$
begin
  if to_regclass('storage.buckets') is null
    or to_regclass('storage.objects') is null
  then
    raise exception 'Supabase Storage tables are required for candidate resumes';
  end if;

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

  execute 'alter table storage.objects enable row level security';
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
end
$storage$;

commit;
