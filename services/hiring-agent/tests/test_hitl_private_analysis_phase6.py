"""Private Phase 4 → Phase 6 evidence handoff tests."""

from __future__ import annotations

import asyncio

import pytest
from test_resume_review_workflow_phase4 import (
    agent1_output,
    agent2_output,
    policies,
    request,
)

from teamflow_hiring_agent.resume_review.confidence import (
    ConfidencePolicy,
    ConfidenceShadowRecord,
    ConfidenceSignal,
    ConfidenceSignalId,
    assess_confidence,
    build_shadow_record,
    load_default_confidence_policy,
)
from teamflow_hiring_agent.resume_review.contracts import ConfidenceAssessment
from teamflow_hiring_agent.resume_review.persistence import (
    build_review_persistence_record,
    role_policy_fingerprint,
)
from teamflow_hiring_agent.resume_review.runtime import (
    LangGraphResumeReviewWorkflow,
    ResumeReviewWorkflowExecutionError,
)
from teamflow_hiring_agent.resume_review.scoring import build_agent1_evaluation
from teamflow_hiring_agent.resume_review.workflow_contracts import (
    ExtractionSummary,
    PersistenceStatus,
    QuestionsStatus,
    ResumeReviewResponse,
    ReviewStatus,
)


def run(coro):
    return asyncio.run(coro)


def extraction_summary() -> ExtractionSummary:
    return ExtractionSummary(
        schema_version="1.0",
        document_id=request().document_id,
        merchant_id=request().merchant_id,
        status="complete",
        extraction_method="pdf_text",
        model_id="pypdf-6.16.2",
        embedding_available=True,
        mock=False,
        quality="usable",
        character_count=120,
        block_count=2,
        page_count=1,
        warnings=(),
        snapshot_sha256="c" * 64,
    )


def final_response() -> ResumeReviewResponse:
    return ResumeReviewResponse(
        schema_version="1.0",
        request_id=request().request_id,
        document_id=request().document_id,
        status=ReviewStatus.REVIEW_REQUIRED,
        review_required=True,
        agent1_evaluation=build_agent1_evaluation(agent1_output(), policies()),
        questions_status=QuestionsStatus.COMPLETE,
        question_plan=agent2_output(),
        persistence_status=PersistenceStatus.NOT_REQUESTED,
        reason_codes=("model_classification_requires_human_review",),
        extraction_status="complete",
        embedding_available=True,
    )


def confidence_policy() -> ConfidencePolicy:
    return load_default_confidence_policy()


def confidence_signals() -> tuple[ConfidenceSignal, ...]:
    return tuple(
        ConfidenceSignal(
            component_id=component.component_id,
            score=(88 if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE else 100),
            hard_failure=False,
            reason_codes=(
                ("criteria_evidence_missing",)
                if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE
                else ()
            ),
        )
        for component in confidence_policy().components
    )


def confidence_assessment() -> ConfidenceAssessment:
    return assess_confidence(confidence_signals(), confidence_policy())


def confidence_shadow() -> ConfidenceShadowRecord:
    assessment = confidence_assessment()
    return build_shadow_record(
        assessment,
        confidence_policy(),
        signals=confidence_signals(),
        review_required=True,
        status=ReviewStatus.REVIEW_REQUIRED,
    )


class StateBackedRuntime(LangGraphResumeReviewWorkflow):
    def __init__(self, state):
        self.state = state
        self.calls = []
        self._merchant_id = str(request().merchant_id)
        self._review_writer = None

    async def _execute_state(self, incoming):
        self.calls.append(incoming)
        return self.state


def test_private_analysis_returns_content_bound_evidence_without_external_write() -> None:
    evaluation = build_agent1_evaluation(agent1_output(), policies())
    state = {
        "output": final_response(),
        "agent1_evaluation": evaluation,
        "agent2_question_plan": agent2_output(),
        "role_policies": policies(),
        "extraction_summary": extraction_summary(),
        "confidence_assessment": confidence_assessment(),
        "confidence_shadow_record": confidence_shadow(),
        "confidence_policy_snapshot": confidence_policy(),
        "confidence_signals": confidence_signals(),
    }
    runtime = StateBackedRuntime(state)
    incoming = request(persist=True)

    artifact = run(runtime.analyze_for_human_review(incoming))

    assert runtime.calls[0].persist is False
    expected = build_review_persistence_record(
        request=incoming.model_copy(update={"persist": False}),
        evaluation=evaluation,
        question_plan=agent2_output(),
        questions_status=QuestionsStatus.COMPLETE,
        extraction_fingerprint="c" * 64,
        policy_fingerprint=role_policy_fingerprint(policies()),
        policy_snapshot=policies(),
        confidence_assessment=confidence_assessment(),
        confidence_shadow_record=confidence_shadow(),
        confidence_policy_snapshot=confidence_policy(),
        confidence_signal_snapshot=confidence_signals(),
        status=ReviewStatus.REVIEW_REQUIRED,
        review_required=True,
        reason_codes=("model_classification_requires_human_review",),
    )
    assert artifact == expected


@pytest.mark.parametrize(
    "missing_field",
    [
        "agent1_evaluation",
        "role_policies",
        "extraction_summary",
        "confidence_assessment",
        "confidence_shadow_record",
        "confidence_policy_snapshot",
        "confidence_signals",
    ],
)
def test_private_analysis_refuses_incomplete_or_failed_agent1_state(
    missing_field: str,
) -> None:
    state = {
        "output": final_response(),
        "agent1_evaluation": build_agent1_evaluation(agent1_output(), policies()),
        "agent2_question_plan": agent2_output(),
        "role_policies": policies(),
        "extraction_summary": extraction_summary(),
        "confidence_assessment": confidence_assessment(),
        "confidence_shadow_record": confidence_shadow(),
        "confidence_policy_snapshot": confidence_policy(),
        "confidence_signals": confidence_signals(),
    }
    state.pop(missing_field)

    with pytest.raises(ResumeReviewWorkflowExecutionError):
        run(StateBackedRuntime(state).analyze_for_human_review(request()))
