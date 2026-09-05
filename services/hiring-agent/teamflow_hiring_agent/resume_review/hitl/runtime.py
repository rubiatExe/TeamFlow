"""Production lifespan composition for durable human review.

The feature is inert by default.  When enabled, startup validates server-only
configuration, verifies the already-migrated checkpoint schema, owns both PostgreSQL
resource lifetimes, compiles the privacy-minimized outer graph once, and only then
publishes the application service to the HTTP router.

Normal startup never calls the LangGraph checkpointer's ``setup`` method.  Schema DDL
remains isolated in :mod:`checkpoint_admin`.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager
from typing import Any, Literal
from urllib.parse import parse_qs, urlsplit

from ...config import HumanReviewRuntimeSettings
from ...supabase_http import validate_supabase_origin
from .api import HitlDependencyUnavailableError, HitlReviewService
from .auth import SupabaseUserAuthenticator, decode_capability_secret
from .checkpoint_admin import check_checkpoint_schema
from .checkpointing import (
    CHECKPOINT_RUNTIME_ROLE,
    open_postgres_checkpointer,
    validate_checkpoint_dsn,
)
from .lifecycle import HumanReviewLifecycleRunner
from .service import DurableHumanReviewService, PrivateAnalysisRunner

logger = logging.getLogger(__name__)

HITL_RUNTIME_ROLE = "teamflow_hitl_service"
_PRODUCTION_SSL_MODE = "verify-full"
_PUBLISHABLE_KEY_RE = re.compile(r"^sb_publishable_[A-Za-z0-9_-]{20,8192}$")

RuntimeStatus = Literal["disabled", "not_ready", "starting", "ready", "failed", "stopped"]
ServiceContextFactory = Callable[
    [HumanReviewRuntimeSettings],
    AbstractAsyncContextManager[HitlReviewService],
]


class HumanReviewRuntimeConfigurationError(ValueError):
    """Credential-free configuration error safe for readiness diagnostics."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class HumanReviewRuntimeStartupError(RuntimeError):
    """Sanitized lifespan failure that never embeds a connection error or secret."""

    def __init__(self, code: str = "hitl_runtime_startup_failed") -> None:
        super().__init__(code)
        self.code = code


def _legacy_anon_key(key: str) -> bool:
    """Identify a legacy anon JWT without treating its unsigned data as authority."""

    parts = key.split(".")
    if len(parts) != 3:
        return False
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return False
    return isinstance(payload, dict) and payload.get("role") == "anon"


def _validate_supabase_auth(
    *,
    url: str,
    anon_key: str,
    production: bool,
) -> None:
    if not isinstance(url, str) or not url or url != url.strip():
        raise HumanReviewRuntimeConfigurationError("supabase_auth_url_invalid")
    malformed = False
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        malformed = True
        parsed = None
        port = None
    if malformed or parsed is None:
        raise HumanReviewRuntimeConfigurationError("supabase_auth_url_invalid")
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or port is not None
        and not 1 <= port <= 65_535
    ):
        raise HumanReviewRuntimeConfigurationError("supabase_auth_url_invalid")
    if production and parsed.scheme != "https":
        raise HumanReviewRuntimeConfigurationError("supabase_auth_https_required")
    if not production and parsed.scheme not in {"http", "https"}:
        raise HumanReviewRuntimeConfigurationError("supabase_auth_url_invalid")

    if (
        not isinstance(anon_key, str)
        or not 20 <= len(anon_key) <= 8_192
        or anon_key != anon_key.strip()
        or any(character.isspace() for character in anon_key)
    ):
        raise HumanReviewRuntimeConfigurationError("supabase_anon_key_invalid")
    if anon_key.startswith("sb_secret_"):
        raise HumanReviewRuntimeConfigurationError("supabase_anon_key_invalid")
    if production and not (_PUBLISHABLE_KEY_RE.fullmatch(anon_key) or _legacy_anon_key(anon_key)):
        raise HumanReviewRuntimeConfigurationError("supabase_anon_key_invalid")


