"""Real PostgreSQL restart gate for the durable Phase 6 HITL lifecycle.

This test deliberately uses fresh spawned interpreters. Process A creates a review
and exits while the graph is interrupted. Process B reconstructs the graph from the
PostgreSQL checkpoint and applies a decision. Process C reconstructs it once more
and proves an exact decision replay is a no-op.

The test is opt-in because it creates isolated test-support tables and applies the
pinned LangGraph checkpoint migrations. Set ``TEST_POSTGRES_DSN`` to a loopback
PostgreSQL database to run it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import multiprocessing
import os
import queue as queue_module
import uuid
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import pytest
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from teamflow_hiring_agent.resume_review.hitl.checkpoint_admin import (
    EXPECTED_CHECKPOINT_TABLES,
    EXPECTED_MIGRATION_VERSIONS,
    check_checkpoint_schema,
    migrate_checkpoint_schema,
)
from teamflow_hiring_agent.resume_review.hitl.checkpointing import (
    CHECKPOINT_SCHEMA,
    open_postgres_checkpointer,
    stable_thread_id,
    validate_checkpoint_dsn,
)
from teamflow_hiring_agent.resume_review.hitl.lifecycle import (
    AppliedDecision,
    CreatedReview,
    HumanReviewLifecycleRunner,
)

_EFFECT_SCHEMA = "teamflow_phase6_restart_test"
_PROCESS_TIMEOUT_SECONDS = 45

_PRIVATE_CANARIES = (
    "PRIVATE_CANDIDATE_NAME_CANARY",
    "candidate-canary@example.invalid",
    "+1-202-555-0199",
    "RAW_RESUME_TEXT_CANARY",
    "SYSTEM_PROMPT_CANARY",
    "JVBERi0xLjQK_PDF_BASE64_CANARY",
)
_FORBIDDEN_CHECKPOINT_KEYS = (
    "candidate_name",
    "email",
    "exact_quote",
    "messages",
    "pdf_base64",
    "phone",
    "private_payload",
    "raw_pdf",
    "resume_text",
    "source_blocks",
    "system_prompt",
)

_EFFECT_DDL = f"""
CREATE SCHEMA IF NOT EXISTS {_EFFECT_SCHEMA};

