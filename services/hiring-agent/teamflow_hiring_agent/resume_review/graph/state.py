"""Typed, invocation-local state for résumé review.

The graph has no checkpointer. PDF bytes, Base64 data, and embedding vectors never enter
this state; canonical text/source blocks exist only for this bounded invocation.
"""

from __future__ import annotations

import operator
from typing import Annotated, TypedDict

from ..confidence import ConfidencePolicy, ConfidenceShadowRecord, ConfidenceSignal
from ..contracts import (
    Agent1Evaluation,
    Agent1ModelOutput,
    Agent2PlanningContext,
    Agent2QuestionPlan,
    ConfidenceAssessment,
    RoleScoringPolicy,
)
from ..workflow_contracts import (
    DocumentMetadata,
    ExtractionStatus,
    ExtractionSummary,
    PersistenceStatus,
    QuestionsStatus,
    ResumeReviewRequest,
    ResumeReviewResponse,
    ReviewStatus,
)


class ResumeReviewState(TypedDict, total=False):
    request: ResumeReviewRequest
    document_metadata: DocumentMetadata
    extraction_summary: ExtractionSummary
    role_policies: tuple[RoleScoringPolicy, ...]
    agent1_model_output: Agent1ModelOutput
    agent1_evaluation: Agent1Evaluation
    agent2_context: Agent2PlanningContext
    agent2_question_plan: Agent2QuestionPlan
    confidence_signals: tuple[ConfidenceSignal, ...]
    confidence_policy_snapshot: ConfidencePolicy
    confidence_assessment: ConfidenceAssessment
    confidence_shadow_record: ConfidenceShadowRecord
    extraction_validated: bool
    context_validated: bool
    agent1_schema_validated: bool
    provider_completed: bool
    evidence_validated: bool
    safety_validated: bool
    score_calculation_validated: bool
    failure_code: str
    review_required: bool
    agent2_ready: bool
    status: ReviewStatus
    questions_status: QuestionsStatus
    extraction_status: ExtractionStatus
    embedding_available: bool
    persistence_status: PersistenceStatus
    reason_codes: Annotated[list[str], operator.add]
    node_trace: Annotated[list[str], operator.add]
    output: ResumeReviewResponse
