"""Minimal authenticated HTTP boundary for the tenant-scoped hiring workflow.

Composition, telemetry, and the ASGI server remain explicit startup concerns.  This
module only adapts one already-composed, long-lived workflow to HTTP and deliberately
does not add another queue or execution deadline around the bounded runtime.
"""

from __future__ import annotations

import asyncio
import math
import os
import re
import secrets
from collections.abc import Mapping
from dataclasses import dataclass, field

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .composition import (
    HiringRuntimeUnavailableError,
    HiringTenantScopeError,
    TenantScopedHiringRuntime,
)
from .contracts import HiringAgentOutput, HiringAgentRequest
from .runtime import (
    HiringWorkflowBusyError,
    HiringWorkflowDependencyError,
    HiringWorkflowExecutionError,
    HiringWorkflowRequestError,
    HiringWorkflowResultError,
    HiringWorkflowTimeoutError,
)

_PUBLIC_PATHS = frozenset({"/health", "/ready", "/version"})
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})
_SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}
_CANONICAL_CONTENT_LENGTH = re.compile(rb"^(?:0|[1-9][0-9]*)$")
_MAX_BODY_FRAMES = 64
_BODY_FRAME_YIELD_INTERVAL = 8


class HiringHTTPConfigurationError(ValueError):
    """A sanitized HTTP boundary configuration failure."""


@dataclass(frozen=True, slots=True)
class HiringHTTPSettings:
    """Immutable HTTP limits and the internal caller credential."""

    service_token: str = field(repr=False)
    environment: str = "development"
    max_request_bytes: int = 65_536
    body_timeout_seconds: float = 5.0

    def __post_init__(self) -> None:
        if type(self.environment) is not str or self.environment not in {
            "development",
            "test",
            "production",
        }:
            raise HiringHTTPConfigurationError("hiring_http_configuration_invalid")
        if (
            type(self.service_token) is not str
            or not 1 <= len(self.service_token) <= 512
            or (self.environment == "production" and len(self.service_token) < 32)
            or not self.service_token.isascii()
            or not self.service_token.isprintable()
            or any(character.isspace() for character in self.service_token)
        ):
            raise HiringHTTPConfigurationError("hiring_http_configuration_invalid")
        if (
            type(self.max_request_bytes) is not int
            or not 4_096 <= self.max_request_bytes <= 262_144
        ):
            raise HiringHTTPConfigurationError("hiring_http_configuration_invalid")
        if type(self.body_timeout_seconds) not in {int, float}:
            raise HiringHTTPConfigurationError("hiring_http_configuration_invalid")
        try:
            timeout = float(self.body_timeout_seconds)
        except (OverflowError, ValueError):
            raise HiringHTTPConfigurationError("hiring_http_configuration_invalid") from None
        if not math.isfinite(timeout) or not 0.01 <= timeout <= 10.0:
            raise HiringHTTPConfigurationError("hiring_http_configuration_invalid")

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> HiringHTTPSettings:
        environment = os.environ if environ is None else environ
        try:
            token = environment.get("HIRING_AGENT_TOKEN", "")
            runtime_environment = environment.get("ENVIRONMENT", "development")
            raw_bytes = environment.get("HIRING_AGENT_MAX_REQUEST_BYTES", "65536")
            raw_timeout = environment.get("HIRING_AGENT_BODY_TIMEOUT_SECONDS", "5")
            if any(
                type(value) is not str
                for value in (token, runtime_environment, raw_bytes, raw_timeout)
            ):
                raise ValueError
            return cls(
                service_token=token,
                environment=runtime_environment,
                max_request_bytes=int(raw_bytes),
                body_timeout_seconds=float(raw_timeout),
            )
        except Exception:
            raise HiringHTTPConfigurationError("hiring_http_configuration_invalid") from None


def _json_response(
    content: object,
    *,
    status_code: int,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        content=content,
        status_code=status_code,
        headers={**_SECURITY_HEADERS, **dict(headers or {})},
    )


def _header_values(scope: Scope, name: bytes) -> tuple[bytes, ...]:
    return tuple(value for key, value in scope.get("headers", ()) if key.lower() == name)


async def _send_json(
    content: object,
    *,
    status_code: int,
    scope: Scope,
    receive: Receive,
    send: Send,
    headers: Mapping[str, str] | None = None,
) -> None:
    await _json_response(content, status_code=status_code, headers=headers)(scope, receive, send)


