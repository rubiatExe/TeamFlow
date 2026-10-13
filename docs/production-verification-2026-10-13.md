# Production verification — 2026-10-13

This record covers the pending repository changes, including Google Cloud Vision OCR, manager criteria, and 3,072-dimensional embeddings. The live production site inspected during verification serves the earlier `main` revision `7ab9f9d`. Its four passing smoke checks validate that existing deployment; they do not validate the pending code in production.

## Completed local verification

| Check | Result |
| --- | --- |
| Document processor suite | 209 passed, no skips, including a clean Linux container with the checked-in dependency lock |
| Hiring agent deterministic suite | 852 passed, no skips, including a clean native Linux container with the checked-in dependency lock |
| Python lint and formatting | Ruff passed for 17 document/script files and 112 hiring files |
| Hiring evaluation corpus | Verified: 15 adversarial, 20 test, and 30 validation cases; human review status remains pending |
| PostgreSQL repository and restart suites | 12 passed, no skips |
| Supabase migration suites | 6 passed, no skips; historical migrations, full migration chain, and schema snapshot covered |
| Production container builds | Both services built for Linux ARM64 and Linux amd64 using hash-locked dependencies |
| Container dependency integrity | `pip check` passed for both services and architectures |
| Production configuration smoke | Both containers returned health/readiness 200 and rejected unauthenticated requests with 401; hiring version endpoint returned 200 |
| Web verification | TypeScript, ESLint, integration/model/release contracts, and 252 unit tests passed under Node 22 |
| Web production build | Next.js 16.3.8 build and all 11 compiled-style checks passed |
| HTTP journey checks | 3 development and 5 production checks passed, including sample criteria proposal/approval and cross-origin rejection |
| Dependency audit | Zero npm vulnerabilities; clean Linux Node 22.23.2/npm 10.9.8 install, adapter regression tests, and audit passed |
| Browser verification | Sample scores/completeness, evidence search, criteria proposal/weight validation/approval, role isolation, disabled uploads, and reviewer unavailable/disconnect handling passed; no console errors or warnings observed |
| GitHub CI and preview deployment | Run after this commit; final result recorded in the pull request |

Database tests used disposable PostgreSQL 16 and Supabase PostgreSQL 17.6.1.054 instances. Coverage includes checkpoint persistence/restart, preservation of existing 768-dimensional embeddings, `halfvec(3072)` writes and search, invalid-dimension rejection, conditional backfill updates, grants, tenant isolation, and pgvector installed in either `public` or `extensions`. Temporary database containers were removed after the suites passed.

Container smoke checks used `ENVIRONMENT=production`, synthetic credentials, disabled external networking, and a read-only filesystem. They verify startup, configuration, native dependencies, and HTTP boundaries. They do not establish that live Google credentials, Supabase credentials, or Cloud Run permissions work.

Native Linux ARM64 PDF rendering passed with the production worker resource limits and user ID 10001. Under Docker Rosetta, the amd64 worker's address-space limit caused an emulator `mmap` failure. The amd64 libraries rendered successfully in a diagnostic without that limit; production limits were retained. Native amd64 rendering with the limit still requires CI or a Cloud Run canary. One emulated hiring MCP startup test exceeded its initialization budget during the full run and passed when rerun alone; all 852 tests passed together on native Linux.

Verification fixed one packaging issue: the document processor Docker context now excludes its local `.venv/`. The host's shared Python installation had an unrelated OpenTelemetry dependency conflict; clean locked containers passed dependency checks and the complete native Linux suites. A Starlette test-client deprecation warning remains.

The web review fixed stale reviewer requests, premature decision-success messages, stale candidates after an empty refresh, and valid loopback criteria requests rejected by Next.js URL normalization. Browser criteria checks used a synthetic local signing secret and the fictional corpus. Dependency updates keep the full audit gate enabled; the scoped lint adapter's npm metadata warning is documented in [its README](../tooling/eslint-root-glob/README.md).

## Reproduce the repository checks