def validate_hitl_dsn(dsn: str, *, production: bool) -> str:
    """Validate the direct application DSN without rendering credentials."""

    if not isinstance(dsn, str) or not dsn or dsn != dsn.strip():
        raise HumanReviewRuntimeConfigurationError("hitl_dsn_invalid")
    malformed = False
    try:
        parsed = urlsplit(dsn)
        port = parsed.port
    except ValueError:
        malformed = True
        parsed = None
        port = None
    if malformed or parsed is None:
        raise HumanReviewRuntimeConfigurationError("hitl_dsn_invalid")
    if (
        parsed.scheme not in {"postgres", "postgresql"}
        or not parsed.hostname
        or not parsed.username
        or not parsed.path.removeprefix("/")
        or parsed.fragment
        or port is not None
        and not 1 <= port <= 65_535
    ):
        raise HumanReviewRuntimeConfigurationError("hitl_dsn_invalid")
    if parsed.username != HITL_RUNTIME_ROLE:
        raise HumanReviewRuntimeConfigurationError("hitl_dsn_role_invalid")
    # The guarded write transaction requires a direct/session connection.  Reject
    # the standard transaction-pooler port and Supavisor pooler host explicitly.
    if production and (
        port not in {None, 5432} or parsed.hostname.lower().endswith(".pooler.supabase.com")
    ):
        raise HumanReviewRuntimeConfigurationError("hitl_direct_dsn_required")
    malformed_query = False
    try:
        query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        malformed_query = True
        query = {}
    if malformed_query:
        raise HumanReviewRuntimeConfigurationError("hitl_dsn_invalid")
    normalized_query = {key.lower(): values for key, values in query.items()}
    if len(normalized_query) != len(query):
        raise HumanReviewRuntimeConfigurationError("hitl_dsn_invalid")
    ssl_modes = normalized_query.get("sslmode", [])
    if len(ssl_modes) > 1:
        raise HumanReviewRuntimeConfigurationError("hitl_dsn_invalid")
    if production and (not ssl_modes or ssl_modes[0].lower() != _PRODUCTION_SSL_MODE):
        raise HumanReviewRuntimeConfigurationError("hitl_dsn_verify_full_required")
    if "pgbouncer" in normalized_query:
        raise HumanReviewRuntimeConfigurationError("hitl_direct_dsn_required")
    return dsn


