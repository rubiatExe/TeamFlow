"""Sanitized FastAPI boundary for the additive Phase 6 human-review contracts."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol, TypeVar

from fastapi import APIRouter, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import TypeAdapter, ValidationError

from ..contracts import DatabaseId, FrozenContract
from .contracts import (
    PendingResumeReviewQueueResponse,
    PendingReviewCursor,
    ResumeReviewDecisionRequest,
    ResumeReviewRunDetailResponse,
    ResumeReviewRunResponse,
    ResumeReviewRunStatus,
    StartResumeReviewRunRequest,
)

logger = logging.getLogger(__name__)

_SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
}
_PENDING_STATUSES = frozenset(
    {
        ResumeReviewRunStatus.RUNNING,
        ResumeReviewRunStatus.PENDING_REVIEW,
        ResumeReviewRunStatus.DECISION_RECORDED,
        ResumeReviewRunStatus.APPLYING,
    }
)


class HitlReviewService(Protocol):
    """Injected application service; authentication and persistence live elsewhere."""

    async def start(
        self,
        request: StartResumeReviewRunRequest,
        authorization: str,
    ) -> ResumeReviewRunResponse: ...

    async def inspect(
        self,
        run_id: str,
        authorization: str,
    ) -> ResumeReviewRunDetailResponse: ...

    async def list_pending(
        self,
        *,
        limit: int,
        cursor: str | None,
        authorization: str,
    ) -> PendingResumeReviewQueueResponse: ...

    async def decide(
        self,
        run_id: str,
        request: ResumeReviewDecisionRequest,
        authorization: str,
    ) -> ResumeReviewRunResponse: ...


class HitlServiceError(RuntimeError):
    """Base for sanitized, expected application-service failures."""

    status_code = 500
    error_code = "hitl_service_error"
    public_message = "Résumé-review request failed"


class HitlIdentityError(HitlServiceError):
    status_code = 401
    error_code = "unauthorized"
    public_message = "Unauthorized"


class HitlMembershipDeniedError(HitlServiceError):
    status_code = 403
    error_code = "forbidden"
    public_message = "Forbidden"


class HitlReviewerDeniedError(HitlMembershipDeniedError):
    pass


class HitlNotFoundError(HitlServiceError):
    status_code = 404
    error_code = "not_found"
    public_message = "Résumé-review run was not found"


class HitlWrongTenantError(HitlNotFoundError):
    """Intentionally indistinguishable from a missing run at the HTTP boundary."""


class HitlIdempotencyConflictError(HitlServiceError):
    status_code = 409
    error_code = "idempotency_conflict"
    public_message = "Request conflicts with an existing idempotency key"


class HitlStaleDecisionError(HitlServiceError):
    status_code = 409
    error_code = "stale_decision"
    public_message = "Review decision is stale"


class HitlAlreadyDecidedError(HitlServiceError):
    status_code = 409
    error_code = "review_already_decided"
    public_message = "Review already has a decision"


class HitlInvalidEditError(HitlServiceError):
    status_code = 422
    error_code = "invalid_edit"
    public_message = "Edited review output is invalid"


class HitlInvalidRequestError(HitlServiceError):
    status_code = 422
    error_code = "invalid_request"
    public_message = "Invalid résumé-review request"


class HitlDependencyUnavailableError(HitlServiceError):
    status_code = 503
    error_code = "service_unavailable"
    public_message = "Résumé-review service is unavailable"


def _json_response(
    content: object,
    *,
    status_code: int,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        content,
        status_code=status_code,
        headers={**_SECURITY_HEADERS, **(headers or {})},
    )


def _error_response(error: HitlServiceError) -> JSONResponse:
    headers: dict[str, str] = {}
    if error.status_code == 401:
        headers["WWW-Authenticate"] = "Bearer"
    if error.status_code == 503:
        headers["Retry-After"] = "2"
    return _json_response(
        {"error": error.public_message, "code": error.error_code},
        status_code=error.status_code,
        headers=headers,
    )


def _authorization(request: Request) -> str:
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        raise HitlIdentityError
    raw = values[0]
    scheme, separator, credential = raw.partition(" ")
    if (
        separator != " "
        or scheme.lower() != "bearer"
        or not credential
        or len(credential) > 8_192
        or credential != credential.strip()
        or any(character.isspace() for character in credential)
    ):
        raise HitlIdentityError
    return f"Bearer {credential}"


class _SanitizedValidationRoute(APIRoute):
    """Keep Pydantic input values out of validation error responses."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Any]]:
        original = super().get_route_handler()

        async def sanitized(request: Request) -> Any:
            try:
                # Authenticate the end-user identity before FastAPI validates or
                # reflects on body/path fields. The outer service-token and body
                # cap middleware have already run at this point.
                _authorization(request)
                return await original(request)
            except HitlIdentityError as exc:
                return _error_response(exc)
            except RequestValidationError:
                return _json_response(
                    {"error": "Invalid résumé-review request", "code": "invalid_request"},
                    status_code=422,
                )

        return sanitized


OperationResult = TypeVar("OperationResult")
ContractResult = TypeVar("ContractResult", bound=FrozenContract)


async def _execute(
    operation: str,
    call: Callable[[], Awaitable[OperationResult]],
    response_contract: type[ContractResult],
    *,
    run_id: str | None = None,
) -> ContractResult | JSONResponse:
    try:
        raw = await call()
        return response_contract.model_validate(raw)
    except HitlServiceError as exc:
        return _error_response(exc)
    except Exception as exc:
        logger.error(
            "Durable résumé-review %s failed with %s",
            operation,
            type(exc).__name__,
            extra={"run_id": run_id} if run_id is not None else None,
        )
        return _json_response(
            {"error": "Résumé-review request failed", "code": "workflow_failed"},
            status_code=502,
        )


