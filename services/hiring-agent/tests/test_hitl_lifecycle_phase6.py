"""Component tests for the privacy-minimized Phase 6 HITL lifecycle.

``InMemorySaver`` is intentionally used only as a non-production component-test
double. Production wiring must use the PostgreSQL saver from ``checkpointing``;
restart durability requires the PostgreSQL integration test owned by that wiring.
"""

from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Mapping
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from pydantic import ValidationError

from teamflow_hiring_agent.resume_review.hitl import checkpointing, lifecycle
from teamflow_hiring_agent.resume_review.hitl.checkpointing import (
    CheckpointConfigurationError,
    checkpoint_config,
    stable_thread_id,
    strict_checkpoint_serializer,
    validate_checkpoint_dsn,
)
from teamflow_hiring_agent.resume_review.hitl.lifecycle import (
    AppliedDecision,
    CreatedReview,
    HumanReviewLifecycleRunner,
    LifecycleStart,
    state_contains_only_json_values,
)

MERCHANT_ID = "11111111-1111-4111-8111-111111111111"
REQUEST_ID = "22222222-2222-4222-8222-222222222222"
WORKFLOW_ID = "33333333-3333-4333-8333-333333333333"
ANALYSIS_RUN_ID = "44444444-4444-4444-8444-444444444444"
REVIEW_ID = "55555555-5555-4555-8555-555555555555"
APPROVE_DECISION_ID = "66666666-6666-4666-8666-666666666666"
REJECT_DECISION_ID = "77777777-7777-4777-8777-777777777777"
REQUEST_SHA256 = "a" * 64

PRIVATE_CANARIES = (
    "PRIVATE_CANDIDATE_NAME_CANARY",
    "candidate-canary@example.invalid",
    "+1-202-555-0199",
    "RAW_RESUME_TEXT_CANARY",
    "SYSTEM_PROMPT_CANARY",
    "JVBERi0xLjQK_PDF_BASE64_CANARY",
)


def _start_value() -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "workflow_id": WORKFLOW_ID,
        "merchant_id": MERCHANT_ID,
        "request_id": REQUEST_ID,
        "request_sha256": REQUEST_SHA256,
        "analysis_run_id": ANALYSIS_RUN_ID,
        "reason_codes": ["low_confidence", "critical_field_disagreement"],
    }


def _component_checkpointer() -> InMemorySaver:
    """Return the strict, non-production checkpointer used only in these tests."""

    return InMemorySaver(serde=strict_checkpoint_serializer())


class RecordingRepository:
    """An idempotent repository double whose private record never enters graph state."""

    def __init__(self) -> None:
        self.private_record = {
            "resume_text": PRIVATE_CANARIES[3],
            "contact": PRIVATE_CANARIES[:3],
            "prompt": PRIVATE_CANARIES[4],
            "pdf_base64": PRIVATE_CANARIES[5],
        }
        self.create_calls: list[dict[str, object]] = []
        self.create_effects = 0
        self.apply_calls: list[dict[str, object]] = []
        self.apply_effects = 0
        self._created_keys: set[tuple[str, str]] = set()
        self._applied_decisions: set[str] = set()

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
        call = {
            "workflow_id": workflow_id,
            "merchant_id": merchant_id,
            "request_id": request_id,
            "request_sha256": request_sha256,
            "analysis_run_id": analysis_run_id,
            "reason_codes": reason_codes,
        }
        self.create_calls.append(call)
        key = (merchant_id, workflow_id)
        replayed = key in self._created_keys
        if not replayed:
            self._created_keys.add(key)
            self.create_effects += 1
        return CreatedReview(
            review_id=REVIEW_ID,
            review_version=1,
            status="pending_review",
            replayed=replayed,
        )

    async def apply_decision(
        self,
        *,
        workflow_id: str,
        merchant_id: str,
        review_id: str,
        expected_review_version: int,
        decision_id: str,
    ) -> AppliedDecision:
        call = {
            "workflow_id": workflow_id,
            "merchant_id": merchant_id,
            "review_id": review_id,
            "expected_review_version": expected_review_version,
            "decision_id": decision_id,
        }
        self.apply_calls.append(call)
        replayed = decision_id in self._applied_decisions
        if not replayed:
            self._applied_decisions.add(decision_id)
            self.apply_effects += 1
        statuses = {
            APPROVE_DECISION_ID: "approved",
            REJECT_DECISION_ID: "rejected",
        }
        return AppliedDecision(
            review_version=expected_review_version + 1,
            status=statuses[decision_id],
            replayed=replayed,
        )


