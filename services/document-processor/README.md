# Document Processor

This FastAPI service is TeamFlow's first AI pipeline stage. It accepts resumes, extracts structured text, generates embeddings, and returns the result to the Next.js parser route.

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

Set `GOOGLE_API_KEY` and `OCR_SERVICE_TOKEN` for real extraction. `MOCK_MODE=True`
is only a contract/development check: `/extract` returns an empty, explicitly
non-scoreable `mock` result with HTTP 503. It never returns fabricated résumé text.
The fixed model and embedding compatibility defaults are recorded in
[`config/ai-model-contract.json`](../../config/ai-model-contract.json).

The v1 boundary accepts PDF, JPEG, and PNG files up to 10 MiB, verifies MIME
signatures, and returns a strict Pydantic result containing status, canonical text,
stable source blocks, extraction and embedding provenance, the uploaded-byte SHA-256,
warnings, and quality fields. Digital PDFs use deterministic `pypdf` text only when
every page has usable text and bounded content inspection finds no image-dominant or
non-painting text layer. Image-backed, mixed, suspicious-layer PDFs and direct images
use Gemini vision. Only `complete` or embedding-degraded results with usable source
blocks may reach scoring.

Synthetic PDF fixtures are locked by `tests/fixtures/manifest.json`. Regenerate them
with the dependencies pinned in `tests/fixtures/requirements-fixtures.txt`; those
authoring dependencies are intentionally excluded from the production image.

## Deployment

`.github/workflows/deploy-python-service.yml` is configured to deploy this directory to
`teamflow-python-service` in `us-central1` through GitHub OIDC and Google Cloud Workload
Identity Federation. The repository contains no service-account key file; the external
provider, IAM, secrets, and deployed revision still require environment verification.
The workflow declares a 60-second request timeout, 1 GiB memory, concurrency two, and a
ten-instance maximum. This composes conservatively with the two isolated PDF workers'
256 MiB address-space ceilings while load profiling is still absent; repository
configuration is not evidence that those settings are active in Cloud Run.

The processor reports the stable OpenTelemetry service name
`teamflow-document-processor`, so exported spans can be distinguished from the Next.js
API after Cloud Trace export is verified.

The MCP hiring tools now live with the separate LangGraph service under
`services/hiring-agent`; this service remains responsible only for document
extraction and embeddings.