Use an isolated Python 3.11 environment per service and install its `requirements-dev.lock` with `--only-binary=:all: --require-hashes`. From the repository root:

```bash
npm ci --ignore-scripts
npm audit --audit-level=high
npm run verify:quick
npm run test:journeys:development
npm run build
npm run test:journeys:production
```

Then verify the document processor in its isolated environment:

```bash
python -m ruff check services/document-processor/ scripts/verify-models.py scripts/pytest-no-skips.py
python -m ruff format --check services/document-processor/ scripts/verify-models.py scripts/pytest-no-skips.py
cd services/document-processor
python ../../scripts/pytest-no-skips.py -q -rs tests
```

From `services/hiring-agent`, using that service's isolated environment:

```bash
python -m ruff check .
python -m ruff format --check .
python -m teamflow_hiring_agent.evaluation verify --dataset evals/resume_review_v1
python ../../scripts/pytest-no-skips.py -q -rs tests \
  --ignore=tests/test_hiring_reader_migration_phase19.py \
  --ignore=tests/test_hitl_postgres_repository_phase6.py \
  --ignore=tests/test_hitl_postgres_restart_phase6.py \
  --ignore=tests/test_supabase_migration_replay_phase8a.py
```

Run the excluded suites separately against disposable local databases, with `TEST_POSTGRES_DSN` and `TEST_SUPABASE_POSTGRES_DSN` configured as in [CI](../.github/workflows/ci.yml). The test wrapper fails on skipped tests; these commands must not target production:

```bash
python ../../scripts/pytest-no-skips.py -q -rs \
  tests/test_hitl_postgres_repository_phase6.py \
  tests/test_hitl_postgres_restart_phase6.py
python ../../scripts/pytest-no-skips.py -q -rs \
  tests/test_hiring_reader_migration_phase19.py \
  tests/test_supabase_migration_replay_phase8a.py
```

Build and inspect the production dependency sets from the repository root:

```bash
docker build --platform linux/amd64 -t teamflow-document-processor:verify services/document-processor
docker build --platform linux/amd64 -t teamflow-hiring-agent:verify services/hiring-agent
docker run --rm --platform linux/amd64 --network none teamflow-document-processor:verify python -m pip check
docker run --rm --platform linux/amd64 --network none teamflow-hiring-agent:verify python -m pip check
```

Repeat with `--platform linux/arm64` for native ARM64 verification. Dated local Python/container evidence is in `/tmp/teamflow-python-production-20261013/`; those temporary logs are not committed or a substitute for GitHub CI results.

## Live production limitations

- Vercel production environment metadata lacks `HIRING_AGENT_URL`, `HIRING_AGENT_TOKEN`, `HIRING_AGENT_TRUSTED_ORIGIN`, `OCR_SERVICE_TRUSTED_ORIGIN`, and `TEAMFLOW_HITL_ENABLED`. The connected extraction/hiring/review paths have not been verified on production.
- `MANAGER_CRITERIA_SIGNING_SECRET` is also absent from that metadata. It is required for the new criteria proposal flow in production, including public sample mode; see [manager criteria configuration](manager-criteria.md).
- Inspected GitHub repository/environment variables are empty. Only the `WIF_PROVIDER` and `WIF_SERVICE_ACCOUNT` secret names are configured. Required Cloud Run release variables—including build/runtime identities, artifact repository, numeric secret versions, and canary identifiers—remain missing. See [release configuration](phase8a-release-hardening.md#required-github-production-environment).
- The local `.env.local` references an inactive Supabase project. The active TeamFlow project lacks the repository's migration history/baseline. The sensitive Vercel production Supabase URL could not be confirmed, so the actual production database target remains unverified.
- Live Google Cloud Vision, Gemini embedding, tenant-scoped retrieval, and the pending manager criteria workflow have not been verified against production services. Passing local tests or the four checks against the older deployment does not establish those integrations.

No production migration, embedding backfill, or deployment was performed during this verification. Resolve the environment/database targets and required configuration before following the [coordinated embedding rollout](embedding-migration.md). Consult the pull request for GitHub CI and preview status.
