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
        )