@pytest.mark.parametrize(
    ("decision_id", "expected_status"),
    [
        (APPROVE_DECISION_ID, "approved"),
        (REJECT_DECISION_ID, "rejected"),
    ],
)
def test_create_once_interrupt_reruns_and_repository_applies_decision(
    monkeypatch: pytest.MonkeyPatch,
    decision_id: str,
    expected_status: str,
) -> None:
    repository = RecordingRepository()
    saver = _component_checkpointer()
    runner = HumanReviewLifecycleRunner(repository, checkpointer=saver)
    interrupt_payloads: list[object] = []
    real_interrupt = lifecycle.interrupt

    def counted_interrupt(value: object) -> object:
        interrupt_payloads.append(value)
        return real_interrupt(value)

    monkeypatch.setattr(lifecycle, "interrupt", counted_interrupt)

    async def scenario() -> None:
        started = await runner.start(_start_value())
        assert len(started["__interrupt__"]) == 1
        assert started["__interrupt__"][0].value == {
            "schema_version": "1.0",
            "workflow_id": WORKFLOW_ID,
            "review_id": REVIEW_ID,
            "review_version": 1,
            "status": "pending_review",
        }
        config = runner.config(merchant_id=MERCHANT_ID, request_id=REQUEST_ID)
        pending = await runner.graph.aget_state(config)
        assert pending.next == ("await_decision",)

        completed = await runner.resume(
            merchant_id=MERCHANT_ID,
            request_id=REQUEST_ID,
            decision={"decision_id": decision_id},
        )
        assert completed["review_status"] == expected_status
        assert completed["review_version"] == 2
        assert completed["decision_applied"] is True
        assert state_contains_only_json_values(completed)

    asyncio.run(scenario())

    assert len(repository.create_calls) == 1
    assert repository.create_effects == 1
    assert len(interrupt_payloads) == 2
    assert interrupt_payloads[0] == interrupt_payloads[1]
    assert repository.apply_calls == [
        {
            "workflow_id": WORKFLOW_ID,
            "merchant_id": MERCHANT_ID,
            "review_id": REVIEW_ID,
            "expected_review_version": 1,
            "decision_id": decision_id,
        }
    ]
    assert repository.apply_effects == 1


@pytest.mark.parametrize(
    "invalid_decision",
    [
        APPROVE_DECISION_ID,
        {"decision_id": "not-a-uuid"},
        {"decision_id": APPROVE_DECISION_ID, "action": "approve"},
        {"decision_id": {"value": APPROVE_DECISION_ID}},
        {"decisionId": APPROVE_DECISION_ID},
    ],
)
def test_resume_rejects_everything_except_exact_decision_reference(
    invalid_decision: object,
) -> None:
    repository = RecordingRepository()
    runner = HumanReviewLifecycleRunner(
        repository,
        checkpointer=_component_checkpointer(),
    )

    async def scenario() -> None:
        await runner.start(_start_value())
        with pytest.raises(ValidationError):
            await runner.resume(
                merchant_id=MERCHANT_ID,
                request_id=REQUEST_ID,
                decision=invalid_decision,
            )

    asyncio.run(scenario())
    assert repository.apply_calls == []


