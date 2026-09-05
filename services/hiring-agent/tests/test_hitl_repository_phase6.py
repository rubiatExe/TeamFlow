from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime

import pytest
from psycopg import OperationalError

from teamflow_hiring_agent.resume_review.contracts import (
    Agent1Evaluation,
    Agent1ModelOutput,
    RoleScoringPolicy,
)
from teamflow_hiring_agent.resume_review.hitl.api import (
    HitlDependencyUnavailableError,
    HitlInvalidEditError,
    HitlMembershipDeniedError,
    HitlStaleDecisionError,
)
from teamflow_hiring_agent.resume_review.hitl.repository import (
    PostgresHitlRepository,
    PostgresHumanEditValidator,
    _raise_domain_error,
)
from teamflow_hiring_agent.resume_review.hitl.service import DecisionAuthorization
from teamflow_hiring_agent.resume_review.persistence import role_policy_fingerprint
from teamflow_hiring_agent.resume_review.scoring import build_agent1_evaluation
from teamflow_hiring_agent.resume_review.workflow_contracts import canonical_snapshot_sha256

MERCHANT_ID = "20000000-0000-4000-8000-000000000002"
WORKFLOW_ID = "50000000-0000-4000-8000-000000000005"
REQUEST_ID = "30000000-0000-4000-8000-000000000003"
REVIEW_ID = "70000000-0000-4000-8000-000000000007"
ROLE_ID = "90000000-0000-4000-8000-000000000009"
DOCUMENT_ID = f"doc-{'a' * 64}"


def run(coro):
    return asyncio.run(coro)


def _source_block(text: str) -> dict[str, object]:
    digest = hashlib.sha256(f"1|1|{text}".encode()).hexdigest()[:12]
    return {
        "source_block_id": f"src-{'a' * 12}-p0001-b0001-{digest}",
        "page_number": 1,
        "ordinal": 1,
        "text": text,
    }


def _document() -> dict[str, object]:
    text = "Managed customer service for busy cafe shifts."
    snapshot: dict[str, object] = {
        "schema_version": "1.0",
        "merchant_id": MERCHANT_ID,
        "document_id": DOCUMENT_ID,
        "content_sha256": "a" * 64,
        "status": "complete",
        "text": text,
        "source_blocks": [_source_block(text)],
        "extraction_method": "pdf_text",
        "model_id": "pypdf-test",
        "embedding_available": True,
        "mock": False,
        "warnings": [],
        "quality": {
            "assessment": "usable",
            "character_count": len(text),
            "block_count": 1,
            "page_count": 1,
            "reason_codes": [],
        },
    }
    snapshot["snapshot_sha256"] = canonical_snapshot_sha256(snapshot)
    return snapshot


def _policies() -> tuple[RoleScoringPolicy, ...]:
    return (
        RoleScoringPolicy.model_validate(
            {
                "schema_version": "1.0",
                "role_id": ROLE_ID,
                "role_title": "Cafe Associate",
                "policy_identity": {
                    "policy_id": "cafe-policy",
                    "policy_version": "1.0.0",
                },
                "criteria": [
                    {
                        "criterion_id": "customer-service",
                        "criterion_text": "Customer-service experience",
                        "weight": 100,
                    }
                ],
            }
        ),
    )


def _model_output(*, quote: str, limitations: list[str]) -> Agent1ModelOutput:
    block = _source_block("Managed customer service for busy cafe shifts.")
    return Agent1ModelOutput.model_validate(
        {
            "schema_version": "1.0",
            "role_assessments": [
                {
                    "role_id": ROLE_ID,
                    "criterion_assessments": [
                        {
                            "criterion_id": "customer-service",
                            "status": "met",
                            "evidence": [
                                {
                                    "criterion_id": "customer-service",
                                    "exact_quote": quote,
                                    "source_block_id": block["source_block_id"],
                                }
                            ],
                        }
                    ],
                }
            ],
            "limitations": limitations,
        }
    )


class _ContextRepository:
    def __init__(self, row: dict[str, object]) -> None:
        self.row = row
        self.calls: list[DecisionAuthorization] = []

    async def load_edit_context(self, context: DecisionAuthorization):
        self.calls.append(context)
        return self.row


def _context_row() -> tuple[dict[str, object], Agent1Evaluation]:
    document = _document()
    policies = _policies()
    original_model = _model_output(
        quote="Managed customer service",
        limitations=["Original sanitized limitation."],
    )
    original = build_agent1_evaluation(original_model, policies)
    return (
        {
            "merchant_id": MERCHANT_ID,
            "extraction_snapshot_sha256": document["snapshot_sha256"],
            "policy_sha256": role_policy_fingerprint(policies),
            "document_snapshot": document,
            "role_policy_snapshot": [item.model_dump(mode="json") for item in policies],
            "original_evaluation": original.model_dump(mode="json"),
        },
        original,
    )


