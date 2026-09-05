"""Focused production-composition tests for the Phase 6 HITL runtime."""

from __future__ import annotations

import asyncio
import base64
import inspect
import logging
from contextlib import asynccontextmanager
from dataclasses import replace

import pytest

from teamflow_hiring_agent.config import HumanReviewRuntimeSettings
from teamflow_hiring_agent.resume_review.hitl import runtime as runtime_module
from teamflow_hiring_agent.resume_review.hitl.api import HitlDependencyUnavailableError
from teamflow_hiring_agent.resume_review.hitl.runtime import (
    BoundedHitlReviewService,
    HumanReviewRuntime,
    HumanReviewRuntimeConfigurationError,
    HumanReviewRuntimeStartupError,
    open_production_hitl_service,
    validate_hitl_dsn,
    validate_runtime_settings,
)

HITL_DSN = (
    "postgresql://teamflow_hitl_service:private-hitl-password@"
    "db.project.supabase.co:5432/postgres?sslmode=verify-full"
)
CHECKPOINT_DSN = (
    "postgresql://teamflow_checkpoint_runtime:private-checkpoint-password@"
    "db.project.supabase.co:5432/postgres?sslmode=verify-full"
)
PUBLISHABLE_KEY = "sb_publishable_" + "a" * 32
CAPABILITY_SECRET = base64.urlsafe_b64encode(b"k" * 32).decode("ascii").rstrip("=")


def _settings(**changes: object) -> HumanReviewRuntimeSettings:
    base = HumanReviewRuntimeSettings(
        enabled=True,
        production=True,
        supabase_url="https://project.supabase.co",
        supabase_anon_key=PUBLISHABLE_KEY,
        database_dsn=HITL_DSN,
        capability_secret=CAPABILITY_SECRET,
        checkpoint_dsn=CHECKPOINT_DSN,
    )
    return replace(base, **changes)


class RecordingService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    async def start(self, request: object, authorization: str) -> object:
        self.calls.append(("start", request))
        return {"authorization_received": bool(authorization)}

    async def inspect(self, run_id: str, authorization: str) -> object:
        self.calls.append(("inspect", run_id))
        return {"authorization_received": bool(authorization)}

    async def decide(
        self,
        run_id: str,
        request: object,
        authorization: str,
    ) -> object:
        self.calls.append(("decide", (run_id, request)))
        return {"authorization_received": bool(authorization)}


def test_feature_is_disabled_by_default_and_secrets_are_absent_from_repr() -> None:
    settings = HumanReviewRuntimeSettings.from_env({})
    assert settings.enabled is False
    assert HumanReviewRuntime(settings).ready is True
    dormant = HumanReviewRuntimeSettings.from_env(
        {
            "TEAMFLOW_HITL_ENABLED": "false",
            "TEAMFLOW_HITL_DSN": "private-dormant-dsn",
            "TEAMFLOW_HITL_DB_MAX_POOL_SIZE": "not-parsed",
        }
    )
    assert dormant.database_dsn == ""

    rendered = repr(_settings())
    assert "private-hitl-password" not in rendered
    assert "private-checkpoint-password" not in rendered
    assert PUBLISHABLE_KEY not in rendered
    assert CAPABILITY_SECRET not in rendered


def test_feature_flag_and_numeric_configuration_are_strict() -> None:
    with pytest.raises(ValueError, match="TEAMFLOW_HITL_ENABLED"):
        HumanReviewRuntimeSettings.from_env({"TEAMFLOW_HITL_ENABLED": "yes"})
    with pytest.raises(ValueError, match="TEAMFLOW_HITL_DB_MAX_POOL_SIZE"):
        HumanReviewRuntimeSettings.from_env(
            {
                "TEAMFLOW_HITL_ENABLED": "true",
                "TEAMFLOW_HITL_DB_MAX_POOL_SIZE": "many",
            }
        )

    for environment, field_name in (
        ({"TEAMFLOW_HITL_ENABLED": True}, "TEAMFLOW_HITL_ENABLED"),
        (
            {"TEAMFLOW_HITL_ENABLED": "false", "ENVIRONMENT": object()},
            "ENVIRONMENT",
        ),
        (
            {"TEAMFLOW_HITL_ENABLED": "true", "SUPABASE_URL": object()},
            "SUPABASE_URL",
        ),
        (
            {
                "TEAMFLOW_HITL_ENABLED": "true",
                "TEAMFLOW_HITL_DB_MAX_POOL_SIZE": False,
            },
            "TEAMFLOW_HITL_DB_MAX_POOL_SIZE",
        ),
        (
            {
                "TEAMFLOW_HITL_ENABLED": "true",
                "TEAMFLOW_HITL_AUTH_TIMEOUT_SECONDS": object(),
            },
            "TEAMFLOW_HITL_AUTH_TIMEOUT_SECONDS",
        ),
        (
            {
                "TEAMFLOW_HITL_ENABLED": "true",
                "TEAMFLOW_HITL_DB_MAX_POOL_SIZE": "9" * 10_000,
            },
            "TEAMFLOW_HITL_DB_MAX_POOL_SIZE",
        ),
    ):
        with pytest.raises(ValueError, match=field_name) as captured:
            HumanReviewRuntimeSettings.from_env(environment)  # type: ignore[arg-type]
        assert captured.value.__cause__ is None
        assert captured.value.__context__ is None

    with pytest.raises(ValueError, match="TEAMFLOW_HITL_AUTH_TIMEOUT_SECONDS"):
        HumanReviewRuntimeSettings.from_env(
            {
                "TEAMFLOW_HITL_ENABLED": "true",
                "TEAMFLOW_HITL_AUTH_TIMEOUT_SECONDS": "nan",
            }
        )