def test_sensitive_content_never_enters_state_interrupt_or_serialized_history() -> None:
    repository = RecordingRepository()
    saver = _component_checkpointer()
    runner = HumanReviewLifecycleRunner(repository, checkpointer=saver)

    async def scenario() -> tuple[list[object], dict[str, object], object]:
        started = await runner.start(_start_value())
        interrupt_value = started["__interrupt__"][0].value
        assert state_contains_only_json_values(interrupt_value)
        await runner.resume(
            merchant_id=MERCHANT_ID,
            request_id=REQUEST_ID,
            decision={"decision_id": APPROVE_DECISION_ID},
        )
        config = runner.config(merchant_id=MERCHANT_ID, request_id=REQUEST_ID)
        snapshot = await runner.graph.aget_state(config)
        assert state_contains_only_json_values(snapshot.values)
        history = [item async for item in saver.alist(config)]
        return history, snapshot.values, interrupt_value

    history, state, interrupt_value = asyncio.run(scenario())
    serialized_history = repr((saver.storage, saver.writes, saver.blobs)).encode()
    logical_history = repr((history, state, interrupt_value)).encode()

    for canary in PRIVATE_CANARIES:
        encoded = canary.encode()
        assert encoded not in serialized_history
        assert encoded not in logical_history

    forbidden_keys = {
        "candidate_name",
        "contact",
        "email",
        "exact_quote",
        "messages",
        "pdf_base64",
        "phone",
        "prompt",
        "raw_pdf",
        "resume_text",
        "source_blocks",
    }
    assert not forbidden_keys.intersection(state)
    for checkpoint in history:
        channel_values = checkpoint.checkpoint.get("channel_values", {})
        if isinstance(channel_values, Mapping):
            assert not forbidden_keys.intersection(channel_values)


def test_stable_thread_identity_is_opaque_deterministic_and_versioned() -> None:
    first = stable_thread_id(merchant_id=MERCHANT_ID, request_id=REQUEST_ID)
    second = stable_thread_id(merchant_id=MERCHANT_ID, request_id=REQUEST_ID)
    different_tenant = stable_thread_id(
        merchant_id="88888888-8888-4888-8888-888888888888",
        request_id=REQUEST_ID,
    )
    different_request = stable_thread_id(
        merchant_id=MERCHANT_ID,
        request_id="99999999-9999-4999-8999-999999999999",
    )
    different_version = stable_thread_id(
        merchant_id=MERCHANT_ID,
        request_id=REQUEST_ID,
        graph_version="2.0.0",
    )

    assert first == second
    assert re.fullmatch(r"rrh-v1-[0-9a-f]{64}", first)
    assert MERCHANT_ID not in first
    assert REQUEST_ID not in first
    assert len({first, different_tenant, different_request, different_version}) == 4
    assert checkpoint_config(merchant_id=MERCHANT_ID, request_id=REQUEST_ID) == {
        "configurable": {"thread_id": first},
        "recursion_limit": 10,
    }


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        (
            {
                "merchant_id": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
                "request_id": REQUEST_ID,
            },
            "merchant_id must be a canonical UUID",
        ),
        (
            {"merchant_id": MERCHANT_ID, "request_id": "not-a-uuid"},
            "request_id must be a canonical UUID",
        ),
        (
            {
                "merchant_id": MERCHANT_ID,
                "request_id": REQUEST_ID,
                "graph_version": "01.0.0",
            },
            "graph_version must be a semantic version",
        ),
    ],
)
def test_thread_identity_rejects_noncanonical_inputs(
    kwargs: dict[str, str],
    message: str,
) -> None:
    with pytest.raises(CheckpointConfigurationError, match=message):
        stable_thread_id(**kwargs)


def test_checkpoint_serializer_has_no_pickle_or_custom_type_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class UnsafeCanary:
        pass

    serializer_options: list[dict[str, object]] = []
    serializer_type = checkpointing.JsonPlusSerializer

    def recording_serializer(**options: object) -> object:
        serializer_options.append(options)
        return serializer_type(**options)

    monkeypatch.setattr(checkpointing, "JsonPlusSerializer", recording_serializer)
    serializer = strict_checkpoint_serializer()
    encoded = serializer.dumps_typed({"safe": ["value", 1, True, None]})

    assert serializer_options == [
        {
            "pickle_fallback": False,
            "allowed_json_modules": (),
            "allowed_msgpack_modules": (),
        }
    ]
    assert serializer.loads_typed(encoded) == {"safe": ["value", 1, True, None]}
    assert serializer.pickle_fallback is False
    with pytest.raises(TypeError, match="not msgpack serializable"):
        serializer.dumps_typed(UnsafeCanary())
    with pytest.raises(NotImplementedError, match="Unknown serialization type"):
        serializer.loads_typed(("pickle", b"not-a-pickle"))


