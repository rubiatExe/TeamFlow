"""Environment-backed configuration for the hiring-agent service."""

import math
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

DEFAULT_HIRING_AGENT_MODEL = "gemini-3.7-flash"
DEFAULT_HIRING_AGENT_FALLBACK_MODEL = "gemini-3.6-flash"

_MODEL_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_MAX_QUEUE_AND_WORKFLOW_SECONDS = 49.0


def _strict_bool(
    environ: Mapping[str, str],
    name: str,
    *,
    default: bool = False,
) -> bool:
    raw = environ.get(name, str(default))
    if type(raw) is not str:
        raise ValueError(f"{name} must be true or false")
    raw = raw.strip().lower()
    if raw not in {"true", "false"}:
        raise ValueError(f"{name} must be true or false")
    return raw == "true"


def _mapping_text(
    environ: Mapping[str, str],
    name: str,
    *,
    default: str = "",
) -> str:
    raw = environ.get(name, default)
    if type(raw) is not str:
        raise ValueError(f"{name} is invalid")
    return raw


def _mapping_int(
    environ: Mapping[str, str],
    name: str,
    *,
    default: int,
) -> int:
    raw = environ.get(name, str(default))
    if type(raw) is not str:
        raise ValueError(f"{name} must be an integer")
    invalid = False
    try:
        value = int(raw)
    except (ValueError, OverflowError):
        invalid = True
        value = 0
    if invalid:
        raise ValueError(f"{name} must be an integer")
    return value


def _mapping_float(
    environ: Mapping[str, str],
    name: str,
    *,
    default: float,
) -> float:
    raw = environ.get(name, str(default))
    if type(raw) is not str:
        raise ValueError(f"{name} must be a number")
    invalid = False
    try:
        value = float(raw)
    except (ValueError, OverflowError):
        invalid = True
        value = 0.0
    if invalid:
        raise ValueError(f"{name} must be a number")
    return value


def _model_id(value: object, name: str, *, allow_empty: bool = False) -> str:
    if allow_empty and value == "":
        return ""
    if not isinstance(value, str) or _MODEL_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{name} is invalid")
    return value


