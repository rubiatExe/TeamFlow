# TeamFlow Architecture

TeamFlow is a Next.js application backed by Supabase and a Python document-processing service on Google Cloud Run. GitHub Actions deploys the Python service through keyless Workload Identity Federation (WIF).

## Repository map

```text
app/                              Next.js pages and API route handlers
components/
  candidate-application/         Candidate-facing application steps
  candidates/                    Manager candidate board and resume upload
  hiring-personas/               Role and hiring-criteria settings
  shared/                         App-wide interactive components
  ui/                             Reusable design-system primitives
lib/
  ai/                             Gemini parsing and candidate scoring
  contracts/                      Shared TypeScript types and Zod schemas
  db/                             Supabase database and storage access
  domain/                         Café roles and demo-domain data
  integrations/                   Twilio and magic-link integrations
services/document-processor/      FastAPI OCR and embedding service
supabase/                         Database schema and ordered migrations
scripts/                          Local verification utilities
.github/workflows/                CI and Cloud Run deployment
```

## Runtime flow

1. A manager uploads a resume from `app/page.tsx`.
2. The browser sends the document to `POST /api/parser`.
3. `app/api/parser/route.ts` calls the Cloud Run document processor at `POST /extract`, including the `X-OCR-Token` header.
4. `services/document-processor/main.py` extracts text and generates an embedding with Gemini.
5. `lib/ai/scorer.ts` scores the candidate against the selected role.
6. `lib/db/supabase.ts` writes the candidate from the server using `SUPABASE_SERVICE_ROLE_KEY`.
7. The dashboard reads candidates through `GET /api/candidates`; browser code does not receive the service-role key.

## Integration contracts

| Boundary | Contract that must remain stable |
|---|---|
| Browser → Next.js | `/api/parser`, `/api/candidates`, `/api/application`, `/api/invite`, `/api/square/labor` |
| Next.js → Cloud Run | `OCR_SERVICE_URL`, `POST /extract`, `X-OCR-Token` |
| Cloud Run runtime | `GOOGLE_API_KEY`, `OCR_SERVICE_TOKEN`, `MOCK_MODE`, `ENVIRONMENT`, `OTEL_SERVICE_NAME` |
| Next.js → Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, server-only `SUPABASE_SERVICE_ROLE_KEY` |
| GitHub → Google Cloud | `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`, `permissions.id-token: write` |
| Cloud Run deployment | Service `teamflow-python-service`, region `us-central1` |

## Supabase boundary

`lib/db/supabase.ts` lazily creates the Supabase client. On the server it prefers `SUPABASE_SERVICE_ROLE_KEY`; in the browser it can only use the public key. Candidate list and delete operations initiated by the browser are routed through `/api/candidates`.

Database history is maintained under `supabase/migrations/`. Reorganizing TypeScript or Python source files must not rewrite applied migrations or change table/RPC names.

## WIF and Cloud Run deployment

`.github/workflows/deploy-python-service.yml` runs only after changes under `services/document-processor/**` reach `main`.

The workflow:

1. Checks out the repository.
2. Requests a GitHub OIDC token through `id-token: write`.
3. Exchanges it through the provider stored in `WIF_PROVIDER`.
4. Impersonates the service account stored in `WIF_SERVICE_ACCOUNT`.
5. Deploys `./services/document-processor` to the existing `teamflow-python-service` Cloud Run service.

WIF secret names and the Cloud Run service identity are intentionally independent of the repository folder name.

## Observability

`services/document-processor/telemetry.py` configures OpenTelemetry for Google Cloud Trace and Monitoring. Cloud Run uses its attached service account through Application Default Credentials; no service-account JSON key belongs in this repository.

Cloud Run supplies a W3C `traceparent` header for incoming requests. FastAPI
instrumentation extracts that context so `ocr_extraction` and
`embedding_generation` appear beneath the Cloud Run request instead of as a
separate trace.

When local Next.js trace export is enabled, root `instrumentation.ts` registers
the Node.js SDK. Only the OCR fetch explicitly propagates its context to Cloud
Run; third-party Gemini and Supabase requests do not receive tracing headers.
The local collector configuration lives under `ops/observability/` and export
is disabled by default so observability can never block resume processing.

Do not attach file names, resume text, candidate contact details, prompts, or
model responses to spans. See `ops/observability/README.md` for local setup.

## Local entry points

```bash
npm install
cp .env.example .env.local
npm run dev
```

In separate terminals:

```bash
cd services/document-processor
uvicorn main:app --reload --port 8000
python mcp_server.py
```

See `docs/setup-and-access.md` for the production access required to perform an end-to-end verification.
