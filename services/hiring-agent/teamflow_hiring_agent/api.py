"""Compatibility factory for tests and older imports.

Production starts through ``main.py`` and ``compose_hiring_service``.  This module has
no application global, telemetry side effect, model construction, database connection,
or environment read at import time.  Its call-time fallback runtime is mock-only and
can never report ready in production.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

from fastapi import FastAPI

from .composition import TenantScopedHiringRuntime
from .http_api import HiringHTTPSettings, ResumeReviewWorkflowRunner, create_hiring_app
from .resume_review.hitl.api import HitlReviewService
from .resume_review.hitl.runtime import HumanReviewRuntime

_COMPATIBILITY_MERCHANT_ID = "00000000-0000-0000-0000-000000000001"


class _UnavailableHiringWorkflow:
    async def invoke(self, _request: object) -> Any:
        raise RuntimeError("hiring_workflow_unavailable")


def _snapshot(environ: Mapping[str, str] | None) -> Mapping[str, str]:
    source = os.environ if environ is None else environ
    if not isinstance(source, Mapping):
        raise ValueError("hiring_compatibility_configuration_invalid")
    try:
        copied = dict(source)
    except Exception:
        raise ValueError("hiring_compatibility_configuration_invalid") from None
    if any(type(key) is not str or type(value) is not str for key, value in copied.items()):
        raise ValueError("hiring_compatibility_configuration_invalid")
    return MappingProxyType(copied)


def create_app(
    workflow: Any | None = None,
    *,
    resume_review_workflow: ResumeReviewWorkflowRunner | None = None,
    hitl_review_service: HitlReviewService | None = None,
    hitl_runtime: HumanReviewRuntime | None = None,
    environ: Mapping[str, str] | None = None,
) -> FastAPI:
    """Adapt injected fakes through the hardened boundary without live composition."""

    snapshot = _snapshot(environ)
    environment = snapshot.get("ENVIRONMENT", "development")
    merchant_id = snapshot.get("HIRING_AGENT_MERCHANT_ID", _COMPATIBILITY_MERCHANT_ID)
    runtime = TenantScopedHiringRuntime(
        merchant_id=merchant_id,
        environment=environment,
        mock_tools=True,
        workflow=workflow if workflow is not None else _UnavailableHiringWorkflow(),
    )
    return create_hiring_app(
        runtime,
        settings=HiringHTTPSettings.from_env(snapshot),
        resume_review_workflow=resume_review_workflow,
        hitl_review_service=hitl_review_service,
        hitl_runtime=hitl_runtime,
    )


__all__ = ["create_app"]
