from dataclasses import FrozenInstanceError, replace

import pytest

from teamflow_hiring_agent.config import (
    DEFAULT_HIRING_AGENT_FALLBACK_MODEL,
    DEFAULT_HIRING_AGENT_MODEL,
    Settings,
)


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "model": DEFAULT_HIRING_AGENT_MODEL,
        "fallback_model": DEFAULT_HIRING_AGENT_FALLBACK_MODEL,
        "google_api_key": "test-key",
        "max_tool_rounds": 2,
        "max_tool_calls_per_round": 3,
        "model_timeout_seconds": 12.0,
        "tool_timeout_seconds": 10.0,
        "workflow_timeout_seconds": 45.0,
        "max_concurrency": 4,
        "queue_timeout_seconds": 1.0,
        "max_request_bytes": 65_536,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def test_defaults_are_loaded_from_an_injected_empty_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HIRING_AGENT_MODEL_TIMEOUT_SECONDS", "invalid-host-value")

    settings = Settings.from_env({})

    assert settings.model == DEFAULT_HIRING_AGENT_MODEL
    assert settings.fallback_model == DEFAULT_HIRING_AGENT_FALLBACK_MODEL
    assert settings.google_api_key == ""
    assert settings.max_tool_rounds == 2
    assert settings.max_tool_calls_per_round == 3
    assert settings.model_timeout_seconds == 12.0
    assert settings.tool_timeout_seconds == 10.0
    assert settings.workflow_timeout_seconds == 45.0
    assert settings.max_concurrency == 4
    assert settings.queue_timeout_seconds == 1.0
    assert settings.max_request_bytes == 65_536
    assert settings.queue_timeout_seconds + settings.workflow_timeout_seconds < 50


def test_injected_environment_overrides_each_workflow_setting() -> None:
    settings = Settings.from_env(
        {
            "HIRING_AGENT_MODEL": "gemini-3.7-flash-001",
            "HIRING_AGENT_FALLBACK_MODEL": "",
            "GOOGLE_API_KEY": "api-key_123",
            "HIRING_AGENT_MAX_TOOL_ROUNDS": "4",
            "HIRING_AGENT_MAX_TOOL_CALLS_PER_ROUND": "5",
            "HIRING_AGENT_MODEL_TIMEOUT_SECONDS": "5.5",
            "HIRING_AGENT_TOOL_TIMEOUT_SECONDS": "0.25",
            "HIRING_AGENT_TIMEOUT_SECONDS": "48",
            "HIRING_AGENT_MAX_CONCURRENCY": "16",
            "HIRING_AGENT_QUEUE_TIMEOUT_SECONDS": "0.5",
            "HIRING_AGENT_MAX_REQUEST_BYTES": "4096",
        }
    )

    assert settings.model == "gemini-3.7-flash-001"
    assert settings.fallback_model == ""
    assert settings.google_api_key == "api-key_123"
    assert settings.max_tool_rounds == 4
    assert settings.max_tool_calls_per_round == 5
    assert settings.model_timeout_seconds == 5.5
    assert settings.tool_timeout_seconds == 0.25
    assert settings.workflow_timeout_seconds == 48.0
    assert settings.max_concurrency == 16
    assert settings.queue_timeout_seconds == 0.5
    assert settings.max_request_bytes == 4_096


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("HIRING_AGENT_MODEL", ""),
        ("HIRING_AGENT_MODEL", " gemini-3.7-flash"),
        ("HIRING_AGENT_MODEL", "models/gemini-3.7-flash"),
        ("HIRING_AGENT_MODEL", "../gemini-3.7-flash"),
        ("HIRING_AGENT_MODEL", "Gemini-3.7-Flash"),
        ("HIRING_AGENT_FALLBACK_MODEL", "gemini 3.6 flash"),
        ("HIRING_AGENT_FALLBACK_MODEL", "a" * 129),
    ],
)
def test_model_ids_are_strict_and_errors_do_not_reflect_values(name: str, value: str) -> None:
    with pytest.raises(ValueError) as error:
        Settings.from_env({name: value})

    assert name in str(error.value)
    if value:
        assert value not in str(error.value)


def test_direct_model_id_validation_cannot_be_bypassed() -> None:
    with pytest.raises(ValueError, match="HIRING_AGENT_MODEL is invalid"):
        _settings(model="../private-model")


@pytest.mark.parametrize("value", ["key with spaces", "key\nline", "clé", "x" * 513])
def test_api_key_is_validated_without_reflection(value: str) -> None:
    with pytest.raises(ValueError) as error:
        _settings(google_api_key=value)

    assert str(error.value) == "GOOGLE_API_KEY is invalid"
    assert value not in str(error.value)


def test_non_string_api_key_is_rejected_by_direct_construction() -> None:
    with pytest.raises(ValueError, match="GOOGLE_API_KEY is invalid"):
        _settings(google_api_key=123)


def test_api_key_is_excluded_from_repr_for_direct_and_replaced_settings() -> None:
    canary = "api-key-secret-canary"
    settings = _settings(google_api_key=canary)

    assert canary not in repr(settings)
    assert canary not in repr(replace(settings, max_tool_rounds=3))


