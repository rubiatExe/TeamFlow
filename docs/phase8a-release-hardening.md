# Phase 8A release hardening

Phase 8A prepares a fail-closed production release path without enabling the Phase 7 judge, automatic hiring decisions, or durable HITL writes. Repository controls are enforced by `npm run verify:release-hardening`. A live deployment is still blocked until the production resources below are provisioned and verified.

Production eligibility in this phase covers the two Python service images and their reusable release workflows, plus the server-side Next.js proxy code compiled by CI. The manager `/` page, candidate `/apply` page, and all legacy demo routes intentionally return 404 in production and are excluded from production feature eligibility.

## Release path

The main CI workflow is the only caller of the two reusable Cloud Run deployment workflows. A service deploy can run only after the Next.js typecheck, lint, contracts, unit tests and production build; both Python lint, format and test suites; evaluation-corpus verification; a fresh replay of every Supabase migration and the seed in pinned Supabase Postgres; and both container builds succeed. Path detection selects which service actually deploys, including hiring-agent releases after migration changes.

For each selected service, the release workflow then:

1. Requires an existing service with exactly one revision receiving 100% traffic. First-time bootstrap and split-traffic releases are intentionally manual so rollback is never ambiguous.
2. Verifies that Cloud Run has one unconditional `allUsers` `roles/run.invoker` binding and public ingress. CI does not mutate invoker IAM or ingress.
3. Uses an explicit `.gcloudignore` and validates the actual `gcloud` upload manifest with environment-file and generated-OIDC canaries before submitting source.
4. Uses a dedicated Cloud Build service account to build the pinned Dockerfile, run an on-demand vulnerability scan, and reject `HIGH` or `CRITICAL` findings before Artifact Registry push. Scan-query errors fail the build before severity filtering.
5. Pushes through the Cloud Build `images` field with `requestedVerifyOption: VERIFIED`, so a build cannot succeed unless Google Cloud generates verified provenance. An explicit `docker push` is forbidden because it would bypass that provenance path.
6. Resolves the resulting digest, generates an Artifact Analysis SBOM, and requires both provenance and the SBOM reference to be present.
7. Deploys that exact digest to a resource-bounded, tagged Cloud Run revision with 0% traffic. HTTP startup (`/ready`) and liveness (`/health`) probes gate instance startup and restart unhealthy instances. Secret Manager references use configured numeric versions, never `latest`.
8. Confirms the revision commit label and image digest, probes `/ready`, then runs a token-authenticated synthetic functional canary against the tagged zero-traffic revision. The document canary verifies the known scanned fixture through Gemini transcription and embedding. The hiring canary verifies the configured synthetic candidate and role through tenant-scoped reads and a complete model response without requesting a write.
9. Only after those checks does the workflow route 100% traffic to the exact revision. It restores the previously serving revision whenever promotion or post-promotion verification is not successful—including cancelled or skipped verification—and verifies the restored revision becomes ready. Candidate-tag cleanup is mandatory, including after failed verification, so a zero-traffic revision is not left publicly reachable through a tag URL without making the release fail.

Successful runs record the commit, Cloud Build ID, Cloud Run revision, and image digest in the GitHub job summary.

## Network and authentication posture

The current Next.js clients authenticate to the Python services with application credentials (`X-OCR-Token` and `X-Agent-Token`). They do not mint Google platform identity tokens. The coherent production posture is therefore:

- Cloud Run invocation is public at the platform layer through a preprovisioned `allUsers` `roles/run.invoker` binding.
- `/health`, `/ready`, and the hiring-agent `/version` endpoint expose only minimal non-sensitive state.
- Every sensitive service route remains fail-closed behind its application token. The hiring-agent token uses a dedicated header, leaving the user's `Authorization` header available to the HITL boundary.
- In production, `OCR_SERVICE_TOKEN` and `HIRING_AGENT_TOKEN` must each be 32–512 printable ASCII characters with no whitespace. Readiness and clients reject weak values.
- That check validates format, not entropy. Generate independent tokens with a CSPRNG
  providing at least 256 bits of entropy, never reuse them across services, and capture
  a rotation/revocation drill before promotion.
- Both Python services pin OpenTelemetry propagation to W3C `tracecontext`; caller baggage is not forwarded into service or MCP child processes.
- `OCR_SERVICE_TRUSTED_ORIGIN` and `HIRING_AGENT_TRUSTED_ORIGIN` must exactly match the corresponding production service origins in the Next.js environment.
- Deployment automation verifies this posture but never mutates Cloud Run invoker IAM. A future private-service migration requires a reviewed workload-identity seam in the Next.js runtime first.

## Required GitHub production environment

Protect the `production` GitHub Environment with required reviewers and restrict it to `main`. Configure:

Secrets:

- `WIF_PROVIDER`
- `WIF_SERVICE_ACCOUNT`

Variables:

