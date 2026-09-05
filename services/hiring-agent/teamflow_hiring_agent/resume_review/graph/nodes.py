"""Deterministic nodes for the two-agent résumé-review graph."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar

from langchain_core.messages import AIMessage
from pydantic import BaseModel, ValidationError

from ...reliability import InvalidModelOutputError, ModelSafetyError, validate_ai_message
from ...security import contains_instructional_manipulation
from ..confidence import (
    ConfidencePolicy,
    build_shadow_record,
    derive_confidence_signals,
    has_structural_evidence_conflict,
    load_default_confidence_policy,
)
from ..confidence import (
    assess_confidence as apply_confidence_policy,
)
from ..contracts import (
    Agent1Evaluation,
    Agent1ModelOutput,
    Agent2QuestionPlan,
    CriterionStatus,
    RoleScoringPolicy,
)
from ..evidence import (
    EvidenceValidationError,
    validate_agent1_evidence,
    validate_question_plan_safety,
    validate_role_policy_safety,
)
from ..fingerprints import role_policy_fingerprint
from ..prompts import build_agent1_messages, build_agent2_messages
from ..scoring import (
    ResumeReviewContractError,
    build_agent1_evaluation,
    build_agent2_planning_context,
    validate_agent1_evaluation_against_policies,
)
from ..workflow_contracts import (
    DocumentMetadata,
    DocumentSourceBlock,
    ExtractionStatus,
    ExtractionSummary,
    PersistenceStatus,
    QuestionsStatus,
    ResumeReviewResponse,
    ReviewStatus,
    StoredDocumentExtraction,
    StoredExtractionQuality,
)
from .state import ResumeReviewState

logger = logging.getLogger(__name__)
MAX_ACTIVE_ROLES = 5
MAX_TOTAL_CRITERIA = 30


class AsyncRunnable(Protocol):
    async def ainvoke(self, input: Any, **kwargs: Any) -> Any: ...


class DocumentLoader(Protocol):
    async def load_metadata(
        self, *, merchant_id: str, document_id: str, candidate_id: str | None
    ) -> DocumentMetadata | dict[str, Any]: ...

    async def ensure_extraction(
        self, *, merchant_id: str, document_id: str, candidate_id: str | None
    ) -> ExtractionSummary | dict[str, Any]: ...

    async def load_source_blocks(
        self, *, merchant_id: str, document_id: str, candidate_id: str | None
    ) -> Iterable[DocumentSourceBlock | dict[str, Any]]: ...


class ActiveRoleLoader(Protocol):
    async def load_active_roles(
        self, *, merchant_id: str, limit: int
    ) -> Iterable[RoleScoringPolicy | dict[str, Any]]: ...


class ReviewWriter(Protocol):
    async def persist(self, **kwargs: Any) -> Any: ...


@dataclass(frozen=True, slots=True)
class ResumeReviewDependencies:
    document_loader: DocumentLoader
    active_role_loader: ActiveRoleLoader
    agent1_model: AsyncRunnable
    agent2_model: AsyncRunnable
    review_writer: ReviewWriter | None = None
    confidence_policy: ConfidencePolicy = field(default_factory=load_default_confidence_policy)


ModelContract = TypeVar("ModelContract", bound=BaseModel)


def _unwrap_structured(value: Any) -> Any:
    if isinstance(value, dict) and "raw" in value:
        raw = value.get("raw")
        if isinstance(raw, AIMessage):
            validate_ai_message(raw, require_content=False)
        if value.get("parsing_error") is not None:
            raise InvalidModelOutputError("structured model output failed validation")
        return value.get("parsed")
    return value


async def _invoke_structured(
    model: AsyncRunnable,
    messages: Any,
    contract: type[ModelContract],
) -> ModelContract:
    """Retry one schema-invalid completion; provider and safety failures are not retried."""

    for attempt in range(2):
        try:
            raw = _unwrap_structured(await model.ainvoke(messages))
            if raw is None:
                raise InvalidModelOutputError("structured model output was empty")
            return raw if isinstance(raw, contract) else contract.model_validate(raw)
        except ModelSafetyError:
            raise
        except (InvalidModelOutputError, ValidationError, ValueError) as exc:
            if attempt == 1:
                raise InvalidModelOutputError("structured model output failed validation") from exc
    raise AssertionError("unreachable structured-output retry state")


def _with_application_limitations(evaluation: Agent1Evaluation) -> Agent1Evaluation:
    """Replace model free text with bounded facts derived from validated classifications."""

    limitations = tuple(
        f"Role {role.role_id}: {unknown_count} "
        f"{'criterion remains' if unknown_count == 1 else 'criteria remain'} unknown."
        for role in evaluation.ranked_roles
        if (
            unknown_count := sum(
                assessment.status is CriterionStatus.UNKNOWN
                for assessment in role.criterion_assessments
            )
        )
    )
    return Agent1Evaluation(
        schema_version="1.0",
        ranked_roles=evaluation.ranked_roles,
        recommended_role_id=evaluation.recommended_role_id,
        limitations=limitations,
    )


def _effective_status(state: ResumeReviewState) -> ReviewStatus:
    if state.get("review_required", False):
        return ReviewStatus.REVIEW_REQUIRED
    if state.get("reason_codes"):
        return ReviewStatus.DEGRADED
    return ReviewStatus.COMPLETE


def _build_document_snapshot(
    metadata: DocumentMetadata,
    extraction: ExtractionSummary,
    raw_blocks: Iterable[DocumentSourceBlock | dict[str, Any]],
) -> StoredDocumentExtraction:
    blocks = tuple(
        block
        if isinstance(block, DocumentSourceBlock)
        else DocumentSourceBlock.model_validate(block)
        for block in raw_blocks
    )
    text = "\n\n".join(block.text for block in blocks)
    return StoredDocumentExtraction(
        schema_version="1.0",
        merchant_id=metadata.merchant_id,
        document_id=metadata.document_id,
        content_sha256=metadata.content_sha256,
        snapshot_sha256=extraction.snapshot_sha256,
        status=extraction.status,
        text=text,
        source_blocks=blocks,
        extraction_method=extraction.extraction_method,
        model_id=extraction.model_id,
        embedding_available=extraction.embedding_available,
        mock=False,
        warnings=extraction.warnings,
        quality=StoredExtractionQuality(
            assessment="usable",
            character_count=extraction.character_count,
            block_count=extraction.block_count,
            page_count=extraction.page_count,
            reason_codes=(),
        ),
    )


def create_resume_review_nodes(
    dependencies: ResumeReviewDependencies,
    *,
    model_timeout_seconds: float = 12.0,
) -> dict[str, Any]:
    # The graph is compiled per invocation in production. Private source blocks remain
    # in this closure only; they never enter returned or checkpointable graph state.
    document_cache: dict[tuple[str, str], StoredDocumentExtraction] = {}

    def cache_key(state: ResumeReviewState) -> tuple[str, str]:
        request = state["request"]
        return request.merchant_id, request.document_id

    async def load_document(state: ResumeReviewState) -> dict[str, Any]:
        request = state["request"]
        try:
            raw = await dependencies.document_loader.load_metadata(
                merchant_id=request.merchant_id,
                document_id=request.document_id,
                candidate_id=request.candidate_id,
            )
            metadata = (
                raw if isinstance(raw, DocumentMetadata) else DocumentMetadata.model_validate(raw)
            )
            if metadata.merchant_id != request.merchant_id:
                return {
                    "failure_code": "tenant_mismatch",
                    "reason_codes": ["tenant_mismatch"],
                    "node_trace": ["load_document"],
                }
            if metadata.document_id != request.document_id:
                raise ValueError("document ID mismatch")
            return {"document_metadata": metadata, "node_trace": ["load_document"]}
        except Exception as exc:
            logger.warning("Resume document load failed with %s", type(exc).__name__)
            return {
                "failure_code": "document_unavailable",
                "reason_codes": ["document_unavailable"],
                "node_trace": ["load_document"],
            }

    async def extract_document(state: ResumeReviewState) -> dict[str, Any]:
        request = state["request"]
        try:
            raw = await dependencies.document_loader.ensure_extraction(
                merchant_id=request.merchant_id,
                document_id=request.document_id,
                candidate_id=request.candidate_id,
            )
            extraction = (
                raw if isinstance(raw, ExtractionSummary) else ExtractionSummary.model_validate(raw)
            )
            if extraction.merchant_id != request.merchant_id:
                return {
                    "failure_code": "tenant_mismatch",
                    "reason_codes": ["tenant_mismatch"],
                    "node_trace": ["extract_document"],
                }
            if extraction.document_id != request.document_id:
                raise ValueError("document ID mismatch")
            return {
                "extraction_summary": extraction,
                "extraction_status": extraction.status,
                "embedding_available": extraction.embedding_available,
                "node_trace": ["extract_document"],
            }
        except Exception as exc:
            logger.warning("Stored extraction load failed with %s", type(exc).__name__)
            return {
                "failure_code": "invalid_extraction",
                "reason_codes": ["invalid_extraction"],
                "node_trace": ["extract_document"],
            }

    async def validate_extraction(state: ResumeReviewState) -> dict[str, Any]:
        request = state["request"]
        try:
            raw_blocks = await dependencies.document_loader.load_source_blocks(
                merchant_id=request.merchant_id,
                document_id=request.document_id,
                candidate_id=request.candidate_id,
            )
            document = _build_document_snapshot(
                state["document_metadata"], state["extraction_summary"], raw_blocks
            )
            if contains_instructional_manipulation(document.text):
                return {
                    "failure_code": "document_instruction_detected",
                    "reason_codes": ["document_instruction_detected"],
                    "node_trace": ["validate_extraction"],
                }
            document_cache[cache_key(state)] = document
            reason_codes: list[str] = []
            if document.status is ExtractionStatus.DEGRADED:
                reason_codes.append("extraction_degraded")
            if not document.embedding_available:
                reason_codes.append("embedding_unavailable")
            return {
                "reason_codes": reason_codes,
                "extraction_validated": True,
                "node_trace": ["validate_extraction"],
            }
        except Exception as exc:
            logger.warning("Stored extraction validation failed with %s", type(exc).__name__)
            return {
                "failure_code": "invalid_extraction",
                "reason_codes": ["invalid_extraction"],
                "node_trace": ["validate_extraction"],
            }

    async def load_active_roles(state: ResumeReviewState) -> dict[str, Any]:
        request = state["request"]
        try:
            raw_policies = tuple(
                await dependencies.active_role_loader.load_active_roles(
                    merchant_id=request.merchant_id,
                    limit=MAX_ACTIVE_ROLES,
                )
            )
            if not raw_policies:
                return {
                    "failure_code": "no_active_roles",
                    "reason_codes": ["no_active_roles"],
                    "node_trace": ["load_active_roles"],
                }
            if len(raw_policies) > MAX_ACTIVE_ROLES:
                raise ValueError("active role catalog exceeds limit")
            policies = tuple(
                policy
                if isinstance(policy, RoleScoringPolicy)
                else RoleScoringPolicy.model_validate(policy)
                for policy in raw_policies
            )
            policies = tuple(sorted(policies, key=lambda policy: policy.role_id))
            if sum(len(policy.criteria) for policy in policies) > MAX_TOTAL_CRITERIA:
                raise ValueError("active role catalog exceeds criterion budget")
            validate_role_policy_safety(policies)
            return {
                "role_policies": policies,
                "context_validated": True,
                "node_trace": ["load_active_roles"],
            }
        except Exception as exc:
            logger.warning("Active role load failed with %s", type(exc).__name__)
            return {
                "failure_code": "active_roles_unavailable",
                "reason_codes": ["active_roles_unavailable"],
                "node_trace": ["load_active_roles"],
            }

    async def agent1_evaluate(state: ResumeReviewState) -> dict[str, Any]:
        try:
            async with asyncio.timeout(model_timeout_seconds):
                output = await _invoke_structured(
                    dependencies.agent1_model,
                    build_agent1_messages(document_cache[cache_key(state)], state["role_policies"]),
                    Agent1ModelOutput,
                )
            return {
                "agent1_model_output": output,
                "agent1_schema_validated": True,
                "provider_completed": True,
                "node_trace": ["agent1_evaluate"],
            }
        except ModelSafetyError:
            return {
                "failure_code": "agent1_refused",
                "reason_codes": ["agent1_refused"],
                "node_trace": ["agent1_evaluate"],
            }
        except InvalidModelOutputError:
            return {
                "failure_code": "agent1_invalid_output",
                "reason_codes": ["agent1_invalid_output"],
                "node_trace": ["agent1_evaluate"],
            }
        except Exception as exc:
            logger.warning("Agent 1 provider failed with %s", type(exc).__name__)
            return {
                "failure_code": "agent1_provider_failed",
                "reason_codes": ["agent1_provider_failed"],
                "node_trace": ["agent1_evaluate"],
            }

    async def validate_evidence(state: ResumeReviewState) -> dict[str, Any]:
        try:
            validate_agent1_evidence(
                state["agent1_model_output"],
                state["role_policies"],
                document_cache[cache_key(state)],
            )
            if has_structural_evidence_conflict(
                state["agent1_model_output"],
                state["role_policies"],
            ):
                return {
                    "failure_code": "conflicting_evidence",
                    "reason_codes": ["conflicting_evidence"],
                    "evidence_validated": True,
                    "safety_validated": True,
                    "node_trace": ["validate_evidence"],
                }
            return {
                "evidence_validated": True,
                "safety_validated": True,
                "node_trace": ["validate_evidence"],
            }
        except (EvidenceValidationError, ResumeReviewContractError, ValueError) as exc:
            logger.warning("Agent 1 evidence rejected with %s", type(exc).__name__)
            return {
                "failure_code": "agent1_invalid_evidence",
                "reason_codes": ["agent1_invalid_evidence"],
                "node_trace": ["validate_evidence"],
            }

    async def calculate_scores(state: ResumeReviewState) -> dict[str, Any]:
        try:
            evaluation = _with_application_limitations(
                build_agent1_evaluation(state["agent1_model_output"], state["role_policies"])
            )
            return {
                "agent1_evaluation": evaluation,
                "score_calculation_validated": True,
                "node_trace": ["calculate_scores"],
            }
        except (ResumeReviewContractError, ValidationError, ValueError) as exc:
            logger.warning("Deterministic score calculation failed with %s", type(exc).__name__)
            return {
                "failure_code": "score_calculation_failed",
                "reason_codes": ["score_calculation_failed"],
                "node_trace": ["calculate_scores"],
            }

    async def assess_confidence(state: ResumeReviewState) -> dict[str, Any]:
        """Compute shadow confidence; only explicit hard failures can affect routing."""

        try:
            signals = derive_confidence_signals(state)
            assessment = apply_confidence_policy(signals, dependencies.confidence_policy)
        except Exception as exc:
            logger.error(
                "Résumé-review confidence policy failed with %s",
                type(exc).__name__,
            )
            return {
                "status": ReviewStatus.REVIEW_REQUIRED,
                "review_required": True,
                "agent2_ready": False,
                "questions_status": QuestionsStatus.SKIPPED,
                "reason_codes": ["confidence_policy_failed"],
                "node_trace": ["assess_confidence"],
            }
        if assessment.hard_failure:
            decision: dict[str, Any] = {
                "status": ReviewStatus.REVIEW_REQUIRED,
                "review_required": True,
                "agent2_ready": False,
                "questions_status": QuestionsStatus.SKIPPED,
            }
            if not state.get("failure_code"):
                hard_reasons = tuple(
                    dict.fromkeys(
                        reason
                        for signal in signals
                        if signal.hard_failure or signal.score is None
                        for reason in signal.reason_codes
                    )
                )
                decision["reason_codes"] = list(hard_reasons or ("confidence_hard_failure",))
        else:
            evaluation = state["agent1_evaluation"]
            if evaluation.recommended_role_id is None:
                decision = {
                    "status": ReviewStatus.REVIEW_REQUIRED,
                    "review_required": True,
                    "agent2_ready": False,
                    "questions_status": QuestionsStatus.SKIPPED,
                    "reason_codes": ["recommendation_not_unique"],
                }
            else:
                context = build_agent2_planning_context(evaluation, state["role_policies"])
                if not context.gaps:
                    decision = {
                        "agent2_context": context,
                        "agent2_ready": False,
                        "review_required": True,
                        "status": ReviewStatus.REVIEW_REQUIRED,
                        "questions_status": QuestionsStatus.NOT_REQUIRED,
                        "reason_codes": ["model_classification_requires_human_review"],
                    }
                elif len(context.gaps) > 10:
                    decision = {
                        "agent2_context": context,
                        "agent2_ready": False,
                        "review_required": True,
                        "status": ReviewStatus.REVIEW_REQUIRED,
                        "questions_status": QuestionsStatus.SKIPPED,
                        "reason_codes": ["question_limit_exceeded"],
                    }
                else:
                    decision = {
                        "agent2_context": context,
                        "agent2_ready": True,
                        "review_required": True,
                        "status": ReviewStatus.REVIEW_REQUIRED,
                        "reason_codes": ["model_classification_requires_human_review"],
                    }

        return {
            **decision,
            "confidence_signals": signals,
            "confidence_policy_snapshot": dependencies.confidence_policy,
            "confidence_assessment": assessment,
            "node_trace": ["assess_confidence"],
        }

    async def agent2_generate_questions(state: ResumeReviewState) -> dict[str, Any]:
        try:
            async with asyncio.timeout(model_timeout_seconds):
                plan = await _invoke_structured(
                    dependencies.agent2_model,
                    build_agent2_messages(state["agent2_context"]),
                    Agent2QuestionPlan,
                )
            return {"agent2_question_plan": plan, "node_trace": ["agent2_generate_questions"]}
        except ModelSafetyError:
            return {
                "questions_status": QuestionsStatus.DEGRADED,
                "reason_codes": ["agent2_refused"],
                "node_trace": ["agent2_generate_questions"],
            }
        except InvalidModelOutputError:
            return {
                "questions_status": QuestionsStatus.DEGRADED,
                "reason_codes": ["agent2_invalid_output"],
                "node_trace": ["agent2_generate_questions"],
            }
        except Exception as exc:
            logger.warning("Agent 2 provider failed with %s", type(exc).__name__)
            return {
                "questions_status": QuestionsStatus.DEGRADED,
                "reason_codes": ["agent2_provider_failed"],
                "node_trace": ["agent2_generate_questions"],
            }

    async def validate_questions(state: ResumeReviewState) -> dict[str, Any]:
        try:
            validate_question_plan_safety(
                state["agent2_context"],
                state["agent2_question_plan"],
                evaluation=state["agent1_evaluation"],
                policies=state["role_policies"],
            )
            return {
                "questions_status": QuestionsStatus.COMPLETE,
                "node_trace": ["validate_questions"],
            }
        except (EvidenceValidationError, ResumeReviewContractError, ValueError) as exc:
            logger.warning("Agent 2 questions rejected with %s", type(exc).__name__)
            return {
                "agent2_question_plan": None,
                "questions_status": QuestionsStatus.DEGRADED,
                "reason_codes": ["questions_invalid"],
                "node_trace": ["validate_questions"],
            }

    async def finalize_confidence(state: ResumeReviewState) -> dict[str, Any]:
        """Bind confidence provenance to the final post-Agent-2 disposition."""

        status = state.get("status") or _effective_status(state)
        review_required = state.get("review_required", False)
        try:
            shadow = build_shadow_record(
                state["confidence_assessment"],
                dependencies.confidence_policy,
                signals=state["confidence_signals"],
                review_required=review_required,
                status=status,
            )
        except Exception as exc:
            logger.error(
                "Résumé-review final confidence provenance failed with %s",
                type(exc).__name__,
            )
            return {
                "status": ReviewStatus.REVIEW_REQUIRED,
                "review_required": True,
                "agent2_ready": False,
                "questions_status": QuestionsStatus.SKIPPED,
                "reason_codes": ["confidence_policy_failed"],
                "node_trace": ["finalize_confidence"],
            }
        try:
            logger.info(
                "Résumé-review confidence finalized in shadow mode",
                extra={
                    "confidence_policy_id": shadow.policy_identity.policy_id,
                    "confidence_policy_version": shadow.policy_identity.policy_version,
                    "confidence_policy_sha256": shadow.policy_sha256,
                    "confidence_threshold_applied": False,
                },
            )
        except Exception:
            # Observability must never become a candidate decision boundary.
            pass
        return {
            "status": status,
            "confidence_shadow_record": shadow,
            "node_trace": ["finalize_confidence"],
        }

    async def guarded_persistence(state: ResumeReviewState) -> dict[str, Any]:
        request = state["request"]
        if not request.persist:
            return {
                "persistence_status": PersistenceStatus.NOT_REQUESTED,
                "node_trace": ["guarded_persistence"],
            }
        if "agent1_evaluation" not in state or dependencies.review_writer is None:
            return {
                "persistence_status": PersistenceStatus.SKIPPED,
                "node_trace": ["guarded_persistence"],
            }
        if (
            "confidence_assessment" not in state
            or "confidence_shadow_record" not in state
            or "confidence_policy_snapshot" not in state
            or "confidence_signals" not in state
        ):
            return {
                "persistence_status": PersistenceStatus.FAILED,
                "reason_codes": ["persistence_failed"],
                "node_trace": ["guarded_persistence"],
            }
        try:
            document = document_cache[cache_key(state)]
            validate_agent1_evidence(state["agent1_model_output"], state["role_policies"], document)
            validate_agent1_evaluation_against_policies(
                state["agent1_evaluation"], state["role_policies"]
            )
            plan = (
                state.get("agent2_question_plan")
                if state.get("questions_status") is QuestionsStatus.COMPLETE
                else None
            )
            if plan is not None:
                validate_question_plan_safety(
                    state["agent2_context"],
                    plan,
                    evaluation=state["agent1_evaluation"],
                    policies=state["role_policies"],
                )
            await dependencies.review_writer.persist(
                request=request,
                evaluation=state["agent1_evaluation"],
                question_plan=plan,
                questions_status=state.get("questions_status", QuestionsStatus.NOT_REQUIRED),
                extraction_fingerprint=document.snapshot_sha256,
                policy_fingerprint=role_policy_fingerprint(state["role_policies"]),
                policy_snapshot=state["role_policies"],
                confidence_assessment=state["confidence_assessment"],
                confidence_shadow_record=state["confidence_shadow_record"],
                confidence_policy_snapshot=state["confidence_policy_snapshot"],
                confidence_signal_snapshot=state["confidence_signals"],
                status=state.get("status", _effective_status(state)),
                review_required=state.get("review_required", False),
                reason_codes=tuple(dict.fromkeys(state.get("reason_codes", []))),
            )
            return {
                "persistence_status": PersistenceStatus.SUCCEEDED,
                "node_trace": ["guarded_persistence"],
            }
        except Exception as exc:
            logger.warning("Résumé review persistence failed with %s", type(exc).__name__)
            return {
                "persistence_status": PersistenceStatus.FAILED,
                "reason_codes": ["persistence_failed"],
                "node_trace": ["guarded_persistence"],
            }

    async def assemble_response(state: ResumeReviewState) -> dict[str, Any]:
        reason_codes = tuple(dict.fromkeys(state.get("reason_codes", [])))
        review_required = state.get("review_required", False)
        status = state.get("status")
        if status is None:
            status = _effective_status(state)
        question_status = state.get("questions_status", QuestionsStatus.SKIPPED)
        question_plan = (
            state.get("agent2_question_plan")
            if question_status is QuestionsStatus.COMPLETE
            else None
        )
        output = ResumeReviewResponse(
            schema_version="1.0",
            request_id=state["request"].request_id,
            document_id=state["request"].document_id,
            status=status,
            review_required=review_required,
            agent1_evaluation=state.get("agent1_evaluation"),
            questions_status=question_status,
            question_plan=question_plan,
            persistence_status=state.get(
                "persistence_status",
                PersistenceStatus.SKIPPED
                if state["request"].persist
                else PersistenceStatus.NOT_REQUESTED,
            ),
            reason_codes=reason_codes,
            extraction_status=state.get("extraction_status"),
            embedding_available=state.get("embedding_available", False),
        )
        return {"output": output, "node_trace": ["assemble_response"]}

    return {
        "load_document": load_document,
        "extract_document": extract_document,
        "validate_extraction": validate_extraction,
        "load_active_roles": load_active_roles,
        "agent1_evaluate": agent1_evaluate,
        "validate_evidence": validate_evidence,
        "calculate_scores": calculate_scores,
        "assess_confidence": assess_confidence,
        "agent2_generate_questions": agent2_generate_questions,
        "validate_questions": validate_questions,
        "finalize_confidence": finalize_confidence,
        "guarded_persistence": guarded_persistence,
        "assemble_response": assemble_response,
    }
