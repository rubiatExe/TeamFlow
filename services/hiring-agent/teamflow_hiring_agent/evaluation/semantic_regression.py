"""Offline-only, human-bound semantic judge regression comparison.

This module consumes immutable cached judge artifacts.  It never calls a model,
selects a routing threshold, writes a baseline, or participates in hiring runtime.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from datetime import datetime
from enum import StrEnum
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal

from pydantic import (
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    StringConstraints,
    field_validator,
    model_validator,
)

from .diagnostic_judge import (
    CachedJudgeInput,
    CachedJudgeOutput,
    DiagnosticJudgeRunManifest,
    JudgeConfiguration,
    JudgeDimension,
    JudgeExecutionStatus,
    JudgeProducerKind,
    JudgeVerdict,
    cached_judge_input_fingerprint,
    cached_judge_output_fingerprint,
    judge_run_manifest_fingerprint,
)
from .fingerprints import case_input_fingerprint, ordered_digest, sha256_bytes
from .loader import sha256_file
from .models import DatasetPurpose, DatasetSplit, FrozenModel, Identifier, Sha256, Version
from .risk_coverage import (
    VerifiedValidationPopulation,
    load_verified_validation_population,
)
from .serialization import canonical_json, jsonl_bytes

ArtifactFile = Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]
Rate = Annotated[StrictFloat, Field(ge=0.0, le=1.0, allow_inf_nan=False)]
MINIMUM_HUMAN_REVIEWS = 30
MINIMUM_PER_OVERALL_CLASS = 15


def _artifact_fingerprint(value: FrozenModel, *, domain: str) -> str:
    return hashlib.sha256(
        canonical_json({"artifact": value.model_dump(mode="json"), "domain": domain}).encode()
    ).hexdigest()


def _direct_file(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) != 1 or path.name in {"", ".", ".."}:
        raise ValueError("regression artifact file must be a direct relative file")
    return value


class HumanLabelStatus(StrEnum):
    FIXTURE_ONLY = "fixture_only"
    HUMAN_APPROVED = "human_approved"


class GateDecision(StrEnum):
    PASS = "pass"
    FAIL = "fail"
    FIXTURE_ONLY_NOT_EVIDENCE = "fixture_only_not_evidence"


class KappaStatus(StrEnum):
    DEFINED = "defined"
    NO_RESOLVED_HUMAN_LABELS = "undefined_no_resolved_human_labels"
    DEGENERATE = "undefined_degenerate_denominator"


class HumanDimensionLabel(FrozenModel):
    dimension: JudgeDimension
    verdict: JudgeVerdict
    pass_votes: StrictInt = Field(ge=0, le=100)
    fail_votes: StrictInt = Field(ge=0, le=100)
    abstain_votes: StrictInt = Field(ge=0, le=100)
    adjudicated: StrictBool

    @model_validator(mode="after")
    def validate_vote_resolution(self) -> HumanDimensionLabel:
        if self.pass_votes + self.fail_votes + self.abstain_votes < 1:
            raise ValueError("human label requires at least one reviewer vote")
        if self.adjudicated:
            if self.verdict is JudgeVerdict.UNCERTAIN:
                raise ValueError("adjudication must resolve to pass or fail")
            return self
        expected = (
            JudgeVerdict.PASS
            if self.pass_votes > self.fail_votes
            else (
                JudgeVerdict.FAIL if self.fail_votes > self.pass_votes else JudgeVerdict.UNCERTAIN
            )
        )
        if self.verdict is not expected:
            raise ValueError("non-adjudicated verdict must follow the reviewer vote majority")
        return self


def _overall_verdict(dimensions: Sequence[HumanDimensionLabel]) -> JudgeVerdict:
    verdicts = {item.verdict for item in dimensions}
    if JudgeVerdict.FAIL in verdicts:
        return JudgeVerdict.FAIL
    if JudgeVerdict.UNCERTAIN in verdicts:
        return JudgeVerdict.UNCERTAIN
    return JudgeVerdict.PASS


class HumanSemanticLabel(FrozenModel):
    """Adjudicated human target for one exact generator result, never a hiring label."""

    schema_version: Literal["1.0"] = "1.0"
    label_set_id: Identifier
    case_id: Identifier
    split: Literal[DatasetSplit.VALIDATION]
    case_input_fingerprint: Sha256
    semantic_target_fingerprint: Sha256
    generator_run_manifest_fingerprint: Sha256
    generator_configuration_fingerprint: Sha256
    agent1_result_fingerprint: Sha256
    question_plan_fingerprint: Sha256 | None
    dimensions: Annotated[
        tuple[HumanDimensionLabel, ...],
        Field(min_length=len(JudgeDimension), max_length=len(JudgeDimension)),
    ]
    overall_verdict: JudgeVerdict

    @model_validator(mode="after")
    def validate_dimensions(self) -> HumanSemanticLabel:
        if tuple(item.dimension for item in self.dimensions) != tuple(JudgeDimension):
            raise ValueError("human dimensions must be complete and in canonical rubric order")
        if self.overall_verdict is not _overall_verdict(self.dimensions):
            raise ValueError("human overall verdict must be derived from dimension verdicts")
        return self


class HumanLabelApproval(FrozenModel):
    """Declared independent reviewers; each votes on every case and dimension."""

    approved_at: datetime
    reviewer_count: StrictInt = Field(ge=1, le=100)
    adjudicator_count: StrictInt = Field(ge=1, le=100)
    approval_reference: Identifier

    @field_validator("approved_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("approval timestamp must include a timezone")
        return value


class HumanSemanticLabelSetManifest(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    label_set_id: Identifier
    status: HumanLabelStatus
    dataset_name: Identifier
    dataset_version: Version
    dataset_fingerprint: Sha256
    split: Literal[DatasetSplit.VALIDATION]
    purpose: Literal[DatasetPurpose.VALIDATION]
    split_file_sha256: Sha256
    population_case_id_sha256: Sha256
    population_case_input_fingerprint_sha256: Sha256
    full_split_count: StrictInt = Field(ge=1)
    generator_run_manifest_fingerprint: Sha256
    generator_configuration_fingerprint: Sha256
    rubric_id: Identifier
    rubric_version: Version
    rubric_sha256: Sha256
    required_dimensions: Annotated[
        tuple[JudgeDimension, ...],
        Field(min_length=len(JudgeDimension), max_length=len(JudgeDimension)),
    ]
    labels_file: ArtifactFile
    labels_sha256: Sha256
    label_record_fingerprint_sha256: Sha256
    label_count: StrictInt = Field(ge=1)
    approval: HumanLabelApproval | None
    contains_resume_text: Literal[False]
    contains_free_form_rationale: Literal[False]
    contains_candidate_identifiers: Literal[False]
    contains_tenant_identifiers: Literal[False]
    contains_contact_details: Literal[False]
    contains_hiring_scores: Literal[False]

    @field_validator("labels_file")
    @classmethod
    def validate_labels_file(cls, value: str) -> str:
        return _direct_file(value)

    @model_validator(mode="after")
    def validate_manifest(self) -> HumanSemanticLabelSetManifest:
        if self.required_dimensions != tuple(JudgeDimension):
            raise ValueError("human label dimensions must be complete and canonical")
        if self.label_count != self.full_split_count:
            raise ValueError("human labels must cover the complete split population")
        if self.status is HumanLabelStatus.HUMAN_APPROVED and self.approval is None:
            raise ValueError("human-approved labels require approval metadata")
        if self.status is HumanLabelStatus.FIXTURE_ONLY and self.approval is not None:
            raise ValueError("fixture-only labels cannot claim human approval")
        return self


class SemanticRegressionPolicy(FrozenModel):
    """Versioned, non-calibrated rules for a non-compensating regression gate."""

    schema_version: Literal["1.0"] = "1.0"
    policy_id: Literal["semantic-regression-no-offset-v1"]
    policy_version: Literal["1.0.0"]
    minimum_human_reviews: Literal[30]
    minimum_per_overall_class: Literal[15]
    require_complete_validation_population: Literal[True]
    reject_execution_failures: Literal[True]
    require_defined_kappa: Literal[True]
    reject_unresolved_human_labels: Literal[True]
    reject_new_false_accepts: Literal[True]
    reject_new_false_rejects: Literal[True]
    reject_new_uncertainties: Literal[True]
    reject_pass_to_nonpass: Literal[True]
    reject_new_human_disagreements: Literal[True]
    allow_error_compensation: Literal[False]
    threshold_selected: Literal[False]
    calibrated: Literal[False]


def canonical_semantic_regression_policy() -> SemanticRegressionPolicy:
    return SemanticRegressionPolicy(
        policy_id="semantic-regression-no-offset-v1",
        policy_version="1.0.0",
        minimum_human_reviews=30,
        minimum_per_overall_class=15,
        require_complete_validation_population=True,
        reject_execution_failures=True,
        require_defined_kappa=True,
        reject_unresolved_human_labels=True,
        reject_new_false_accepts=True,
        reject_new_false_rejects=True,
        reject_new_uncertainties=True,
        reject_pass_to_nonpass=True,
        reject_new_human_disagreements=True,
        allow_error_compensation=False,
        threshold_selected=False,
        calibrated=False,
    )


def semantic_regression_policy_sha256(policy: SemanticRegressionPolicy) -> str:
    return _artifact_fingerprint(policy, domain="teamflow.semantic-regression-policy.v1")


class SemanticRegressionBaselineLock(FrozenModel):
    """Content-addressed baseline pointer; this package exposes no update operation."""

    schema_version: Literal["1.0"] = "1.0"
    lock_id: Identifier
    lock_version: Version
    baseline_run_id: Identifier
    baseline_run_manifest_file: ArtifactFile
    baseline_run_manifest_sha256: Sha256
    baseline_run_manifest_fingerprint: Sha256
    baseline_judge_configuration_fingerprint: Sha256
    baseline_input_record_fingerprint_sha256: Sha256
    baseline_output_record_fingerprint_sha256: Sha256
    dataset_fingerprint: Sha256
    split: Literal[DatasetSplit.VALIDATION]
    full_split_count: StrictInt = Field(ge=1)
    regression_policy: SemanticRegressionPolicy
    regression_policy_sha256: Sha256
    allowed_candidate_change_fields: Annotated[tuple[Identifier, ...], Field(max_length=24)]
    automatic_baseline_update: Literal[False]

    @field_validator("baseline_run_manifest_file")
    @classmethod
    def validate_manifest_file(cls, value: str) -> str:
        return _direct_file(value)

    @model_validator(mode="after")
    def validate_allowed_changes(self) -> SemanticRegressionBaselineLock:
        if self.allowed_candidate_change_fields != tuple(
            sorted(set(self.allowed_candidate_change_fields))
        ):
            raise ValueError("allowed candidate changes must be unique and canonical")
        canonical_policy = canonical_semantic_regression_policy()
        if (
            self.regression_policy != canonical_policy
            or self.regression_policy_sha256 != semantic_regression_policy_sha256(canonical_policy)
        ):
            raise ValueError("baseline lock regression policy is not canonical")
        return self


def semantic_target_fingerprint(record: CachedJudgeInput) -> str:
    """Bind human review to generator content while excluding judge/run identities."""

    payload = {
        "agent1_result_fingerprint": record.agent1_result_fingerprint,
        "case_id": record.case_id,
        "case_input_fingerprint": record.case_input_fingerprint,
        "dataset_fingerprint": record.dataset_fingerprint,
        "generator_configuration_fingerprint": record.generator_configuration_fingerprint,
        "generator_run_manifest_fingerprint": record.generator_run_manifest_fingerprint,
        "question_plan_fingerprint": record.question_plan_fingerprint,
        "source_kind": record.source_kind,
        "anonymization_approval_fingerprint": record.anonymization_approval_fingerprint,
        "split": record.split,
        "transient_payload_sha256": record.transient_payload_sha256,
    }
    return sha256_bytes(
        canonical_json({"domain": "teamflow.semantic-human-target.v1", "target": payload}).encode()
    )


def human_label_fingerprint(label: HumanSemanticLabel) -> str:
    return _artifact_fingerprint(label, domain="teamflow.semantic-human-label.v1")


def human_label_set_manifest_fingerprint(manifest: HumanSemanticLabelSetManifest) -> str:
    return _artifact_fingerprint(manifest, domain="teamflow.semantic-human-label-set.v1")


def baseline_lock_fingerprint(lock: SemanticRegressionBaselineLock) -> str:
    return _artifact_fingerprint(lock, domain="teamflow.semantic-regression-baseline-lock.v1")


class AgreementMetrics(FrozenModel):
    total: StrictInt = Field(ge=1)
    resolved_human_total: StrictInt = Field(ge=0)
    human_uncertain: StrictInt = Field(ge=0)
    judge_pass: StrictInt = Field(ge=0)
    judge_fail: StrictInt = Field(ge=0)
    judge_uncertain: StrictInt = Field(ge=0)
    agreements: StrictInt = Field(ge=0)
    false_accepts: StrictInt = Field(ge=0)
    false_rejects: StrictInt = Field(ge=0)
    errors: StrictInt = Field(ge=0)
    human_fail_denominator: StrictInt = Field(ge=0)
    human_pass_denominator: StrictInt = Field(ge=0)
    agreement_rate: Rate | None
    false_accept_rate: Rate | None
    false_reject_rate: Rate | None
    judge_error_rate: Rate | None
    cohen_kappa: Annotated[StrictFloat, Field(ge=-1.0, le=1.0, allow_inf_nan=False)] | None
    kappa_status: KappaStatus

    @model_validator(mode="after")
    def validate_denominators(self) -> AgreementMetrics:
        if self.resolved_human_total + self.human_uncertain != self.total:
            raise ValueError("resolved and uncertain human counts must equal total")
        if self.judge_pass + self.judge_fail + self.judge_uncertain != self.total:
            raise ValueError("judge verdict counts must equal total")
        if self.human_fail_denominator + self.human_pass_denominator != self.resolved_human_total:
            raise ValueError("human pass/fail denominators must equal resolved total")
        if self.errors != self.resolved_human_total - self.agreements:
            raise ValueError("error count must use the resolved-human denominator")
        expected = (
            None if not self.resolved_human_total else self.agreements / self.resolved_human_total
        )
        expected_error = (
            None if not self.resolved_human_total else self.errors / self.resolved_human_total
        )
        expected_fa = (
            None
            if not self.human_fail_denominator
            else self.false_accepts / self.human_fail_denominator
        )
        expected_fr = (
            None
            if not self.human_pass_denominator
            else self.false_rejects / self.human_pass_denominator
        )
        for actual, wanted, name in (
            (self.agreement_rate, expected, "agreement"),
            (self.judge_error_rate, expected_error, "judge error"),
            (self.false_accept_rate, expected_fa, "false accept"),
            (self.false_reject_rate, expected_fr, "false reject"),
        ):
            if wanted is None:
                if actual is not None:
                    raise ValueError(f"{name} rate must be null without a denominator")
            elif actual is None or not math.isclose(actual, wanted, rel_tol=0, abs_tol=1e-12):
                raise ValueError(f"{name} rate does not match its explicit denominator")
        if (self.cohen_kappa is None) != (self.kappa_status is not KappaStatus.DEFINED):
            raise ValueError("kappa value and status are inconsistent")
        return self


class RegressionSlice(FrozenModel):
    dimension: JudgeDimension | Literal["overall"]
    baseline: AgreementMetrics
    candidate: AgreementMetrics
    tied_predictions: StrictInt = Field(ge=0)
    new_false_accepts: StrictInt = Field(ge=0)
    new_false_rejects: StrictInt = Field(ge=0)
    new_uncertainties: StrictInt = Field(ge=0)
    pass_to_nonpass: StrictInt = Field(ge=0)
    new_disagreements: StrictInt = Field(ge=0)
    resolved_disagreements: StrictInt = Field(ge=0)


class SemanticRegressionReport(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    result_status: Literal["fixture_only_diagnostic", "human_approved_evidence"]
    gate_decision: GateDecision
    gate_failure_codes: Annotated[tuple[Identifier, ...], Field(max_length=16)]
    regression_policy: SemanticRegressionPolicy
    regression_policy_sha256: Sha256
    dataset_name: Identifier
    dataset_version: Version
    dataset_fingerprint: Sha256
    split: Literal[DatasetSplit.VALIDATION]
    full_split_count: StrictInt = Field(ge=1)
    baseline_run_id: Identifier
    baseline_run_manifest_fingerprint: Sha256
    baseline_lock_fingerprint: Sha256
    baseline_judge_configuration: JudgeConfiguration
    baseline_judge_configuration_fingerprint: Sha256
    candidate_run_id: Identifier
    candidate_run_manifest_fingerprint: Sha256
    candidate_judge_configuration: JudgeConfiguration
    candidate_judge_configuration_fingerprint: Sha256
    declared_judge_change_fields: Annotated[tuple[Identifier, ...], Field(max_length=24)]
    generator_provider: Identifier
    generator_model: StrictStr
    generator_run_manifest_fingerprint: Sha256
    generator_configuration_fingerprint: Sha256
    baseline_same_provider_as_generator: StrictBool
    candidate_same_provider_as_generator: StrictBool
    label_set_id: Identifier
    label_set_status: HumanLabelStatus
    label_set_manifest_fingerprint: Sha256
    label_count: StrictInt = Field(ge=1)
    human_overall_pass: StrictInt = Field(ge=0)
    human_overall_fail: StrictInt = Field(ge=0)
    human_overall_uncertain: StrictInt = Field(ge=0)
    reviewer_tied_dimension_count: StrictInt = Field(ge=0)
    baseline_operational_error_count: StrictInt = Field(ge=0)
    baseline_contract_failure_count: StrictInt = Field(ge=0)
    candidate_operational_error_count: StrictInt = Field(ge=0)
    candidate_contract_failure_count: StrictInt = Field(ge=0)
    minimum_human_reviews: Literal[30]
    minimum_per_overall_class: Literal[15]
    slices: Annotated[
        tuple[RegressionSlice, ...],
        Field(min_length=len(JudgeDimension) + 1, max_length=len(JudgeDimension) + 1),
    ]
    diagnostic_only: Literal[True]
    human_agreement_measured: StrictBool
    threshold_selected: Literal[False]
    calibrated: Literal[False]
    production_routing_authorized: Literal[False]
    contains_case_ids: Literal[False]
    contains_resume_text: Literal[False]
    contains_candidate_identifiers: Literal[False]
    contains_tenant_identifiers: Literal[False]
    contains_contact_details: Literal[False]
    contains_hiring_scores: Literal[False]

    @model_validator(mode="after")
    def validate_report(self) -> SemanticRegressionReport:
        canonical_policy = canonical_semantic_regression_policy()
        if (
            self.regression_policy != canonical_policy
            or self.regression_policy_sha256 != semantic_regression_policy_sha256(canonical_policy)
        ):
            raise ValueError("report regression policy is not canonical")
        expected_dimensions: tuple[JudgeDimension | str, ...] = (*tuple(JudgeDimension), "overall")
        if tuple(item.dimension for item in self.slices) != expected_dimensions:
            raise ValueError(
                "regression slices must contain each dimension and overall canonically"
            )
        if self.human_overall_pass + self.human_overall_fail + self.human_overall_uncertain != (
            self.label_count
        ):
            raise ValueError("overall human counts must equal label count")
        if self.gate_failure_codes != tuple(sorted(set(self.gate_failure_codes))):
            raise ValueError("gate failure codes must be unique and canonical")
        if self.label_set_status is HumanLabelStatus.FIXTURE_ONLY:
            if self.gate_decision is not GateDecision.FIXTURE_ONLY_NOT_EVIDENCE:
                raise ValueError("fixture labels can never produce a gate pass or fail")
            if self.result_status != "fixture_only_diagnostic" or self.human_agreement_measured:
                raise ValueError("fixture output must remain visibly non-evidence")
        else:
            expected = GateDecision.FAIL if self.gate_failure_codes else GateDecision.PASS
            if self.gate_decision is not expected:
                raise ValueError("human-approved gate decision does not match failure codes")
            if self.result_status != "human_approved_evidence" or not self.human_agreement_measured:
                raise ValueError("human-approved output must be marked as evidence")
        return self


class SemanticRegressionContractError(ValueError):
    """Cached artifacts are incomplete, mutable, or not comparable."""


def _records_digest(records: Sequence[FrozenModel], fingerprint) -> str:  # type: ignore[no-untyped-def]
    return ordered_digest(fingerprint(record) for record in records)


def _validate_population(
    manifest: DiagnosticJudgeRunManifest | HumanSemanticLabelSetManifest,
    population: VerifiedValidationPopulation,
) -> None:
    verified = population.verified_dataset
    expected = {
        "dataset_name": verified.manifest.dataset_name,
        "dataset_version": verified.manifest.dataset_version,
        "dataset_fingerprint": verified.dataset_fingerprint,
        "split": DatasetSplit.VALIDATION,
        "purpose": DatasetPurpose.VALIDATION,
        "split_file_sha256": population.split_manifest.sha256,
        "population_case_id_sha256": population.split_manifest.case_id_sha256,
        "population_case_input_fingerprint_sha256": (
            population.split_manifest.input_fingerprint_sha256
        ),
        "full_split_count": len(population.cases),
    }
    mismatches = [key for key, value in expected.items() if getattr(manifest, key) != value]
    if mismatches:
        raise SemanticRegressionContractError(
            f"artifact differs from the exact verified validation population: {mismatches}"
        )


def _validate_run(
    inputs: Sequence[CachedJudgeInput],
    outputs: Sequence[CachedJudgeOutput],
    manifest: DiagnosticJudgeRunManifest,
    population: VerifiedValidationPopulation,
) -> tuple[dict[str, CachedJudgeInput], dict[str, CachedJudgeOutput]]:
    _validate_population(manifest, population)
    ordered_inputs = tuple(sorted(inputs, key=lambda item: item.case_id))
    ordered_outputs = tuple(sorted(outputs, key=lambda item: item.case_id))
    if len({item.case_id for item in inputs}) != len(inputs):
        raise SemanticRegressionContractError("judge input case IDs must be unique")
    if len({item.case_id for item in outputs}) != len(outputs):
        raise SemanticRegressionContractError("judge output case IDs must be unique")
    expected_ids = {case.case_id for case in population.cases}
    if {item.case_id for item in inputs} != expected_ids or {
        item.case_id for item in outputs
    } != expected_ids:
        raise SemanticRegressionContractError(
            "judge artifacts must cover the complete validation split"
        )
    if len(inputs) != manifest.input_count or len(outputs) != manifest.output_count:
        raise SemanticRegressionContractError("judge manifest counts differ from cached records")
    if sha256_bytes(jsonl_bytes(ordered_inputs)) != manifest.inputs_sha256:
        raise SemanticRegressionContractError("cached judge input bytes differ from manifest")
    if sha256_bytes(jsonl_bytes(ordered_outputs)) != manifest.outputs_sha256:
        raise SemanticRegressionContractError("cached judge output bytes differ from manifest")
    if _records_digest(ordered_inputs, cached_judge_input_fingerprint) != (
        manifest.input_record_fingerprint_sha256
    ):
        raise SemanticRegressionContractError("cached judge input fingerprints differ")
    if _records_digest(ordered_outputs, cached_judge_output_fingerprint) != (
        manifest.output_record_fingerprint_sha256
    ):
        raise SemanticRegressionContractError("cached judge output fingerprints differ")
    completed = sum(
        item.execution_status is JudgeExecutionStatus.COMPLETED for item in ordered_outputs
    )
    operational = sum(
        item.execution_status is JudgeExecutionStatus.OPERATIONAL_ERROR for item in ordered_outputs
    )
    contract = sum(
        item.execution_status is JudgeExecutionStatus.CONTRACT_FAILURE for item in ordered_outputs
    )
    if (
        completed != manifest.completed_count
        or operational != manifest.operational_error_count
        or contract != manifest.contract_failure_count
    ):
        raise SemanticRegressionContractError("judge execution-status counts differ from manifest")
    if operational or contract:
        raise SemanticRegressionContractError(
            "semantic regression comparison requires every cached judge output to complete"
        )
    expected_input = {case.case_id: case_input_fingerprint(case) for case in population.cases}
    input_by_id = {item.case_id: item for item in inputs}
    output_by_id = {item.case_id: item for item in outputs}
    for case_id in sorted(expected_ids):
        judge_input = input_by_id[case_id]
        output = output_by_id[case_id]
        if (
            judge_input.run_id != manifest.run_id
            or judge_input.dataset_name != manifest.dataset_name
            or judge_input.dataset_version != manifest.dataset_version
            or judge_input.split is not manifest.split
            or judge_input.purpose is not manifest.purpose
            or judge_input.case_input_fingerprint != expected_input[case_id]
            or judge_input.dataset_fingerprint != manifest.dataset_fingerprint
            or judge_input.generator_run_manifest_fingerprint
            != manifest.generator_run_manifest_fingerprint
            or judge_input.generator_configuration_fingerprint
            != manifest.generator_configuration_fingerprint
            or judge_input.judge_configuration_fingerprint
            != manifest.judge_configuration_fingerprint
        ):
            raise SemanticRegressionContractError("cached judge input identity mismatch")
        if (
            output.run_id != manifest.run_id
            or output.judge_input_fingerprint != cached_judge_input_fingerprint(judge_input)
            or output.agent1_result_fingerprint != judge_input.agent1_result_fingerprint
            or output.question_plan_fingerprint != judge_input.question_plan_fingerprint
            or output.judge_configuration_fingerprint != manifest.judge_configuration_fingerprint
            or output.producer_kind is not manifest.producer_kind
        ):
            raise SemanticRegressionContractError("cached judge output linkage mismatch")
    return input_by_id, output_by_id


def _configuration_changes(
    baseline: JudgeConfiguration, candidate: JudgeConfiguration
) -> tuple[str, ...]:
    left = baseline.model_dump(mode="json")
    right = candidate.model_dump(mode="json")
    return tuple(sorted(key for key in left if left[key] != right[key]))


def _metrics(human: Sequence[JudgeVerdict], judge: Sequence[JudgeVerdict]) -> AgreementMetrics:
    resolved = [
        (h, j) for h, j in zip(human, judge, strict=True) if h is not JudgeVerdict.UNCERTAIN
    ]
    resolved_total = len(resolved)
    human_fail = sum(h is JudgeVerdict.FAIL for h, _ in resolved)
    human_pass = sum(h is JudgeVerdict.PASS for h, _ in resolved)
    agreements = sum(h is j for h, j in resolved)
    false_accepts = sum(h is JudgeVerdict.FAIL and j is JudgeVerdict.PASS for h, j in resolved)
    false_rejects = sum(h is JudgeVerdict.PASS and j is JudgeVerdict.FAIL for h, j in resolved)
    judge_counts = {verdict: sum(item is verdict for item in judge) for verdict in JudgeVerdict}
    if not resolved_total:
        kappa = None
        kappa_status = KappaStatus.NO_RESOLVED_HUMAN_LABELS
    else:
        observed = agreements / resolved_total
        expected = sum(
            (sum(h is verdict for h, _ in resolved) / resolved_total)
            * (sum(j is verdict for _, j in resolved) / resolved_total)
            for verdict in JudgeVerdict
        )
        if math.isclose(1.0 - expected, 0.0, rel_tol=0.0, abs_tol=1e-12):
            kappa = None
            kappa_status = KappaStatus.DEGENERATE
        else:
            kappa = (observed - expected) / (1.0 - expected)
            kappa_status = KappaStatus.DEFINED
    errors = resolved_total - agreements
    return AgreementMetrics(
        total=len(human),
        resolved_human_total=resolved_total,
        human_uncertain=len(human) - resolved_total,
        judge_pass=judge_counts[JudgeVerdict.PASS],
        judge_fail=judge_counts[JudgeVerdict.FAIL],
        judge_uncertain=judge_counts[JudgeVerdict.UNCERTAIN],
        agreements=agreements,
        false_accepts=false_accepts,
        false_rejects=false_rejects,
        errors=errors,
        human_fail_denominator=human_fail,
        human_pass_denominator=human_pass,
        agreement_rate=agreements / resolved_total if resolved_total else None,
        false_accept_rate=false_accepts / human_fail if human_fail else None,
        false_reject_rate=false_rejects / human_pass if human_pass else None,
        judge_error_rate=errors / resolved_total if resolved_total else None,
        cohen_kappa=kappa,
        kappa_status=kappa_status,
    )


def _slice(
    dimension: JudgeDimension | Literal["overall"],
    human: Sequence[JudgeVerdict],
    baseline: Sequence[JudgeVerdict],
    candidate: Sequence[JudgeVerdict],
) -> RegressionSlice:
    triples = tuple(zip(human, baseline, candidate, strict=True))
    resolved = tuple(item for item in triples if item[0] is not JudgeVerdict.UNCERTAIN)
    return RegressionSlice(
        dimension=dimension,
        baseline=_metrics(human, baseline),
        candidate=_metrics(human, candidate),
        tied_predictions=sum(left is right for _, left, right in triples),
        new_false_accepts=sum(
            h is JudgeVerdict.FAIL and c is JudgeVerdict.PASS and b is not JudgeVerdict.PASS
            for h, b, c in resolved
        ),
        new_false_rejects=sum(
            h is JudgeVerdict.PASS and c is JudgeVerdict.FAIL and b is not JudgeVerdict.FAIL
            for h, b, c in resolved
        ),
        new_uncertainties=sum(
            c is JudgeVerdict.UNCERTAIN and b is not JudgeVerdict.UNCERTAIN for _, b, c in resolved
        ),
        pass_to_nonpass=sum(
            b is JudgeVerdict.PASS and c is not JudgeVerdict.PASS for _, b, c in triples
        ),
        new_disagreements=sum(h is b and h is not c for h, b, c in resolved),
        resolved_disagreements=sum(h is not b and h is c for h, b, c in resolved),
    )


def build_semantic_regression_report(
    baseline_inputs: Sequence[CachedJudgeInput],
    baseline_outputs: Sequence[CachedJudgeOutput],
    candidate_inputs: Sequence[CachedJudgeInput],
    candidate_outputs: Sequence[CachedJudgeOutput],
    labels: Sequence[HumanSemanticLabel],
    *,
    baseline_manifest: DiagnosticJudgeRunManifest,
    candidate_manifest: DiagnosticJudgeRunManifest,
    label_manifest: HumanSemanticLabelSetManifest,
    baseline_lock: SemanticRegressionBaselineLock,
    dataset_directory: str | Path,
    allow_fixture_labels: bool = False,
) -> SemanticRegressionReport:
    """Compare two exact full-population caches without allowing errors to compensate."""

    population = load_verified_validation_population(dataset_directory)
    if label_manifest.status is HumanLabelStatus.FIXTURE_ONLY and not allow_fixture_labels:
        raise SemanticRegressionContractError(
            "fixture-only semantic labels require --allow-fixture-labels"
        )
    baseline_input_by_id, baseline_output_by_id = _validate_run(
        baseline_inputs, baseline_outputs, baseline_manifest, population
    )
    candidate_input_by_id, candidate_output_by_id = _validate_run(
        candidate_inputs, candidate_outputs, candidate_manifest, population
    )
    _validate_population(label_manifest, population)
    if baseline_manifest.run_id == candidate_manifest.run_id:
        raise SemanticRegressionContractError("baseline and candidate run IDs must differ")
    if (
        baseline_manifest.generator_run_manifest_fingerprint
        != candidate_manifest.generator_run_manifest_fingerprint
        or baseline_manifest.generator_configuration_fingerprint
        != candidate_manifest.generator_configuration_fingerprint
        or baseline_manifest.generator_provider != candidate_manifest.generator_provider
        or baseline_manifest.generator_model != candidate_manifest.generator_model
    ):
        raise SemanticRegressionContractError(
            "generator identity changes are incomparable and require a separately "
            "labeled population"
        )
    for field in ("rubric_id", "rubric_version", "rubric_sha256", "output_schema_sha256"):
        if getattr(baseline_manifest.judge_configuration, field) != getattr(
            candidate_manifest.judge_configuration, field
        ):
            raise SemanticRegressionContractError(f"judge {field} differs between runs")
    if baseline_manifest.producer_kind is not candidate_manifest.producer_kind:
        raise SemanticRegressionContractError("judge producer-kind changes are incomparable")
    if label_manifest.status is HumanLabelStatus.HUMAN_APPROVED and (
        baseline_manifest.producer_kind is not JudgeProducerKind.LIVE_PROVIDER
        or candidate_manifest.producer_kind is not JudgeProducerKind.LIVE_PROVIDER
    ):
        raise SemanticRegressionContractError("human evidence requires live-provider judge outputs")

    expected_baseline_manifest_fp = judge_run_manifest_fingerprint(baseline_manifest)
    if (
        baseline_lock.baseline_run_id != baseline_manifest.run_id
        or baseline_lock.baseline_run_manifest_fingerprint != expected_baseline_manifest_fp
        or baseline_lock.baseline_judge_configuration_fingerprint
        != baseline_manifest.judge_configuration_fingerprint
        or baseline_lock.baseline_input_record_fingerprint_sha256
        != baseline_manifest.input_record_fingerprint_sha256
        or baseline_lock.baseline_output_record_fingerprint_sha256
        != baseline_manifest.output_record_fingerprint_sha256
        or baseline_lock.dataset_fingerprint != baseline_manifest.dataset_fingerprint
        or baseline_lock.full_split_count != baseline_manifest.full_split_count
    ):
        raise SemanticRegressionContractError("baseline cache differs from its immutable lock")
    observed_changes = _configuration_changes(
        baseline_manifest.judge_configuration,
        candidate_manifest.judge_configuration,
    )
    if observed_changes != baseline_lock.allowed_candidate_change_fields:
        raise SemanticRegressionContractError(
            "candidate judge configuration changes differ from the baseline lock declaration"
        )

    if len({item.case_id for item in labels}) != len(labels):
        raise SemanticRegressionContractError("human label case IDs must be unique")
    expected_ids = {case.case_id for case in population.cases}
    label_by_id = {item.case_id: item for item in labels}
    if set(label_by_id) != expected_ids or len(labels) != label_manifest.label_count:
        raise SemanticRegressionContractError(
            "human labels must cover the complete validation split"
        )
    ordered_labels = tuple(sorted(labels, key=lambda item: item.case_id))
    if sha256_bytes(jsonl_bytes(ordered_labels)) != label_manifest.labels_sha256:
        raise SemanticRegressionContractError("human label bytes differ from their manifest")
    if _records_digest(ordered_labels, human_label_fingerprint) != (
        label_manifest.label_record_fingerprint_sha256
    ):
        raise SemanticRegressionContractError("human label fingerprints differ from their manifest")
    if (
        label_manifest.generator_run_manifest_fingerprint
        != baseline_manifest.generator_run_manifest_fingerprint
        or label_manifest.generator_configuration_fingerprint
        != baseline_manifest.generator_configuration_fingerprint
        or label_manifest.rubric_id != baseline_manifest.judge_configuration.rubric_id
        or label_manifest.rubric_version != baseline_manifest.judge_configuration.rubric_version
        or label_manifest.rubric_sha256 != baseline_manifest.judge_configuration.rubric_sha256
    ):
        raise SemanticRegressionContractError(
            "human label manifest targets another generator/rubric"
        )

    if label_manifest.status is HumanLabelStatus.HUMAN_APPROVED:
        approval = label_manifest.approval
        if approval is None:  # already rejected by the model; keep the trust boundary explicit
            raise SemanticRegressionContractError(
                "human-approved label manifest is missing approval metadata"
            )
        if any(
            dimension.pass_votes + dimension.fail_votes + dimension.abstain_votes
            != approval.reviewer_count
            for label in labels
            for dimension in label.dimensions
        ):
            raise SemanticRegressionContractError(
                "human vote totals must equal the declared reviewer count for every dimension"
            )

    case_ids = sorted(expected_ids)
    for case_id in case_ids:
        baseline_input = baseline_input_by_id[case_id]
        candidate_input = candidate_input_by_id[case_id]
        label = label_by_id[case_id]
        baseline_target = semantic_target_fingerprint(baseline_input)
        if baseline_target != semantic_target_fingerprint(candidate_input):
            raise SemanticRegressionContractError("baseline and candidate semantic targets differ")
        if (
            label.label_set_id != label_manifest.label_set_id
            or label.case_input_fingerprint != baseline_input.case_input_fingerprint
            or label.semantic_target_fingerprint != baseline_target
            or label.generator_run_manifest_fingerprint
            != baseline_input.generator_run_manifest_fingerprint
            or label.generator_configuration_fingerprint
            != baseline_input.generator_configuration_fingerprint
            or label.agent1_result_fingerprint != baseline_input.agent1_result_fingerprint
            or label.question_plan_fingerprint != baseline_input.question_plan_fingerprint
        ):
            raise SemanticRegressionContractError("human label is not bound to its exact target")

    slices: list[RegressionSlice] = []
    for dimension in JudgeDimension:
        human = [
            next(
                item.verdict
                for item in label_by_id[case_id].dimensions
                if item.dimension is dimension
            )
            for case_id in case_ids
        ]
        baseline = [
            next(
                item.verdict
                for item in baseline_output_by_id[case_id].dimensions
                if item.dimension is dimension
            )
            for case_id in case_ids
        ]
        candidate = [
            next(
                item.verdict
                for item in candidate_output_by_id[case_id].dimensions
                if item.dimension is dimension
            )
            for case_id in case_ids
        ]
        slices.append(_slice(dimension, human, baseline, candidate))
    slices.append(
        _slice(
            "overall",
            [label_by_id[item].overall_verdict for item in case_ids],
            [baseline_output_by_id[item].overall_verdict for item in case_ids],
            [candidate_output_by_id[item].overall_verdict for item in case_ids],
        )
    )

    human_pass = sum(item.overall_verdict is JudgeVerdict.PASS for item in labels)
    human_fail = sum(item.overall_verdict is JudgeVerdict.FAIL for item in labels)
    human_uncertain = len(labels) - human_pass - human_fail
    tied_dimensions = sum(
        dimension.pass_votes == dimension.fail_votes
        for label in labels
        for dimension in label.dimensions
    )
    failure_codes: set[str] = set()
    if len(labels) < MINIMUM_HUMAN_REVIEWS:
        failure_codes.add("human_population_below_minimum")
    if human_pass < MINIMUM_PER_OVERALL_CLASS or human_fail < MINIMUM_PER_OVERALL_CLASS:
        failure_codes.add("human_label_balance_insufficient")
    if any(item.baseline.kappa_status is not KappaStatus.DEFINED for item in slices) or any(
        item.candidate.kappa_status is not KappaStatus.DEFINED for item in slices
    ):
        failure_codes.add("kappa_undefined")
    if any(item.baseline.human_uncertain or item.candidate.human_uncertain for item in slices):
        failure_codes.add("unresolved_human_labels")
    if any(item.new_false_accepts for item in slices):
        failure_codes.add("new_false_accept")
    if any(item.new_false_rejects for item in slices):
        failure_codes.add("new_false_reject")
    if any(item.new_uncertainties for item in slices):
        failure_codes.add("new_judge_uncertainty")
    if any(item.pass_to_nonpass for item in slices):
        failure_codes.add("pass_to_nonpass_regression")
    if any(item.new_disagreements for item in slices):
        failure_codes.add("new_human_disagreement")
    if baseline_manifest.operational_error_count or candidate_manifest.operational_error_count:
        failure_codes.add("judge_operational_error")
    if baseline_manifest.contract_failure_count or candidate_manifest.contract_failure_count:
        failure_codes.add("judge_contract_failure")

    human_evidence = label_manifest.status is HumanLabelStatus.HUMAN_APPROVED
    regression_policy = canonical_semantic_regression_policy()
    return SemanticRegressionReport(
        result_status="human_approved_evidence" if human_evidence else "fixture_only_diagnostic",
        gate_decision=(
            GateDecision.FAIL
            if human_evidence and failure_codes
            else (GateDecision.PASS if human_evidence else GateDecision.FIXTURE_ONLY_NOT_EVIDENCE)
        ),
        gate_failure_codes=tuple(sorted(failure_codes)),
        regression_policy=regression_policy,
        regression_policy_sha256=semantic_regression_policy_sha256(regression_policy),
        dataset_name=population.verified_dataset.manifest.dataset_name,
        dataset_version=population.verified_dataset.manifest.dataset_version,
        dataset_fingerprint=population.verified_dataset.dataset_fingerprint,
        split=DatasetSplit.VALIDATION,
        full_split_count=len(population.cases),
        baseline_run_id=baseline_manifest.run_id,
        baseline_run_manifest_fingerprint=expected_baseline_manifest_fp,
        baseline_lock_fingerprint=baseline_lock_fingerprint(baseline_lock),
        baseline_judge_configuration=baseline_manifest.judge_configuration,
        baseline_judge_configuration_fingerprint=(
            baseline_manifest.judge_configuration_fingerprint
        ),
        candidate_run_id=candidate_manifest.run_id,
        candidate_run_manifest_fingerprint=judge_run_manifest_fingerprint(candidate_manifest),
        candidate_judge_configuration=candidate_manifest.judge_configuration,
        candidate_judge_configuration_fingerprint=(
            candidate_manifest.judge_configuration_fingerprint
        ),
        declared_judge_change_fields=baseline_lock.allowed_candidate_change_fields,
        generator_provider=baseline_manifest.generator_provider,
        generator_model=baseline_manifest.generator_model,
        generator_run_manifest_fingerprint=(baseline_manifest.generator_run_manifest_fingerprint),
        generator_configuration_fingerprint=(baseline_manifest.generator_configuration_fingerprint),
        baseline_same_provider_as_generator=baseline_manifest.same_provider_as_generator,
        candidate_same_provider_as_generator=candidate_manifest.same_provider_as_generator,
        label_set_id=label_manifest.label_set_id,
        label_set_status=label_manifest.status,
        label_set_manifest_fingerprint=human_label_set_manifest_fingerprint(label_manifest),
        label_count=len(labels),
        human_overall_pass=human_pass,
        human_overall_fail=human_fail,
        human_overall_uncertain=human_uncertain,
        reviewer_tied_dimension_count=tied_dimensions,
        baseline_operational_error_count=baseline_manifest.operational_error_count,
        baseline_contract_failure_count=baseline_manifest.contract_failure_count,
        candidate_operational_error_count=candidate_manifest.operational_error_count,
        candidate_contract_failure_count=candidate_manifest.contract_failure_count,
        minimum_human_reviews=MINIMUM_HUMAN_REVIEWS,
        minimum_per_overall_class=MINIMUM_PER_OVERALL_CLASS,
        slices=tuple(slices),
        diagnostic_only=True,
        human_agreement_measured=human_evidence,
        threshold_selected=False,
        calibrated=False,
        production_routing_authorized=False,
        contains_case_ids=False,
        contains_resume_text=False,
        contains_candidate_identifiers=False,
        contains_tenant_identifiers=False,
        contains_contact_details=False,
        contains_hiring_scores=False,
    )


def resolve_direct_artifact(manifest_path: str | Path, relative_file: str) -> Path:
    root = Path(manifest_path).resolve().parent
    unresolved = root / _direct_file(relative_file)
    if unresolved.is_symlink():
        raise SemanticRegressionContractError("regression artifact may not be a symlink")
    resolved = unresolved.resolve()
    if resolved.parent != root:
        raise SemanticRegressionContractError("regression artifact must remain beside its manifest")
    return resolved


def verify_baseline_manifest_file(
    lock_path: str | Path,
    lock: SemanticRegressionBaselineLock,
) -> Path:
    path = resolve_direct_artifact(lock_path, lock.baseline_run_manifest_file)
    if sha256_file(path) != lock.baseline_run_manifest_sha256:
        raise SemanticRegressionContractError("baseline run manifest SHA-256 differs from lock")
    return path
