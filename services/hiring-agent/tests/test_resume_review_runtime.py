"""Runtime fail-closed checks for advisory résumé-review results."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from langchain_core.messages import HumanMessage
from langchain_google_genai import ChatGoogleGenerativeAI

from teamflow_hiring_agent.config import Settings
from teamflow_hiring_agent.resume_review.runtime import (
    LangGraphResumeReviewWorkflow,
    ResumeReviewWorkflowExecutionError,
    _validated_output,
)
from teamflow_hiring_agent.resume_review.workflow_contracts import ResumeReviewRequest

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "tests" / "fixtures" / "resume-review-api-v1.json").read_text(encoding="utf-8")
)


def test_runtime_rejects_a_correlated_model_evaluation_marked_complete() -> None:
    request = ResumeReviewRequest.model_validate(FIXTURE["normal"]["request"])
    unsafe = dict(FIXTURE["normal"]["response"])
    unsafe.update(status="complete", review_required=False, reason_codes=[])

    with pytest.raises(
        ResumeReviewWorkflowExecutionError,
        match="^resume_review_result_invalid$",
    ):
        _validated_output({"output": unsafe}, request=request)


def test_runtime_accepts_the_same_evaluation_only_as_a_review_proposal() -> None:
    request = ResumeReviewRequest.model_validate(FIXTURE["normal"]["request"])

    output = _validated_output(
        {"output": FIXTURE["normal"]["response"]},
        request=request,
    )

    assert output.status.value == "review_required"
    assert output.review_required is True
    assert output.agent1_evaluation is not None


def test_actual_structured_gemini_requests_omit_unsupported_candidate_count() -> None:
    models: list[ChatGoogleGenerativeAI] = []

    def factory(**kwargs: Any) -> ChatGoogleGenerativeAI:
        model = ChatGoogleGenerativeAI(**kwargs)
        models.append(model)
        return model

    settings = Settings(
        model="gemini-3.7-flash",
        fallback_model="gemini-3.6-flash",
        google_api_key="private-test-key",
        max_tool_rounds=2,
        max_tool_calls_per_round=3,
        model_timeout_seconds=12.0,
        tool_timeout_seconds=5.0,
        workflow_timeout_seconds=20.0,
        max_concurrency=2,
        queue_timeout_seconds=1.0,
        max_request_bytes=65_536,
    )
    runtime = LangGraphResumeReviewWorkflow(
        object(),  # type: ignore[arg-type]
        merchant_id="00000000-0000-0000-0000-000000000001",
        settings=settings,
        model_factory=factory,
    )

    assert [model.model for model in models] == ["gemini-3.7-flash", "gemini-3.6-flash"]
    assert all(model.n is None for model in models)
    bindings = [
        runtime._agent1_model._primary.first.steps__["raw"],
        runtime._agent1_model._fallback.first.steps__["raw"],
        runtime._agent2_model._primary.first.steps__["raw"],
        runtime._agent2_model._fallback.first.steps__["raw"],
    ]
    assert all(binding is not None for binding in bindings)
    unsupported = {
        "candidate_count",
        "temperature",
        "top_p",
        "top_k",
        "frequency_penalty",
        "presence_penalty",
    }
    for binding in bindings:
        kwargs = {
            key: value
            for key, value in binding.kwargs.items()
            if key != "ls_structured_output_format"
        }
        prepared = binding.bound._prepare_request(
            [HumanMessage(content="test")],
            **kwargs,
        )
        config = prepared["config"].model_dump(exclude_none=True)
        assert unsupported.isdisjoint(config)
        assert config["max_output_tokens"] == 4_096
