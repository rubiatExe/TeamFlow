# Production candidate applications

The production `/apply` page accepts one-use application links issued to a signed-in
owner or manager. The résumé is required. The browser uploads a PDF, JPEG, or PNG
of at most 10 MiB directly to the private Supabase `resumes` bucket using a
server-issued, path-specific signed upload token. Next.js receives only small
metadata requests, so the file does not hit the Vercel Function body limit.

After upload, the server downloads the registered private object, checks its
size, MIME type, extension, and file signature, and sends it to the document
processor for editable form prefill. A failed extraction leaves the form
available for manual entry. Submission downloads and validates the file again.
One database transaction binds the server-side merchant, optional job, selected
role, reviewed answers, résumé hash, candidate, application, and consumed link.

## Production setup

1. Apply the ordered prerequisite and application migrations
   `supabase/migrations/20261014051403_production_application_prerequisites.sql`
   and `supabase/migrations/20261014051404_production_candidate_applications.sql`
   to the Supabase project attached to the live Vercel site. The prerequisite
   creates the private `resumes` bucket and manager membership table, and
   removes the legacy public-all candidate data policies.
2. Configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
   server-only `SUPABASE_SERVICE_ROLE_KEY` for that same project. Set
   `NEXT_PUBLIC_APP_URL` to the canonical HTTPS origin. The key must never be
   included in a browser bundle.
3. Configure `OCR_SERVICE_URL`, `OCR_SERVICE_TRUSTED_ORIGIN`, and
   `OCR_SERVICE_TOKEN` to the deployed document processor. If extraction is
   unavailable, applicants can fill in the form manually and still attach the
   validated résumé.
4. Configure an independent random `CRON_SECRET` of at least 16 characters.
   Vercel calls `/api/internal/application-upload-cleanup` daily. It deletes
   unused private objects only after the invitation and signed upload token
   have expired; saved candidate and application references are protected.
5. Provision Supabase Auth users and active `merchant_memberships` rows with
   role `owner` or `manager` for the merchant that issues links. The manager
   sign-in screen uses an emailed one-time code, so the Supabase Auth email
   template must include `{{ .Token }}`.

An authorized manager can sign in at `/manager/application-links`, choose one
of their assigned workspaces, create a one-use link, and copy it for the
candidate. The manager can review submitted applications at
`/manager/applications` and open each verified private résumé through a
short-lived read URL. The same link can be issued through this API:

```http
POST /api/application/invitations
Authorization: Bearer <Supabase Auth access token>
Content-Type: application/json

{"merchantId":"<merchant UUID>","roleId":"barista","candidateName":"Alex Applicant"}
```

The response contains `invitation.url` and `expiresAt`. The optional `jobId`
must refer to an active job in the same merchant. Links expire after 72 hours
by default, can be set from 10 minutes to 7 days with `ttlMinutes`, and are
consumed once. The raw token is returned only in the creation response and is
stored only as a SHA-256 hash. Send it to the intended applicant through a
trusted channel.

The browser keeps a failed upload grant for a retry on the same file. If a
submission response is lost after the transaction commits, it checks the
receipt for that exact invitation and upload before asking the applicant to
try again. Final submission stores the reviewed form answers and verified
résumé attachment without starting a second OCR call.

## Verification

After applying the migration, run a read-only query against the production
project to confirm the bucket and privileges:

```sql
select id, public, file_size_limit
from storage.buckets where id = 'resumes';

select
  has_function_privilege('service_role',
    'public.teamflow_finalize_candidate_application(uuid,uuid,jsonb,text,text,boolean)',
    'EXECUTE') as service_can_finalize,
  has_function_privilege('anon',
    'public.teamflow_finalize_candidate_application(uuid,uuid,jsonb,text,text,boolean)',
    'EXECUTE') as anonymous_can_finalize;
```

Expect a private bucket with a 10 MiB limit, `service_can_finalize = true`,
and `anonymous_can_finalize = false`. In a production smoke run, `/apply` should
load, unauthenticated upload/preview/submit requests should return 401, a valid
link should upload a synthetic résumé and produce editable fields, and a second
submission of the same link should fail without creating another candidate.

## Limits

Each invitation can mint at most three upload grants, and each grant can call
the OCR preview at most three times. Signed upload tokens expire after two
hours; the cleanup job waits at least three hours and until the application
link expires. A failed or missing OCR service does not prevent a manually
completed application.
