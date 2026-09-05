from __future__ import annotations

import shutil
import subprocess
import sys
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
    review_workflow = object()
    hitl_runtime = object()
    components = service_main.HiringServiceComponents(
        hiring_runtime=runtime,  # type: ignore[arg-type]
        resume_review_workflow=review_workflow,
        hitl_runtime=hitl_runtime,  # type: ignore[arg-type]
    )
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
        return components

    def read_http_settings(environment: Mapping[str, str]) -> Any:
        events.append("http_settings")
        received_environments.append(environment)
        return settings

    def create_application(
        composed_runtime: Any,
        *,
        settings: Any,
        resume_review_workflow: Any,
        hitl_runtime: Any,
    ) -> Any:
        events.append("application")
        assert composed_runtime is runtime
        assert settings is globals_settings
        assert resume_review_workflow is review_workflow
        assert hitl_runtime is globals_hitl_runtime
        return application

    globals_settings = settings
    globals_hitl_runtime = hitl_runtime
    source = {"ENVIRONMENT": "test", "HIRING_AGENT_TOKEN": "secret"}
    result = service_main.build_app(
        source,
        telemetry_initializer=initialize_telemetry,
        composition_factory=compose,
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
    review_workflow = object()
    hitl_runtime = object()
    components = service_main.HiringServiceComponents(
        hiring_runtime=runtime,  # type: ignore[arg-type]
        resume_review_workflow=review_workflow,
        hitl_runtime=hitl_runtime,  # type: ignore[arg-type]
    )
    settings = object()
    application = object()

    def initialize_telemetry(environment: Mapping[str, str]) -> None:
        events.append("telemetry")
        assert environment["ENVIRONMENT"] == "test"

    def compose(_environment: Mapping[str, str]) -> Any:
        events.append("composition")
        return components

    def read_http_settings(_environment: Mapping[str, str]) -> Any:
        events.append("http_settings")
        return settings

    def create_application(
        composed_runtime: Any,
        *,
        settings: Any,
        resume_review_workflow: Any,
        hitl_runtime: Any,
    ) -> Any:
        events.append("application")
        assert composed_runtime is runtime
        assert settings is globals_settings
        assert resume_review_workflow is review_workflow
        assert hitl_runtime is globals_hitl_runtime
        return application

    def run_server(app: Any, *, host: str, port: int) -> None:
        events.append("server")
        assert app is application
        assert host == "0.0.0.0"
        assert port == 9090

    globals_settings = settings
    globals_hitl_runtime = hitl_runtime
    service_main.main(
        {"PORT": "9090", "ENVIRONMENT": "test"},
        telemetry_initializer=initialize_telemetry,
        composition_factory=compose,
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
    assert "!teamflow_hiring_agent/**" in dockerignore
    assert "teamflow_hiring_agent/resume_review/mcp_server.py" in dockerignore
    for marker in (".env*", "gha-creds-*.json", "cloudbuild*.yaml"):
        assert marker in dockerignore


def test_minimal_container_source_imports_main_and_serves_health(tmp_path: Path) -> None:
    service_root = Path(__file__).resolve().parents[1]
    package_root = service_root / "teamflow_hiring_agent"

    def container_exclusions(directory: str, names: list[str]) -> set[str]:
        excluded = {
            name for name in names if name == "__pycache__" or name.endswith((".pyc", ".pyo"))
        }
        if Path(directory) == package_root:
            excluded.update({"api.py", "evaluation"})
        if Path(directory) == package_root / "resume_review":
            excluded.add("mcp_server.py")
        return excluded

    shutil.copy2(service_root / "main.py", tmp_path / "main.py")
    shutil.copytree(
        package_root,
        tmp_path / "teamflow_hiring_agent",
        ignore=container_exclusions,
    )
    assert not (tmp_path / "teamflow_hiring_agent/resume_review/mcp_server.py").exists()
    exercise = """
import asyncio
import sys

import httpx

sys.path.insert(0, ".")
import main
from teamflow_hiring_agent.composition import TenantScopedHiringRuntime
from teamflow_hiring_agent.config import HumanReviewRuntimeSettings
from teamflow_hiring_agent.resume_review.hitl.runtime import HumanReviewRuntime
from teamflow_hiring_agent.service_composition import HiringServiceComponents


class InertWorkflow:
    async def invoke(self, _request):
        raise AssertionError("health must not invoke a workflow")


review_workflow = InertWorkflow()
components = HiringServiceComponents(
    hiring_runtime=TenantScopedHiringRuntime(
        merchant_id="00000000-0000-0000-0000-000000000001",
        environment="test",
        mock_tools=True,
        workflow=InertWorkflow(),
    ),
    resume_review_workflow=review_workflow,
    hitl_runtime=HumanReviewRuntime(
        HumanReviewRuntimeSettings(),
        analysis_runner=review_workflow,
    ),
)
application = main.build_app(
    {"ENVIRONMENT": "test", "HIRING_AGENT_TOKEN": "test-token"},
    telemetry_initializer=lambda _snapshot: None,
    composition_factory=lambda _snapshot: components,
)
assert "app" not in vars(main)


async def check_health():
    transport = httpx.ASGITransport(app=application)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


asyncio.run(check_health())
"""

    result = subprocess.run(
        [sys.executable, "-I", "-c", exercise],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