def validate_runtime_settings(
    settings: HumanReviewRuntimeSettings,
) -> HumanReviewRuntimeSettings:
    """Validate every enabled dependency before opening a socket or pool."""

    if not isinstance(settings, HumanReviewRuntimeSettings):
        raise HumanReviewRuntimeConfigurationError("hitl_runtime_settings_invalid")
    if type(settings.enabled) is not bool or type(settings.production) is not bool:
        raise HumanReviewRuntimeConfigurationError("hitl_runtime_settings_invalid")
    if not settings.enabled:
        return settings
    _validate_supabase_auth(
        url=settings.supabase_url,
        anon_key=settings.supabase_anon_key,
        production=settings.production,
    )
    validate_hitl_dsn(settings.database_dsn, production=settings.production)
    invalid_secret = False
    try:
        decode_capability_secret(settings.capability_secret)
    except ValueError:
        invalid_secret = True
    if invalid_secret:
        raise HumanReviewRuntimeConfigurationError("hitl_capability_secret_invalid")
    invalid_checkpoint_dsn = False
    try:
        validate_checkpoint_dsn(
            settings.checkpoint_dsn,
            production=settings.production,
            expected_username=CHECKPOINT_RUNTIME_ROLE if settings.production else None,
        )
    except ValueError:
        invalid_checkpoint_dsn = True
    if invalid_checkpoint_dsn:
        raise HumanReviewRuntimeConfigurationError("checkpoint_dsn_invalid")
    if (
        type(settings.database_min_pool_size) is not int
        or type(settings.database_max_pool_size) is not int
        or not 1 <= settings.database_min_pool_size <= settings.database_max_pool_size <= 16
    ):
        raise HumanReviewRuntimeConfigurationError("hitl_pool_size_invalid")
    if (
        type(settings.checkpoint_min_pool_size) is not int
        or type(settings.checkpoint_max_pool_size) is not int
        or not 1 <= settings.checkpoint_min_pool_size <= settings.checkpoint_max_pool_size <= 8
    ):
        raise HumanReviewRuntimeConfigurationError("checkpoint_pool_size_invalid")
    if (
        type(settings.auth_timeout_seconds) not in {int, float}
        or not math.isfinite(float(settings.auth_timeout_seconds))
        or not 0 < settings.auth_timeout_seconds <= 15
    ):
        raise HumanReviewRuntimeConfigurationError("supabase_auth_timeout_invalid")
    if type(settings.max_concurrency) is not int or not 1 <= settings.max_concurrency <= 16:
        raise HumanReviewRuntimeConfigurationError("hitl_concurrency_invalid")
    if (
        type(settings.queue_timeout_seconds) not in {int, float}
        or not math.isfinite(float(settings.queue_timeout_seconds))
        or not 0 < settings.queue_timeout_seconds <= 5
    ):
        raise HumanReviewRuntimeConfigurationError("hitl_queue_timeout_invalid")
    if not (
        type(settings.start_timeout_seconds) in {int, float}
        and math.isfinite(float(settings.start_timeout_seconds))
        and 0 < settings.start_timeout_seconds <= 45
        and settings.queue_timeout_seconds + settings.start_timeout_seconds <= 48
    ):
        raise HumanReviewRuntimeConfigurationError("hitl_start_timeout_invalid")
    if (
        type(settings.decision_timeout_seconds) not in {int, float}
        or not math.isfinite(float(settings.decision_timeout_seconds))
        or not 0 < settings.decision_timeout_seconds <= 30
    ):
        raise HumanReviewRuntimeConfigurationError("hitl_decision_timeout_invalid")
    if (
        type(settings.inspect_timeout_seconds) not in {int, float}
        or not math.isfinite(float(settings.inspect_timeout_seconds))
        or not 0 < settings.inspect_timeout_seconds <= 10
    ):
        raise HumanReviewRuntimeConfigurationError("hitl_inspect_timeout_invalid")
    return settings


class RuntimeHitlReviewService:
    """Stable router dependency that publishes no service before readiness."""

    def __init__(self) -> None:
        self._delegate: HitlReviewService | None = None

    def bind(self, service: HitlReviewService) -> None:
        if self._delegate is not None:
            raise HumanReviewRuntimeStartupError("hitl_runtime_already_bound")
        self._delegate = service

    def unbind(self) -> None:
        self._delegate = None

    def _service(self) -> HitlReviewService:
        if self._delegate is None:
            raise HitlDependencyUnavailableError
        return self._delegate

    async def start(self, request: Any, authorization: str) -> Any:
        return await self._service().start(request, authorization)

    async def inspect(self, run_id: str, authorization: str) -> Any:
        return await self._service().inspect(run_id, authorization)

    async def list_pending(
        self,
        *,
        limit: int,
        cursor: str | None,
        authorization: str,
    ) -> Any:
        return await self._service().list_pending(
            limit=limit,
            cursor=cursor,
            authorization=authorization,
        )

    async def decide(self, run_id: str, request: Any, authorization: str) -> Any:
        return await self._service().decide(run_id, request, authorization)


