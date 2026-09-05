"""Minimal durable LangGraph lifecycle for human résumé review.

The protected analysis result remains in the review repository. Checkpoint state and
interrupt/resume values contain only opaque identifiers, hashes, versions, bounded
status values, and application reason codes.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Annotated, Any, Literal, Protocol, TypedDict

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    StringConstraints,
    model_validator,
)

from .checkpointing import HITL_GRAPH_VERSION, checkpoint_config

_UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
_SHA256_PATTERN = r"^[0-9a-f]{64}$"
_REASON_CODE_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$"

DatabaseId = Annotated[StrictStr, StringConstraints(pattern=_UUID_PATTERN)]
Sha256 = Annotated[StrictStr, StringConstraints(pattern=_SHA256_PATTERN)]
ReasonCode = Annotated[StrictStr, StringConstraints(pattern=_REASON_CODE_PATTERN)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, validate_default=True)


class LifecycleStart(_StrictModel):
    schema_version: Literal["1.0"]
    workflow_id: DatabaseId
    merchant_id: DatabaseId
    request_id: DatabaseId
    request_sha256: Sha256
    analysis_run_id: DatabaseId
    reason_codes: Annotated[list[ReasonCode], Field(max_length=20)]

    @model_validator(mode="after")
    def validate_reason_codes(self) -> LifecycleStart:
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("reason_codes must be unique")
        return self


class DecisionReference(_StrictModel):
    """The complete and only value accepted through ``Command(resume=...)``."""

    decision_id: DatabaseId


class CreatedReview(_StrictModel):
    review_id: DatabaseId
    review_version: StrictInt = Field(ge=0)
    status: Literal["pending_review"]
    replayed: StrictBool


class AppliedDecision(_StrictModel):
    review_version: StrictInt = Field(ge=1)
    status: Literal["approved", "edited", "rejected"]
    replayed: StrictBool


class HumanReviewRepository(Protocol):
    """Transactional, tenant-scoped, idempotent operations owned by the database layer."""

    async def create_review(
        self,
        *,
        workflow_id: str,
        merchant_id: str,
        request_id: str,
        request_sha256: str,
        analysis_run_id: str,
        reason_codes: tuple[str, ...],
    ) -> CreatedReview | Mapping[str, object]:
        """Create once by workflow identity; replays return the existing review."""

        ...

    async def apply_decision(
        self,
        *,
        workflow_id: str,
        merchant_id: str,
        review_id: str,
        expected_review_version: int,
        decision_id: str,
    ) -> AppliedDecision | Mapping[str, object]:
        """Apply once by decision identity; replays return the original outcome."""

        ...


class HumanReviewState(TypedDict, total=False):
    """Checkpoint-safe state: JSON containers and scalar primitives only."""

    schema_version: str
    workflow_id: str
    merchant_id: str
    request_id: str
    request_sha256: str
    analysis_run_id: str
    reason_codes: list[str]
    review_id: str
    review_version: int
    review_status: str
    decision_id: str
    decision_applied: bool


def _validated_start(value: LifecycleStart | Mapping[str, object]) -> LifecycleStart:
    return value if isinstance(value, LifecycleStart) else LifecycleStart.model_validate(value)


def build_human_review_graph(
    repository: HumanReviewRepository,
    *,
    checkpointer: BaseCheckpointSaver[Any],
) -> Any:
    """Compile the small durable graph; production supplies a PostgreSQL saver."""

    async def create_review(state: HumanReviewState) -> dict[str, object]:
        raw = await repository.create_review(
            workflow_id=state["workflow_id"],
            merchant_id=state["merchant_id"],
            request_id=state["request_id"],
            request_sha256=state["request_sha256"],
            analysis_run_id=state["analysis_run_id"],
            reason_codes=tuple(state["reason_codes"]),
        )
        created = raw if isinstance(raw, CreatedReview) else CreatedReview.model_validate(raw)
        return {
            "review_id": created.review_id,
            "review_version": created.review_version,
            "review_status": created.status,
        }

    async def await_decision(state: HumanReviewState) -> dict[str, object]:
        # This node is intentionally pure: LangGraph re-executes it after resumption.
        resumed = interrupt(
            {
                "schema_version": "1.0",
                "workflow_id": state["workflow_id"],
                "review_id": state["review_id"],
                "review_version": state["review_version"],
                "status": "pending_review",
            }
        )
        decision = DecisionReference.model_validate(resumed)
        return {"decision_id": decision.decision_id}

    async def apply_decision(state: HumanReviewState) -> dict[str, object]:
        raw = await repository.apply_decision(
            workflow_id=state["workflow_id"],
            merchant_id=state["merchant_id"],
            review_id=state["review_id"],
            expected_review_version=state["review_version"],
            decision_id=state["decision_id"],
        )
        applied = raw if isinstance(raw, AppliedDecision) else AppliedDecision.model_validate(raw)
        if applied.review_version <= state["review_version"]:
            raise ValueError("applied review version must advance")
        return {
            "review_version": applied.review_version,
            "review_status": applied.status,
            "decision_applied": True,
        }

    builder = StateGraph(HumanReviewState)
    builder.add_node("create_review", create_review)
    builder.add_node("await_decision", await_decision)
    builder.add_node("apply_decision", apply_decision)
    builder.add_edge(START, "create_review")
    builder.add_edge("create_review", "await_decision")
    builder.add_edge("await_decision", "apply_decision")
    builder.add_edge("apply_decision", END)
    return builder.compile(
        checkpointer=checkpointer,
        name="resume-review-hitl-v1",
    )


class HumanReviewLifecycleRunner:
    """Invoke and resume a compiled lifecycle with synchronous durability."""

    def __init__(
        self,
        repository: HumanReviewRepository,
        *,
        checkpointer: BaseCheckpointSaver[Any],
        graph_version: str = HITL_GRAPH_VERSION,
    ) -> None:
        self._graph_version = graph_version
        self.graph = build_human_review_graph(repository, checkpointer=checkpointer)

    def config(self, *, merchant_id: str, request_id: str) -> dict[str, Any]:
        return checkpoint_config(
            merchant_id=merchant_id,
            request_id=request_id,
            graph_version=self._graph_version,
        )

    async def start(
        self,
        value: LifecycleStart | Mapping[str, object],
    ) -> dict[str, Any]:
        start = _validated_start(value)
        state = start.model_dump(mode="json")
        return await self.graph.ainvoke(
            state,
            self.config(merchant_id=start.merchant_id, request_id=start.request_id),
            durability="sync",
        )

    async def resume(
        self,
        *,
        merchant_id: str,
        request_id: str,
        decision: object,
    ) -> dict[str, Any]:
        reference = DecisionReference.model_validate(decision)
        return await self.graph.ainvoke(
            Command(resume=reference.model_dump(mode="json")),
            self.config(merchant_id=merchant_id, request_id=request_id),
            durability="sync",
        )


def state_contains_only_json_values(value: object) -> bool:
    """Return whether a value is composed only of JSON scalar/container types."""

    if value is None or isinstance(value, str | bool | int):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(state_contains_only_json_values(item) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and state_contains_only_json_values(item)
            for key, item in value.items()
        )
    return False
