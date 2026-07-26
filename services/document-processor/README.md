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
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Set `GOOGLE_API_KEY` and `OCR_SERVICE_TOKEN` for real extraction. Set `MOCK_MODE=True` for credential-free local development.

## Deployment

`.github/workflows/deploy-python-service.yml` deploys this directory to the existing `teamflow-python-service` service in `us-central1`. Authentication uses GitHub OIDC and Google Cloud Workload Identity Federation; no service-account key file is stored in the repository.