class BoundedHitlReviewService:
    """Bound admission and deadlines for the production v2 service.

    A timed-out decision is safe to retry because the authoritative database operation
    is atomic and idempotent.  Cancellation may arrive after PostgreSQL committed but
    before checkpoint resumption; the next identical request replays the decision and
    resumes the same thread.  Start never performs a candidate score write.
    """

    def __init__(
        self,
        delegate: HitlReviewService,
        *,
        max_concurrency: int,
        queue_timeout_seconds: float,
        start_timeout_seconds: float,
        decision_timeout_seconds: float,
        inspect_timeout_seconds: float,
    ) -> None:
        self._delegate = delegate
        self._slots = asyncio.Semaphore(max_concurrency)
        self._queue_timeout = queue_timeout_seconds
        self._start_timeout = start_timeout_seconds
        self._decision_timeout = decision_timeout_seconds
        self._inspect_timeout = inspect_timeout_seconds

    async def _execute(
        self,
        operation: str,
        call: Callable[[], Awaitable[Any]],
        *,
        timeout_seconds: float,
    ) -> Any:
        acquired = False
        queue_timed_out = False
        try:
            await asyncio.wait_for(
                self._slots.acquire(),
                timeout=self._queue_timeout,
            )
            acquired = True
        except TimeoutError:
            queue_timed_out = True
        if queue_timed_out:
            logger.warning(
                "Durable human-review request reached admission capacity",
                extra={"hitl_operation": operation},
            )
            raise HitlDependencyUnavailableError

        operation_timed_out = False
        try:
            async with asyncio.timeout(timeout_seconds):
                result = await call()
        except TimeoutError:
            operation_timed_out = True
            result = None
        finally:
            if acquired:
                self._slots.release()
        if operation_timed_out:
            logger.warning(
                "Durable human-review request exceeded its deadline",
                extra={"hitl_operation": operation},
            )
            raise HitlDependencyUnavailableError
        return result

    async def start(self, request: Any, authorization: str) -> Any:
        return await self._execute(
            "start",
            lambda: self._delegate.start(request, authorization),
            timeout_seconds=self._start_timeout,
        )

    async def inspect(self, run_id: str, authorization: str) -> Any:
        return await self._execute(
            "inspect",
            lambda: self._delegate.inspect(run_id, authorization),
            timeout_seconds=self._inspect_timeout,
        )

    async def list_pending(
        self,
        *,
        limit: int,
        cursor: str | None,
        authorization: str,
    ) -> Any:
        return await self._execute(
            "list_pending",
            lambda: self._delegate.list_pending(
                limit=limit,
                cursor=cursor,
                authorization=authorization,
            ),
            timeout_seconds=self._inspect_timeout,
        )

    async def decide(self, run_id: str, request: Any, authorization: str) -> Any:
        return await self._execute(
            "decide",
            lambda: self._delegate.decide(run_id, request, authorization),
            timeout_seconds=self._decision_timeout,
        )


def _new_repository(settings: HumanReviewRuntimeSettings) -> Any:
    # Kept local so a disabled service does not import or initialize DB adapters.
    from .repository import PostgresHitlRepository

    return PostgresHitlRepository(
        settings.database_dsn,
        capability_secret=settings.capability_secret,
        auth_issuer=(
            validate_supabase_origin(
                settings.supabase_url,
                settings.supabase_url,
                production=settings.production,
            )
            + "/auth/v1"
        ),
        min_size=settings.database_min_pool_size,
        max_size=settings.database_max_pool_size,
    )


def _new_edit_validator(repository: Any) -> Any:
    from .repository import PostgresHumanEditValidator

    return PostgresHumanEditValidator(repository)