@pytest.mark.parametrize(
    ("field_name", "value", "environment_name"),
    [
        ("max_tool_rounds", -1, "HIRING_AGENT_MAX_TOOL_ROUNDS"),
        ("max_tool_rounds", 5, "HIRING_AGENT_MAX_TOOL_ROUNDS"),
        ("max_tool_rounds", True, "HIRING_AGENT_MAX_TOOL_ROUNDS"),
        ("max_tool_calls_per_round", 0, "HIRING_AGENT_MAX_TOOL_CALLS_PER_ROUND"),
        ("max_tool_calls_per_round", 6, "HIRING_AGENT_MAX_TOOL_CALLS_PER_ROUND"),
        ("max_concurrency", 0, "HIRING_AGENT_MAX_CONCURRENCY"),
        ("max_concurrency", 17, "HIRING_AGENT_MAX_CONCURRENCY"),
        ("max_request_bytes", 4_095, "HIRING_AGENT_MAX_REQUEST_BYTES"),
        ("max_request_bytes", 262_145, "HIRING_AGENT_MAX_REQUEST_BYTES"),
    ],
)
def test_direct_integer_budgets_are_bounded_and_reject_booleans(
    field_name: str,
    value: object,
    environment_name: str,
) -> None:
    with pytest.raises(ValueError, match=environment_name):
        _settings(**{field_name: value})


@pytest.mark.parametrize(
    ("field_name", "value", "environment_name"),
    [
        ("model_timeout_seconds", 4.99, "HIRING_AGENT_MODEL_TIMEOUT_SECONDS"),
        ("model_timeout_seconds", 30.01, "HIRING_AGENT_MODEL_TIMEOUT_SECONDS"),
        ("tool_timeout_seconds", 0, "HIRING_AGENT_TOOL_TIMEOUT_SECONDS"),
        ("tool_timeout_seconds", 30.01, "HIRING_AGENT_TOOL_TIMEOUT_SECONDS"),
        ("tool_timeout_seconds", float("inf"), "HIRING_AGENT_TOOL_TIMEOUT_SECONDS"),
        pytest.param(
            "tool_timeout_seconds",
            10**10_000,
            "HIRING_AGENT_TOOL_TIMEOUT_SECONDS",
            id="huge-integer",
        ),
        ("workflow_timeout_seconds", 9.99, "HIRING_AGENT_TIMEOUT_SECONDS"),
        ("workflow_timeout_seconds", float("nan"), "HIRING_AGENT_TIMEOUT_SECONDS"),
        ("queue_timeout_seconds", 0.09, "HIRING_AGENT_QUEUE_TIMEOUT_SECONDS"),
        ("queue_timeout_seconds", True, "HIRING_AGENT_QUEUE_TIMEOUT_SECONDS"),
    ],
)
def test_direct_float_budgets_are_finite_and_bounded(
    field_name: str,
    value: object,
    environment_name: str,
) -> None:
    with pytest.raises(ValueError, match=environment_name):
        _settings(**{field_name: value})


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("HIRING_AGENT_MAX_TOOL_ROUNDS", "not-an-int-secret"),
        ("HIRING_AGENT_MAX_TOOL_CALLS_PER_ROUND", "1.5"),
        ("HIRING_AGENT_MAX_CONCURRENCY", "nan"),
        ("HIRING_AGENT_MAX_REQUEST_BYTES", "secret-bytes"),
    ],
)
def test_integer_parse_errors_are_sanitized(name: str, value: str) -> None:
    with pytest.raises(ValueError) as error:
        Settings.from_env({name: value})

    assert str(error.value) == f"{name} must be an integer"
    assert error.value.__cause__ is None
    assert error.value.__context__ is None
    assert value not in str(error.value)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("HIRING_AGENT_MODEL_TIMEOUT_SECONDS", "private-number"),
        ("HIRING_AGENT_TOOL_TIMEOUT_SECONDS", "nan"),
        ("HIRING_AGENT_TIMEOUT_SECONDS", "inf"),
        ("HIRING_AGENT_QUEUE_TIMEOUT_SECONDS", "-inf"),
    ],
)
def test_float_parse_and_range_errors_are_sanitized(name: str, value: str) -> None:
    with pytest.raises(ValueError) as error:
        Settings.from_env({name: value})

    assert name in str(error.value)
    assert error.value.__cause__ is None
    assert error.value.__context__ is None
    assert value not in str(error.value)


def test_settings_are_frozen() -> None:
    settings = _settings()

    with pytest.raises(FrozenInstanceError):
        settings.max_tool_rounds = 3  # type: ignore[misc]


@pytest.mark.parametrize(
    ("field_name", "value", "environment_name"),
    [
        (
            "model_timeout_seconds",
            20.0,
            "HIRING_AGENT_MODEL_TIMEOUT_SECONDS",
        ),
        (
            "tool_timeout_seconds",
            20.0,
            "HIRING_AGENT_TOOL_TIMEOUT_SECONDS",
        ),
    ],
)
def test_inner_deadlines_cannot_exceed_the_workflow_deadline(
    field_name: str,
    value: float,
    environment_name: str,
) -> None:
    overrides: dict[str, object] = {
        "workflow_timeout_seconds": 10.0,
        "model_timeout_seconds": 5.0,
        "tool_timeout_seconds": 1.0,
        field_name: value,
    }
    with pytest.raises(ValueError, match=environment_name):
        _settings(**overrides)


def test_queue_and_workflow_deadlines_fit_inside_the_upstream_budget() -> None:
    assert (
        _settings(
            workflow_timeout_seconds=48.0,
            queue_timeout_seconds=1.0,
        ).workflow_timeout_seconds
        == 48.0
    )

    with pytest.raises(ValueError, match="must not exceed 49 seconds"):
        _settings(workflow_timeout_seconds=49.0, queue_timeout_seconds=1.0)