def _security_header_send(send: Send) -> Send:
    async def secured(message: Message) -> None:
        if message["type"] == "http.response.start":
            protected_names = {name.lower().encode("ascii") for name in _SECURITY_HEADERS}
            existing = [
                (name, value)
                for name, value in message.get("headers", ())
                if name.lower() not in protected_names
            ]
            existing.extend(
                (name.encode("ascii"), value.encode("ascii"))
                for name, value in _SECURITY_HEADERS.items()
            )
            message = {**message, "headers": existing}
        await send(message)

    return secured


class HiringHTTPBoundary:
    """Authenticate and cap request bytes before FastAPI parses protected input."""

    def __init__(self, app: ASGIApp, *, settings: HiringHTTPSettings) -> None:
        self._app = app
        self._settings = settings
        self._service_token = settings.service_token.encode("ascii")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        secured_send = _security_header_send(send)
        path = scope.get("path", "")
        if path not in _PUBLIC_PATHS:
            presented_tokens = _header_values(scope, b"x-agent-token")
            valid_token = len(presented_tokens) == 1
            if valid_token:
                try:
                    valid_token = secrets.compare_digest(
                        presented_tokens[0],
                        self._service_token,
                    )
                except (TypeError, ValueError):
                    valid_token = False
            if not valid_token:
                await _send_json(
                    {"error": "Unauthorized", "code": "unauthorized"},
                    status_code=401,
                    scope=scope,
                    receive=receive,
                    send=secured_send,
                )
                return

        if scope.get("method") not in _BODY_METHODS:
            await self._app(scope, receive, secured_send)
            return

        content_types = _header_values(scope, b"content-type")
        if len(content_types) != 1 or content_types[0] != b"application/json":
            await _send_json(
                {"error": "Unsupported media type", "code": "unsupported_media_type"},
                status_code=415,
                scope=scope,
                receive=receive,
                send=secured_send,
            )
            return

        content_lengths = _header_values(scope, b"content-length")
        transfer_encodings = _header_values(scope, b"transfer-encoding")
        if content_lengths and transfer_encodings:
            await _send_json(
                {"error": "Invalid request", "code": "invalid_request"},
                status_code=400,
                scope=scope,
                receive=receive,
                send=secured_send,
            )
            return
        if len(content_lengths) > 1:
            await _send_json(
                {"error": "Invalid request", "code": "invalid_request"},
                status_code=400,
                scope=scope,
                receive=receive,
                send=secured_send,
            )
            return
        declared_content_length: int | None = None
        if content_lengths:
            try:
                if _CANONICAL_CONTENT_LENGTH.fullmatch(content_lengths[0]) is None:
                    raise ValueError
                declared_content_length = int(content_lengths[0])
            except (ValueError, OverflowError):
                await _send_json(
                    {"error": "Invalid request", "code": "invalid_request"},
                    status_code=400,
                    scope=scope,
                    receive=receive,
                    send=secured_send,
                )
                return
            if declared_content_length > self._settings.max_request_bytes:
                await _send_json(
                    {"error": "Request body is too large", "code": "request_too_large"},
                    status_code=413,
                    scope=scope,
                    receive=receive,
                    send=secured_send,
                )
                return

        body_buffer = bytearray()
        total_bytes = 0
        frame_count = 0
        try:
            async with asyncio.timeout(float(self._settings.body_timeout_seconds)):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    if message["type"] != "http.request":
                        raise ValueError
                    body = message.get("body", b"")
                    if type(body) is not bytes:
                        raise ValueError
                    frame_count += 1
                    if frame_count > _MAX_BODY_FRAMES:
                        raise ValueError
                    next_total = total_bytes + len(body)
                    exceeds_byte_limit = next_total > self._settings.max_request_bytes
                    if (
                        exceeds_byte_limit
                        or declared_content_length is not None
                        and next_total > declared_content_length
                    ):
                        await _send_json(
                            {
                                "error": (
                                    "Request body is too large"
                                    if exceeds_byte_limit
                                    else "Invalid request"
                                ),
                                "code": (
                                    "request_too_large" if exceeds_byte_limit else "invalid_request"
                                ),
                            },
                            status_code=413 if exceeds_byte_limit else 400,
                            scope=scope,
                            receive=receive,
                            send=secured_send,
                        )
                        return
                    body_buffer.extend(body)
                    total_bytes = next_total
                    if not message.get("more_body", False):
                        break
                    if frame_count % _BODY_FRAME_YIELD_INTERVAL == 0:
                        await asyncio.sleep(0)
        except TimeoutError:
            await _send_json(
                {"error": "Request body deadline exceeded", "code": "body_timeout"},
                status_code=408,
                scope=scope,
                receive=receive,
                send=secured_send,
            )
            return
        except (KeyError, TypeError, ValueError):
            await _send_json(
                {"error": "Invalid request", "code": "invalid_request"},
                status_code=400,
                scope=scope,
                receive=receive,
                send=secured_send,
            )
            return

        if declared_content_length is not None and total_bytes != declared_content_length:
            await _send_json(
                {"error": "Invalid request", "code": "invalid_request"},
                status_code=400,
                scope=scope,
                receive=receive,
                send=secured_send,
            )
            return

        buffered_body = bytes(body_buffer)
        replayed = False

        async def replay_receive() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {
                    "type": "http.request",
                    "body": buffered_body,
                    "more_body": False,
                }
            return {"type": "http.disconnect"}

        await self._app(scope, replay_receive, secured_send)


