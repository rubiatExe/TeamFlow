FROM python:3.14.6-slim-trixie@sha256:7bec7ddcddeff7975d6ba9b4be7dd6f6b2f55e7491539145e2978f7f97ce9144

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
