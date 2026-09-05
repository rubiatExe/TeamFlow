"""Process entry point for the tenant-scoped TeamFlow hiring agent."""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Mapping
from types import MappingProxyType
from typing import Any

from fastapi import FastAPI

from teamflow_hiring_agent.composition import (
    TenantScopedHiringRuntime,
    compose_tenant_scoped_runtime,
)
from teamflow_hiring_agent.http_api import (
    HiringHTTPSettings,
    create_hiring_app,
)
from teamflow_hiring_agent.telemetry import setup_telemetry

_DEFAULT_PORT = 8080
_HOST = "0.0.0.0"
_CANONICAL_PORT = re.compile(r"^[1-9][0-9]{0,4}$")


class HiringEntrypointConfigurationError(ValueError):
    """A sanitized process-level configuration failure."""


def _configuration_error() -> HiringEntrypointConfigurationError:
    return HiringEntrypointConfigurationError("hiring_entrypoint_configuration_invalid")


def _environment_snapshot(environ: Mapping[str, str] | None) -> Mapping[str, str]:
    """Copy startup configuration once and make it immutable for all factories."""

    try:
        source = os.environ if environ is None else environ
        if not isinstance(source, Mapping):
            raise TypeError
        snapshot = dict(source)
    except Exception:
        raise _configuration_error() from None
    if any(type(key) is not str or type(value) is not str for key, value in snapshot.items()):
        raise _configuration_error()
    return MappingProxyType(snapshot)


def _port(environ: Mapping[str, str]) -> int:
    """Parse a canonical TCP port without accepting coercions or whitespace."""

    try:
        raw_port = environ.get("PORT")
    except Exception:
        raise _configuration_error() from None
    if raw_port is None:
        return _DEFAULT_PORT
    if type(raw_port) is not str or _CANONICAL_PORT.fullmatch(raw_port) is None:
        raise _configuration_error()
    port = int(raw_port)
    if port > 65_535:
        raise _configuration_error()
    return port


def build_app(
    environ: Mapping[str, str] | None = None,
    *,
    telemetry_initializer: Callable[[Mapping[str, str]], None] = setup_telemetry,
    runtime_factory: Callable[[Mapping[str, str]], TenantScopedHiringRuntime] = (
        compose_tenant_scoped_runtime
    ),
    http_settings_factory: Callable[[Mapping[str, str]], HiringHTTPSettings] = (
        HiringHTTPSettings.from_env
    ),
    application_factory: Callable[..., FastAPI] = create_hiring_app,
) -> FastAPI:
    """Build the ASGI app explicitly in fail-closed dependency order."""

    snapshot = _environment_snapshot(environ)
    telemetry_initializer(snapshot)
    runtime = runtime_factory(snapshot)
    settings = http_settings_factory(snapshot)
    return application_factory(runtime, settings=settings)


def main(
    environ: Mapping[str, str] | None = None,
    *,
    telemetry_initializer: Callable[[Mapping[str, str]], None] = setup_telemetry,
    runtime_factory: Callable[[Mapping[str, str]], TenantScopedHiringRuntime] = (
        compose_tenant_scoped_runtime
    ),
    http_settings_factory: Callable[[Mapping[str, str]], HiringHTTPSettings] = (
        HiringHTTPSettings.from_env
    ),
    application_factory: Callable[..., FastAPI] = create_hiring_app,
    server_runner: Callable[..., Any] | None = None,
) -> None:
    """Validate process configuration, compose the app, and start Uvicorn."""

    snapshot = _environment_snapshot(environ)
    port = _port(snapshot)
    if server_runner is None:
        from uvicorn import run as server_runner

    application = build_app(
        snapshot,
        telemetry_initializer=telemetry_initializer,
        runtime_factory=runtime_factory,
        http_settings_factory=http_settings_factory,
        application_factory=application_factory,
    )
    server_runner(application, host=_HOST, port=port)


if __name__ == "__main__":
    main()
