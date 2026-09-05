FROM python:3.11.16-slim-trixie@sha256:1042b61448fef4ba92d16a8c7eb4996d027568ce64792a7877fd88511e0af7c6

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
