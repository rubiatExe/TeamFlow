FROM python:3.15.0rc3-slim-trixie@sha256:a3af3d230522dd52f7f2191b39e1892912dbcb0c8dee22afdec3dc83baf0f549

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONFAULTHANDLER=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.lock .
RUN python -m pip install \
    --only-binary=:all: \
    --require-hashes \
    --requirement requirements.lock

RUN addgroup --system --gid 10001 teamflow \
    && adduser --system --uid 10001 --ingroup teamflow \
        --home /nonexistent --no-create-home teamflow

COPY --chown=10001:10001 . .

USER 10001:10001

# OCR Extraction API (main.py / uvicorn)
EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