def test_production_checkpoint_dsn_requires_hostname_verified_postgres_ssl() -> None:
    dsn = "postgresql://checkpoint:secret@db.internal/teamflow?sslmode=verify-full"
    assert validate_checkpoint_dsn(dsn, production=True) == dsn


@pytest.mark.parametrize(
    "dsn",
    [
        "mysql://checkpoint:secret@db.internal/teamflow?sslmode=require",
        "postgresql://checkpoint:secret@db.internal/teamflow",
        "postgresql://checkpoint:secret@db.internal/teamflow?sslmode=disable",
        "postgresql://checkpoint:secret@db.internal/teamflow?sslmode=prefer",
        "postgresql://checkpoint:secret@db.internal/teamflow?sslmode=require",
        "postgresql://checkpoint:secret@db.internal/teamflow?sslmode=verify-ca",
        "postgresql://checkpoint:secret@db.internal/teamflow?sslmode=require&sslmode=verify-full",
        "postgresql://checkpoint:secret@db.internal/teamflow?sslmode=verify-full&SSLMODE=disable",
        "postgresql://checkpoint:secret@db.internal/teamflow?sslmode",
        "postgresql://@db.internal/teamflow?sslmode=require",
        " postgresql://checkpoint:secret@db.internal/teamflow?sslmode=require",
    ],
)
def test_invalid_production_checkpoint_dsn_is_rejected(dsn: str) -> None:
    with pytest.raises(CheckpointConfigurationError):
        validate_checkpoint_dsn(dsn, production=True)


def test_nonproduction_checkpoint_dsn_may_disable_ssl_explicitly() -> None:
    dsn = "postgresql://checkpoint:secret@localhost/teamflow?sslmode=disable"
    assert validate_checkpoint_dsn(dsn, production=False) == dsn


def test_runner_forces_sync_durability_and_exact_resume_command() -> None:
    repository = RecordingRepository()
    runner = HumanReviewLifecycleRunner(
        repository,
        checkpointer=_component_checkpointer(),
    )

    class InvocationRecorder:
        def __init__(self) -> None:
            self.calls: list[tuple[object, dict[str, Any], str]] = []

        async def ainvoke(
            self,
            value: object,
            config: dict[str, Any],
            *,
            durability: str,
        ) -> dict[str, object]:
            self.calls.append((value, config, durability))
            return {}

    recorder = InvocationRecorder()
    runner.graph = recorder

    async def scenario() -> None:
        await runner.start(LifecycleStart.model_validate(_start_value()))
        await runner.resume(
            merchant_id=MERCHANT_ID,
            request_id=REQUEST_ID,
            decision={"decision_id": APPROVE_DECISION_ID},
        )

    asyncio.run(scenario())

    assert [call[2] for call in recorder.calls] == ["sync", "sync"]
    assert isinstance(recorder.calls[0][0], dict)
    resume_command = recorder.calls[1][0]
    assert isinstance(resume_command, Command)
    assert resume_command.resume == {"decision_id": APPROVE_DECISION_ID}
    assert recorder.calls[0][1] == recorder.calls[1][1]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ({"nested": [None, "value", 1, 1.5, True]}, True),
        ({"tuple": ("not", "json")}, False),
        ({1: "non-string key"}, False),
        ({"nan": math.nan}, False),
        ({"infinity": math.inf}, False),
    ],
)
def test_json_state_guard(value: object, expected: bool) -> None:
    assert state_contains_only_json_values(value) is expected