CREATE TABLE IF NOT EXISTS {_EFFECT_SCHEMA}.reviews (
    workflow_id UUID PRIMARY KEY,
    merchant_id UUID NOT NULL,
    request_id UUID NOT NULL,
    request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    analysis_run_id UUID NOT NULL,
    review_id UUID NOT NULL UNIQUE,
    review_version INTEGER NOT NULL CHECK (review_version >= 1),
    status TEXT NOT NULL,
    reason_codes JSONB NOT NULL,
    private_payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS {_EFFECT_SCHEMA}.decisions (
    decision_id UUID PRIMARY KEY,
    workflow_id UUID NOT NULL UNIQUE
        REFERENCES {_EFFECT_SCHEMA}.reviews(workflow_id) ON DELETE CASCADE,
    review_id UUID NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS {_EFFECT_SCHEMA}.events (
    workflow_id UUID NOT NULL
        REFERENCES {_EFFECT_SCHEMA}.reviews(workflow_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    PRIMARY KEY (workflow_id, event_type)
);

CREATE TABLE IF NOT EXISTS {_EFFECT_SCHEMA}.candidate_revisions (
    workflow_id UUID PRIMARY KEY
        REFERENCES {_EFFECT_SCHEMA}.reviews(workflow_id) ON DELETE CASCADE,
    review_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS {_EFFECT_SCHEMA}.candidate_effects (
    workflow_id UUID PRIMARY KEY
        REFERENCES {_EFFECT_SCHEMA}.reviews(workflow_id) ON DELETE CASCADE,
    mutation_count INTEGER NOT NULL DEFAULT 0 CHECK (mutation_count BETWEEN 0 AND 1)
);
"""


def _private_payload() -> dict[str, object]:
    return {
        "candidate_name": _PRIVATE_CANARIES[0],
        "email": _PRIVATE_CANARIES[1],
        "phone": _PRIVATE_CANARIES[2],
        "resume_text": _PRIVATE_CANARIES[3],
        "system_prompt": _PRIVATE_CANARIES[4],
        "pdf_base64": _PRIVATE_CANARIES[5],
    }


def _new_ids() -> dict[str, str]:
    return {
        "merchant_id": str(uuid.uuid4()),
        "request_id": str(uuid.uuid4()),
        "workflow_id": str(uuid.uuid4()),
        "analysis_run_id": str(uuid.uuid4()),
        "review_id": str(uuid.uuid4()),
        "decision_id": str(uuid.uuid4()),
        "request_sha256": uuid.uuid4().hex + uuid.uuid4().hex,
    }


def _require_loopback_test_dsn() -> str:
    dsn = os.environ.get("TEST_POSTGRES_DSN", "")
    if not dsn:
        pytest.skip("TEST_POSTGRES_DSN is required for the PostgreSQL restart gate")
    validate_checkpoint_dsn(dsn, production=False)
    host = urlsplit(dsn).hostname
    try:
        is_loopback = host == "localhost" or bool(host and ipaddress.ip_address(host).is_loopback)
    except ValueError:
        is_loopback = False
    if not is_loopback:
        pytest.fail("TEST_POSTGRES_DSN must target a loopback test database")
    return dsn


async def _open_connection(
    dsn: str,
    *,
    autocommit: bool,
) -> AsyncConnection[dict[str, Any]]:
    return await AsyncConnection.connect(
        dsn,
        autocommit=autocommit,
        prepare_threshold=None,
        row_factory=dict_row,
    )


async def _prepare_database(dsn: str) -> None:
    connection = await _open_connection(dsn, autocommit=True)
    try:
        await connection.execute(f"CREATE SCHEMA IF NOT EXISTS {CHECKPOINT_SCHEMA}")
        await connection.execute(_EFFECT_DDL)
    finally:
        await connection.close()

    migrated = await migrate_checkpoint_schema(
        dsn,
        allow_migrate=True,
        production=False,
    )
    assert migrated.tables == EXPECTED_CHECKPOINT_TABLES
    assert migrated.migration_versions == EXPECTED_MIGRATION_VERSIONS
    ready = await check_checkpoint_schema(dsn, production=False)
    assert ready == migrated


class _PostgresEffectRepository:
    """Small database-backed test adapter with idempotent, atomic side effects."""

    def __init__(self, dsn: str, ids: Mapping[str, str]) -> None:
        self._dsn = dsn
        self._ids = dict(ids)

    async def create_review(
        self,
        *,
        workflow_id: str,
        merchant_id: str,
        request_id: str,
        request_sha256: str,
        analysis_run_id: str,
        reason_codes: tuple[str, ...],
    ) -> CreatedReview:
        if (
            workflow_id != self._ids["workflow_id"]
            or merchant_id != self._ids["merchant_id"]
            or request_id != self._ids["request_id"]
            or request_sha256 != self._ids["request_sha256"]
            or analysis_run_id != self._ids["analysis_run_id"]
        ):
            raise RuntimeError("restart_test_identity_mismatch")

        connection = await _open_connection(self._dsn, autocommit=True)
        try:
            cursor = await connection.execute(
                f"""
                INSERT INTO {_EFFECT_SCHEMA}.reviews (
                    workflow_id,
                    merchant_id,
                    request_id,
                    request_sha256,
                    analysis_run_id,
                    review_id,
                    review_version,
                    status,
                    reason_codes,
                    private_payload
                )
                VALUES (
                    %s::uuid,
                    %s::uuid,
                    %s::uuid,
                    %s,
                    %s::uuid,
                    %s::uuid,
                    1,
                    'pending_review',
                    %s::jsonb,
                    %s::jsonb
                )
                ON CONFLICT (workflow_id) DO NOTHING
                RETURNING
                    merchant_id,
                    request_id,
                    request_sha256,
                    analysis_run_id,
                    review_id,
                    review_version,
                    status
                """,
                (
                    workflow_id,
                    merchant_id,
                    request_id,
                    request_sha256,
                    analysis_run_id,
                    self._ids["review_id"],
                    json.dumps(list(reason_codes)),
                    json.dumps(_private_payload()),
                ),
            )
            row = await cursor.fetchone()
            replayed = row is None
            if row is None:
                cursor = await connection.execute(
                    f"""
                    SELECT
                        merchant_id,
                        request_id,
                        request_sha256,
                        analysis_run_id,
                        review_id,
                        review_version,
                        status
                    FROM {_EFFECT_SCHEMA}.reviews
                    WHERE workflow_id = %s::uuid
                    """,
                    (workflow_id,),
                )
                row = await cursor.fetchone()
            if row is None:
                raise RuntimeError("restart_test_review_missing")
            if (
                str(row["merchant_id"]) != merchant_id
                or str(row["request_id"]) != request_id
                or row["request_sha256"] != request_sha256
                or str(row["analysis_run_id"]) != analysis_run_id
            ):
                raise RuntimeError("restart_test_idempotency_conflict")
            if not replayed:
                await connection.execute(
                    f"""
                    INSERT INTO {_EFFECT_SCHEMA}.candidate_effects (
                        workflow_id,
                        mutation_count
                    ) VALUES (%s::uuid, 0)
                    """,
                    (workflow_id,),
                )
            return CreatedReview(
                review_id=str(row["review_id"]),
                review_version=int(row["review_version"]),
                status=row["status"],
                replayed=replayed,
            )
        finally:
            await connection.close()

    async def apply_decision(
        self,
        *,
        workflow_id: str,
        merchant_id: str,
        review_id: str,
        expected_review_version: int,
        decision_id: str,
    ) -> AppliedDecision:
        connection = await _open_connection(self._dsn, autocommit=False)
        try:
            async with connection.transaction():
                cursor = await connection.execute(
                    f"""
                    SELECT merchant_id, review_id, review_version, status
                    FROM {_EFFECT_SCHEMA}.reviews
                    WHERE workflow_id = %s::uuid
                    FOR UPDATE
                    """,
                    (workflow_id,),
                )
                review = await cursor.fetchone()
                if review is None:
                    raise RuntimeError("restart_test_review_missing")
                if (
                    str(review["merchant_id"]) != merchant_id
                    or str(review["review_id"]) != review_id
                ):
                    raise RuntimeError("restart_test_review_scope_mismatch")

                cursor = await connection.execute(
                    f"""
                    SELECT decision_id, status
                    FROM {_EFFECT_SCHEMA}.decisions
                    WHERE workflow_id = %s::uuid
                    """,
                    (workflow_id,),
                )
                existing = await cursor.fetchone()
                if existing is not None:
                    if str(existing["decision_id"]) != decision_id:
                        raise RuntimeError("restart_test_decision_conflict")
                    return AppliedDecision(
                        review_version=int(review["review_version"]),
                        status=existing["status"],
                        replayed=True,
                    )

                if int(review["review_version"]) != expected_review_version:
                    raise RuntimeError("restart_test_stale_review")
                if review["status"] != "pending_review":
                    raise RuntimeError("restart_test_review_not_pending")

                await connection.execute(
                    f"""
                    INSERT INTO {_EFFECT_SCHEMA}.decisions (
                        decision_id,
                        workflow_id,
                        review_id,
                        status
                    ) VALUES (%s::uuid, %s::uuid, %s::uuid, 'approved')
                    """,
                    (decision_id, workflow_id, review_id),
                )
                cursor = await connection.execute(
                    f"""
                    UPDATE {_EFFECT_SCHEMA}.reviews
                    SET review_version = review_version + 1,
                        status = 'approved'
                    WHERE workflow_id = %s::uuid
                      AND review_version = %s
                      AND status = 'pending_review'
                    RETURNING review_version
                    """,
                    (workflow_id, expected_review_version),
                )
                updated = await cursor.fetchone()
                if updated is None:
                    raise RuntimeError("restart_test_guarded_update_failed")
                await connection.execute(
                    f"""
                    INSERT INTO {_EFFECT_SCHEMA}.events (workflow_id, event_type)
                    VALUES (%s::uuid, 'decision_applied')
                    """,
                    (workflow_id,),
                )
                await connection.execute(
                    f"""
                    INSERT INTO {_EFFECT_SCHEMA}.candidate_revisions (
                        workflow_id,
                        review_version
                    ) VALUES (%s::uuid, %s)
                    """,
                    (workflow_id, int(updated["review_version"])),
                )
                cursor = await connection.execute(
                    f"""
                    UPDATE {_EFFECT_SCHEMA}.candidate_effects
                    SET mutation_count = mutation_count + 1
                    WHERE workflow_id = %s::uuid
                      AND mutation_count = 0
                    """,
                    (workflow_id,),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError("restart_test_candidate_update_not_once")
                return AppliedDecision(
                    review_version=int(updated["review_version"]),
                    status="approved",
                    replayed=False,
                )
        finally:
            await connection.close()


async def _worker_scenario(
    action: str,
    dsn: str,
    ids: Mapping[str, str],
) -> dict[str, object]:
    repository = _PostgresEffectRepository(dsn, ids)
    async with open_postgres_checkpointer(
        dsn,
        production=False,
        min_pool_size=1,
        max_pool_size=1,
    ) as checkpointer:
        runner = HumanReviewLifecycleRunner(repository, checkpointer=checkpointer)
        config = runner.config(
            merchant_id=ids["merchant_id"],
            request_id=ids["request_id"],
        )
        if action == "start":
            result = await runner.start(
                {
                    "schema_version": "1.0",
                    "workflow_id": ids["workflow_id"],
                    "merchant_id": ids["merchant_id"],
                    "request_id": ids["request_id"],
                    "request_sha256": ids["request_sha256"],
                    "analysis_run_id": ids["analysis_run_id"],
                    "reason_codes": [
                        "low_confidence",
                        "critical_field_disagreement",
                    ],
                }
            )
            interrupts = result.get("__interrupt__", [])
            if len(interrupts) != 1:
                raise RuntimeError("restart_test_interrupt_missing")
            snapshot = await runner.graph.aget_state(config)
            return {
                "action": action,
                "interrupt": interrupts[0].value,
                "next": list(snapshot.next),
                "review_status": result["review_status"],
                "review_version": result["review_version"],
            }

        if action not in {"resume", "replay"}:
            raise RuntimeError("restart_test_action_invalid")
        result = await runner.resume(
            merchant_id=ids["merchant_id"],
            request_id=ids["request_id"],
            decision={"decision_id": ids["decision_id"]},
        )
        snapshot = await runner.graph.aget_state(config)
        return {
            "action": action,
            "decision_applied": result["decision_applied"],
            "decision_id": result["decision_id"],
            "next": list(snapshot.next),
            "review_status": result["review_status"],
            "review_version": result["review_version"],
        }


def _worker_entry(
    action: str,
    dsn: str,
    ids: Mapping[str, str],
    output: Any,
) -> None:
    try:
        result = asyncio.run(_worker_scenario(action, dsn, ids))
    except Exception as exc:
        output.put(
            {
                "error_key": str(exc) if isinstance(exc, KeyError) else None,
                "error_type": type(exc).__name__,
                "ok": False,
                "pid": os.getpid(),
            }
        )
        return
    output.put(
        {
            "ok": True,
            "pid": os.getpid(),
            "result": result,
            "strict_msgpack": os.environ.get("LANGGRAPH_STRICT_MSGPACK"),
        }
    )


def _spawn_worker(action: str, dsn: str, ids: Mapping[str, str]) -> dict[str, object]:
    context = multiprocessing.get_context("spawn")
    output = context.Queue(maxsize=1)
    process = context.Process(
        target=_worker_entry,
        args=(action, dsn, dict(ids), output),
        name=f"phase6-hitl-{action}",
    )
    process.start()
    process.join(_PROCESS_TIMEOUT_SECONDS)
    if process.is_alive():
        process.terminate()
        process.join(5)
        pytest.fail(f"{action} process exceeded the restart-test timeout")
    exit_code = process.exitcode
    try:
        message = output.get(timeout=5)
    except queue_module.Empty:
        pytest.fail(f"{action} process produced no result (exit code {process.exitcode})")
    finally:
        output.close()
        output.join_thread()
        process.close()
    assert message["ok"] is True, message
    assert exit_code == 0
    return message


async def _assert_exact_effects_and_checkpoint_privacy(
    dsn: str,
    ids: Mapping[str, str],
) -> None:
    connection = await _open_connection(dsn, autocommit=True)
    thread_id = stable_thread_id(
        merchant_id=ids["merchant_id"],
        request_id=ids["request_id"],
    )
    try:
        cursor = await connection.execute(
            f"""
            SELECT
                review_id,
                review_version,
                status,
                private_payload
            FROM {_EFFECT_SCHEMA}.reviews
            WHERE workflow_id = %s::uuid
            """,
            (ids["workflow_id"],),
        )
        review = await cursor.fetchone()
        assert review is not None
        assert str(review["review_id"]) == ids["review_id"]
        assert review["review_version"] == 2
        assert review["status"] == "approved"
        private_serialized = json.dumps(review["private_payload"], sort_keys=True)
        for canary in _PRIVATE_CANARIES:
            assert canary in private_serialized

        cursor = await connection.execute(
            f"""
            SELECT decision_id, review_id, status
            FROM {_EFFECT_SCHEMA}.decisions
            WHERE workflow_id = %s::uuid
            """,
            (ids["workflow_id"],),
        )
        assert await cursor.fetchall() == [
            {
                "decision_id": uuid.UUID(ids["decision_id"]),
                "review_id": uuid.UUID(ids["review_id"]),
                "status": "approved",
            }
        ]

        count_queries = {
            "events": f"SELECT count(*) AS count FROM {_EFFECT_SCHEMA}.events "
            "WHERE workflow_id = %s::uuid",
            "candidate_revisions": (
                f"SELECT count(*) AS count FROM {_EFFECT_SCHEMA}.candidate_revisions "
                "WHERE workflow_id = %s::uuid"
            ),
        }
        for query in count_queries.values():
            cursor = await connection.execute(query, (ids["workflow_id"],))
            row = await cursor.fetchone()
            assert row == {"count": 1}

        cursor = await connection.execute(
            f"""
            SELECT mutation_count
            FROM {_EFFECT_SCHEMA}.candidate_effects
            WHERE workflow_id = %s::uuid
            """,
            (ids["workflow_id"],),
        )
        assert await cursor.fetchone() == {"mutation_count": 1}

        checkpoint_queries = (
            f"""
            SELECT checkpoint::text AS checkpoint, metadata::text AS metadata
            FROM {CHECKPOINT_SCHEMA}.checkpoints
            WHERE thread_id = %s
            """,
            f"""
            SELECT channel, type, blob
            FROM {CHECKPOINT_SCHEMA}.checkpoint_blobs
            WHERE thread_id = %s
            """,
            f"""
            SELECT channel, type, blob, task_path
            FROM {CHECKPOINT_SCHEMA}.checkpoint_writes
            WHERE thread_id = %s
            """,
        )
        raw_values: list[bytes] = []
        row_counts: list[int] = []
        for query in checkpoint_queries:
            cursor = await connection.execute(query, (thread_id,))
            rows = await cursor.fetchall()
            row_counts.append(len(rows))
            for row in rows:
                for value in row.values():
                    if isinstance(value, bytes):
                        raw_values.append(value)
                    else:
                        raw_values.append(str(value).encode())

        assert all(count > 0 for count in row_counts)
        serialized_checkpoint_rows = b"\n".join(raw_values)
        for canary in _PRIVATE_CANARIES:
            assert canary.encode() not in serialized_checkpoint_rows
        for forbidden_key in _FORBIDDEN_CHECKPOINT_KEYS:
            assert forbidden_key.encode() not in serialized_checkpoint_rows
    finally:
        await connection.close()


async def _cleanup_run(dsn: str, ids: Mapping[str, str]) -> None:
    connection = await _open_connection(dsn, autocommit=True)
    thread_id = stable_thread_id(
        merchant_id=ids["merchant_id"],
        request_id=ids["request_id"],
    )
    try:
        await connection.execute(
            f"DELETE FROM {_EFFECT_SCHEMA}.reviews WHERE workflow_id = %s::uuid",
            (ids["workflow_id"],),
        )
        await connection.execute(
            f"DELETE FROM {CHECKPOINT_SCHEMA}.checkpoint_writes WHERE thread_id = %s",
            (thread_id,),
        )
        await connection.execute(
            f"DELETE FROM {CHECKPOINT_SCHEMA}.checkpoint_blobs WHERE thread_id = %s",
            (thread_id,),
        )
        await connection.execute(
            f"DELETE FROM {CHECKPOINT_SCHEMA}.checkpoints WHERE thread_id = %s",
            (thread_id,),
        )
    finally:
        await connection.close()


def test_postgres_checkpoint_survives_process_restart_and_replay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dsn = _require_loopback_test_dsn()
    ids = _new_ids()
    monkeypatch.setenv("LANGGRAPH_STRICT_MSGPACK", "true")
    asyncio.run(_prepare_database(dsn))
    try:
        started = _spawn_worker("start", dsn, ids)
        assert started["result"] == {
            "action": "start",
            "interrupt": {
                "schema_version": "1.0",
                "workflow_id": ids["workflow_id"],
                "review_id": ids["review_id"],
                "review_version": 1,
                "status": "pending_review",
            },
            "next": ["await_decision"],
            "review_status": "pending_review",
            "review_version": 1,
        }

        resumed = _spawn_worker("resume", dsn, ids)
        replayed = _spawn_worker("replay", dsn, ids)
        expected_terminal = {
            "decision_applied": True,
            "decision_id": ids["decision_id"],
            "next": [],
            "review_status": "approved",
            "review_version": 2,
        }
        assert resumed["result"] == {"action": "resume", **expected_terminal}
        assert replayed["result"] == {"action": "replay", **expected_terminal}

        workers = (started, resumed, replayed)
        assert all(worker["strict_msgpack"] == "true" for worker in workers)
        process_ids = {worker["pid"] for worker in workers}
        assert len(process_ids) == 3
        assert os.getpid() not in process_ids

        asyncio.run(_assert_exact_effects_and_checkpoint_privacy(dsn, ids))
    finally:
        asyncio.run(_cleanup_run(dsn, ids))