def _decision_context() -> DecisionAuthorization:
    return DecisionAuthorization(
        user_id="10000000-0000-4000-8000-000000000001",
        session_id="11000000-0000-4000-8000-000000000001",
        assurance_level="aal2",
        authenticated_at=1_800_000_000,
        workflow_id=WORKFLOW_ID,
        merchant_id=MERCHANT_ID,
        request_id=REQUEST_ID,
        review_id=REVIEW_ID,
        review_version=1,
        role="reviewer",
    )


def test_edit_validator_uses_immutable_sources_and_discards_caller_free_text() -> None:
    row, original = _context_row()
    repository = _ContextRepository(row)
    validator = PostgresHumanEditValidator(repository)  # type: ignore[arg-type]
    replacement = _model_output(
        quote="Managed customer service",
        limitations=["Caller-authored text is not persisted."],
    )

    evaluation = run(validator.validate(_decision_context(), replacement))

    assert evaluation.limitations == original.limitations
    assert evaluation.ranked_roles[0].deterministic_score == 100
    assert repository.calls == [_decision_context()]


def test_edit_validator_rejects_nonliteral_quote_against_stored_snapshot() -> None:
    row, _ = _context_row()
    validator = PostgresHumanEditValidator(_ContextRepository(row))  # type: ignore[arg-type]
    replacement = _model_output(
        quote="Invented customer service achievement",
        limitations=[],
    )

    with pytest.raises(HitlInvalidEditError):
        run(validator.validate(_decision_context(), replacement))


class _Diagnostic:
    def __init__(self, message: str) -> None:
        self.message_primary = message


class _DatabaseSignal(Exception):
    def __init__(self, sqlstate: str, message: str) -> None:
        super().__init__("private driver detail must not escape")
        self.sqlstate = sqlstate
        self.diag = _Diagnostic(message)


def test_database_signal_mapping_fails_ambiguous_membership_closed() -> None:
    signal = _DatabaseSignal("PT409", "teamflow_active_membership_ambiguous")
    with pytest.raises(HitlMembershipDeniedError):
        _raise_domain_error(signal, operation="resolve_membership")  # type: ignore[arg-type]


def test_database_signal_mapping_distinguishes_stale_and_sanitizes_unknown() -> None:
    stale = _DatabaseSignal("PT409", "teamflow_stale_review_version")
    with pytest.raises(HitlStaleDecisionError):
        _raise_domain_error(stale, operation="record_decision")  # type: ignore[arg-type]

    unknown = _DatabaseSignal("XX000", "secret-value")
    with pytest.raises(HitlDependencyUnavailableError) as captured:
        _raise_domain_error(unknown, operation="inspect")  # type: ignore[arg-type]
    assert "secret-value" not in str(captured.value)
    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None


class _FailingPool:
    def connection(self):
        raise OperationalError("private-postgres-canary")


def test_database_driver_failures_have_no_raw_exception_chain() -> None:
    repository = object.__new__(PostgresHitlRepository)
    repository._pool = _FailingPool()  # type: ignore[attr-defined]

    with pytest.raises(HitlDependencyUnavailableError) as captured:
        run(repository._fetch_optional("select 1", (), operation="inspect"))

    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert "private-postgres-canary" not in repr(captured.value)


class _PendingQueueRepository(PostgresHitlRepository):
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows

    async def _actor_fetch_all(self, *args, **kwargs):
        return self.rows


def test_pending_queue_rejects_unsafe_historical_role_title_without_leaking_it() -> None:
    private_title = "Contact reviewer-private@example.test"
    repository = _PendingQueueRepository(
        [
            {
                "workflow_id": WORKFLOW_ID,
                "candidate_id": "80000000-0000-4000-8000-000000000008",
                "created_at": datetime(2026, 8, 28, 12, tzinfo=UTC),
                "workflow_version": 2,
                "review_id": REVIEW_ID,
                "review_version": 1,
                "reason_codes": ["human-approval-required"],
                "top_role_id": ROLE_ID,
                "top_role_title": private_title,
                "top_role_score": 100,
                "recommended_role_id": ROLE_ID,
                "has_more": False,
            }
        ]
    )

    with pytest.raises(HitlDependencyUnavailableError) as captured:
        run(
            repository.list_pending(
                user_id="10000000-0000-4000-8000-000000000001",
                limit=25,
                before_created_at=None,
                before_id=None,
            )
        )
    assert private_title not in str(captured.value)
