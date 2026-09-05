# Phase 8A Supabase hardening

Phase 8A narrows the production data boundary without enabling the Phase 7 judge,
numeric confidence routing, or automatic hiring decisions. The forward-only
hardening migrations are
`supabase/migrations/20260828192200_phase8a_supabase_boundary_hardening.sql` and
`supabase/migrations/20260829001553_hitl_actor_capabilities_and_retention_inventory.sql`;
the same end state is present in `supabase/schema.sql` for the documented snapshot
bootstrap.

## Enforced in SQL

- All TeamFlow tables in `public` have RLS enabled. `anon` has no TeamFlow table
  privileges. `authenticated` can only select its own active membership through the
  existing `auth.uid()` RLS policy.
- `service_role` retains the legacy server-only candidate/job/merchant and append-only
  Phase 4 write surface. It can no longer read Phase 6 lifecycle tables, provision
  memberships, use `teamflow_private`, or execute actor-parameterized Phase 6 RPCs.
- `teamflow_hitl_service` has no direct TeamFlow table privileges. Actor-gated
  operations use one short-lived, one-time HMAC capability dispatcher; the role
  cannot execute the legacy UUID-parameterized actor functions. Actor-free lifecycle
  completion functions remain narrowly granted. Startup attests the actual login,
  zero role memberships, the complete ACL allowlist, and the Auth issuer bound to the
  active capability key.
- The HITL and checkpoint roles remain non-superuser, non-inheriting, non-replicating,
  and unable to create roles/databases or bypass RLS. Source control leaves them
  `NOLOGIN`; credential creation and rotation remain deployment operations.
- One active merchant membership per Auth user is a database invariant until a trusted
  tenant-selection context is implemented. The migration fails with
  `teamflow_multiple_active_memberships_require_remediation` if existing data violates
  that invariant.
- Application submissions and audit rows are insert-only for `service_role`; update
  triggers reject mutation. Privileged retention deletion is intentionally not granted.
- A private `resumes` Storage bucket is configured for PDF/JPEG/PNG objects up to 10 MiB.
  A restrictive `storage.objects` policy denies `anon` and `authenticated` access to
  this bucket even if another bucket receives a permissive policy. Server code returns
  object paths and creates five-minute signed URLs instead of public URLs.
- Production HITL and checkpoint DSNs require `sslmode=verify-full`. PostgreSQL
  recommends this mode for security-sensitive environments because it validates both
  the certificate chain and server hostname.

These choices follow Supabase's current guidance to combine explicit grants with RLS,
make Data API exposure opt-in, keep secret/service credentials server-side, and use
Storage RLS: [Securing your API](https://supabase.com/docs/guides/api/securing-your-api),
[Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security),
and [Storage access control](https://supabase.com/docs/guides/storage/security/access-control).

## Staging application gate

Do not apply the migration to production first. On a staging clone:

1. Check for identities with multiple active memberships. Decide which membership to
   suspend before applying the unique partial index.
2. Apply the ordered migrations as the `postgres` migration owner. Do not use the
   application service, checkpoint-runtime, or checkpoint-migrator credential.
3. Run the repository PostgreSQL suite with `TEST_POSTGRES_DSN` and run
   `supabase test db` when a local Supabase project is available.
4. Inspect Security Advisor/Data API exposure for every TeamFlow table and function.
   The currently installed local CLI is 2.62.10 and cannot run the newer
   `supabase db advisors` command; upgrade it in the controlled toolchain before using
   that command.
5. Verify live ACLs as `anon`, `authenticated`, `service_role`, and the dedicated HITL
   role. Exercise one real Auth session for an owner/manager and reviewer, plus missing,
   suspended, and cross-tenant users.
6. Confirm the `resumes` bucket is private, direct client upload/download fails, a
   server upload succeeds, and a signed URL expires.
7. Run the pinned checkpoint migrations only with the temporary checkpoint-migrator
   login, return that role to `NOLOGIN`, and verify runtime DML/restart with the distinct
   checkpoint-runtime credential.

## Retention and backup gate

The first hardening migration adds the owner-only, read-only function
`teamflow_private.resume_review_retention_inventory(timestamptz)`. The follow-up
migration adds approved per-tenant policy inventory, scoped legal holds, and
`teamflow_private.resume_review_retention_due_inventory(timestamptz)`. It computes
policy-relative due dates, hold IDs, and current score references. Both functions
perform no deletion; the follow-up schema structurally fixes
`purge_enabled=false`, exposes no purge function, and returns
`purge_permitted=false`. Restrictive foreign keys keep policy and legal-hold
evidence from being cascade-deleted with a tenant or held resource.

Replay-ledger housekeeping is separate from résumé-review retention. Only the
`postgres` operator can invoke the bounded expired-capability cleanup; the HITL
runtime retains no ledger `DELETE` or cleanup `EXECUTE` privilege. The operational
cutoff, batching, and backlog monitoring contract is in
`docs/hitl-security-and-retention.md`.

A production purge remains blocked until the organization supplies an approved
employment-record retention period, legal-hold behavior, derived-score disposition,
and deletion audit requirements. The purge must delete a complete aggregate without
breaking the candidate revision guard, and its schedule must be tested against backup
expiry. Supabase daily database backups retain 7 days on Pro, 14 on Team, and up to 30
on Enterprise; Storage objects are not contained in database backups. See
[Database backups](https://supabase.com/docs/guides/platform/backups).

Auth session lifetime, inactivity timeout, single-session policy, JWT expiry, session
revocation on offboarding, network restrictions, PITR, and restore drills are hosted
project settings and cannot be proven by repository SQL. Configure and capture those
settings before production. See
[Supabase Auth sessions](https://supabase.com/docs/guides/auth/sessions).

Capability-key provisioning, rotation, recent-AAL2 enforcement, and the exact
non-destructive retention gate are documented in
`docs/hitl-security-and-retention.md`.

## Bootstrap and remote-verification boundaries

- A fresh empty application database now replays the complete ordered migration set:
  the new idempotent `000_teamflow_base.sql` supplies the tables and extensions that
  historical migration `001_add_embedding_column.sql` expects. CI runs this replay
  against a pinned Supabase PostgreSQL image and then loads the demo seed. Existing
  projects that already recorded `001` or later must verify their base objects and
  explicitly reconcile `000` in the remote migration ledger; they must not blindly
  replay the baseline or rewrite an applied migration.
- No live Supabase project, Auth session, Data API, Storage API, pooler, backup, restore,
  or remote migration history was accessed or mutated.
- The candidate/application portal still needs its production manager/applicant Auth
  design. Phase 8A only narrows the database and Storage boundaries beneath it.
- The `supabase_admin`-owned default ACL and the hosted project's “Automatically expose
  new tables and functions” setting must be inspected remotely. Repository migrations
  explicitly revoke the `postgres` owner defaults and grant every intended Data API
  privilege, but cannot attest to hosted control-plane state.