@pytest.mark.parametrize(
    ("field_name", "invalid_value"),
    [
        ("enabled", 1),
        ("production", 0),
        ("supabase_url", object()),
        ("database_min_pool_size", True),
        ("database_max_pool_size", 10**100),
        ("checkpoint_min_pool_size", False),
        ("auth_timeout_seconds", float("nan")),
        ("max_concurrency", True),
        ("queue_timeout_seconds", float("inf")),
        ("start_timeout_seconds", float("-inf")),
        ("decision_timeout_seconds", True),
        ("inspect_timeout_seconds", "5"),
    ],
)
def test_runtime_settings_reject_invalid_direct_construction(
    field_name: str,
    invalid_value: object,
) -> None:
    with pytest.raises(ValueError):
        HumanReviewRuntimeSettings(**{field_name: invalid_value})  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "dsn",
    [
        "postgresql://postgres:secret@db.project.supabase.co:5432/postgres?sslmode=require",
        "postgresql://teamflow_hitl_service:secret@db.project.supabase.co:5432/postgres?sslmode=require",
        "postgresql://teamflow_hitl_service:secret@db.project.supabase.co:5432/postgres?sslmode=verify-ca",
        "postgresql://teamflow_hitl_service:secret@db.project.supabase.co:6543/postgres?sslmode=require",
        "postgresql://teamflow_hitl_service:secret@aws-0.pooler.supabase.com:5432/postgres?sslmode=require",
        "postgresql://teamflow_hitl_service:secret@db.project.supabase.co:5432/postgres?sslmode=disable",
        "postgresql://teamflow_hitl_service:secret@db.project.supabase.co:5432/postgres?pgbouncer=true&sslmode=require",
        "postgresql://teamflow_hitl_service:secret@db.project.supabase.co:5432/postgres?sslmode=require&SSLMODE=disable",
    ],
)
def test_production_hitl_dsn_requires_direct_dedicated_role_and_ssl(dsn: str) -> None:
    with pytest.raises(HumanReviewRuntimeConfigurationError):
        validate_hitl_dsn(dsn, production=True)


def test_malformed_hitl_dsn_does_not_retain_parser_exception() -> None:
    private_canary = "private-dsn-canary"
    dsn = f"postgresql://teamflow_hitl_service:{private_canary}@[::1/postgres"

    with pytest.raises(HumanReviewRuntimeConfigurationError) as captured:
        validate_hitl_dsn(dsn, production=True)

    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert private_canary not in repr(captured.value)


def test_enabled_nonproduction_hitl_still_requires_the_dedicated_login() -> None:
    with pytest.raises(
        HumanReviewRuntimeConfigurationError,
        match="hitl_dsn_role_invalid",
    ):
        validate_hitl_dsn(
            "postgresql://postgres:secret@127.0.0.1:5432/postgres",
            production=False,
        )


