"""Deterministic, threshold-free confidence assessment for résumé review.

The v1 numeric diagnostic is weighted known-criterion coverage, never a probability.
Separate zero-weight integrity gates can require review without disguising themselves
as measured numeric signals. Numeric scores remain shadow data until a validation-only
risk/coverage study supports a separate policy decision.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, StrictBool, StrictStr, StringConstraints, model_validator

from .contracts import (
    Agent1Evaluation,
    Agent1ModelOutput,
    ConfidenceAssessment,
    ConfidenceComponent,
    CriterionStatus,
    FrozenContract,
    Identifier,
    JsonInteger,
    PolicyIdentity,
    RoleScoringPolicy,
)
from .scoring import validate_agent1_evaluation_against_policies
from .workflow_contracts import ExtractionStatus, ReviewStatus, Sha256

DEFAULT_CONFIDENCE_POLICY_PATH = Path(__file__).with_name("confidence_policy_v1.json")
MAX_POLICY_BYTES = 64 * 1024


class ConfidenceSignalId(StrEnum):
    WORKFLOW_COMPLETION_GATE = "workflow_completion_gate"
    EXTRACTION_VALIDATION_GATE = "extraction_validation_gate"
    CONTEXT_VALIDATION_GATE = "context_validation_gate"
    AGENT1_SCHEMA_GATE = "agent1_schema_gate"
    LITERAL_GROUNDING_GATE = "literal_grounding_gate"
    CRITERIA_COVERAGE = "criteria_coverage"
    EVIDENCE_CONSISTENCY_GATE = "evidence_consistency_gate"
    SCORE_CALCULATION_GATE = "score_calculation_gate"
    PROVIDER_COMPLETION_GATE = "provider_completion_gate"
    SAFETY_VALIDATION_GATE = "safety_validation_gate"


class ConfidencePolicyComponent(FrozenContract):
    component_id: ConfidenceSignalId
    weight: JsonInteger = Field(ge=0, le=100)


class ConfidencePolicy(FrozenContract):
    schema_version: Literal["1.0"]
    policy_id: Identifier
    policy_version: Annotated[
        StrictStr,
        StringConstraints(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$"),
    ]
    mode: Literal["shadow"]
    status: Literal["uncalibrated"]
    components: Annotated[
        tuple[ConfidencePolicyComponent, ...],
        Field(min_length=len(ConfidenceSignalId), max_length=len(ConfidenceSignalId)),
    ]

    @model_validator(mode="after")
    def validate_complete_policy(self) -> ConfidencePolicy:
        identifiers = [component.component_id for component in self.components]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("confidence policy component IDs must be unique")
        if set(identifiers) != set(ConfidenceSignalId):
            raise ValueError("confidence policy must configure every supported signal exactly once")
        if sum(component.weight for component in self.components) != 100:
            raise ValueError("confidence policy weights must sum to 100")
        return self

    @property
    def identity(self) -> PolicyIdentity:
        return PolicyIdentity(
            policy_id=self.policy_id,
            policy_version=self.policy_version,
        )


class ConfidenceSignal(FrozenContract):
    component_id: ConfidenceSignalId
    score: JsonInteger | None = Field(default=None, ge=0, le=100)
    hard_failure: StrictBool = False
    reason_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)] = ()

    @model_validator(mode="after")
    def validate_signal(self) -> ConfidenceSignal:
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("confidence signal reason codes must be unique")
        if self.score is None and not self.hard_failure:
            raise ValueError("missing confidence signal scores must be hard failures")
        if self.hard_failure and not self.reason_codes:
            raise ValueError("hard-failure confidence signal requires a reason code")
        return self


class ConfidenceShadowRecord(FrozenContract):
    """Identifier-free but still sensitive hiring metadata for restricted telemetry."""

    schema_version: Literal["1.0"]
    mode: Literal["shadow"]
    score: JsonInteger = Field(ge=0, le=100)
    is_probability: Literal[False]
    hard_failure: StrictBool
    threshold_applied: Literal[False]
    review_required: StrictBool
    status: ReviewStatus
    reason_codes: Annotated[tuple[Identifier, ...], Field(max_length=20)]
    policy_identity: PolicyIdentity
    policy_sha256: Sha256

    @model_validator(mode="after")
    def validate_shadow_record(self) -> ConfidenceShadowRecord:
        if len(self.reason_codes) != len(set(self.reason_codes)):
            raise ValueError("shadow reason codes must be unique")
        if self.hard_failure and not self.review_required:
            raise ValueError("hard failures must require review")
        if self.review_required != (self.status is ReviewStatus.REVIEW_REQUIRED):
            raise ValueError("shadow review_required must match status")
        return self


class ConfidencePolicyError(ValueError):
    """A policy artifact or assessment input violated the confidence contract."""


def _canonical_policy_json(policy: ConfidencePolicy) -> str:
    return json.dumps(
        policy.model_dump(mode="json"),
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )


def confidence_policy_sha256(policy: ConfidencePolicy) -> str:
    return hashlib.sha256(_canonical_policy_json(policy).encode("utf-8")).hexdigest()


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ConfidencePolicyError(f"duplicate confidence policy key: {key}")
        result[key] = value
    return result


def load_confidence_policy(path: str | Path) -> ConfidencePolicy:
    source = Path(path)
    if source.is_symlink():
        raise ConfidencePolicyError("confidence policy may not be a symlink")
    if not source.exists() or not source.is_file():
        raise ConfidencePolicyError("confidence policy is not a regular file")
    if source.stat().st_size > MAX_POLICY_BYTES:
        raise ConfidencePolicyError("confidence policy exceeds the byte limit")
    try:
        payload = source.read_text(encoding="utf-8")
        value = json.loads(
            payload,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ConfidencePolicyError(f"non-finite confidence policy number: {value}")
            ),
        )
        if not isinstance(value, dict):
            raise ConfidencePolicyError("confidence policy root must be an object")
        policy = ConfidencePolicy.model_validate(value)
    except ConfidencePolicyError:
        raise
    except Exception as exc:
        raise ConfidencePolicyError("confidence policy failed strict validation") from exc
    if payload != _canonical_policy_json(policy) + "\n":
        raise ConfidencePolicyError("confidence policy must use canonical JSON serialization")
    return policy


@lru_cache(maxsize=1)
def load_default_confidence_policy() -> ConfidencePolicy:
    return load_confidence_policy(DEFAULT_CONFIDENCE_POLICY_PATH)


def _round_ratio(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        return 0
    return (numerator * 100 + denominator // 2) // denominator


def _confidence_signal(
    component_id: ConfidenceSignalId,
    score: int | None,
    *,
    hard_failure: bool = False,
    reason_codes: Iterable[str] = (),
) -> ConfidenceSignal:
    return ConfidenceSignal(
        component_id=component_id,
        score=score,
        hard_failure=hard_failure,
        reason_codes=tuple(dict.fromkeys(reason_codes)),
    )


def has_structural_evidence_conflict(
    output: Agent1ModelOutput,
    policies: tuple[RoleScoringPolicy, ...],
) -> bool:
    """Detect opposing classifications for the same configured criterion.

    Criterion identity is the normalized ``criterion_id`` plus configured criterion
    text.  Evidence quote spelling is deliberately not part of the comparison: two
    roles cannot classify the exact same configured requirement both met and not met
    merely by citing different or overlapping substrings.  Semantic contradictions
    between different criteria remain an evaluation limitation.
    """

    policy_by_role = {policy.role_id: policy for policy in policies}
    statuses_by_criterion: dict[tuple[str, str], set[CriterionStatus]] = {}
    for role in output.role_assessments:
        policy = policy_by_role.get(role.role_id)
        if policy is None:
            continue
        text_by_id = {
            criterion.criterion_id: " ".join(criterion.criterion_text.casefold().split())
            for criterion in policy.criteria
        }
        for assessment in role.criterion_assessments:
            key = (
                " ".join(assessment.criterion_id.casefold().split()),
                text_by_id.get(assessment.criterion_id, ""),
            )
            statuses_by_criterion.setdefault(key, set()).add(assessment.status)
    return any(
        CriterionStatus.MET in statuses and CriterionStatus.NOT_MET in statuses
        for statuses in statuses_by_criterion.values()
    )


def has_insufficient_recommendation_evidence(
    evaluation: Agent1Evaluation,
    policies: tuple[RoleScoringPolicy, ...],
) -> bool:
    """Require positive support to exceed all non-supporting weight for the top role.

    This is a structural human-review gate, not a calibrated acceptance threshold.
    Both known-negative and unresolved criteria keep a weakly supported leader from
    being presented as a complete recommendation.
    """

    if evaluation.recommended_role_id is None:
        return False
    policy_by_role = {policy.role_id: policy for policy in policies}
    recommended = next(
        role for role in evaluation.ranked_roles if role.role_id == evaluation.recommended_role_id
    )
    policy = policy_by_role.get(recommended.role_id)
    if policy is None:
        return True
    status_by_criterion = {
        item.criterion_id: item.status for item in recommended.criterion_assessments
    }
    non_supporting_weight = sum(
        criterion.weight
        for criterion in policy.criteria
        if status_by_criterion.get(criterion.criterion_id) is not CriterionStatus.MET
    )
    return recommended.deterministic_score <= non_supporting_weight


def derive_confidence_signals(state: Mapping[str, Any]) -> tuple[ConfidenceSignal, ...]:
    """Derive only application-observable signals from trusted graph state."""

    failure_code = str(state.get("failure_code", ""))
    extraction = state.get("extraction_summary")
    policies = tuple(state.get("role_policies", ()))
    model_output = state.get("agent1_model_output")
    evaluation = state.get("agent1_evaluation")
    workflow_signal = _confidence_signal(
        ConfidenceSignalId.WORKFLOW_COMPLETION_GATE,
        0 if failure_code else 100,
        hard_failure=bool(failure_code),
        reason_codes=(failure_code,) if failure_code else (),
    )

    if extraction is None:
        extraction_signal = _confidence_signal(
            ConfidenceSignalId.EXTRACTION_VALIDATION_GATE,
            None,
            hard_failure=True,
            reason_codes=("extraction_signal_missing",),
        )
    elif not state.get("extraction_validated", False):
        extraction_signal = _confidence_signal(
            ConfidenceSignalId.EXTRACTION_VALIDATION_GATE,
            0,
            hard_failure=True,
            reason_codes=(
                "invalid_extraction"
                if failure_code == "invalid_extraction"
                else "extraction_validation_missing",
            ),
        )
    elif extraction.status is ExtractionStatus.DEGRADED:
        extraction_signal = _confidence_signal(
            ConfidenceSignalId.EXTRACTION_VALIDATION_GATE,
            100,
            reason_codes=("extraction_degraded",),
        )
    else:
        extraction_signal = _confidence_signal(
            ConfidenceSignalId.EXTRACTION_VALIDATION_GATE,
            100,
        )

    context_ready = bool(state.get("context_validated", False) and policies)
    context_signal = _confidence_signal(
        ConfidenceSignalId.CONTEXT_VALIDATION_GATE,
        100 if context_ready else None,
        hard_failure=not context_ready,
        reason_codes=() if context_ready else ("required_context_missing",),
    )

    structured_ready = bool(
        state.get("agent1_schema_validated", False) and isinstance(model_output, Agent1ModelOutput)
    )
    structured_reasons = (
        (failure_code,)
        if failure_code in {"agent1_refused", "agent1_invalid_output", "agent1_provider_failed"}
        else (() if structured_ready else ("structured_output_missing",))
    )
    structured_signal = _confidence_signal(
        ConfidenceSignalId.AGENT1_SCHEMA_GATE,
        100 if structured_ready else None,
        hard_failure=not structured_ready,
        reason_codes=structured_reasons,
    )

    grounding_ready = bool(state.get("evidence_validated", False) and structured_ready)
    grounding_reason = (
        "agent1_invalid_evidence"
        if failure_code == "agent1_invalid_evidence"
        else "grounding_signal_missing"
    )
    grounding_signal = _confidence_signal(
        ConfidenceSignalId.LITERAL_GROUNDING_GATE,
        100 if grounding_ready else (0 if failure_code == "agent1_invalid_evidence" else None),
        hard_failure=not grounding_ready,
        reason_codes=() if grounding_ready else (grounding_reason,),
    )

    if isinstance(evaluation, Agent1Evaluation) and policies:
        weights = {
            (policy.role_id, criterion.criterion_id): criterion.weight
            for policy in policies
            for criterion in policy.criteria
        }
        total_weight = sum(weights.values())
        covered_weight = sum(
            weights.get((role.role_id, item.criterion_id), 0)
            for role in evaluation.ranked_roles
            for item in role.criterion_assessments
            if item.status is not CriterionStatus.UNKNOWN
        )
        coverage_score = _round_ratio(covered_weight, total_weight)
        coverage_signal = _confidence_signal(
            ConfidenceSignalId.CRITERIA_COVERAGE,
            coverage_score,
            reason_codes=() if coverage_score == 100 else ("criteria_evidence_missing",),
        )
    else:
        coverage_signal = _confidence_signal(
            ConfidenceSignalId.CRITERIA_COVERAGE,
            None,
            hard_failure=True,
            reason_codes=("criteria_coverage_missing",),
        )

    if structured_ready and policies:
        conflict = has_structural_evidence_conflict(model_output, policies)
        sparse_recommendation = isinstance(
            evaluation, Agent1Evaluation
        ) and has_insufficient_recommendation_evidence(evaluation, policies)
        consistency_signal = _confidence_signal(
            ConfidenceSignalId.EVIDENCE_CONSISTENCY_GATE,
            0 if conflict or sparse_recommendation else 100,
            hard_failure=conflict or sparse_recommendation,
            reason_codes=(
                ("conflicting_evidence",)
                if conflict
                else (("recommendation_evidence_insufficient",) if sparse_recommendation else ())
            ),
        )
    else:
        consistency_signal = _confidence_signal(
            ConfidenceSignalId.EVIDENCE_CONSISTENCY_GATE,
            None,
            hard_failure=True,
            reason_codes=("evidence_consistency_missing",),
        )

    calculation_ready = bool(
        state.get("score_calculation_validated", False)
        and isinstance(evaluation, Agent1Evaluation)
        and policies
    )
    calculation_inconsistent = failure_code == "score_calculation_failed"
    if calculation_ready:
        try:
            validate_agent1_evaluation_against_policies(evaluation, policies)
        except Exception:
            calculation_ready = False
            calculation_inconsistent = True
    if calculation_ready:
        calculation_reasons: tuple[str, ...] = ()
    elif calculation_inconsistent:
        calculation_reasons = ("calculation_inconsistent",)
    else:
        calculation_reasons = ("calculation_signal_missing",)
    calculation_signal = _confidence_signal(
        ConfidenceSignalId.SCORE_CALCULATION_GATE,
        100 if calculation_ready else (0 if calculation_inconsistent else None),
        hard_failure=not calculation_ready,
        reason_codes=calculation_reasons,
    )

    provider_ready = bool(state.get("provider_completed", False) and structured_ready)
    provider_reason = (
        failure_code
        if failure_code in {"agent1_provider_failed", "agent1_refused"}
        else "provider_signal_missing"
    )
    provider_signal = _confidence_signal(
        ConfidenceSignalId.PROVIDER_COMPLETION_GATE,
        100 if provider_ready else (0 if failure_code == "agent1_provider_failed" else None),
        hard_failure=not provider_ready,
        reason_codes=() if provider_ready else (provider_reason,),
    )

    safety_failures = {"document_instruction_detected", "agent1_refused"}
    safety_observed = bool(state.get("safety_validated", False))
    safety_failed = failure_code in safety_failures
    safety_signal = _confidence_signal(
        ConfidenceSignalId.SAFETY_VALIDATION_GATE,
        0 if safety_failed else (100 if safety_observed else None),
        hard_failure=safety_failed or not safety_observed,
        reason_codes=(
            (failure_code,)
            if safety_failed
            else (() if safety_observed else ("safety_signal_missing",))
        ),
    )

    return (
        workflow_signal,
        extraction_signal,
        context_signal,
        structured_signal,
        grounding_signal,
        coverage_signal,
        consistency_signal,
        calculation_signal,
        provider_signal,
        safety_signal,
    )


def assess_confidence(
    signals: Iterable[ConfidenceSignal],
    policy: ConfidencePolicy,
) -> ConfidenceAssessment:
    """Apply a complete, versioned policy without selecting or applying a threshold."""

    supplied = tuple(signals)
    by_id = {signal.component_id: signal for signal in supplied}
    if len(by_id) != len(supplied):
        raise ConfidencePolicyError("confidence signals must be unique")

    components: list[ConfidenceComponent] = []
    aggregate_reasons: list[str] = []
    hard_failure = False
    weighted_total = 0
    for configured in policy.components:
        signal = by_id.get(configured.component_id)
        if signal is None:
            signal = _confidence_signal(
                configured.component_id,
                None,
                hard_failure=True,
                reason_codes=(f"missing_{configured.component_id.value}",),
            )
        score = signal.score if signal.score is not None else 0
        weighted_total += configured.weight * score
        hard_failure = hard_failure or signal.hard_failure or signal.score is None
        aggregate_reasons.extend(signal.reason_codes)
        components.append(
            ConfidenceComponent(
                component_id=configured.component_id.value,
                score=score,
                reason_codes=signal.reason_codes,
            )
        )

    extras = set(by_id).difference(component.component_id for component in policy.components)
    if extras:
        raise ConfidencePolicyError("confidence signal is not configured by the active policy")
    score = (weighted_total + 50) // 100
    reasons = tuple(dict.fromkeys(aggregate_reasons))
    if hard_failure and not reasons:
        reasons = ("confidence_hard_failure",)
    return ConfidenceAssessment(
        schema_version="1.0",
        score=score,
        is_probability=False,
        hard_failure=hard_failure,
        components=tuple(components),
        reason_codes=reasons,
        policy_identity=policy.identity,
    )


def validate_confidence_assessment(
    assessment: ConfidenceAssessment,
    policy: ConfidencePolicy,
    *,
    signals: Iterable[ConfidenceSignal],
) -> None:
    """Recompute and prove an assessment from its safe source signals and policy."""

    if assessment.policy_identity != policy.identity:
        raise ConfidencePolicyError("confidence assessment policy identity does not match")
    expected_ids = tuple(component.component_id.value for component in policy.components)
    actual_ids = tuple(component.component_id for component in assessment.components)
    if actual_ids != expected_ids:
        raise ConfidencePolicyError("confidence assessment components do not match policy order")
    score_by_id = {component.component_id: component.score for component in assessment.components}
    weighted_total = sum(
        component.weight * score_by_id[component.component_id.value]
        for component in policy.components
    )
    if assessment.score != (weighted_total + 50) // 100:
        raise ConfidencePolicyError("confidence assessment score does not match policy formula")
    expected = assess_confidence(tuple(signals), policy)
    if assessment != expected:
        raise ConfidencePolicyError(
            "confidence assessment hard failure or reasons do not match source signals"
        )


def build_shadow_record(
    assessment: ConfidenceAssessment,
    policy: ConfidencePolicy,
    *,
    signals: Iterable[ConfidenceSignal],
    review_required: bool,
    status: ReviewStatus,
) -> ConfidenceShadowRecord:
    validate_confidence_assessment(assessment, policy, signals=tuple(signals))
    return ConfidenceShadowRecord(
        schema_version="1.0",
        mode="shadow",
        score=assessment.score,
        is_probability=False,
        hard_failure=assessment.hard_failure,
        threshold_applied=False,
        review_required=review_required,
        status=status,
        reason_codes=assessment.reason_codes,
        policy_identity=assessment.policy_identity,
        policy_sha256=confidence_policy_sha256(policy),
    )
