"""Comparable, validation-only risk/coverage analysis for shadow confidence.

This module never selects or installs a threshold. It accepts only a complete,
manifest-verified validation population, recomputes every diagnostic assessment from
PII-free confidence signals and a canonical policy artifact, and keeps hard failures
outside the eligible acceptance population at every score cutoff.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from dataclasses import dataclass
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

from ..resume_review.confidence import (
    ConfidencePolicy,
    ConfidenceSignal,
    assess_confidence,
    confidence_policy_sha256,
)
from ..resume_review.contracts import (
    Agent1Evaluation,
    ConfidenceAssessment,
    PolicyIdentity,
)
from .fingerprints import case_input_fingerprint
from .loader import VerifiedDataset, load_dataset_split, verify_dataset
from .models import (
    DatasetPurpose,
    DatasetSplit,
    EvaluationCase,
    FrozenModel,
    Identifier,
    Sha256,
    SplitManifest,
    Version,
)
from .serialization import canonical_json

SafeText = Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]
ArtifactFile = Annotated[StrictStr, StringConstraints(min_length=1, max_length=200)]
Rate = Annotated[StrictFloat, Field(ge=0.0, le=1.0, allow_inf_nan=False)]


def _direct_artifact_file(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) != 1 or path.name in {"", ".", ".."}:
        raise ValueError("artifact file must be a direct relative file")
    return value


def _model_fingerprint(model: FrozenModel, *, domain: str) -> str:
    payload = {"artifact": model.model_dump(mode="json"), "domain": domain}
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def _records_fingerprint(records: Sequence[FrozenModel], *, domain: str) -> str:
    payload = {
        "domain": domain,
        "records": [
            record.model_dump(mode="json")
            for record in sorted(records, key=lambda item: str(item.case_id))
        ],
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


class ShadowConfidenceObservation(FrozenModel):
    """One PII-free cached assessment and the signals needed to reproduce it."""

    schema_version: Literal["1.0"] = "1.0"
    run_id: Identifier
    case_id: Identifier
    input_fingerprint: Sha256
    agent1_result_fingerprint: Sha256
    split: Literal[DatasetSplit.VALIDATION]
    signals: Annotated[tuple[ConfidenceSignal, ...], Field(min_length=1, max_length=32)]
    assessment: ConfidenceAssessment
    threshold_applied: Literal[False]


class AutomaticAcceptanceLabel(FrozenModel):
    """Human-label target for the Agent 1 decision only, not the final hiring decision."""

    schema_version: Literal["1.0"] = "1.0"
    label_set_id: Identifier
    case_id: Identifier
    input_fingerprint: Sha256
    agent1_result_fingerprint: Sha256
    split: Literal[DatasetSplit.VALIDATION]
    safe_for_agent1_automatic_acceptance: StrictBool


class AutomaticAcceptanceDimension(StrEnum):
    CRITERION_CLASSIFICATIONS = "criterion_classifications_semantically_supported"
    EVIDENCE_SUPPORT = "evidence_relevant_and_entailed"
    RECOMMENDATION_SUPPORT = "recommendation_supported"
    SCORE_CONSISTENCY = "deterministic_score_consistent"
    DISALLOWED_CLAIMS = "no_disallowed_claims"


class AutomaticAcceptanceLabelPolicy(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    policy_id: Identifier
    policy_version: Version
    target: Literal["safe_for_agent1_automatic_acceptance"]
    decision_scope: Literal["agent1_evaluation_only"]
    required_dimensions: Annotated[
        tuple[AutomaticAcceptanceDimension, ...],
        Field(
            min_length=len(AutomaticAcceptanceDimension),
            max_length=len(AutomaticAcceptanceDimension),
        ),
    ]

    @model_validator(mode="after")
    def validate_dimensions(self) -> AutomaticAcceptanceLabelPolicy:
        if self.required_dimensions != tuple(AutomaticAcceptanceDimension):
            raise ValueError("automatic-acceptance label dimensions must be complete and canonical")
        return self


def automatic_acceptance_label_policy_sha256(
    policy: AutomaticAcceptanceLabelPolicy,
) -> str:
    return _model_fingerprint(policy, domain="teamflow.automatic-acceptance-label-policy.v1")


def agent1_result_fingerprint(result: Agent1Evaluation) -> str:
    """Hash the exact bounded Agent 1 evaluation targeted by a human label."""

    payload = {
        "agent1_evaluation": result.model_dump(mode="json"),
        "domain": "teamflow.agent1-evaluation.v1",
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


class LabelSetStatus(StrEnum):
    FIXTURE_ONLY = "fixture_only"
    HUMAN_APPROVED = "human_approved"


class LabelApprovalMetadata(FrozenModel):
    approved_at: datetime
    reviewer_count: StrictInt = Field(ge=1, le=100)
    adjudicator_count: StrictInt = Field(ge=1, le=100)
    approval_reference: Identifier

    @field_validator("approved_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("label approval time must include a timezone")
        return value


class ShadowConfidenceRunManifest(FrozenModel):
    """Complete identity of one cached validation run."""

    schema_version: Literal["1.0"] = "1.0"
    run_id: Identifier
    run_status: Literal["complete"]
    partial_run: Literal[False]
    dataset_name: Identifier
    dataset_version: Version
    dataset_fingerprint: Sha256
    split: Literal[DatasetSplit.VALIDATION]
    split_file_sha256: Sha256
    case_id_sha256: Sha256
    input_fingerprint_sha256: Sha256
    full_split_count: StrictInt = Field(ge=1)
    model_provider: Identifier
    model_id: SafeText
    observed_model_versions: Annotated[tuple[SafeText, ...], Field(min_length=1, max_length=8)]
    model_configuration_sha256: Sha256
    prompt_sha256: Sha256
    result_schema_sha256: Sha256
    graph_version: Version
    evaluator_version: Version
    confidence_policy_identity: PolicyIdentity
    confidence_policy_sha256: Sha256
    observations_file: ArtifactFile
    observations_sha256: Sha256
    observation_fingerprint: Sha256
    observation_count: StrictInt = Field(ge=1)
    threshold_applied: Literal[False]
    contains_resume_text: Literal[False]
    contains_candidate_identifiers: Literal[False]

    @field_validator("observations_file")
    @classmethod
    def validate_observation_file(cls, value: str) -> str:
        return _direct_artifact_file(value)

    @model_validator(mode="after")
    def validate_model_versions(self) -> ShadowConfidenceRunManifest:
        if len(self.observed_model_versions) != len(set(self.observed_model_versions)):
            raise ValueError("observed model versions must be unique")
        if self.observed_model_versions != tuple(sorted(self.observed_model_versions)):
            raise ValueError("observed model versions must use canonical lexical order")
        return self


class AutomaticAcceptanceLabelSetManifest(FrozenModel):
    """Identity and approval declaration for one complete validation label set."""

    schema_version: Literal["1.0"] = "1.0"
    label_set_id: Identifier
    status: LabelSetStatus
    dataset_name: Identifier
    dataset_version: Version
    dataset_fingerprint: Sha256
    split: Literal[DatasetSplit.VALIDATION]
    split_file_sha256: Sha256
    case_id_sha256: Sha256
    input_fingerprint_sha256: Sha256
    full_split_count: StrictInt = Field(ge=1)
    observation_run_id: Identifier
    observation_fingerprint: Sha256
    run_manifest_fingerprint: Sha256
    label_policy: AutomaticAcceptanceLabelPolicy
    label_policy_sha256: Sha256
    labels_file: ArtifactFile
    labels_sha256: Sha256
    label_fingerprint: Sha256
    label_count: StrictInt = Field(ge=1)
    approval: LabelApprovalMetadata | None
    contains_resume_text: Literal[False]
    contains_candidate_identifiers: Literal[False]

    @field_validator("labels_file")
    @classmethod
    def validate_label_file(cls, value: str) -> str:
        return _direct_artifact_file(value)

    @model_validator(mode="after")
    def validate_label_set(self) -> AutomaticAcceptanceLabelSetManifest:
        if self.label_policy_sha256 != automatic_acceptance_label_policy_sha256(self.label_policy):
            raise ValueError("label policy SHA-256 does not match its canonical content")
        if self.status is LabelSetStatus.HUMAN_APPROVED and self.approval is None:
            raise ValueError("human-approved labels require approval metadata")
        if self.status is LabelSetStatus.FIXTURE_ONLY and self.approval is not None:
            raise ValueError("fixture-only labels cannot claim approval metadata")
        return self


class RiskCoveragePoint(FrozenModel):
    point_kind: Literal["accept_none", "score_cutoff"]
    cutoff_score: StrictInt | None = Field(default=None, ge=0, le=100)
    accepted: StrictInt = Field(ge=0)
    unsafe_accepted: StrictInt = Field(ge=0)
    total: StrictInt = Field(ge=1)
    eligible_total: StrictInt = Field(ge=0)
    coverage: Rate
    selective_risk: Rate | None
    unsafe_accept_rate_over_population: Rate
    review_rate: Rate

    @model_validator(mode="after")
    def validate_point(self) -> RiskCoveragePoint:
        if self.eligible_total > self.total:
            raise ValueError("eligible population cannot exceed the total population")
        if self.accepted > self.eligible_total:
            raise ValueError("accepted count cannot exceed the eligible population")
        if self.unsafe_accepted > self.accepted:
            raise ValueError("unsafe accepted count cannot exceed accepted count")
        if self.point_kind == "accept_none":
            if self.cutoff_score is not None or self.accepted != 0 or self.unsafe_accepted != 0:
                raise ValueError("accept-none point must accept zero cases and have no cutoff")
        elif self.cutoff_score is None or self.accepted == 0:
            raise ValueError("score-cutoff point requires a cutoff and accepted cases")

        expected_coverage = self.accepted / self.total
        expected_population_rate = self.unsafe_accepted / self.total
        expected_review_rate = (self.total - self.accepted) / self.total
        expected_selective = self.unsafe_accepted / self.accepted if self.accepted else None
        for actual, expected, label in (
            (self.coverage, expected_coverage, "coverage"),
            (
                self.unsafe_accept_rate_over_population,
                expected_population_rate,
                "unsafe acceptance population rate",
            ),
            (self.review_rate, expected_review_rate, "review rate"),
        ):
            if not math.isclose(actual, expected, rel_tol=0.0, abs_tol=1e-12):
                raise ValueError(f"{label} does not match its explicit denominator")
        if expected_selective is None:
            if self.selective_risk is not None:
                raise ValueError("selective risk must be null when no cases are accepted")
        elif self.selective_risk is None or not math.isclose(
            self.selective_risk,
            expected_selective,
            rel_tol=0.0,
            abs_tol=1e-12,
        ):
            raise ValueError("selective risk does not match unsafe accepted / accepted")
        return self


class RiskCoverageReport(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    result_status: Literal["fixture_only_analysis", "derived_from_human_approved_labels"]
    dataset_name: Identifier
    dataset_version: Version
    dataset_fingerprint: Sha256
    split: Literal[DatasetSplit.VALIDATION]
    split_file_sha256: Sha256
    case_id_sha256: Sha256
    input_fingerprint_sha256: Sha256
    observation_run_id: Identifier
    run_manifest_fingerprint: Sha256
    label_set_id: Identifier
    label_set_status: LabelSetStatus
    label_set_manifest_fingerprint: Sha256
    observation_count: StrictInt = Field(ge=1)
    safe_label_count: StrictInt = Field(ge=0)
    unsafe_label_count: StrictInt = Field(ge=0)
    hard_failure_count: StrictInt = Field(ge=0)
    eligible_count: StrictInt = Field(ge=0)
    observation_fingerprint: Sha256
    label_fingerprint: Sha256
    confidence_policy_identity: PolicyIdentity
    confidence_policy_sha256: Sha256
    label_policy_id: Identifier
    label_policy_version: Version
    label_policy_sha256: Sha256
    model_provider: Identifier
    model_id: SafeText
    observed_model_versions: Annotated[tuple[SafeText, ...], Field(min_length=1, max_length=8)]
    model_configuration_sha256: Sha256
    prompt_sha256: Sha256
    result_schema_sha256: Sha256
    graph_version: Version
    evaluator_version: Version
    score_is_probability: Literal[False]
    threshold_selected: Literal[False]
    contains_case_ids: Literal[False]
    contains_resume_text: Literal[False]
    contains_candidate_identifiers: Literal[False]
    points: Annotated[tuple[RiskCoveragePoint, ...], Field(min_length=1, max_length=102)]

    @model_validator(mode="after")
    def validate_report(self) -> RiskCoverageReport:
        if self.safe_label_count + self.unsafe_label_count != self.observation_count:
            raise ValueError("risk/coverage label counts are inconsistent")
        if self.hard_failure_count + self.eligible_count != self.observation_count:
            raise ValueError("risk/coverage eligibility counts are inconsistent")
        expected_status = (
            "fixture_only_analysis"
            if self.label_set_status is LabelSetStatus.FIXTURE_ONLY
            else "derived_from_human_approved_labels"
        )
        if self.result_status != expected_status:
            raise ValueError("report status does not match the label-set status")

        first = self.points[0]
        if first.point_kind != "accept_none":
            raise ValueError("risk/coverage curve must begin with an accept-none point")
        prior_cutoff = 101
        prior_accepted = 0
        prior_unsafe_accepted = 0
        for index, point in enumerate(self.points):
            if point.total != self.observation_count or point.eligible_total != self.eligible_count:
                raise ValueError("risk/coverage point population differs from the report")
            if point.unsafe_accepted > self.unsafe_label_count:
                raise ValueError("point accepts more unsafe cases than the label population")
            if point.accepted - point.unsafe_accepted > self.safe_label_count:
                raise ValueError("point accepts more safe cases than the label population")
            if index == 0:
                continue
            if point.point_kind != "score_cutoff" or point.cutoff_score is None:
                raise ValueError("only the first curve point may be accept-none")
            if point.cutoff_score >= prior_cutoff:
                raise ValueError("score cutoffs must be strictly descending")
            if point.accepted <= prior_accepted:
                raise ValueError("accepted population must increase at each tied-score cutoff")
            if point.unsafe_accepted < prior_unsafe_accepted:
                raise ValueError("unsafe accepted population cannot decrease across cutoffs")
            prior_cutoff = point.cutoff_score
            prior_accepted = point.accepted
            prior_unsafe_accepted = point.unsafe_accepted
        if self.points[-1].accepted != self.eligible_count:
            raise ValueError("final curve point must include every eligible observation")
        return self


class RiskCoverageContractError(ValueError):
    """Artifacts cannot form one comparable, approved validation population."""


@dataclass(frozen=True, slots=True)
class VerifiedValidationPopulation:
    verified_dataset: VerifiedDataset
    split_manifest: SplitManifest
    cases: tuple[EvaluationCase, ...]


def load_verified_validation_population(
    dataset_directory: str | Path,
) -> VerifiedValidationPopulation:
    """Verify the corpus and load only its purpose-authorized validation split."""

    verified = verify_dataset(dataset_directory)
    cases = load_dataset_split(
        dataset_directory,
        DatasetSplit.VALIDATION,
        purpose=DatasetPurpose.VALIDATION,
        manifest=verified.manifest,
    )
    verified_validation = tuple(
        case for case in verified.cases if case.split is DatasetSplit.VALIDATION
    )
    if cases != verified_validation:
        raise RiskCoverageContractError(
            "purpose-loaded validation population differs from the verified dataset"
        )
    split_manifest = next(
        item for item in verified.manifest.splits if item.split is DatasetSplit.VALIDATION
    )
    return VerifiedValidationPopulation(
        verified_dataset=verified,
        split_manifest=split_manifest,
        cases=cases,
    )


def shadow_observation_fingerprint(
    observations: Sequence[ShadowConfidenceObservation],
) -> str:
    return _records_fingerprint(
        observations,
        domain="teamflow.shadow-confidence-observations.v1",
    )


def automatic_acceptance_label_fingerprint(
    labels: Sequence[AutomaticAcceptanceLabel],
) -> str:
    return _records_fingerprint(
        labels,
        domain="teamflow.automatic-acceptance-labels.v1",
    )


def shadow_run_manifest_fingerprint(manifest: ShadowConfidenceRunManifest) -> str:
    return _model_fingerprint(manifest, domain="teamflow.shadow-confidence-run-manifest.v1")


def label_set_manifest_fingerprint(
    manifest: AutomaticAcceptanceLabelSetManifest,
) -> str:
    return _model_fingerprint(
        manifest,
        domain="teamflow.automatic-acceptance-label-set-manifest.v1",
    )


def resolve_direct_artifact(manifest_path: str | Path, relative_file: str) -> Path:
    """Resolve one direct manifest member without allowing traversal or symlinks."""

    safe_name = _direct_artifact_file(relative_file)
    root = Path(manifest_path).resolve().parent
    unresolved = root / safe_name
    if unresolved.is_symlink():
        raise RiskCoverageContractError("manifest member may not be a symlink")
    resolved = unresolved.resolve()
    if resolved.parent != root:
        raise RiskCoverageContractError("manifest member must remain beside its manifest")
    return resolved


def _validate_population_identity(
    manifest: ShadowConfidenceRunManifest | AutomaticAcceptanceLabelSetManifest,
    population: VerifiedValidationPopulation,
) -> None:
    verified = population.verified_dataset
    expected = {
        "dataset_name": verified.manifest.dataset_name,
        "dataset_version": verified.manifest.dataset_version,
        "dataset_fingerprint": verified.dataset_fingerprint,
        "split": DatasetSplit.VALIDATION,
        "split_file_sha256": population.split_manifest.sha256,
        "case_id_sha256": population.split_manifest.case_id_sha256,
        "input_fingerprint_sha256": population.split_manifest.input_fingerprint_sha256,
        "full_split_count": len(population.cases),
    }
    mismatches = [field for field, value in expected.items() if getattr(manifest, field) != value]
    if mismatches:
        raise RiskCoverageContractError(
            f"artifact does not match the verified validation population: {mismatches}"
        )


def _validate_unique_population(
    observations: Sequence[ShadowConfidenceObservation],
    labels: Sequence[AutomaticAcceptanceLabel],
) -> tuple[
    dict[str, ShadowConfidenceObservation],
    dict[str, AutomaticAcceptanceLabel],
]:
    observation_by_id = {item.case_id: item for item in observations}
    label_by_id = {item.case_id: item for item in labels}
    if len(observation_by_id) != len(observations) or len(label_by_id) != len(labels):
        raise RiskCoverageContractError("risk/coverage case IDs must be unique")
    if len({item.input_fingerprint for item in observations}) != len(observations):
        raise RiskCoverageContractError("observation input fingerprints must be unique")
    if len({item.input_fingerprint for item in labels}) != len(labels):
        raise RiskCoverageContractError("label input fingerprints must be unique")
    if set(observation_by_id) != set(label_by_id):
        raise RiskCoverageContractError("observations and labels must cover the same cases")
    return observation_by_id, label_by_id


def build_risk_coverage_report(
    observations: Sequence[ShadowConfidenceObservation],
    labels: Sequence[AutomaticAcceptanceLabel],
    *,
    run_manifest: ShadowConfidenceRunManifest,
    label_manifest: AutomaticAcceptanceLabelSetManifest,
    population: VerifiedValidationPopulation,
    confidence_policy: ConfidencePolicy,
    allow_fixture_labels: bool = False,
) -> RiskCoverageReport:
    """Build all observed cutoffs after strict comparability checks; select none."""

    if not observations or not labels:
        raise RiskCoverageContractError("risk/coverage requires observations and labels")
    if label_manifest.status is LabelSetStatus.FIXTURE_ONLY and not allow_fixture_labels:
        raise RiskCoverageContractError(
            "fixture-only labels require the explicit allow-fixture-labels override"
        )

    _validate_population_identity(run_manifest, population)
    _validate_population_identity(label_manifest, population)
    observation_by_id, label_by_id = _validate_unique_population(observations, labels)

    expected_case_ids = {case.case_id for case in population.cases}
    if set(observation_by_id) != expected_case_ids:
        raise RiskCoverageContractError(
            "observations and labels must cover the complete verified validation split"
        )
    if run_manifest.observation_count != len(observations):
        raise RiskCoverageContractError("run manifest observation count is incomplete")
    if label_manifest.label_count != len(labels):
        raise RiskCoverageContractError("label-set manifest label count is incomplete")
    if run_manifest.observation_fingerprint != shadow_observation_fingerprint(observations):
        raise RiskCoverageContractError("run manifest observation fingerprint differs")
    if label_manifest.label_fingerprint != automatic_acceptance_label_fingerprint(labels):
        raise RiskCoverageContractError("label-set manifest label fingerprint differs")
    expected_run_manifest_fingerprint = shadow_run_manifest_fingerprint(run_manifest)
    if (
        label_manifest.observation_run_id != run_manifest.run_id
        or label_manifest.observation_fingerprint != run_manifest.observation_fingerprint
        or label_manifest.run_manifest_fingerprint != expected_run_manifest_fingerprint
    ):
        raise RiskCoverageContractError(
            "label set is not bound to the exact shadow observation run"
        )

    policy_sha256 = confidence_policy_sha256(confidence_policy)
    if (
        run_manifest.confidence_policy_identity != confidence_policy.identity
        or run_manifest.confidence_policy_sha256 != policy_sha256
    ):
        raise RiskCoverageContractError(
            "run manifest confidence policy does not match the canonical policy artifact"
        )

    expected_signal_order = tuple(
        component.component_id for component in confidence_policy.components
    )
    expected_input_by_id = {case.case_id: case_input_fingerprint(case) for case in population.cases}
    for case_id in sorted(expected_case_ids):
        observation = observation_by_id[case_id]
        label = label_by_id[case_id]
        expected_input = expected_input_by_id[case_id]
        if observation.run_id != run_manifest.run_id:
            raise RiskCoverageContractError("observation run ID differs from its manifest")
        if label.label_set_id != label_manifest.label_set_id:
            raise RiskCoverageContractError("label-set ID differs from its manifest")
        if observation.input_fingerprint != expected_input:
            raise RiskCoverageContractError(
                "observation input fingerprint differs from the verified dataset"
            )
        if label.input_fingerprint != expected_input:
            raise RiskCoverageContractError(
                "label input fingerprint differs from the verified dataset"
            )
        if label.agent1_result_fingerprint != observation.agent1_result_fingerprint:
            raise RiskCoverageContractError(
                "label target differs from the exact Agent 1 result that was observed"
            )
        if (
            observation.split is not DatasetSplit.VALIDATION
            or label.split is not DatasetSplit.VALIDATION
        ):
            raise RiskCoverageContractError("risk/coverage analysis is validation-only")
        signal_order = tuple(signal.component_id for signal in observation.signals)
        if signal_order != expected_signal_order:
            raise RiskCoverageContractError(
                "stored confidence signals must be complete and in canonical policy order"
            )
        recomputed = assess_confidence(observation.signals, confidence_policy)
        if recomputed != observation.assessment:
            raise RiskCoverageContractError(
                "stored confidence assessment does not exactly recompute from its signals"
            )

    eligible = sorted(
        (item for item in observations if not item.assessment.hard_failure),
        key=lambda item: (-item.assessment.score, item.case_id),
    )
    total = len(observations)
    safe_label_count = sum(label.safe_for_agent1_automatic_acceptance for label in labels)
    unsafe_label_count = total - safe_label_count
    accepted = unsafe_accepted = 0
    points: list[RiskCoveragePoint] = [
        RiskCoveragePoint(
            point_kind="accept_none",
            cutoff_score=None,
            accepted=0,
            unsafe_accepted=0,
            total=total,
            eligible_total=len(eligible),
            coverage=0.0,
            selective_risk=None,
            unsafe_accept_rate_over_population=0.0,
            review_rate=1.0,
        )
    ]
    index = 0
    while index < len(eligible):
        cutoff = eligible[index].assessment.score
        tied: list[ShadowConfidenceObservation] = []
        while index < len(eligible) and eligible[index].assessment.score == cutoff:
            tied.append(eligible[index])
            index += 1
        accepted += len(tied)
        unsafe_accepted += sum(
            not label_by_id[item.case_id].safe_for_agent1_automatic_acceptance for item in tied
        )
        points.append(
            RiskCoveragePoint(
                point_kind="score_cutoff",
                cutoff_score=cutoff,
                accepted=accepted,
                unsafe_accepted=unsafe_accepted,
                total=total,
                eligible_total=len(eligible),
                coverage=accepted / total,
                selective_risk=unsafe_accepted / accepted,
                unsafe_accept_rate_over_population=unsafe_accepted / total,
                review_rate=(total - accepted) / total,
            )
        )

    label_policy = label_manifest.label_policy
    return RiskCoverageReport(
        result_status=(
            "fixture_only_analysis"
            if label_manifest.status is LabelSetStatus.FIXTURE_ONLY
            else "derived_from_human_approved_labels"
        ),
        dataset_name=population.verified_dataset.manifest.dataset_name,
        dataset_version=population.verified_dataset.manifest.dataset_version,
        dataset_fingerprint=population.verified_dataset.dataset_fingerprint,
        split=DatasetSplit.VALIDATION,
        split_file_sha256=population.split_manifest.sha256,
        case_id_sha256=population.split_manifest.case_id_sha256,
        input_fingerprint_sha256=population.split_manifest.input_fingerprint_sha256,
        observation_run_id=run_manifest.run_id,
        run_manifest_fingerprint=expected_run_manifest_fingerprint,
        label_set_id=label_manifest.label_set_id,
        label_set_status=label_manifest.status,
        label_set_manifest_fingerprint=label_set_manifest_fingerprint(label_manifest),
        observation_count=total,
        safe_label_count=safe_label_count,
        unsafe_label_count=unsafe_label_count,
        hard_failure_count=total - len(eligible),
        eligible_count=len(eligible),
        observation_fingerprint=run_manifest.observation_fingerprint,
        label_fingerprint=label_manifest.label_fingerprint,
        confidence_policy_identity=confidence_policy.identity,
        confidence_policy_sha256=policy_sha256,
        label_policy_id=label_policy.policy_id,
        label_policy_version=label_policy.policy_version,
        label_policy_sha256=label_manifest.label_policy_sha256,
        model_provider=run_manifest.model_provider,
        model_id=run_manifest.model_id,
        observed_model_versions=run_manifest.observed_model_versions,
        model_configuration_sha256=run_manifest.model_configuration_sha256,
        prompt_sha256=run_manifest.prompt_sha256,
        result_schema_sha256=run_manifest.result_schema_sha256,
        graph_version=run_manifest.graph_version,
        evaluator_version=run_manifest.evaluator_version,
        score_is_probability=False,
        threshold_selected=False,
        contains_case_ids=False,
        contains_resume_text=False,
        contains_candidate_identifiers=False,
        points=tuple(points),
    )