def test_enabled_runtime_validates_auth_roles_pools_and_secret_key_kind() -> None:
    assert validate_runtime_settings(_settings()) == _settings()

    invalid_settings = [
        _settings(supabase_url="http://project.supabase.co"),
        _settings(supabase_anon_key="sb_secret_" + "a" * 32),
        _settings(capability_secret="weak"),
        _settings(checkpoint_dsn=CHECKPOINT_DSN.replace("runtime", "migrator")),
    ]
    for field_name, invalid_value in (
        ("database_min_pool_size", True),
        ("checkpoint_max_pool_size", True),
        ("auth_timeout_seconds", float("nan")),
        ("max_concurrency", True),
        ("queue_timeout_seconds", float("inf")),
        ("start_timeout_seconds", float("nan")),
        ("decision_timeout_seconds", True),
        ("inspect_timeout_seconds", float("-inf")),
    ):
        corrupted = _settings()
        object.__setattr__(corrupted, field_name, invalid_value)
        invalid_settings.append(corrupted)
    for value in invalid_settings:
        with pytest.raises(HumanReviewRuntimeConfigurationError) as captured:
            validate_runtime_settings(value)
        assert "private" not in str(captured.value)


def test_disabled_runtime_opens_nothing_and_enabled_runtime_binds_only_in_lifespan() -> None:
    events: list[str] = []
    service = RecordingService()

    @asynccontextmanager
    async def service_context(_settings: HumanReviewRuntimeSettings):
        events.append("open")
        try:
            yield service
        finally:
            events.append("close")

    async def exercise() -> None:
        disabled = HumanReviewRuntime(HumanReviewRuntimeSettings())
        async with disabled.lifespan(None):
            assert disabled.status == "disabled"
        assert events == []

        runtime = HumanReviewRuntime(
            _settings(),
            _service_context_factory=service_context,
        )
        with pytest.raises(HitlDependencyUnavailableError):
            await runtime.service.inspect("run", "Bearer before")
        async with runtime.lifespan(None):
            assert runtime.status == "ready"
            assert runtime.ready is True
            await runtime.service.inspect("run", "Bearer during")
        assert runtime.status == "stopped"
        assert runtime.ready is False
        with pytest.raises(HitlDependencyUnavailableError):
            await runtime.service.inspect("run", "Bearer after")

    asyncio.run(exercise())
    assert events == ["open", "close"]
    assert service.calls == [("inspect", "run")]


def test_startup_failure_is_sanitized_and_never_publishes_the_service(caplog) -> None:
    private_detail = "postgresql://user:secret@private-host/database"

    @asynccontextmanager
    async def failing_context(_settings: HumanReviewRuntimeSettings):
        raise RuntimeError(private_detail)
        yield RecordingService()  # pragma: no cover

    runtime = HumanReviewRuntime(
        _settings(),
        _service_context_factory=failing_context,
    )
    caplog.set_level(logging.ERROR)

    async def exercise() -> None:
        with pytest.raises(HumanReviewRuntimeStartupError) as captured:
            async with runtime.lifespan(None):
                pass
        assert str(captured.value) == "hitl_runtime_startup_failed"
        with pytest.raises(HitlDependencyUnavailableError):
            await runtime.service.inspect("run", "Bearer secret-token")

    asyncio.run(exercise())
    assert runtime.status == "failed"
    assert private_detail not in caplog.text
    assert "secret-token" not in caplog.text


def test_enabled_runtime_without_an_injected_analysis_runner_fails_closed() -> None:
    runtime = HumanReviewRuntime(_settings())

    async def exercise() -> None:
        with pytest.raises(HumanReviewRuntimeStartupError):
            async with runtime.lifespan(None):
                pass

    asyncio.run(exercise())
    assert runtime.status == "failed"