def _api_key(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("GOOGLE_API_KEY is invalid")
    if value and (
        len(value) > 512
        or not value.isascii()
        or not value.isprintable()
        or any(character.isspace() for character in value)
    ):
        raise ValueError("GOOGLE_API_KEY is invalid")
    return value


def _validated_int(
    value: object,
    name: str,
    minimum: int,
    maximum: int,
) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _validated_float(
    value: object,
    name: str,
    minimum: float,
    maximum: float,
) -> float:
    invalid = type(value) not in {int, float}
    normalized = 0.0
    if not invalid:
        try:
            normalized = float(value)
        except (TypeError, ValueError, OverflowError):
            invalid = True
    if invalid or not math.isfinite(normalized) or not minimum <= normalized <= maximum:
        raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")
    return normalized


def _bounded_int(
    environ: Mapping[str, str],
    name: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    raw = environ.get(name, str(default))
    if not isinstance(raw, str):
        raise ValueError(f"{name} must be an integer")
    invalid = False
    try:
        value = int(raw)
    except (TypeError, ValueError, OverflowError):
        invalid = True
        value = 0
    if invalid:
        raise ValueError(f"{name} must be an integer")
    return _validated_int(value, name, minimum, maximum)


def _bounded_float(
    environ: Mapping[str, str],
    name: str,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    raw = environ.get(name, str(default))
    if not isinstance(raw, str):
        raise ValueError(f"{name} must be a number")
    invalid = False
    try:
        value = float(raw)
    except (TypeError, ValueError, OverflowError):
        invalid = True
        value = 0.0
    if invalid:
        raise ValueError(f"{name} must be a number")
    return _validated_float(value, name, minimum, maximum)


@dataclass(frozen=True, slots=True)
class Settings:
    """Immutable model, graph, and service budgets for one workflow invocation."""

    model: str
    fallback_model: str
    google_api_key: str = field(repr=False)
    max_tool_rounds: int
    max_tool_calls_per_round: int
    model_timeout_seconds: float
    tool_timeout_seconds: float
    workflow_timeout_seconds: float
    max_concurrency: int
    queue_timeout_seconds: float
    max_request_bytes: int
    hitl_max_decision_request_bytes: int = 524_288

    def __post_init__(self) -> None:
        _model_id(self.model, "HIRING_AGENT_MODEL")
        _model_id(
            self.fallback_model,
            "HIRING_AGENT_FALLBACK_MODEL",
            allow_empty=True,
        )
        _api_key(self.google_api_key)
        _validated_int(
            self.max_tool_rounds,
            "HIRING_AGENT_MAX_TOOL_ROUNDS",
            0,
            4,
        )
        _validated_int(
            self.max_tool_calls_per_round,
            "HIRING_AGENT_MAX_TOOL_CALLS_PER_ROUND",
            1,
            5,
        )
        _validated_float(
            self.model_timeout_seconds,
            "HIRING_AGENT_MODEL_TIMEOUT_SECONDS",
            5.0,
            30.0,
        )
        _validated_float(
            self.tool_timeout_seconds,
            "HIRING_AGENT_TOOL_TIMEOUT_SECONDS",
            0.01,
            30.0,
        )
        _validated_float(
            self.workflow_timeout_seconds,
            "HIRING_AGENT_TIMEOUT_SECONDS",
            10.0,
            55.0,
        )
        _validated_int(
            self.max_concurrency,
            "HIRING_AGENT_MAX_CONCURRENCY",
            1,
            16,
        )
        _validated_float(
            self.queue_timeout_seconds,
            "HIRING_AGENT_QUEUE_TIMEOUT_SECONDS",
            0.1,
            5.0,
        )
        _validated_int(
            self.max_request_bytes,
            "HIRING_AGENT_MAX_REQUEST_BYTES",
            4_096,
            262_144,
        )
        _validated_int(
            self.hitl_max_decision_request_bytes,
            "TEAMFLOW_HITL_MAX_DECISION_REQUEST_BYTES",
            262_144,
            1_048_576,
        )
        if self.model_timeout_seconds > self.workflow_timeout_seconds:
            raise ValueError(
                "HIRING_AGENT_MODEL_TIMEOUT_SECONDS must not exceed HIRING_AGENT_TIMEOUT_SECONDS"
            )
        if self.tool_timeout_seconds > self.workflow_timeout_seconds:
            raise ValueError(
                "HIRING_AGENT_TOOL_TIMEOUT_SECONDS must not exceed HIRING_AGENT_TIMEOUT_SECONDS"
            )
        if (
            self.queue_timeout_seconds + self.workflow_timeout_seconds
            > _MAX_QUEUE_AND_WORKFLOW_SECONDS
        ):
            raise ValueError(
                "HIRING_AGENT_QUEUE_TIMEOUT_SECONDS plus HIRING_AGENT_TIMEOUT_SECONDS "
                "must not exceed 49 seconds"
            )

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Settings":
        environment = os.environ if environ is None else environ
        return cls(
            model=_model_id(
                environment.get("HIRING_AGENT_MODEL", DEFAULT_HIRING_AGENT_MODEL),
                "HIRING_AGENT_MODEL",
            ),
            fallback_model=_model_id(
                environment.get(
                    "HIRING_AGENT_FALLBACK_MODEL",
                    DEFAULT_HIRING_AGENT_FALLBACK_MODEL,
                ),
                "HIRING_AGENT_FALLBACK_MODEL",
                allow_empty=True,
            ),
            google_api_key=_api_key(environment.get("GOOGLE_API_KEY", "")),
            max_tool_rounds=_bounded_int(
                environment,
                "HIRING_AGENT_MAX_TOOL_ROUNDS",
                2,
                0,
                4,
            ),
            max_tool_calls_per_round=_bounded_int(
                environment,
                "HIRING_AGENT_MAX_TOOL_CALLS_PER_ROUND",
                3,
                1,
                5,
            ),
            model_timeout_seconds=_bounded_float(
                environment,
                "HIRING_AGENT_MODEL_TIMEOUT_SECONDS",
                12.0,
                5.0,
                30.0,
            ),
            tool_timeout_seconds=_bounded_float(
                environment,
                "HIRING_AGENT_TOOL_TIMEOUT_SECONDS",
                10.0,
                0.01,
                30.0,
            ),
            workflow_timeout_seconds=_bounded_float(
                environment,
                "HIRING_AGENT_TIMEOUT_SECONDS",
                45.0,
                10.0,
                55.0,
            ),
            max_concurrency=_bounded_int(
                environment,
                "HIRING_AGENT_MAX_CONCURRENCY",
                4,
                1,
                16,
            ),
            queue_timeout_seconds=_bounded_float(
                environment,
                "HIRING_AGENT_QUEUE_TIMEOUT_SECONDS",
                1.0,
                0.1,
                5.0,
            ),
            max_request_bytes=_bounded_int(
                environment,
                "HIRING_AGENT_MAX_REQUEST_BYTES",
                65_536,
                4_096,
                262_144,
            ),
            hitl_max_decision_request_bytes=_bounded_int(
                environment,
                "TEAMFLOW_HITL_MAX_DECISION_REQUEST_BYTES",
                524_288,
                262_144,
                1_048_576,
            ),
        )


@dataclass(frozen=True, slots=True)
class HumanReviewRuntimeSettings:
    """Server-only Phase 6 runtime configuration.

    Secret values are deliberately excluded from ``repr`` so an exception or debug
    log cannot accidentally render a bearer-verification key or database password.
    Configuration is inert unless the explicit feature flag is enabled.
    """

    enabled: bool = False
    production: bool = False
    supabase_url: str = field(default="", repr=False)
    supabase_anon_key: str = field(default="", repr=False)
    database_dsn: str = field(default="", repr=False)
    capability_secret: str = field(default="", repr=False)
    checkpoint_dsn: str = field(default="", repr=False)
    database_min_pool_size: int = 1
    database_max_pool_size: int = 4
    checkpoint_min_pool_size: int = 1
    checkpoint_max_pool_size: int = 2
    auth_timeout_seconds: float = 5.0
    max_concurrency: int = 4
    queue_timeout_seconds: float = 1.0
    start_timeout_seconds: float = 45.0
    decision_timeout_seconds: float = 15.0
    inspect_timeout_seconds: float = 5.0

    def __post_init__(self) -> None:
        if type(self.enabled) is not bool:
            raise ValueError("TEAMFLOW_HITL_ENABLED must be true or false")
        if type(self.production) is not bool:
            raise ValueError("ENVIRONMENT is invalid")
        for name, value in (
            ("SUPABASE_URL", self.supabase_url),
            ("SUPABASE_ANON_KEY", self.supabase_anon_key),
            ("TEAMFLOW_HITL_DSN", self.database_dsn),
            ("TEAMFLOW_HITL_CAPABILITY_SECRET", self.capability_secret),
            ("TEAMFLOW_CHECKPOINT_DSN", self.checkpoint_dsn),
        ):
            if type(value) is not str:
                raise ValueError(f"{name} is invalid")
        _validated_int(
            self.database_min_pool_size,
            "TEAMFLOW_HITL_DB_MIN_POOL_SIZE",
            1,
            16,
        )
        _validated_int(
            self.database_max_pool_size,
            "TEAMFLOW_HITL_DB_MAX_POOL_SIZE",
            1,
            16,
        )
        if self.database_min_pool_size > self.database_max_pool_size:
            raise ValueError(
                "TEAMFLOW_HITL_DB_MIN_POOL_SIZE must not exceed TEAMFLOW_HITL_DB_MAX_POOL_SIZE"
            )
        _validated_int(
            self.checkpoint_min_pool_size,
            "TEAMFLOW_CHECKPOINT_MIN_POOL_SIZE",
            1,
            8,
        )
        _validated_int(
            self.checkpoint_max_pool_size,
            "TEAMFLOW_CHECKPOINT_MAX_POOL_SIZE",
            1,
            8,
        )
        if self.checkpoint_min_pool_size > self.checkpoint_max_pool_size:
            raise ValueError(
                "TEAMFLOW_CHECKPOINT_MIN_POOL_SIZE must not exceed "
                "TEAMFLOW_CHECKPOINT_MAX_POOL_SIZE"
            )
        _validated_float(
            self.auth_timeout_seconds,
            "TEAMFLOW_HITL_AUTH_TIMEOUT_SECONDS",
            0.01,
            15.0,
        )
        _validated_int(
            self.max_concurrency,
            "TEAMFLOW_HITL_MAX_CONCURRENCY",
            1,
            16,
        )
        _validated_float(
            self.queue_timeout_seconds,
            "TEAMFLOW_HITL_QUEUE_TIMEOUT_SECONDS",
            0.01,
            5.0,
        )
        _validated_float(
            self.start_timeout_seconds,
            "TEAMFLOW_HITL_START_TIMEOUT_SECONDS",
            0.01,
            45.0,
        )
        if self.queue_timeout_seconds + self.start_timeout_seconds > 48:
            raise ValueError(
                "TEAMFLOW_HITL_QUEUE_TIMEOUT_SECONDS plus "
                "TEAMFLOW_HITL_START_TIMEOUT_SECONDS must not exceed 48 seconds"
            )
        _validated_float(
            self.decision_timeout_seconds,
            "TEAMFLOW_HITL_DECISION_TIMEOUT_SECONDS",
            0.01,
            30.0,
        )
        _validated_float(
            self.inspect_timeout_seconds,
            "TEAMFLOW_HITL_INSPECT_TIMEOUT_SECONDS",
            0.01,
            10.0,
        )

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "HumanReviewRuntimeSettings":
        environment = os.environ if environ is None else environ
        enabled = _strict_bool(environment, "TEAMFLOW_HITL_ENABLED")
        runtime_environment = (
            _mapping_text(
                environment,
                "ENVIRONMENT",
                default="development",
            )
            .strip()
            .lower()
        )
        if runtime_environment not in {"development", "test", "production"}:
            raise ValueError("ENVIRONMENT is invalid")
        production = runtime_environment == "production"
        if not enabled:
            # Do not retain or parse dormant secrets and tuning values while the
            # feature is disabled.
            return cls(enabled=False, production=production)
        return cls(
            enabled=True,
            production=production,
            supabase_url=_mapping_text(environment, "SUPABASE_URL"),
            supabase_anon_key=_mapping_text(environment, "SUPABASE_ANON_KEY"),
            database_dsn=_mapping_text(environment, "TEAMFLOW_HITL_DSN"),
            capability_secret=_mapping_text(
                environment,
                "TEAMFLOW_HITL_CAPABILITY_SECRET",
            ),
            checkpoint_dsn=_mapping_text(environment, "TEAMFLOW_CHECKPOINT_DSN"),
            database_min_pool_size=_mapping_int(
                environment,
                "TEAMFLOW_HITL_DB_MIN_POOL_SIZE",
                default=1,
            ),
            database_max_pool_size=_mapping_int(
                environment,
                "TEAMFLOW_HITL_DB_MAX_POOL_SIZE",
                default=4,
            ),
            checkpoint_min_pool_size=_mapping_int(
                environment,
                "TEAMFLOW_CHECKPOINT_MIN_POOL_SIZE",
                default=1,
            ),
            checkpoint_max_pool_size=_mapping_int(
                environment,
                "TEAMFLOW_CHECKPOINT_MAX_POOL_SIZE",
                default=2,
            ),
            auth_timeout_seconds=_mapping_float(
                environment,
                "TEAMFLOW_HITL_AUTH_TIMEOUT_SECONDS",
                default=5.0,
            ),
            max_concurrency=_mapping_int(
                environment,
                "TEAMFLOW_HITL_MAX_CONCURRENCY",
                default=4,
            ),
            queue_timeout_seconds=_mapping_float(
                environment,
                "TEAMFLOW_HITL_QUEUE_TIMEOUT_SECONDS",
                default=1.0,
            ),
            start_timeout_seconds=_mapping_float(
                environment,
                "TEAMFLOW_HITL_START_TIMEOUT_SECONDS",
                default=45.0,
            ),
            decision_timeout_seconds=_mapping_float(
                environment,
                "TEAMFLOW_HITL_DECISION_TIMEOUT_SECONDS",
                default=15.0,
            ),
            inspect_timeout_seconds=_mapping_float(
                environment,
                "TEAMFLOW_HITL_INSPECT_TIMEOUT_SECONDS",
                default=5.0,
            ),
        )
