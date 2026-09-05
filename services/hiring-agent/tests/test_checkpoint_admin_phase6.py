"""Static and unit tests for controlled checkpoint-schema administration."""

from __future__ import annotations

import ast
import asyncio
import inspect
from pathlib import Path

import pytest
from psycopg.rows import dict_row

from teamflow_hiring_agent.resume_review.hitl import checkpoint_admin as admin
from teamflow_hiring_agent.resume_review.hitl import checkpointing

MIGRATION_DSN = (
    "postgresql://teamflow_checkpoint_migrator:migration-secret@db.internal/teamflow"
    "?sslmode=verify-full"
)
RUNTIME_DSN = (
    "postgresql://teamflow_checkpoint_runtime:runtime-secret@db.internal/teamflow"
    "?sslmode=verify-full"
)


class FakeCursor:
    def __init__(
        self,
        *,
        row: dict[str, object] | None = None,
        rows: list[dict[str, object]] | None = None,
    ) -> None:
        self._row = row
        self._rows = [] if rows is None else rows

    async def fetchone(self) -> dict[str, object] | None:
        return self._row

    async def fetchall(self) -> list[dict[str, object]]:
        return self._rows


class FakeConnection:
    def __init__(
        self,
        *,
        schema_exists: bool = True,
        tables: tuple[str, ...] = admin.EXPECTED_CHECKPOINT_TABLES,
        versions: tuple[int, ...] = admin.EXPECTED_MIGRATION_VERSIONS,
    ) -> None:
        self.schema_exists = schema_exists
        self.tables = tables
        self.versions = versions
        self.executed: list[tuple[str, object | None]] = []
        self.events: list[str] = []
        self.closed = False

    async def execute(
        self,
        query: str,
        params: object | None = None,
    ) -> FakeCursor:
        self.executed.append((query, params))
        if query == admin._SCHEMA_EXISTS_QUERY:
            return FakeCursor(row={"schema_exists": self.schema_exists})
        if query == admin._TABLES_QUERY:
            return FakeCursor(rows=[{"table_name": table} for table in self.tables])
        if query == admin._VERSIONS_QUERY:
            return FakeCursor(rows=[{"v": version} for version in self.versions])
        raise AssertionError("administration code issued an unexpected query")

    async def close(self) -> None:
        self.closed = True


class RecordingConnectionFactory:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def __call__(self, dsn: str, **kwargs: object) -> FakeConnection:
        self.calls.append((dsn, kwargs))
        return self.connection


class FakeSaver:
    MIGRATIONS = ["migration"] * len(admin.EXPECTED_MIGRATION_VERSIONS)
    instances: list[FakeSaver] = []

    def __init__(self, connection: FakeConnection, *, serde: object) -> None:
        self.connection = connection
        self.serde = serde
        self.setup_calls = 0
        self.__class__.instances.append(self)

    async def setup(self) -> None:
        self.setup_calls += 1
        self.connection.events.append("setup")


def _ready_report() -> admin.CheckpointSchemaReport:
    return admin.CheckpointSchemaReport(
        schema=admin.CHECKPOINT_SCHEMA,
        migration_versions=admin.EXPECTED_MIGRATION_VERSIONS,
        tables=admin.EXPECTED_CHECKPOINT_TABLES,
    )


def test_migrate_uses_privileged_dsn_fixed_path_and_calls_setup_once() -> None:
    FakeSaver.instances.clear()
    connection = FakeConnection()
    factory = RecordingConnectionFactory(connection)

    report = asyncio.run(
        admin.migrate_checkpoint_schema(
            MIGRATION_DSN,
            allow_migrate=True,
            _connection_factory=factory,
            _saver_type=FakeSaver,
        )
    )

    assert report == _ready_report()
    assert len(FakeSaver.instances) == 1
    assert FakeSaver.instances[0].setup_calls == 1
    assert connection.events == ["setup"]
    assert connection.closed is True
    assert factory.calls == [
        (
            MIGRATION_DSN,
            {
                "autocommit": True,
                "prepare_threshold": None,
                "row_factory": dict_row,
                "options": checkpointing.CHECKPOINT_SEARCH_PATH_OPTION,
            },
        )
    ]


def test_migrate_requires_explicit_opt_in_before_connecting() -> None:
    FakeSaver.instances.clear()
    factory = RecordingConnectionFactory(FakeConnection())

    with pytest.raises(admin.CheckpointAdminError) as captured:
        asyncio.run(
            admin.migrate_checkpoint_schema(
                MIGRATION_DSN,
                allow_migrate=False,
                _connection_factory=factory,
                _saver_type=FakeSaver,
            )
        )

    assert captured.value.code == "checkpoint_migration_opt_in_required"
    assert factory.calls == []
    assert FakeSaver.instances == []


