from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

import main as service_main


def test_import_does_not_create_a_global_application_or_server_binding() -> None:
    assert "app" not in vars(service_main)
    assert "uvicorn" not in vars(service_main)


def test_build_app_uses_one_immutable_snapshot_in_fail_closed_order() -> None:
    events: list[str] = []
    received_environments: list[Mapping[str, str]] = []
    runtime = object()
    settings = object()
    application = object()

    def initialize_telemetry(environment: Mapping[str, str]) -> None:
        events.append("telemetry")
        received_environments.append(environment)

    def compose(environment: Mapping[str, str]) -> Any:
        events.append("composition")
        received_environments.append(environment)
        with pytest.raises(TypeError):
            environment["ENVIRONMENT"] = "production"  # type: ignore[index]
        return runtime

    def read_http_settings(environment: Mapping[str, str]) -> Any:
        events.append("http_settings")
        received_environments.append(environment)
        return settings

    def create_application(composed_runtime: Any, *, settings: Any) -> Any:
        events.append("application")
        assert composed_runtime is runtime
        assert settings is globals_settings
        return application

    globals_settings = settings
    source = {"ENVIRONMENT": "test", "HIRING_AGENT_TOKEN": "secret"}
    result = service_main.build_app(
        source,
        telemetry_initializer=initialize_telemetry,
        runtime_factory=compose,
        http_settings_factory=read_http_settings,
        application_factory=create_application,
    )
    source["ENVIRONMENT"] = "production"

    assert result is application
    assert events == ["telemetry", "composition", "http_settings", "application"]
    assert received_environments[0] is received_environments[1]
    assert received_environments[1] is received_environments[2]
    assert received_environments[0]["ENVIRONMENT"] == "test"


@pytest.mark.parametrize(
    ("environment", "expected"),
    [
        ({}, 8080),
        ({"PORT": "1"}, 1),
        ({"PORT": "8080"}, 8080),
        ({"PORT": "65535"}, 65535),
    ],
)
def test_port_accepts_only_canonical_in_range_values(
    environment: Mapping[str, str],
    expected: int,
) -> None:
    assert service_main._port(environment) == expected


@pytest.mark.parametrize(
    "value",
    ["", "0", "00", "01", "+1", "-1", "1.0", " 8080", "8080 ", "65536", "100000"],
)
def test_port_rejects_noncanonical_or_out_of_range_values(value: str) -> None:
    with pytest.raises(
        service_main.HiringEntrypointConfigurationError,
        match="^hiring_entrypoint_configuration_invalid$",
    ):
        service_main._port({"PORT": value})


def test_environment_snapshot_rejects_non_string_values_without_leaking_them() -> None:
    with pytest.raises(
        service_main.HiringEntrypointConfigurationError,
        match="^hiring_entrypoint_configuration_invalid$",
    ) as exc_info:
        service_main._environment_snapshot({"SECRET": object()})  # type: ignore[dict-item]

    assert "SECRET" not in str(exc_info.value)


def test_main_validates_port_before_initializing_dependencies() -> None:
    initialized = False

    def initialize_telemetry(_environment: Mapping[str, str]) -> None:
        nonlocal initialized
        initialized = True

    with pytest.raises(service_main.HiringEntrypointConfigurationError):
        service_main.main(
            {"PORT": "65536"},
            telemetry_initializer=initialize_telemetry,
            server_runner=lambda *_args, **_kwargs: None,
        )

    assert initialized is False


def test_main_runs_the_factory_result_on_the_validated_port() -> None:
    events: list[str] = []
    runtime = object()
    settings = object()
    application = object()

    def initialize_telemetry(environment: Mapping[str, str]) -> None:
        events.append("telemetry")
        assert environment["ENVIRONMENT"] == "test"

    def compose(_environment: Mapping[str, str]) -> Any:
        events.append("composition")
        return runtime

    def read_http_settings(_environment: Mapping[str, str]) -> Any:
        events.append("http_settings")
        return settings

    def create_application(composed_runtime: Any, *, settings: Any) -> Any:
        events.append("application")
        assert composed_runtime is runtime
        assert settings is globals_settings
        return application

    def run_server(app: Any, *, host: str, port: int) -> None:
        events.append("server")
        assert app is application
        assert host == "0.0.0.0"
        assert port == 9090

    globals_settings = settings
    service_main.main(
        {"PORT": "9090", "ENVIRONMENT": "test"},
        telemetry_initializer=initialize_telemetry,
        runtime_factory=compose,
        http_settings_factory=read_http_settings,
        application_factory=create_application,
        server_runner=run_server,
    )

    assert events == ["telemetry", "composition", "http_settings", "application", "server"]


def test_container_uses_a_locked_non_root_exec_entrypoint() -> None:
    service_root = Path(__file__).resolve().parents[1]
    dockerfile = (service_root / "Dockerfile").read_text(encoding="utf-8")
    dockerignore = (service_root / ".dockerignore").read_text(encoding="utf-8")

    assert dockerfile.startswith(
        "FROM python:3.11.16-slim-trixie@sha256:"
        "1042b61448fef4ba92d16a8c7eb4996d027568ce64792a7877fd88511e0af7c6\n"
    )
    assert "--only-binary=:all:" in dockerfile
    assert "--require-hashes" in dockerfile
    assert "COPY --chown=10001:10001" in dockerfile
    assert "USER 10001:10001" in dockerfile
    assert 'CMD ["python", "main.py"]' in dockerfile
    assert "uvicorn main:app" not in dockerfile
    assert dockerignore.startswith("# Send only the production hiring runtime")
    assert "!requirements.lock" in dockerignore
    assert "teamflow_hiring_agent/resume_review/" in dockerignore
