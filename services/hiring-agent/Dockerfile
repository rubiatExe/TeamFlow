FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONFAULTHANDLER=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.lock ./requirements.lock
RUN python -m pip install \
    --only-binary=:all: \
    --require-hashes \
    --requirement requirements.lock

RUN addgroup --system --gid 10001 teamflow \
    && adduser --system --uid 10001 --ingroup teamflow \
        --home /nonexistent --no-create-home teamflow

COPY --chown=10001:10001 main.py ./main.py
COPY --chown=10001:10001 teamflow_hiring_agent ./teamflow_hiring_agent

USER 10001:10001

EXPOSE 8080

CMD ["python", "main.py"]
