# HITL capability and retention gate

Migration
`20260829001553_hitl_actor_capabilities_and_retention_inventory.sql`
closes the durable human-review actor-impersonation boundary. Apply it as a
forward-only migration; do not edit or replay an already applied migration.

## Threat closure

Possession of the shared direct PostgreSQL DSN plus a guessed Supabase Auth UUID is
not enough to start, list, inspect, or decide a review. The
`teamflow_hitl_service` role has lost `EXECUTE` on every actor-parameterized
legacy function. Its only actor entry point is
`teamflow_private.execute_hitl_actor_operation`, which requires a capability that:

- is HMAC-SHA256 signed with a secret distinct from the database credential;
- is bound to the canonical Supabase Auth issuer, verified actor, operation, SHA-256
  digest of the exact canonical full payload, expiry, and random nonce;
- expires after 15 seconds in the application and is rejected by SQL if its lifetime
  exceeds 30 seconds; and
- is atomically recorded in a private nonce ledger, so a successful capability can
  be used exactly once.

The service verifies the bearer token with Supabase Auth before minting a
capability. Decision authorization, recovery, edit-context loading, and recording
also require an `aal2` JWT, an authenticating AMR timestamp no more than 10 minutes
old, and a live `auth.sessions` row for the same actor and session. These checks run
in both the service and the capability consumer.

At startup, `teamflow_private.attest_hitl_runtime` checks that the actual
`session_user` is `teamflow_hitl_service` without `SET ROLE`, the role has no
memberships or privileged attributes, has no non-system relation or sequence
privileges, cannot create or use unexpected schemas, and can execute no
non-allowlisted private or callable `SECURITY DEFINER` routine. An active matching
capability key must also be bound to the canonical `SUPABASE_URL/auth/v1` issuer.
Startup fails closed if any check fails.

## External key provisioning

Keep `TEAMFLOW_HITL_ENABLED=false` until all of these steps are complete:

1. Generate 32 independent cryptographically random bytes with approved secret
   tooling. Do not reuse the PostgreSQL password, route token, JWT secret, or
   checkpoint credential, and never reuse the capability secret across Supabase
   projects or cloned databases.
2. Encode the raw bytes as canonical unpadded base64url and store that value in
   Google Secret Manager. Bind a numeric secret version to the Cloud Run environment
   variable `TEAMFLOW_HITL_CAPABILITY_SECRET`; do not use a floating `latest`
   version.
3. Compute the lowercase SHA-256 hex digest of the raw bytes. Using a privileged,
   parameterized administration operation, insert the digest as `key_id`, the raw
   bytes as `secret`, and the exact canonical `SUPABASE_URL/auth/v1` value as
   `auth_issuer` in
   `teamflow_private.hitl_capability_keys`. Never put the secret literal in a
   migration, SQL history, log, ticket, or repository file.
4. Provision the direct DSN as the exact `teamflow_hitl_service` login with
   `sslmode=verify-full`. The capability secret and DSN should be separate Secret
   Manager secrets with the narrowest runtime IAM access.
5. Start a staging revision and require startup attestation plus authenticated
   start/list/detail and AAL2 decision smoke tests before enabling production.

For rotation, insert the new active database key first, deploy a revision pinned to
the new Secret Manager version, drain old revisions, wait longer than the database's
30-second maximum capability lifetime, and only then set `revoked_at` on the old
key. A mismatch between the environment secret and database key fails startup.

## Replay-ledger cleanup

The nonce ledger is intentionally append-only to the application. The
`teamflow_hitl_service` role has neither `DELETE` on the table nor `EXECUTE` on its
cleanup function. A controlled database-operator job may call
`teamflow_private.cleanup_expired_hitl_capabilities(timestamptz, integer)` as the
`postgres` operator role. The function deletes at most 10,000 rows per call, locks
with `SKIP LOCKED`, and rejects any cutoff newer than two minutes ago. Use a more
conservative cutoff such as `clock_timestamp() - interval '5 minutes'`, a modest
batch size (for example, 1,000), and repeat until it returns zero. Repeating a
completed batch is safe; rows that have not expired by the supplied cutoff remain.

Run this only from the privileged maintenance plane, never from the hiring-agent
runtime. Monitor cleanup duration, deleted rows, errors, total ledger rows, and the
age/count of rows older than the conservative cutoff. Alert on a growing expired-row
backlog or repeated cleanup failures. Retain the two-minute database guard even if
the application's current 15-second issuance lifetime changes, and review the guard
before ever increasing the database's 30-second maximum capability horizon.

## Retention is inventory-only

Legal retention inputs are not encoded in source. The migration therefore creates a
strictly non-destructive foundation:

- a tenant policy record with explicit approver, approval time, legal basis, policy
  version, and retention days;
- merchant, workflow, candidate, and document legal holds;
- an owner-only due-inventory function that reports due time, active hold IDs, and
  whether a current candidate score still references the workflow; and
- a database check that requires `purge_enabled=false`.

No application role can read or mutate the policy/hold tables or execute the due
inventory, no resume-review purge function exists, and every inventory row returns
`purge_permitted=false`. Restrictive foreign keys prevent deletion of a tenant or
held resource from silently deleting its policy or hold evidence. Production deletion
remains blocked until counsel and the data owner approve record classes, hold release,
derived-score handling, deletion audit evidence, and backup-expiry behavior.

Relevant Supabase guidance:
[MFA](https://supabase.com/docs/guides/auth/auth-mfa),
[Auth sessions](https://supabase.com/docs/guides/auth/sessions),
[Database functions](https://supabase.com/docs/guides/database/functions), and
[Securing the Data API](https://supabase.com/docs/guides/api/securing-your-api).