def test_check_uses_runtime_dsn_and_enforces_read_only_connection() -> None:
    connection = FakeConnection()
    factory = RecordingConnectionFactory(connection)

    report = asyncio.run(
        admin.check_checkpoint_schema(
            RUNTIME_DSN,
            _connection_factory=factory,
        )
    )

    assert report == _ready_report()
    assert connection.closed is True
    assert factory.calls == [
        (
            RUNTIME_DSN,
            {
                "autocommit": True,
                "prepare_threshold": None,
                "row_factory": dict_row,
                "options": (
                    f"{checkpointing.CHECKPOINT_SEARCH_PATH_OPTION} "
                    "-cdefault_transaction_read_only=on"
                ),
            },
        )
    ]
    assert connection.executed
    assert all(query.lstrip().upper().startswith("SELECT") for query, _ in connection.executed)


@pytest.mark.parametrize(
    ("connection", "expected_code"),
    [
        (
            FakeConnection(schema_exists=False),
            "checkpoint_schema_missing",
        ),
        (
            FakeConnection(tables=("checkpoint_migrations", "checkpoints")),
            "checkpoint_tables_missing",
        ),
        (
            FakeConnection(versions=tuple(range(9))),
            "checkpoint_migration_versions_incomplete",
        ),
        (
            FakeConnection(versions=tuple(range(11))),
            "checkpoint_migration_versions_incomplete",
        ),
    ],
)
def test_check_fails_closed_for_missing_or_unexpected_schema_state(
    connection: FakeConnection,
    expected_code: str,
) -> None:
    with pytest.raises(admin.CheckpointAdminError) as captured:
        asyncio.run(
            admin.check_checkpoint_schema(
                RUNTIME_DSN,
                _connection_factory=RecordingConnectionFactory(connection),
            )
        )

    assert captured.value.code == expected_code
    assert connection.closed is True


def test_migrate_verifies_all_versions_after_setup() -> None:
    FakeSaver.instances.clear()
    connection = FakeConnection(versions=tuple(range(9)))

    with pytest.raises(admin.CheckpointAdminError) as captured:
        asyncio.run(
            admin.migrate_checkpoint_schema(
                MIGRATION_DSN,
                allow_migrate=True,
                _connection_factory=RecordingConnectionFactory(connection),
                _saver_type=FakeSaver,
            )
        )

    assert captured.value.code == "checkpoint_migration_versions_incomplete"
    assert FakeSaver.instances[0].setup_calls == 1
    assert connection.closed is True


def test_migrate_refuses_an_unexpected_package_migration_contract() -> None:
    class DriftedSaver(FakeSaver):
        MIGRATIONS = ["migration"] * 11

    factory = RecordingConnectionFactory(FakeConnection())
    with pytest.raises(admin.CheckpointAdminError) as captured:
        asyncio.run(
            admin.migrate_checkpoint_schema(
                MIGRATION_DSN,
                allow_migrate=True,
                _connection_factory=factory,
                _saver_type=DriftedSaver,
            )
        )

    assert captured.value.code == "checkpoint_migration_contract_mismatch"
    assert factory.calls == []


