"""Runtime fail-closed checks for advisory résumé-review results."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from teamflow_hiring_agent.resume_review.runtime import (
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