def test_production_composition_checks_schema_then_opens_owned_resources_once(
    monkeypatch,
) -> None:
    events: list[str] = []
    service = RecordingService()

    class Repository:
        async def __aenter__(self):
            events.append("repository_open")
            return self

        async def __aexit__(self, *_args):
            events.append("repository_close")

    async def check_schema(dsn: str, *, production: bool):
        assert dsn == CHECKPOINT_DSN
        assert production is True
        events.append("schema_checked")

    @asynccontextmanager
    async def checkpointer_context(*_args, **_kwargs):
        events.append("checkpointer_open")
        try:
            yield object()
        finally:
            events.append("checkpointer_close")

    class Lifecycle:
        def __init__(self, repository: object, *, checkpointer: object) -> None:
            assert isinstance(repository, Repository)
            assert checkpointer is not None
            events.append("graph_compiled")

    analysis_runner = object()

    class Service:
        def __new__(cls, **kwargs):
            assert kwargs["analysis_runner"] is analysis_runner
            events.append("service_composed")
            return service

    class BoundedService:
        def __new__(cls, delegate, **kwargs):
            assert delegate is service
            assert kwargs == {
                "max_concurrency": 4,
                "queue_timeout_seconds": 1.0,
                "start_timeout_seconds": 45.0,
                "decision_timeout_seconds": 15.0,
                "inspect_timeout_seconds": 5.0,
            }
            events.append("service_bounded")
            return delegate

    monkeypatch.setattr(runtime_module, "check_checkpoint_schema", check_schema)
    monkeypatch.setattr(runtime_module, "_new_repository", lambda _settings: Repository())
    monkeypatch.setattr(
        runtime_module,
        "open_postgres_checkpointer",
        checkpointer_context,
    )
    monkeypatch.setattr(runtime_module, "HumanReviewLifecycleRunner", Lifecycle)
    monkeypatch.setattr(runtime_module, "SupabaseUserAuthenticator", lambda **_kwargs: object())
    monkeypatch.setattr(runtime_module, "_new_edit_validator", lambda _repository: object())
    monkeypatch.setattr(runtime_module, "DurableHumanReviewService", Service)
    monkeypatch.setattr(runtime_module, "BoundedHitlReviewService", BoundedService)

    async def exercise() -> None:
        async with open_production_hitl_service(
            _settings(),
            analysis_runner=analysis_runner,
        ) as composed:
            assert composed is service
            assert events == [
                "schema_checked",
                "repository_open",
                "checkpointer_open",
                "graph_compiled",
                "service_composed",
                "service_bounded",
            ]

    asyncio.run(exercise())
    assert events == [
        "schema_checked",
        "repository_open",
        "checkpointer_open",
        "graph_compiled",
        "service_composed",
        "service_bounded",
        "checkpointer_close",
        "repository_close",
    ]
    source = inspect.getsource(open_production_hitl_service)
    assert "setup(" not in source
    assert "Settings.from_env" not in source
    assert "LangGraphResumeReviewWorkflow(" not in source


def test_bounded_service_rejects_queue_saturation_without_starting_second_call(
    caplog,
) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    class BlockingService(RecordingService):
        async def inspect(self, run_id: str, authorization: str) -> object:
            self.calls.append(("inspect", run_id))
            entered.set()
            await release.wait()
            return {"done": True}

    delegate = BlockingService()
    bounded = BoundedHitlReviewService(
        delegate,
        max_concurrency=1,
        queue_timeout_seconds=0.01,
        start_timeout_seconds=1,
        decision_timeout_seconds=1,
        inspect_timeout_seconds=1,
    )
    caplog.set_level(logging.WARNING)

    async def exercise() -> None:
        first = asyncio.create_task(bounded.inspect("first", "Bearer private-first-token"))
        await entered.wait()
        with pytest.raises(HitlDependencyUnavailableError):
            await bounded.inspect("second", "Bearer private-second-token")
        release.set()
        assert await first == {"done": True}

    asyncio.run(exercise())
    assert delegate.calls == [("inspect", "first")]
    assert "private-first-token" not in caplog.text
    assert "private-second-token" not in caplog.text


def test_start_deadline_cancels_work_and_returns_retryable_domain_error() -> None:
    class SlowStartService(RecordingService):
        cancelled = False

        async def start(self, request: object, authorization: str) -> object:
            try:
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                self.cancelled = True
                raise

    delegate = SlowStartService()
    bounded = BoundedHitlReviewService(
        delegate,
        max_concurrency=1,
        queue_timeout_seconds=0.1,
        start_timeout_seconds=0.01,
        decision_timeout_seconds=1,
        inspect_timeout_seconds=1,
    )

    async def exercise() -> None:
        with pytest.raises(HitlDependencyUnavailableError):
            await bounded.start({"document": "private"}, "Bearer private-token")

    asyncio.run(exercise())
    assert delegate.cancelled is True


def test_decision_timeout_after_commit_is_safe_to_retry_without_duplicate_write() -> None:
    class CommitThenPauseService(RecordingService):
        writes = 0
        first = True
        cancelled = False

        async def decide(
            self,
            run_id: str,
            request: object,
            authorization: str,
        ) -> object:
            if self.first:
                self.first = False
                self.writes += 1
                try:
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    self.cancelled = True
                    raise
            return {"replayed": True}

    delegate = CommitThenPauseService()
    bounded = BoundedHitlReviewService(
        delegate,
        max_concurrency=1,
        queue_timeout_seconds=0.1,
        start_timeout_seconds=1,
        decision_timeout_seconds=0.01,
        inspect_timeout_seconds=1,
    )

    async def exercise() -> None:
        with pytest.raises(HitlDependencyUnavailableError):
            await bounded.decide("run", {"decision": "approve"}, "Bearer token")
        assert await bounded.decide(
            "run",
            {"decision": "approve"},
            "Bearer token",
        ) == {"replayed": True}

    asyncio.run(exercise())
    assert delegate.cancelled is True
    assert delegate.writes == 1