def test_cli_migrate_accepts_flag_and_only_reads_migration_dsn(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[tuple[str, bool, bool]] = []

    async def fake_migrate(
        dsn: str,
        *,
        allow_migrate: bool,
        production: bool,
    ) -> admin.CheckpointSchemaReport:
        calls.append((dsn, allow_migrate, production))
        return _ready_report()

    monkeypatch.setattr(admin, "migrate_checkpoint_schema", fake_migrate)
    exit_code = admin.main(
        ["migrate", "--allow-migrate"],
        environ={
            admin.MIGRATION_DSN_ENV: MIGRATION_DSN,
            admin.RUNTIME_DSN_ENV: RUNTIME_DSN,
        },
    )

    captured = capsys.readouterr()
    assert exit_code == admin.EXIT_OK
    assert calls == [(MIGRATION_DSN, True, True)]
    assert '"status":"migrated"' in captured.out
    assert "secret" not in captured.out
    assert captured.err == ""


def test_cli_migrate_accepts_exact_environment_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[bool] = []

    async def fake_migrate(
        dsn: str,
        *,
        allow_migrate: bool,
        production: bool,
    ) -> admin.CheckpointSchemaReport:
        del dsn, production
        calls.append(allow_migrate)
        return _ready_report()

    monkeypatch.setattr(admin, "migrate_checkpoint_schema", fake_migrate)
    assert (
        admin.main(
            ["migrate"],
            environ={
                admin.MIGRATION_DSN_ENV: MIGRATION_DSN,
                admin.MIGRATION_OPT_IN_ENV: admin.MIGRATION_OPT_IN_VALUE,
            },
        )
        == admin.EXIT_OK
    )
    assert calls == [True]


def test_cli_check_only_reads_runtime_dsn(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[tuple[str, bool]] = []

    async def fake_check(
        dsn: str,
        *,
        production: bool,
    ) -> admin.CheckpointSchemaReport:
        calls.append((dsn, production))
        return _ready_report()

    monkeypatch.setattr(admin, "check_checkpoint_schema", fake_check)
    exit_code = admin.main(
        ["check"],
        environ={
            admin.MIGRATION_DSN_ENV: MIGRATION_DSN,
            admin.RUNTIME_DSN_ENV: RUNTIME_DSN,
        },
    )

    captured = capsys.readouterr()
    assert exit_code == admin.EXIT_OK
    assert calls == [(RUNTIME_DSN, True)]
    assert '"status":"ready"' in captured.out
    assert "secret" not in captured.out
    assert captured.err == ""


def test_cli_allows_insecure_dsn_only_for_loopback(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    local_dsn = "postgresql://checkpoint:local-secret@127.0.0.1/teamflow?sslmode=disable"
    production_values: list[bool] = []

    async def fake_check(
        dsn: str,
        *,
        production: bool,
    ) -> admin.CheckpointSchemaReport:
        del dsn
        production_values.append(production)
        return _ready_report()

    monkeypatch.setattr(admin, "check_checkpoint_schema", fake_check)
    assert (
        admin.main(
            ["check", "--allow-insecure-localhost"],
            environ={admin.RUNTIME_DSN_ENV: local_dsn},
        )
        == admin.EXIT_OK
    )
    capsys.readouterr()
    assert production_values == [False]

    remote_dsn = "postgresql://checkpoint:remote-secret@db.internal/teamflow?sslmode=disable"
    assert (
        admin.main(
            ["check", "--allow-insecure-localhost"],
            environ={admin.RUNTIME_DSN_ENV: remote_dsn},
        )
        == admin.EXIT_CONFIGURATION
    )
    captured = capsys.readouterr()
    assert "remote-secret" not in captured.err
    assert "db.internal" not in captured.err


def test_cli_never_renders_database_exception_or_password(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    async def failing_check(
        dsn: str,
        *,
        production: bool,
    ) -> admin.CheckpointSchemaReport:
        del production
        raise RuntimeError(f"database error exposed {dsn}")

    monkeypatch.setattr(admin, "check_checkpoint_schema", failing_check)
    exit_code = admin.main(
        ["check"],
        environ={admin.RUNTIME_DSN_ENV: RUNTIME_DSN},
    )

    captured = capsys.readouterr()
    assert exit_code == admin.EXIT_OPERATIONAL
    assert captured.out == ""
    assert "runtime-secret" not in captured.err
    assert "database error" not in captured.err
    assert captured.err == '{"code":"unexpected_admin_failure","status":"error"}\n'


def test_setup_call_is_isolated_to_checkpoint_admin_module() -> None:
    package_root = Path(admin.__file__).parents[2]
    setup_calls: dict[str, list[int]] = {}
    for source_path in package_root.rglob("*.py"):
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        lines = [
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "setup"
        ]
        if lines:
            setup_calls[str(source_path.relative_to(package_root))] = lines

    assert set(setup_calls) == {"resume_review/hitl/checkpoint_admin.py"}
    assert len(setup_calls["resume_review/hitl/checkpoint_admin.py"]) == 1


def test_runtime_pool_also_forces_the_checkpoint_search_path() -> None:
    source = inspect.getsource(checkpointing.open_postgres_checkpointer)
    assert '"options": CHECKPOINT_SEARCH_PATH_OPTION' in source
    assert ".setup(" not in source


def test_checkpoint_dependency_and_ci_postgres_are_pinned() -> None:
    service_root = Path(admin.__file__).parents[3]
    requirements = (service_root / "requirements.txt").read_text(encoding="utf-8")
    assert "langgraph-checkpoint-postgres==3.1.2" in requirements
    assert "psycopg[binary]==3.3.4" in requirements
    assert "psycopg-pool==3.3.1" in requirements

    repository_root = service_root.parents[1]
    ci = (repository_root / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    assert "image: postgres:16" in ci
    assert "TEST_POSTGRES_DSN:" in ci