def _success_response(
    result: ResumeReviewRunResponse,
    *,
    pending_status_code: int,
    include_location: bool,
) -> JSONResponse:
    pending = result.status in _PENDING_STATUSES
    headers: dict[str, str] = {}
    if pending:
        headers["Retry-After"] = "2"
        if include_location:
            headers["Location"] = f"/v2/resume-review-runs/{result.run_id}"
    return _json_response(
        result.model_dump(mode="json"),
        status_code=pending_status_code if pending else 200,
        headers=headers,
    )


_CURSOR_ADAPTER = TypeAdapter(PendingReviewCursor)


def _pending_query(request: Request) -> tuple[int, str | None]:
    pairs = list(request.query_params.multi_items())
    allowed = {"status", "limit", "cursor"}
    keys = [key for key, _value in pairs]
    if any(key not in allowed for key in keys) or len(keys) != len(set(keys)):
        raise HitlInvalidRequestError
    values = dict(pairs)
    if values.get("status") != ResumeReviewRunStatus.PENDING_REVIEW.value:
        raise HitlInvalidRequestError
    raw_limit = values.get("limit", "25")
    if not raw_limit.isascii() or not raw_limit.isdecimal():
        raise HitlInvalidRequestError
    limit = int(raw_limit)
    if str(limit) != raw_limit or not 1 <= limit <= 50:
        raise HitlInvalidRequestError
    raw_cursor = values.get("cursor")
    if raw_cursor is not None:
        invalid_cursor = False
        try:
            raw_cursor = _CURSOR_ADAPTER.validate_python(raw_cursor)
        except ValidationError:
            invalid_cursor = True
        if invalid_cursor:
            raise HitlInvalidRequestError
    return limit, raw_cursor


def build_hitl_router(service: HitlReviewService | None) -> APIRouter:
    """Build the v2 router around an injected, separately authenticated service."""

    router = APIRouter(
        prefix="/v2/resume-review-runs",
        tags=["durable-resume-review"],
        route_class=_SanitizedValidationRoute,
    )

    def require_service() -> HitlReviewService:
        if service is None:
            raise HitlDependencyUnavailableError
        return service

    @router.get("", response_model=PendingResumeReviewQueueResponse)
    async def list_pending_reviews(
        http_request: Request,
    ) -> PendingResumeReviewQueueResponse | JSONResponse:
        try:
            authorization = _authorization(http_request)
            limit, cursor = _pending_query(http_request)
            resolved_service = require_service()
        except HitlServiceError as exc:
            return _error_response(exc)
        result = await _execute(
            "list_pending",
            lambda: resolved_service.list_pending(
                limit=limit,
                cursor=cursor,
                authorization=authorization,
            ),
            PendingResumeReviewQueueResponse,
        )
        if isinstance(result, JSONResponse):
            return result
        return _json_response(result.model_dump(mode="json"), status_code=200)

    @router.post("", response_model=ResumeReviewRunResponse)
    async def start_run(
        body: StartResumeReviewRunRequest,
        http_request: Request,
    ) -> ResumeReviewRunResponse | JSONResponse:
        try:
            authorization = _authorization(http_request)
            resolved_service = require_service()
        except HitlServiceError as exc:
            return _error_response(exc)
        result = await _execute(
            "start",
            lambda: resolved_service.start(body, authorization),
            ResumeReviewRunResponse,
        )
        if isinstance(result, JSONResponse):
            return result
        return _success_response(result, pending_status_code=202, include_location=True)

    @router.get("/{run_id}", response_model=ResumeReviewRunDetailResponse)
    async def inspect_run(
        run_id: DatabaseId,
        http_request: Request,
    ) -> ResumeReviewRunDetailResponse | JSONResponse:
        try:
            authorization = _authorization(http_request)
            resolved_service = require_service()
        except HitlServiceError as exc:
            return _error_response(exc)
        result = await _execute(
            "inspect",
            lambda: resolved_service.inspect(run_id, authorization),
            ResumeReviewRunDetailResponse,
            run_id=run_id,
        )
        if isinstance(result, JSONResponse):
            return result
        return _success_response(result, pending_status_code=200, include_location=False)

    @router.put("/{run_id}/decision", response_model=ResumeReviewRunResponse)
    async def decide_run(
        run_id: DatabaseId,
        body: ResumeReviewDecisionRequest,
        http_request: Request,
    ) -> ResumeReviewRunResponse | JSONResponse:
        try:
            authorization = _authorization(http_request)
            resolved_service = require_service()
        except HitlServiceError as exc:
            return _error_response(exc)
        result = await _execute(
            "decide",
            lambda: resolved_service.decide(run_id, body, authorization),
            ResumeReviewRunResponse,
            run_id=run_id,
        )
        if isinstance(result, JSONResponse):
            return result
        return _success_response(result, pending_status_code=202, include_location=True)

    return router


__all__ = [
    "HitlAlreadyDecidedError",
    "HitlDependencyUnavailableError",
    "HitlIdempotencyConflictError",
    "HitlIdentityError",
    "HitlInvalidEditError",
    "HitlInvalidRequestError",
    "HitlMembershipDeniedError",
    "HitlNotFoundError",
    "HitlReviewService",
    "HitlReviewerDeniedError",
    "HitlServiceError",
    "HitlStaleDecisionError",
    "HitlWrongTenantError",
    "build_hitl_router",
]