def create_hiring_app(
    runtime: TenantScopedHiringRuntime,
    *,
    settings: HiringHTTPSettings,
) -> FastAPI:
    """Expose an already-composed tenant runtime without duplicating its budgets."""

    if (
        not isinstance(runtime, TenantScopedHiringRuntime)
        or not isinstance(settings, HiringHTTPSettings)
        or settings.environment != runtime.environment
    ):
        raise HiringHTTPConfigurationError("hiring_http_configuration_invalid")

    app = FastAPI(
        title="TeamFlow Hiring Agent",
        version="2.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(HiringHTTPBoundary, settings=settings)
    app.state.runtime = runtime

    @app.exception_handler(RequestValidationError)
    async def sanitized_validation_error(
        _request: Request,
        _error: RequestValidationError,
    ) -> JSONResponse:
        return _json_response(
            {"error": "Invalid request", "code": "invalid_request"},
            status_code=422,
        )

    @app.exception_handler(StarletteHTTPException)
    async def sanitized_bad_request(
        request: Request,
        error: StarletteHTTPException,
    ) -> Response:
        if error.status_code == 400:
            return _json_response(
                {"error": "Invalid request", "code": "invalid_request"},
                status_code=400,
            )
        return await http_exception_handler(request, error)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/ready")
    async def ready() -> JSONResponse:
        is_ready = runtime.ready
        return _json_response(
            {"status": "ready" if is_ready else "not_ready"},
            status_code=200 if is_ready else 503,
        )

    @app.get("/version")
    async def version() -> dict[str, str]:
        return {"service": "teamflow-hiring-agent", "version": "2.1.0"}

    @app.post("/invoke", response_model=HiringAgentOutput)
    async def invoke(request: HiringAgentRequest) -> HiringAgentOutput | JSONResponse:
        try:
            return await runtime.invoke(request)
        except asyncio.CancelledError:
            raise
        except HiringTenantScopeError:
            return _json_response(
                {"error": "Forbidden", "code": "tenant_scope_mismatch"},
                status_code=403,
            )
        except HiringRuntimeUnavailableError:
            return _json_response(
                {"error": "Workflow is unavailable", "code": "workflow_unavailable"},
                status_code=503,
            )
        except HiringWorkflowBusyError:
            return _json_response(
                {"error": "Workflow is at capacity", "code": "workflow_busy"},
                status_code=429,
                headers={"Retry-After": "1"},
            )
        except HiringWorkflowTimeoutError:
            return _json_response(
                {"error": "Workflow deadline exceeded", "code": "workflow_timeout"},
                status_code=504,
            )
        except HiringWorkflowRequestError:
            return _json_response(
                {"error": "Invalid request", "code": "invalid_request"},
                status_code=422,
            )
        except HiringWorkflowDependencyError:
            return _json_response(
                {"error": "Workflow is unavailable", "code": "workflow_unavailable"},
                status_code=503,
            )
        except (HiringWorkflowExecutionError, HiringWorkflowResultError):
            return _json_response(
                {"error": "Workflow failed", "code": "workflow_failed"},
                status_code=502,
            )
        except Exception:
            return _json_response(
                {"error": "Workflow failed", "code": "workflow_failed"},
                status_code=500,
            )

    return app


__all__ = [
    "HiringHTTPBoundary",
    "HiringHTTPConfigurationError",
    "HiringHTTPSettings",
    "create_hiring_app",
]
