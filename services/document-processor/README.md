# Document Processor

This FastAPI service is TeamFlow's first AI pipeline stage. Google Cloud Vision
transcribes résumé pixels; Gemini generates embeddings. The service returns
canonical text and page-linked source blocks to the Next.js parser route.

## API

- `GET /` — runtime health check
- `POST /extract` — authenticated resume extraction
- Header: `X-OCR-Token`

## Local development

From this directory:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --only-binary=:all: --require-hashes -r requirements.lock
uvicorn main:app --reload --port 8000
```

Alternatively, after installing this service's locked dependencies into `.venv`,
run `npm run dev:documents` from the repository root. That launcher loads the root
development environment but forwards only the document service's allowlisted
settings, never Supabase administrator credentials. It binds `127.0.0.1:8000`.

Set `OCR_PROVIDER=google_cloud_vision` (the default), `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_API_KEY`, and `OCR_SERVICE_TOKEN`. Vision uses
[Application Default Credentials](https://cloud.google.com/vision/docs/authentication):
developer ADC locally (`gcloud auth application-default login` when absent), and
the attached service account in Cloud Run. No service-account key file or browser
credential is needed. Enable `vision.googleapis.com` in the quota project and ensure
the runtime identity has `serviceusage.services.use` there. Keep its privileges
narrow; do not grant Editor/Owner to connect OCR. A Gemini API key alone does not
authenticate Vision. `OCR_PROVIDER=gemini` is an explicit legacy option, never an
automatic fallback after a Vision error.

The Next app must use the same `OCR_SERVICE_TOKEN` and matching
`OCR_SERVICE_URL` / `OCR_SERVICE_TRUSTED_ORIGIN`. Local values can be placed in
gitignored `.env.development.local`; cloud production settings are separate.

`MOCK_MODE=True`
is only a contract/development check: `/extract` returns an empty, explicitly
non-scoreable `mock` result with HTTP 503. It never returns fabricated résumé text.
The provider, legacy model, and embedding compatibility defaults are recorded in
[`config/ai-model-contract.json`](../../config/ai-model-contract.json).

The v1 boundary accepts PDF, JPEG, and PNG files up to 10 MiB, verifies MIME
signatures, and returns a strict Pydantic result containing status, canonical text,
stable source blocks, extraction and embedding provenance, the uploaded-byte SHA-256,
warnings, and quality fields. PDFs are limited to **five pages** and rendered at
144 DPI by a killable PDFium subprocess before OCR. Only rendered PNGs leave that
boundary; PDF text objects, metadata, and hidden/off-page text are never scored.
Encrypted, malformed, over-limit, or partially failed documents are rejected rather
than truncated. The worker has an eight-second wall deadline, ten-second CPU limit,
256 MiB Linux address-space limit, two-worker admission, and bounded pixel/output
sizes. The existing `pdf_text_timeout` warning now also covers rendering timeouts.

Vision calls use `DOCUMENT_TEXT_DETECTION`, keyless ADC refresh, bounded response
size/deadlines, and no redirects or automatic OCR fallback. All PDF pages share one
25-second OCR budget. Gemini embedding has a separate ten-second budget. Successful
Vision extractions are labeled `google_cloud_vision`; missing embeddings produce a
clearly labeled degraded result. Only usable source blocks may reach scoring.

Before enabling canonical persistence, apply the forward
`google_cloud_vision_extraction_method` migration to allow this provenance value.
It does not alter existing records or access rules. Updating code alone does not
apply that migration to a hosted database.

Synthetic PDF fixtures are locked by `tests/fixtures/manifest.json`. Regenerate them
with the dependencies pinned in `tests/fixtures/requirements-fixtures.txt`; those
authoring dependencies are intentionally excluded from the production image.

## Deployment

`.github/workflows/deploy-python-service.yml` is configured to deploy this directory to
`teamflow-python-service` in `us-central1` through GitHub OIDC and Google Cloud Workload
Identity Federation. The repository contains no service-account key file; the external
provider, IAM, secrets, and deployed revision still require environment verification.
The workflow selects Vision OCR and its synthetic canary requires Vision provenance,
expected scanned text, and a real 3,072-dimensional Gemini embedding before promotion.
The workflow declares a 60-second request timeout, 1 GiB memory, concurrency two, and a
ten-instance maximum. The two isolated PDF workers have 256 MiB address-space
ceilings; load profiling is still absent. Repository
configuration is not evidence that those settings are active in Cloud Run.

The processor reports the stable OpenTelemetry service name
`teamflow-document-processor`, so exported spans can be distinguished from the Next.js
API after Cloud Trace export is verified.

The MCP hiring tools now live with the separate LangGraph service under
`services/hiring-agent`; this service remains responsible only for document
extraction and embeddings.