@asynccontextmanager
async def open_production_hitl_service(
    settings: HumanReviewRuntimeSettings,
    *,
    analysis_runner: PrivateAnalysisRunner,
) -> AsyncIterator[HitlReviewService]:
    """Open all Phase 6 resources and compose one production service instance."""

    validated = validate_runtime_settings(settings)
    # This performs read-only inspection using the runtime role.  It never applies
    # saver migrations and deliberately runs before the checkpointer pool is opened.
    await check_checkpoint_schema(
        validated.checkpoint_dsn,
        production=validated.production,
    )
    repository = _new_repository(validated)
    async with repository:
        async with open_postgres_checkpointer(
            validated.checkpoint_dsn,
            production=validated.production,
            min_pool_size=validated.checkpoint_min_pool_size,
            max_pool_size=validated.checkpoint_max_pool_size,
        ) as checkpointer:
            lifecycle = HumanReviewLifecycleRunner(
                repository,
                checkpointer=checkpointer,
            )
            service = DurableHumanReviewService(
                authenticator=SupabaseUserAuthenticator(
                    supabase_url=validated.supabase_url,
                    anon_key=validated.supabase_anon_key,
                    production=validated.production,
                    timeout_seconds=validated.auth_timeout_seconds,
                ),
                repository=repository,
                analysis_runner=analysis_runner,
                lifecycle=lifecycle,
                edit_validator=_new_edit_validator(repository),
            )
            yield BoundedHitlReviewService(
                service,
                max_concurrency=validated.max_concurrency,
                queue_timeout_seconds=validated.queue_timeout_seconds,
                start_timeout_seconds=validated.start_timeout_seconds,
                decision_timeout_seconds=validated.decision_timeout_seconds,
                inspect_timeout_seconds=validated.inspect_timeout_seconds,
            )


class HumanReviewRuntime:
    """Own the service slot and its complete FastAPI lifespan."""

    def __init__(
        self,
        settings: HumanReviewRuntimeSettings,
        *,
        analysis_runner: PrivateAnalysisRunner | None = None,
        _service_context_factory: ServiceContextFactory | None = None,
    ) -> None:
        self._settings = settings
        self._analysis_runner = analysis_runner
        self.service = RuntimeHitlReviewService()
        self.status: RuntimeStatus = "disabled" if not settings.enabled else "not_ready"
        self._service_context_factory = _service_context_factory

    @property
    def ready(self) -> bool:
        """Disabled is healthy; enabled is healthy only after full composition."""

        return not self._settings.enabled or self.status == "ready"

    @asynccontextmanager
    async def lifespan(self, _app: Any) -> AsyncIterator[None]:
        if not self._settings.enabled:
            self.status = "disabled"
            yield
            return

        self.status = "starting"
        stack = AsyncExitStack()
        startup_failed = False
        try:
            if self._service_context_factory is not None:
                service_context = self._service_context_factory(self._settings)
            else:
                if self._analysis_runner is None:
                    raise HumanReviewRuntimeConfigurationError("hitl_analysis_runner_required")
                service_context = open_production_hitl_service(
                    self._settings,
                    analysis_runner=self._analysis_runner,
                )
            service = await stack.enter_async_context(service_context)
        except Exception:
            startup_failed = True
            service = None
        if startup_failed or service is None:
            self.status = "failed"
            self.service.unbind()
            try:
                await stack.aclose()
            except Exception:
                # Preserve the fixed public startup error below.  Connection/pool
                # exceptions can contain hosts, usernames, or driver diagnostics.
                pass
            logger.error(
                "Durable human-review runtime failed to initialize",
                extra={"hitl_status": "failed"},
            )
            raise HumanReviewRuntimeStartupError

        self.service.bind(service)
        self.status = "ready"
        try:
            yield
        finally:
            self.service.unbind()
            self.status = "stopped"
            shutdown_failed = False
            try:
                await stack.aclose()
            except Exception:
                shutdown_failed = True
            if shutdown_failed:
                self.status = "failed"
                logger.error(
                    "Durable human-review runtime failed to shut down cleanly",
                    extra={"hitl_status": "failed"},
                )
                raise HumanReviewRuntimeStartupError("hitl_runtime_shutdown_failed")


__all__ = [
    "HITL_RUNTIME_ROLE",
    "BoundedHitlReviewService",
    "HumanReviewRuntime",
    "HumanReviewRuntimeConfigurationError",
    "HumanReviewRuntimeStartupError",
    "RuntimeHitlReviewService",
    "open_production_hitl_service",
    "validate_hitl_dsn",
    "validate_runtime_settings",
]
