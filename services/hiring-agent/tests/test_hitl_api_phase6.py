"""Focused API tests for the additive Phase 6 durable-review boundary."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from teamflow_hiring_agent.resume_review.hitl.api import (
    HitlAlreadyDecidedError,
    HitlDependencyUnavailableError,
    HitlIdempotencyConflictError,
    HitlIdentityError,
    HitlInvalidEditError,
    HitlMembershipDeniedError,
    HitlNotFoundError,
    HitlReviewerDeniedError,
    HitlReviewService,
    HitlStaleDecisionError,
    HitlWrongTenantError,
    build_hitl_router,
)
from teamflow_hiring_agent.resume_review.hitl.contracts import (
    ApproveWithEditsResumeReviewDecision,
    PendingResumeReviewQueueResponse,
    ResumeReviewDecisionRequest,
    ResumeReviewRunDetailResponse,
    ResumeReviewRunResponse,
    StartResumeReviewRunRequest,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (REPOSITORY_ROOT / "tests" / "fixtures" / "resume-review-hitl-v2.json").read_text(
        encoding="utf-8"
    )
)
REVIEWER_FIXTURE = json.loads(
    (REPOSITORY_ROOT / "tests" / "fixtures" / "resume-review-reviewer-v2.json").read_text(
        encoding="utf-8"
    )
)
RUN_ID = FIXTURE["run_responses"][0]["run_id"]
AUTHORIZATION = "Bearer private-user-access-token"
AUTH_HEADERS = {"Authorization": AUTHORIZATION}


def create_app(*, hitl_review_service: HitlReviewService | None = None) -> FastAPI:
    """Build the Phase 6 router without depending on later app composition."""

    app = FastAPI()
    app.include_router(build_hitl_router(hitl_review_service))
    return app


class RecordingHitlService:
    def __init__(self, response: dict[str, Any] | None = None, error: Exception | None = None):
        self.response = response or FIXTURE["run_responses"][1]
        self.error = error
        self.calls: list[tuple[str, object, str]] = []

    async def _result(self) -> ResumeReviewRunResponse:
        if self.error is not None:
            raise self.error
        return ResumeReviewRunResponse.model_validate(self.response)

    async def _detail_result(self) -> ResumeReviewRunDetailResponse:
        if self.error is not None:
            raise self.error
        return ResumeReviewRunDetailResponse.model_validate(
            {**REVIEWER_FIXTURE["detail_response"], **self.response}
        )

    async def _queue_result(self) -> PendingResumeReviewQueueResponse:
        if self.error is not None:
            raise self.error
        return PendingResumeReviewQueueResponse.model_validate(REVIEWER_FIXTURE["queue_response"])

    async def start(
        self,
        request: StartResumeReviewRunRequest,
        authorization: str,
    ) -> ResumeReviewRunResponse:
        self.calls.append(("start", request, authorization))
        return await self._result()

    async def inspect(
        self,
        run_id: str,
        authorization: str,
    ) -> ResumeReviewRunDetailResponse:
        self.calls.append(("inspect", run_id, authorization))
        return await self._detail_result()

    async def list_pending(
        self,
        *,
        limit: int,
        cursor: str | None,
        authorization: str,
    ) -> PendingResumeReviewQueueResponse:
        self.calls.append(("list_pending", (limit, cursor), authorization))
        return await self._queue_result()

    async def decide(
        self,
        run_id: str,
        request: ResumeReviewDecisionRequest,
        authorization: str,
    ) -> ResumeReviewRunResponse:
        self.calls.append(("decide", (run_id, request), authorization))
        return await self._result()


def request(app, method: str, path: str, **kwargs: Any) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(send())


def test_start_requires_bearer_identity_before_service() -> None:
    service = RecordingHitlService()
    app = create_app(hitl_review_service=service)

    for authorization in (None, "Basic credential", "Bearer", "Bearer token with spaces"):
        headers = {}
        if authorization is not None:
            headers["Authorization"] = authorization
        response = request(
            app,
            "POST",
            "/v2/resume-review-runs",
            headers=headers,
            json=FIXTURE["start_request"],
        )
        assert response.status_code == 401
        assert response.json() == {"error": "Unauthorized", "code": "unauthorized"}
        assert response.headers["www-authenticate"] == "Bearer"

    assert service.calls == []


def test_bearer_identity_is_checked_before_schema_validation() -> None:
    service = RecordingHitlService()

    response = request(
        create_app(hitl_review_service=service),
        "POST",
        "/v2/resume-review-runs",
        json={"merchant_id": "caller-controlled"},
    )

    assert response.status_code == 401
    assert response.json() == {"error": "Unauthorized", "code": "unauthorized"}
    assert service.calls == []


def test_start_returns_accepted_location_and_forwards_bearer_without_echoing_it() -> None:
    service = RecordingHitlService(FIXTURE["run_responses"][1])

    response = request(
        create_app(hitl_review_service=service),
        "POST",
        "/v2/resume-review-runs",
        headers=AUTH_HEADERS,
        json=FIXTURE["start_request"],
    )

    assert response.status_code == 202
    assert response.headers["location"] == f"/v2/resume-review-runs/{RUN_ID}"
    assert response.headers["retry-after"] == "2"
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == FIXTURE["run_responses"][1]
    assert AUTHORIZATION not in response.text
    assert len(service.calls) == 1
    operation, body, forwarded = service.calls[0]
    assert operation == "start"
    assert isinstance(body, StartResumeReviewRunRequest)
    assert forwarded == AUTHORIZATION


def test_inspect_returns_200_and_retry_after_while_pending() -> None:
    service = RecordingHitlService(FIXTURE["run_responses"][1])

    response = request(
        create_app(hitl_review_service=service),
        "GET",
        f"/v2/resume-review-runs/{RUN_ID}",
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 200
    assert response.headers["retry-after"] == "2"
    assert "location" not in response.headers
    assert service.calls == [("inspect", RUN_ID, AUTHORIZATION)]
    assert response.json() == REVIEWER_FIXTURE["detail_response"]
    for private_field in (
        "merchant_id",
        "request_sha256",
        "analysis_input_sha256",
        "document_snapshot",
        "source_blocks",
        "checkpoint",
        "tool_calls",
    ):
        assert private_field not in response.text


def test_pending_queue_requires_bearer_and_strict_bounded_query_then_forwards_cursor() -> None:
    service = RecordingHitlService()
    app = create_app(hitl_review_service=service)
    cursor = REVIEWER_FIXTURE["queue_response"]["next_cursor"]

    unauthorized = request(
        app,
        "GET",
        "/v2/resume-review-runs?status=wrong&limit=999",
        headers={"X-Agent-Token": "test-agent-token"},
    )
    assert unauthorized.status_code == 401
    assert service.calls == []

    response = request(
        app,
        "GET",
        f"/v2/resume-review-runs?status=pending_review&limit=1&cursor={cursor}",
        headers=AUTH_HEADERS,
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == REVIEWER_FIXTURE["queue_response"]
    assert service.calls == [("list_pending", (1, cursor), AUTHORIZATION)]
    for private_field in (
        "merchant_id",
        "actor_id",
        "document_id",
        "resume_text",
        "source_blocks",
        "checkpoint",
        "policy_sha256",
    ):
        assert private_field not in response.text


@pytest.mark.parametrize(
    "query",
    [
        "",
        "?status=running",
        "?status=pending_review&limit=0",
        "?status=pending_review&limit=51",
        "?status=pending_review&limit=01",
        "?status=pending_review&limit=1.0",
        "?status=pending_review&limit=+1",
        "?status=pending_review&limit=1&limit=2",
        "?status=pending_review&unknown=1",
        "?status=pending_review&cursor=too-short",
    ],
)
def test_pending_queue_rejects_ambiguous_or_unbounded_queries(query: str) -> None:
    service = RecordingHitlService()
    response = request(
        create_app(hitl_review_service=service),
        "GET",
        f"/v2/resume-review-runs{query}",
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 422
    assert response.json() == {
        "error": "Invalid résumé-review request",
        "code": "invalid_request",
    }
    assert service.calls == []


def test_detail_editable_output_round_trips_into_the_decision_endpoint() -> None:
    service = RecordingHitlService(FIXTURE["run_responses"][1])
    app = create_app(hitl_review_service=service)
    inspected = request(
        app,
        "GET",
        f"/v2/resume-review-runs/{RUN_ID}",
        headers=AUTH_HEADERS,
    )
    editable = inspected.json()["proposal"]["editable_agent1_output"]
    decision = {
        "schema_version": "2.0",
        "decision_id": "66666666-6666-4666-8666-666666666666",
        "review_id": "64444444-4444-4444-8444-444444444444",
        "expected_review_version": 1,
        "action": "approve_with_edits",
        "replacement_agent1_output": editable,
        "reason_code": "reviewer-confirmed-evidence",
    }

    decided = request(
        app,
        "PUT",
        f"/v2/resume-review-runs/{RUN_ID}/decision",
        headers=AUTH_HEADERS,
        json=decision,
    )

    assert decided.status_code == 202
    operation, captured, forwarded = service.calls[-1]
    assert operation == "decide"
    captured_run_id, captured_decision = captured
    assert captured_run_id == RUN_ID
    assert isinstance(captured_decision, ApproveWithEditsResumeReviewDecision)
    assert captured_decision.replacement_agent1_output.model_dump(mode="json") == editable
    assert forwarded == AUTHORIZATION


def test_decision_returns_202_while_pending_and_200_when_terminal() -> None:
    decision = FIXTURE["decisions"][0]
    pending_service = RecordingHitlService(
        {**FIXTURE["run_responses"][1], "status": "decision_recorded", "run_version": 3}
    )
    pending = request(
        create_app(hitl_review_service=pending_service),
        "PUT",
        f"/v2/resume-review-runs/{RUN_ID}/decision",
        headers=AUTH_HEADERS,
        json=decision,
    )
    assert pending.status_code == 202
    assert pending.headers["retry-after"] == "2"
    assert pending.headers["location"] == f"/v2/resume-review-runs/{RUN_ID}"

    complete_service = RecordingHitlService(FIXTURE["run_responses"][2])
    complete = request(
        create_app(hitl_review_service=complete_service),
        "PUT",
        f"/v2/resume-review-runs/{RUN_ID}/decision",
        headers=AUTH_HEADERS,
        json=decision,
    )
    assert complete.status_code == 200
    assert "retry-after" not in complete.headers
    assert "location" not in complete.headers


def test_authority_score_and_private_fields_are_rejected_before_service() -> None:
    service = RecordingHitlService()
    app = create_app(hitl_review_service=service)

    for field, value in (
        ("merchant_id", "69999999-9999-4999-8999-999999999999"),
        ("actor_id", "69999999-9999-4999-8999-999999999999"),
        ("thread_id", "caller-thread"),
        ("score", 100),
        ("tool_calls", ["update_fit_score"]),
    ):
        response = request(
            app,
            "POST",
            "/v2/resume-review-runs",
            headers=AUTH_HEADERS,
            json={**FIXTURE["start_request"], field: value},
        )
        assert response.status_code == 422
        assert response.json() == {
            "error": "Invalid résumé-review request",
            "code": "invalid_request",
        }

    for field, value in (
        ("merchant_id", "69999999-9999-4999-8999-999999999999"),
        ("actor_id", "69999999-9999-4999-8999-999999999999"),
        ("score", 100),
        ("recommended_role_id", "69999999-9999-4999-8999-999999999999"),
    ):
        response = request(
            app,
            "PUT",
            f"/v2/resume-review-runs/{RUN_ID}/decision",
            headers=AUTH_HEADERS,
            json={**FIXTURE["decisions"][0], field: value},
        )
        assert response.status_code == 422
        assert field not in response.text

    assert service.calls == []


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (HitlIdentityError("private"), 401, "unauthorized"),
        (HitlMembershipDeniedError("private"), 403, "forbidden"),
        (HitlReviewerDeniedError("private"), 403, "forbidden"),
        (HitlNotFoundError("private"), 404, "not_found"),
        (HitlWrongTenantError("private"), 404, "not_found"),
        (HitlIdempotencyConflictError("private"), 409, "idempotency_conflict"),
        (HitlStaleDecisionError("private"), 409, "stale_decision"),
        (HitlAlreadyDecidedError("private"), 409, "review_already_decided"),
        (HitlInvalidEditError("private"), 422, "invalid_edit"),
        (HitlDependencyUnavailableError("private"), 503, "service_unavailable"),
    ],
)
def test_expected_domain_errors_have_exact_sanitized_mapping(
    error: Exception,
    status: int,
    code: str,
) -> None:
    response = request(
        create_app(hitl_review_service=RecordingHitlService(error=error)),
        "GET",
        f"/v2/resume-review-runs/{RUN_ID}",
        headers=AUTH_HEADERS,
    )

    assert response.status_code == status
    assert response.json()["code"] == code
    assert "private" not in response.text


def test_missing_and_wrong_tenant_runs_are_indistinguishable() -> None:
    responses = []
    for error in (HitlNotFoundError("missing detail"), HitlWrongTenantError("tenant detail")):
        responses.append(
            request(
                create_app(hitl_review_service=RecordingHitlService(error=error)),
                "GET",
                f"/v2/resume-review-runs/{RUN_ID}",
                headers=AUTH_HEADERS,
            )
        )

    assert [(response.status_code, response.json()) for response in responses] == [
        (404, {"error": "Résumé-review run was not found", "code": "not_found"}),
        (404, {"error": "Résumé-review run was not found", "code": "not_found"}),
    ]


def test_unexpected_failure_and_invalid_service_output_do_not_leak_private_data(
    caplog,
) -> None:
    caplog.set_level(logging.ERROR)
    private_detail = "private database row and authorization detail"
    failed = request(
        create_app(hitl_review_service=RecordingHitlService(error=RuntimeError(private_detail))),
        "GET",
        f"/v2/resume-review-runs/{RUN_ID}",
        headers=AUTH_HEADERS,
    )
    assert failed.status_code == 502
    assert failed.json() == {
        "error": "Résumé-review request failed",
        "code": "workflow_failed",
    }
    assert private_detail not in failed.text
    assert AUTHORIZATION not in failed.text
    assert private_detail not in caplog.text
    assert AUTHORIZATION not in caplog.text

    invalid_service = RecordingHitlService()
    invalid_service.response = {
        **FIXTURE["run_responses"][1],
        "checkpoint_state": {"resume_text": "private resume"},
    }
    invalid = request(
        create_app(hitl_review_service=invalid_service),
        "GET",
        f"/v2/resume-review-runs/{RUN_ID}",
        headers=AUTH_HEADERS,
    )
    assert invalid.status_code == 502
    assert "checkpoint" not in invalid.text
    assert "private resume" not in invalid.text


def test_unconfigured_v2_service_fails_closed_after_bearer_authentication() -> None:
    response = request(
        create_app(),
        "POST",
        "/v2/resume-review-runs",
        headers=AUTH_HEADERS,
        json=FIXTURE["start_request"],
    )

    assert response.status_code == 503
    assert response.json()["code"] == "service_unavailable"
