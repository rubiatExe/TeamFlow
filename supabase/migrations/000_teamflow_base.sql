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

-- Historical demo policies are part of the pre-Phase19 schema. The ACL revocation
-- below keeps them inert during fresh replay; Phase19 must remove them before it
-- grants the tenant reader any columns because permissive policies combine with OR.
create policy "Allow public all on candidates" on public.candidates
  for all using (true) with check (true);
create policy "Allow public all on applications" on public.applications
  for all using (true) with check (true);
create policy "Allow public all on jobs" on public.jobs
  for all using (true) with check (true);
create policy "Allow public all on merchants" on public.merchants
  for all using (true) with check (true);
create policy "Allow public all on audit_logs" on public.audit_logs
  for all using (true) with check (true);

revoke all on table public.merchants, public.jobs, public.candidates,
  public.applications, public.audit_logs
  from public, anon, authenticated, service_role;

commit;