- `ARTIFACT_REPOSITORY`
- `DOCUMENT_PROCESSOR_BUILD_SERVICE_ACCOUNT`
- `DOCUMENT_PROCESSOR_RUNTIME_SERVICE_ACCOUNT`
- `HIRING_AGENT_BUILD_SERVICE_ACCOUNT`
- `HIRING_AGENT_RUNTIME_SERVICE_ACCOUNT`
- `GOOGLE_API_KEY_SECRET_VERSION`
- `OCR_SERVICE_TOKEN_SECRET_VERSION`
- `SUPABASE_URL_SECRET_VERSION`
- `SUPABASE_TRUSTED_ORIGIN_SECRET_VERSION`
- `SUPABASE_PUBLISHABLE_KEY_SECRET_VERSION`
- `SUPABASE_HIRING_READER_TOKEN_SECRET_VERSION`
- `HIRING_AGENT_TOKEN_SECRET_VERSION`
- `HIRING_AGENT_CANARY_MERCHANT_ID`
- `HIRING_AGENT_CANARY_CANDIDATE_ID`
- `HIRING_AGENT_CANARY_ROLE_ID`

Every secret-version variable must be a positive numeric Secret Manager version. Rotation is a controlled variable update followed by the normal release gate; rollback continues to reference the prior Cloud Run revision and its prior secret versions. The scoped hiring-reader JWT is copied into the immutable startup snapshot and MCP child environment; the process does not hot-reload it. Once that JWT expires, `/ready` fails while `/health` remains live and protected requests fail closed. Rotate the numeric secret version and complete a new gated deployment before expiry. Until an overlapping token-rotation/redeployment runbook is operationally exercised, user-facing live hiring remains an activation blocker rather than a production-readiness claim.

## Required Google Cloud bootstrap

These are live-environment blockers and are not changed by repository code:

- Enable Cloud Run, Cloud Build, Artifact Registry, Artifact Analysis/Container Scanning, On-Demand Scanning, Secret Manager, and the APIs required to export SBOMs.
- Create the regional Docker `ARTIFACT_REPOSITORY` in `us-central1` with automatic container scanning enabled before the first release image is pushed.
- Preprovision `teamflow-python-service` and `teamflow-hiring-agent` with public ingress, put one verified baseline revision at 100% traffic, and grant the unconditional public invoker binding described above.
- Give the GitHub WIF deploy identity only the permissions needed to submit builds, read Artifact Analysis metadata, deploy/update Cloud Run revisions and traffic, inspect service IAM, and act as the dedicated build/runtime service accounts.
- Give each build service account only its service's build/logging, Artifact Registry write, and On-Demand Scanning permissions. Cloud Build must be able to publish through its `images` field.
- Give each runtime service account access only to its named numeric Secret Manager versions and the APIs required by that service.
- Provision independently generated CSPRNG service tokens with at least 256 bits of
  entropy, restrict read access to the corresponding runtime and deploy identities,
  and verify rotation plus revocation of the prior numeric version.
- Provision one isolated synthetic hiring-canary candidate and one configured role under
  `HIRING_AGENT_CANARY_MERCHANT_ID`; set their canonical UUIDs in the three canary
  variables. The scoped reader token must be bound to that merchant. Do not use a real
  candidate or resume in the deployment canary.
- Mint and rotate a scoped Supabase JWT with `role=teamflow_hiring_reader`; store it as `SUPABASE_HIRING_READER_TOKEN`. Configure `SUPABASE_TRUSTED_ORIGIN` as the exact canonical HTTPS origin of `SUPABASE_URL` and configure the corresponding publishable key. Schedule a replacement deployment before the token expires: the immutable runtime snapshot deliberately has no in-process refresh. Do not mount `SUPABASE_SERVICE_KEY` or `SUPABASE_REVIEW_WRITER_TOKEN`; the release keeps `AGENT_ALLOW_WRITES=false`.
- Provision the SBOM storage destination and narrowly scoped Artifact Analysis/Storage permissions required by `gcloud artifacts sbom export`.
- Configure `OCR_SERVICE_URL`, `OCR_SERVICE_TRUSTED_ORIGIN`, `OCR_SERVICE_TOKEN`, `HIRING_AGENT_URL`, `HIRING_AGENT_TRUSTED_ORIGIN`, and `HIRING_AGENT_TOKEN` in the production Next.js environment.
- Configure branch protection so the CI release-gate jobs are required for `main`.
- Put an external edge rate-limit/WAF policy in front of every public platform endpoint and verify it with abuse-oriented tests.
- Exercise the checked-in functional canaries in the protected production environment,
  connect their failures to actionable alerts, and agree service-level objectives. The
  repository defines and statically tests the canaries, but no live execution or alert
  delivery evidence is committed here.

The workflow intentionally fails if any of this state is missing. No live deployment, IAM mutation, secret rotation, or API enablement is performed by Phase 8A repository work.

## Dependency and image maintenance

Node installs use `npm ci` and the integrity-bearing `package-lock.json`; CI also fails
on a high-severity npm advisory. Python CI and containers install complete transitive
locks with `--require-hashes` and binary-only packages. Regenerate each Python lock
from its adjacent manifest with the documented
`uv pip compile ... --universal --python-version 3.11 --generate-hashes` command,
review the diff, and run the release-hardening verifier.

GitHub Actions, Python and PostgreSQL base images, the OpenTelemetry collector, and Cloud Build builder images are pinned by digest or full commit SHA. Dependabot is configured for routine action, npm, pip, and Docker update proposals; every proposal must retain the static release gate and pass container builds.

Phase 7 authority remains disabled: `AGENT_ALLOW_WRITES=false` and `TEAMFLOW_HITL_ENABLED=false` are enforced in the hiring-agent deployment definition.
