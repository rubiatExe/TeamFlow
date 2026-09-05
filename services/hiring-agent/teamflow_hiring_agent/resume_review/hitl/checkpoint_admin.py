"""Controlled administration for LangGraph's pinned PostgreSQL checkpoint schema.

This is the only application module allowed to call ``AsyncPostgresSaver.setup()``.
Normal service startup opens an already-migrated schema and never performs DDL.
Database DSNs are accepted from environment variables only and are never rendered in
command output or exception messages.
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import os
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from importlib.metadata import version as distribution_version
from typing import Any
from urllib.parse import urlsplit

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from .checkpointing import (
    CHECKPOINT_MIGRATOR_ROLE,
    CHECKPOINT_RUNTIME_ROLE,
    CHECKPOINT_SCHEMA,
    CHECKPOINT_SEARCH_PATH_OPTION,
    CheckpointConfigurationError,
    strict_checkpoint_serializer,
    validate_checkpoint_dsn,
)

MIGRATION_DSN_ENV = "TEAMFLOW_CHECKPOINT_MIGRATION_DSN"
RUNTIME_DSN_ENV = "TEAMFLOW_CHECKPOINT_DSN"
MIGRATION_OPT_IN_ENV = "TEAMFLOW_CHECKPOINT_MIGRATE"
MIGRATION_OPT_IN_VALUE = "apply-pinned-migrations"

PINNED_CHECKPOINT_PACKAGE_VERSION = "3.1.2"
EXPECTED_MIGRATION_VERSIONS = tuple(range(10))
EXPECTED_CHECKPOINT_TABLES = (
    "checkpoint_blobs",
    "checkpoint_migrations",
    "checkpoint_writes",
    "checkpoints",
)

EXIT_OK = 0
EXIT_NOT_READY = 1
EXIT_CONFIGURATION = 2
EXIT_OPERATIONAL = 3

_SCHEMA_EXISTS_QUERY = "SELECT to_regnamespace(%s) IS NOT NULL AS schema_exists"
_TABLES_QUERY = """
SELECT table_name
FROM information_schema.tables
WHERE table_schema = %s AND table_name = ANY(%s)
ORDER BY table_name
""".strip()
_VERSIONS_QUERY = f"SELECT v FROM {CHECKPOINT_SCHEMA}.checkpoint_migrations ORDER BY v"
_READ_ONLY_OPTION = "-cdefault_transaction_read_only=on"

ConnectionFactory = Callable[..., Awaitable[Any]]


class CheckpointAdminError(RuntimeError):
    """A public, credential-free administration failure."""

    def __init__(self, code: str, *, exit_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


@dataclass(frozen=True, slots=True)
class CheckpointSchemaReport:
    """Credential-free projection of a verified checkpoint schema."""

    schema: str
    migration_versions: tuple[int, ...]
    tables: tuple[str, ...]

    def payload(self, *, status: str) -> dict[str, object]:
        return {
            "migration_versions": list(self.migration_versions),
            "schema": self.schema,
            "status": status,
            "tables": list(self.tables),
        }


def _assert_pinned_saver_contract(saver_type: type[Any]) -> None:
    unavailable = False
    try:
        installed_version = distribution_version("langgraph-checkpoint-postgres")
        migrations = saver_type.MIGRATIONS
    except Exception:
        unavailable = True
        installed_version = ""
        migrations = ()
    if unavailable:
        raise CheckpointAdminError(
            "checkpoint_package_unavailable",
            exit_code=EXIT_CONFIGURATION,
        )
    if installed_version != PINNED_CHECKPOINT_PACKAGE_VERSION:
        raise CheckpointAdminError(
            "checkpoint_package_version_mismatch",
            exit_code=EXIT_CONFIGURATION,
        )
    if tuple(range(len(migrations))) != EXPECTED_MIGRATION_VERSIONS:
        raise CheckpointAdminError(
            "checkpoint_migration_contract_mismatch",
            exit_code=EXIT_CONFIGURATION,
        )


def _validated_admin_dsn(
    dsn: str,
    *,
    production: bool,
    expected_username: str,
) -> str:
    invalid = False
    try:
        validated = validate_checkpoint_dsn(
            dsn,
            production=production,
            expected_username=expected_username if production else None,
        )
    except CheckpointConfigurationError:
        invalid = True
        validated = ""
    if invalid:
        raise CheckpointAdminError(
            "checkpoint_dsn_invalid",
            exit_code=EXIT_CONFIGURATION,
        )
    return validated


async def _connect(
    dsn: str,
    *,
    production: bool,
    read_only: bool,
    expected_username: str,
    connection_factory: ConnectionFactory,
) -> Any:
    validated = _validated_admin_dsn(
        dsn,
        production=production,
        expected_username=expected_username,
    )
    options = CHECKPOINT_SEARCH_PATH_OPTION
    if read_only:
        options = f"{options} {_READ_ONLY_OPTION}"
    failed = False
    try:
        connection = await connection_factory(
            validated,
            autocommit=True,
            prepare_threshold=None,
            row_factory=dict_row,
            options=options,
        )
    except Exception:
        failed = True
        connection = None
    if failed or connection is None:
        raise CheckpointAdminError(
            "checkpoint_connection_failed",
            exit_code=EXIT_OPERATIONAL,
        )
    return connection


async def _close(connection: Any) -> None:
    failed = False
    try:
        await connection.close()
    except Exception:
        failed = True
    if failed:
        raise CheckpointAdminError(
            "checkpoint_connection_close_failed",
            exit_code=EXIT_OPERATIONAL,
        )


async def _schema_exists(connection: Any) -> bool:
    cursor = await connection.execute(_SCHEMA_EXISTS_QUERY, (CHECKPOINT_SCHEMA,))
    row = await cursor.fetchone()
    return bool(row and row.get("schema_exists") is True)


async def _inspect_schema(connection: Any) -> CheckpointSchemaReport:
    failed = False
    try:
        if not await _schema_exists(connection):
            raise CheckpointAdminError(
                "checkpoint_schema_missing",
                exit_code=EXIT_NOT_READY,
            )

        cursor = await connection.execute(
            _TABLES_QUERY,
            (CHECKPOINT_SCHEMA, list(EXPECTED_CHECKPOINT_TABLES)),
        )
        table_rows = await cursor.fetchall()
        tables = tuple(sorted(str(row["table_name"]) for row in table_rows))
        if tables != EXPECTED_CHECKPOINT_TABLES:
            raise CheckpointAdminError(
                "checkpoint_tables_missing",
                exit_code=EXIT_NOT_READY,
            )

        cursor = await connection.execute(_VERSIONS_QUERY)
        version_rows = await cursor.fetchall()
        versions = tuple(int(row["v"]) for row in version_rows)
        if versions != EXPECTED_MIGRATION_VERSIONS:
            raise CheckpointAdminError(
                "checkpoint_migration_versions_incomplete",
                exit_code=EXIT_NOT_READY,
            )
        return CheckpointSchemaReport(
            schema=CHECKPOINT_SCHEMA,
            migration_versions=versions,
            tables=tables,
        )
    except CheckpointAdminError:
        raise
    except Exception:
        failed = True
    if failed:
        raise CheckpointAdminError(
            "checkpoint_schema_inspection_failed",
            exit_code=EXIT_OPERATIONAL,
        )
    raise CheckpointAdminError(
        "checkpoint_schema_inspection_failed",
        exit_code=EXIT_OPERATIONAL,
    )


async def migrate_checkpoint_schema(
    migration_dsn: str,
    *,
    allow_migrate: bool,
    production: bool = True,
    _connection_factory: ConnectionFactory = AsyncConnection.connect,
    _saver_type: type[Any] = AsyncPostgresSaver,
) -> CheckpointSchemaReport:
    """Run the pinned saver migrations from the privileged administration path."""

    if not allow_migrate:
        raise CheckpointAdminError(
            "checkpoint_migration_opt_in_required",
            exit_code=EXIT_CONFIGURATION,
        )
    _assert_pinned_saver_contract(_saver_type)
    connection = await _connect(
        migration_dsn,
        production=production,
        read_only=False,
        expected_username=CHECKPOINT_MIGRATOR_ROLE,
        connection_factory=_connection_factory,
    )
    try:
        if not await _schema_exists(connection):
            raise CheckpointAdminError(
                "checkpoint_schema_missing",
                exit_code=EXIT_NOT_READY,
            )
        migration_failed = False
        try:
            saver = _saver_type(connection, serde=strict_checkpoint_serializer())
            await saver.setup()
        except Exception:
            migration_failed = True
        if migration_failed:
            raise CheckpointAdminError(
                "checkpoint_migration_failed",
                exit_code=EXIT_OPERATIONAL,
            )
        return await _inspect_schema(connection)
    finally:
        await _close(connection)


async def check_checkpoint_schema(
    runtime_dsn: str,
    *,
    production: bool = True,
    _connection_factory: ConnectionFactory = AsyncConnection.connect,
) -> CheckpointSchemaReport:
    """Perform a read-only readiness check using the runtime checkpoint DSN."""

    connection = await _connect(
        runtime_dsn,
        production=production,
        read_only=True,
        expected_username=CHECKPOINT_RUNTIME_ROLE,
        connection_factory=_connection_factory,
    )
    try:
        return await _inspect_schema(connection)
    finally:
        await _close(connection)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="teamflow-checkpoints")
    commands = parser.add_subparsers(dest="command", required=True)
    migrate = commands.add_parser("migrate", help="apply pinned checkpoint migrations")
    migrate.add_argument(
        "--allow-migrate",
        action="store_true",
        help=(
            "explicitly permit migration; alternatively set "
            f"{MIGRATION_OPT_IN_ENV}={MIGRATION_OPT_IN_VALUE}"
        ),
    )
    for command in (migrate, commands.add_parser("check", help="read-only schema check")):
        command.add_argument(
            "--allow-insecure-localhost",
            action="store_true",
            help="permit sslmode=disable only for a loopback development database",
        )
    return parser


def _allows_migration(arguments: argparse.Namespace, environ: Mapping[str, str]) -> bool:
    return bool(
        arguments.allow_migrate or environ.get(MIGRATION_OPT_IN_ENV, "") == MIGRATION_OPT_IN_VALUE
    )


def _production_mode(dsn: str, *, allow_insecure_localhost: bool) -> bool:
    if not allow_insecure_localhost:
        return True
    try:
        host = urlsplit(dsn).hostname
        loopback = host == "localhost" or bool(host and ipaddress.ip_address(host).is_loopback)
    except ValueError:
        loopback = False
    if not loopback:
        raise CheckpointAdminError(
            "insecure_checkpoint_dsn_must_be_loopback",
            exit_code=EXIT_CONFIGURATION,
        )
    return False


async def _run(arguments: argparse.Namespace, environ: Mapping[str, str]) -> dict[str, object]:
    if arguments.command == "migrate":
        dsn = environ.get(MIGRATION_DSN_ENV, "")
        if not dsn:
            raise CheckpointAdminError(
                "checkpoint_migration_dsn_missing",
                exit_code=EXIT_CONFIGURATION,
            )
        report = await migrate_checkpoint_schema(
            dsn,
            allow_migrate=_allows_migration(arguments, environ),
            production=_production_mode(
                dsn,
                allow_insecure_localhost=arguments.allow_insecure_localhost,
            ),
        )
        return report.payload(status="migrated")

    dsn = environ.get(RUNTIME_DSN_ENV, "")
    if not dsn:
        raise CheckpointAdminError(
            "checkpoint_runtime_dsn_missing",
            exit_code=EXIT_CONFIGURATION,
        )
    report = await check_checkpoint_schema(
        dsn,
        production=_production_mode(
            dsn,
            allow_insecure_localhost=arguments.allow_insecure_localhost,
        ),
    )
    return report.payload(status="ready")


def _render(payload: Mapping[str, object]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> int:
    """Run the credential-safe administration CLI."""

    arguments = _parser().parse_args(argv)
    environment = os.environ if environ is None else environ
    try:
        result = asyncio.run(_run(arguments, environment))
    except CheckpointAdminError as exc:
        sys.stderr.write(_render({"code": exc.code, "status": "error"}))
        return exc.exit_code
    except Exception:
        sys.stderr.write(_render({"code": "unexpected_admin_failure", "status": "error"}))
        return EXIT_OPERATIONAL
    sys.stdout.write(_render(result))
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover - exercised through ``main`` tests
    raise SystemExit(main())
