import asyncio

import httpx

from teamflow_hiring_agent.api import create_app
from teamflow_hiring_agent.contracts import HiringAgentOutput
from teamflow_hiring_agent.runtime import HiringWorkflowTimeoutError


class RecordingWorkflow:
    def __init__(self):
        self.request = None

    async def invoke(self, request):
        self.request = request
        return HiringAgentOutput(
            summary="Candidate reviewed",
            recommendation="Invite for a structured interview.",
            fit_score=84,
            analysis={"evidence": ["Relevant experience"]},
            request_id=str(request.request_id),
            tool_calls=["get_candidate"],
        )


MERCHANT_ID = "00000000-0000-0000-0000-000000000001"
CANDIDATE_ID = "00000000-0000-0000-0000-000000000002"
ROLE_ID = "00000000-0000-0000-0000-000000000003"


def request(app, method, path, **kwargs):
    async def send():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(send())


def test_invoke_accepts_direct_json_and_returns_the_stable_contract(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    workflow = RecordingWorkflow()
    response = request(
        create_app(workflow),
        "POST",
        "/invoke",
        headers={"X-Agent-Token": "test-token"},
        json={
            "candidateId": CANDIDATE_ID,
            "roleId": ROLE_ID,
            "merchantId": MERCHANT_ID,
            "instructions": "Review this candidate",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "summary": "Candidate reviewed",
        "recommendation": "Invite for a structured interview.",
        "fit_score": 84,
        "analysis": {
            "evidence": ["Relevant experience"],
            "gaps": [],
            "limitations": [],
            "confidence": "low",
        },
        "status": "complete",
        "write_status": "not_requested",
        "warnings": [],
        "request_id": str(workflow.request.request_id),
        "tool_calls": ["get_candidate"],
    }
    assert str(workflow.request.candidate_id) == CANDIDATE_ID
    assert str(workflow.request.role_id) == ROLE_ID


def test_invoke_rejects_an_invalid_score_before_the_graph(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    response = request(
        create_app(RecordingWorkflow()),
        "POST",
        "/invoke",
        headers={"X-Agent-Token": "test-token"},
        json={"merchantId": MERCHANT_ID, "score": 101},
    )

    assert response.status_code == 422


class FailingWorkflow:
    async def invoke(self, request):
        raise RuntimeError("sensitive provider details")


class TimedOutWorkflow:
    async def invoke(self, request):
        raise HiringWorkflowTimeoutError("private provider deadline detail")


def test_invoke_returns_a_sanitized_failure(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    response = request(
        create_app(FailingWorkflow()),
        "POST",
        "/invoke",
        headers={"X-Agent-Token": "test-token"},
        json={"merchantId": MERCHANT_ID},
    )

    assert response.status_code == 500
    assert response.json() == {"error": "Workflow failed", "code": "workflow_failed"}
    assert "sensitive" not in response.text


def test_workflow_deadline_is_mapped_without_private_details(monkeypatch):
    monkeypatch.setenv("HIRING_AGENT_TOKEN", "test-token")
    response = request(
        create_app(TimedOutWorkflow()),
        "POST",
        "/invoke",
        headers={"X-Agent-Token": "test-token"},
        json={"merchantId": MERCHANT_ID},
    )

    assert response.status_code == 504
    assert response.json() == {
        "error": "Workflow deadline exceeded",
        "code": "workflow_timeout",
    }
    assert "private" not in response.text
