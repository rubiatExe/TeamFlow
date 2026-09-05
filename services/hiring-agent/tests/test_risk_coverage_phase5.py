from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from teamflow_hiring_agent.evaluation.cli import (
    EXIT_CONTRACT_FAILURE,
    EXIT_OK,
    main,
)
from teamflow_hiring_agent.evaluation.fingerprints import case_input_fingerprint
from teamflow_hiring_agent.evaluation.loader import sha256_file
from teamflow_hiring_agent.evaluation.risk_coverage import (
    AutomaticAcceptanceDimension,
    AutomaticAcceptanceLabel,
    AutomaticAcceptanceLabelPolicy,
    AutomaticAcceptanceLabelSetManifest,
    LabelApprovalMetadata,
    LabelSetStatus,
    RiskCoverageContractError,
    RiskCoverageReport,
    ShadowConfidenceObservation,
    ShadowConfidenceRunManifest,
    VerifiedValidationPopulation,
    agent1_result_fingerprint,
    automatic_acceptance_label_fingerprint,
    automatic_acceptance_label_policy_sha256,
    build_risk_coverage_report,
    load_verified_validation_population,
    shadow_observation_fingerprint,
    shadow_run_manifest_fingerprint,
)
from teamflow_hiring_agent.evaluation.serialization import (
    write_json_artifact,
    write_jsonl_artifact,
)
from teamflow_hiring_agent.resume_review.confidence import (
    DEFAULT_CONFIDENCE_POLICY_PATH,
    ConfidencePolicy,
    ConfidenceSignal,
    ConfidenceSignalId,
    assess_confidence,
    confidence_policy_sha256,
    load_default_confidence_policy,
)
from teamflow_hiring_agent.resume_review.contracts import Agent1Evaluation

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SERVICE_ROOT.parents[1]
DATASET_DIRECTORY = SERVICE_ROOT / "evals" / "resume_review_v1"
CONTRACT_FIXTURE = REPOSITORY_ROOT / "tests" / "fixtures" / "resume-review-contract-v1.json"


@dataclass(frozen=True)
class RiskArtifacts:
    population: VerifiedValidationPopulation
    policy: ConfidencePolicy
    observations: tuple[ShadowConfidenceObservation, ...]
    labels: tuple[AutomaticAcceptanceLabel, ...]
    run_manifest: ShadowConfidenceRunManifest
    label_manifest: AutomaticAcceptanceLabelSetManifest
    run_manifest_path: Path
    label_manifest_path: Path


def _signals(
    policy: ConfidencePolicy,
    score: int,
    *,
    hard_failure: bool = False,
) -> tuple[ConfidenceSignal, ...]:
    hard_component = policy.components[0].component_id
    return tuple(
        ConfidenceSignal(
            component_id=component.component_id,
            score=(
                0
                if hard_failure and component.component_id is hard_component
                else (
                    score if component.component_id is ConfidenceSignalId.CRITERIA_COVERAGE else 100
                )
            ),
            hard_failure=hard_failure and component.component_id is hard_component,
            reason_codes=("fixture_hard_failure",)
            if hard_failure and component.component_id is hard_component
            else (),
        )
        for component in policy.components
    )


def _write_artifacts(
    tmp_path: Path,
    *,
    status: LabelSetStatus = LabelSetStatus.FIXTURE_ONLY,
    all_hard: bool = False,
) -> RiskArtifacts:
    population = load_verified_validation_population(DATASET_DIRECTORY)
    policy = load_default_confidence_policy()
    scores = (90, 70, 70, 100) + (50,) * (len(population.cases) - 4)
    observations: list[ShadowConfidenceObservation] = []
    labels: list[AutomaticAcceptanceLabel] = []
    for index, (case, score) in enumerate(zip(population.cases, scores, strict=True)):
        hard_failure = all_hard or index == 3
        signals = _signals(policy, score, hard_failure=hard_failure)
        agent1_result_fingerprint = hashlib.sha256(
            f"{case.case_id}:fixture-agent1-result".encode()
        ).hexdigest()
        observations.append(
            ShadowConfidenceObservation(
                run_id="phase5-fixture-run",
                case_id=case.case_id,
                input_fingerprint=case_input_fingerprint(case),
                agent1_result_fingerprint=agent1_result_fingerprint,
                split="validation",
                signals=signals,
                assessment=assess_confidence(signals, policy),
                threshold_applied=False,
            )
        )
        labels.append(
            AutomaticAcceptanceLabel(
                label_set_id="phase5-fixture-labels",
                case_id=case.case_id,
                input_fingerprint=case_input_fingerprint(case),
                agent1_result_fingerprint=agent1_result_fingerprint,
                split="validation",
                safe_for_agent1_automatic_acceptance=index not in {1, 3},
            )
        )

    observation_records = tuple(observations)
    label_records = tuple(labels)
    observation_path = tmp_path / "shadow-observations.jsonl"
    label_path = tmp_path / "automatic-acceptance-labels.jsonl"
    write_jsonl_artifact(observation_path, observation_records)
    write_jsonl_artifact(label_path, label_records)

    verified = population.verified_dataset
    split_manifest = population.split_manifest
    run_manifest = ShadowConfidenceRunManifest(
        run_id="phase5-fixture-run",
        run_status="complete",
        partial_run=False,
        dataset_name=verified.manifest.dataset_name,
        dataset_version=verified.manifest.dataset_version,
        dataset_fingerprint=verified.dataset_fingerprint,
        split="validation",
        split_file_sha256=split_manifest.sha256,
        case_id_sha256=split_manifest.case_id_sha256,
        input_fingerprint_sha256=split_manifest.input_fingerprint_sha256,
        full_split_count=len(population.cases),
        model_provider="fixture-provider",
        model_id="fixture/model-v1",
        observed_model_versions=("fixture-model-v1",),
        model_configuration_sha256="1" * 64,
        prompt_sha256="2" * 64,
        result_schema_sha256="3" * 64,
        graph_version="1.0.0",
        evaluator_version="1.0.0",
        confidence_policy_identity=policy.identity,
        confidence_policy_sha256=confidence_policy_sha256(policy),
        observations_file=observation_path.name,
        observations_sha256=sha256_file(observation_path),
        observation_fingerprint=shadow_observation_fingerprint(observation_records),
        observation_count=len(observation_records),
        threshold_applied=False,
        contains_resume_text=False,
        contains_candidate_identifiers=False,
    )
    label_policy = AutomaticAcceptanceLabelPolicy(
        policy_id="agent1-automatic-acceptance-label",
        policy_version="1.0.0",
        target="safe_for_agent1_automatic_acceptance",
        decision_scope="agent1_evaluation_only",
        required_dimensions=tuple(AutomaticAcceptanceDimension),
    )
    approval = (
        LabelApprovalMetadata(
            approved_at=datetime(2026, 8, 28, 12, 0, tzinfo=UTC),
            reviewer_count=2,
            adjudicator_count=1,
            approval_reference="approval-batch-001",
        )
        if status is LabelSetStatus.HUMAN_APPROVED
        else None
    )
    label_manifest = AutomaticAcceptanceLabelSetManifest(
        label_set_id="phase5-fixture-labels",
        status=status,
        dataset_name=verified.manifest.dataset_name,
        dataset_version=verified.manifest.dataset_version,
        dataset_fingerprint=verified.dataset_fingerprint,
        split="validation",
        split_file_sha256=split_manifest.sha256,
        case_id_sha256=split_manifest.case_id_sha256,
        input_fingerprint_sha256=split_manifest.input_fingerprint_sha256,
        full_split_count=len(population.cases),
        observation_run_id=run_manifest.run_id,
        observation_fingerprint=run_manifest.observation_fingerprint,
        run_manifest_fingerprint=shadow_run_manifest_fingerprint(run_manifest),
        label_policy=label_policy,
        label_policy_sha256=automatic_acceptance_label_policy_sha256(label_policy),
        labels_file=label_path.name,
        labels_sha256=sha256_file(label_path),
        label_fingerprint=automatic_acceptance_label_fingerprint(label_records),
        label_count=len(label_records),
        approval=approval,
        contains_resume_text=False,
        contains_candidate_identifiers=False,
    )
    run_manifest_path = tmp_path / "run-manifest.json"
    label_manifest_path = tmp_path / "label-set-manifest.json"
    write_json_artifact(run_manifest_path, run_manifest)
    write_json_artifact(label_manifest_path, label_manifest)
    return RiskArtifacts(
        population=population,
        policy=policy,
        observations=observation_records,
        labels=label_records,
        run_manifest=run_manifest,
        label_manifest=label_manifest,
        run_manifest_path=run_manifest_path,
        label_manifest_path=label_manifest_path,
    )


def _build(
    artifacts: RiskArtifacts,
    *,
    observations: tuple[ShadowConfidenceObservation, ...] | None = None,
    labels: tuple[AutomaticAcceptanceLabel, ...] | None = None,
    run_manifest: ShadowConfidenceRunManifest | None = None,
    label_manifest: AutomaticAcceptanceLabelSetManifest | None = None,
    allow_fixture_labels: bool = True,
) -> RiskCoverageReport:
    return build_risk_coverage_report(
        artifacts.observations if observations is None else observations,
        artifacts.labels if labels is None else labels,
        run_manifest=artifacts.run_manifest if run_manifest is None else run_manifest,
        label_manifest=(artifacts.label_manifest if label_manifest is None else label_manifest),
        population=artifacts.population,
        confidence_policy=artifacts.policy,
        allow_fixture_labels=allow_fixture_labels,
    )


def _bind_labels_to_run(
    artifacts: RiskArtifacts,
    run_manifest: ShadowConfidenceRunManifest,
    *,
    labels: tuple[AutomaticAcceptanceLabel, ...] | None = None,
) -> AutomaticAcceptanceLabelSetManifest:
    updates: dict[str, object] = {
        "observation_run_id": run_manifest.run_id,
        "observation_fingerprint": run_manifest.observation_fingerprint,
        "run_manifest_fingerprint": shadow_run_manifest_fingerprint(run_manifest),
    }
    if labels is not None:
        updates.update(
            label_count=len(labels),
            label_fingerprint=automatic_acceptance_label_fingerprint(labels),
        )
    return artifacts.label_manifest.model_copy(update=updates)


def test_curve_uses_full_population_groups_ties_and_excludes_hard_failures(
    tmp_path: Path,
) -> None:
    artifacts = _write_artifacts(tmp_path)
    report = _build(artifacts)

    assert report.threshold_selected is False
    assert report.score_is_probability is False
    assert report.observation_count == 30
    assert report.hard_failure_count == 1
    assert report.eligible_count == 29
    assert [point.point_kind for point in report.points] == [
        "accept_none",
        "score_cutoff",
        "score_cutoff",
        "score_cutoff",
    ]
    assert [point.cutoff_score for point in report.points] == [None, 90, 70, 50]
    assert [point.accepted for point in report.points] == [0, 1, 3, 29]
    assert [point.unsafe_accepted for point in report.points] == [0, 0, 1, 1]
    assert report.points[2].selective_risk == pytest.approx(1 / 3)
    assert report.points[2].unsafe_accept_rate_over_population == pytest.approx(1 / 30)
    assert report.points[-1].coverage == pytest.approx(29 / 30)
    assert report.points[-1].review_rate == pytest.approx(1 / 30)

    reversed_report = _build(
        artifacts,
        observations=tuple(reversed(artifacts.observations)),
        labels=tuple(reversed(artifacts.labels)),
    )
    assert reversed_report == report


def test_fixture_labels_are_rejected_by_default_and_approval_is_structural(
    tmp_path: Path,
) -> None:
    artifacts = _write_artifacts(tmp_path)
    with pytest.raises(RiskCoverageContractError, match="fixture-only labels"):
        _build(artifacts, allow_fixture_labels=False)

    payload = artifacts.label_manifest.model_dump(mode="json")
    payload["status"] = "human_approved"
    with pytest.raises(ValidationError, match="approval metadata"):
        AutomaticAcceptanceLabelSetManifest.model_validate(payload)

    payload = artifacts.label_manifest.model_dump(mode="json")
    payload["approval"] = {
        "approved_at": "2026-08-28T12:00:00Z",
        "reviewer_count": 2,
        "adjudicator_count": 1,
        "approval_reference": "false-approval",
    }
    with pytest.raises(ValidationError, match="cannot claim approval"):
        AutomaticAcceptanceLabelSetManifest.model_validate(payload)


def test_report_requires_exact_verified_validation_population(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path)
    subset = artifacts.observations[:-1]
    subset_manifest = artifacts.run_manifest.model_copy(
        update={
            "observation_count": len(subset),
            "observation_fingerprint": shadow_observation_fingerprint(subset),
        }
    )
    subset_labels = artifacts.labels[:-1]
    subset_label_manifest = _bind_labels_to_run(
        artifacts,
        subset_manifest,
        labels=subset_labels,
    )
    with pytest.raises(RiskCoverageContractError, match="complete verified validation"):
        _build(
            artifacts,
            observations=subset,
            labels=subset_labels,
            run_manifest=subset_manifest,
            label_manifest=subset_label_manifest,
        )

    disguised = artifacts.observations[1].model_copy(
        update={
            "case_id": artifacts.observations[0].case_id,
            "input_fingerprint": artifacts.observations[0].input_fingerprint,
        }
    )
    duplicate_cases = (artifacts.observations[0], disguised) + artifacts.observations[2:]
    duplicate_case_manifest = artifacts.run_manifest.model_copy(
        update={"observation_fingerprint": shadow_observation_fingerprint(duplicate_cases)}
    )
    with pytest.raises(RiskCoverageContractError, match="case IDs must be unique"):
        _build(
            artifacts,
            observations=duplicate_cases,
            run_manifest=duplicate_case_manifest,
        )

    duplicate_input = artifacts.observations[1].model_copy(
        update={"input_fingerprint": artifacts.observations[0].input_fingerprint}
    )
    duplicate_inputs = (artifacts.observations[0], duplicate_input) + artifacts.observations[2:]
    duplicate_input_manifest = artifacts.run_manifest.model_copy(
        update={"observation_fingerprint": shadow_observation_fingerprint(duplicate_inputs)}
    )
    with pytest.raises(RiskCoverageContractError, match="input fingerprints must be unique"):
        _build(
            artifacts,
            observations=duplicate_inputs,
            run_manifest=duplicate_input_manifest,
        )

    wrong_dataset_manifest = artifacts.run_manifest.model_copy(
        update={"dataset_fingerprint": "f" * 64}
    )
    with pytest.raises(RiskCoverageContractError, match="verified validation population"):
        _build(artifacts, run_manifest=wrong_dataset_manifest)


def test_assessments_must_recompute_from_canonical_signals_and_policy(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path)
    first = artifacts.observations[0]
    forged_assessment = first.assessment.model_copy(update={"score": 99})
    forged = first.model_copy(update={"assessment": forged_assessment})
    forged_records = (forged,) + artifacts.observations[1:]
    forged_manifest = artifacts.run_manifest.model_copy(
        update={"observation_fingerprint": shadow_observation_fingerprint(forged_records)}
    )
    forged_label_manifest = _bind_labels_to_run(artifacts, forged_manifest)
    with pytest.raises(RiskCoverageContractError, match="does not exactly recompute"):
        _build(
            artifacts,
            observations=forged_records,
            run_manifest=forged_manifest,
            label_manifest=forged_label_manifest,
        )

    hard = artifacts.observations[3]
    forged_hard = hard.model_copy(
        update={
            "assessment": hard.assessment.model_copy(
                update={"hard_failure": False, "reason_codes": ()}
            )
        }
    )
    forged_hard_records = artifacts.observations[:3] + (forged_hard,) + artifacts.observations[4:]
    forged_hard_manifest = artifacts.run_manifest.model_copy(
        update={"observation_fingerprint": shadow_observation_fingerprint(forged_hard_records)}
    )
    forged_hard_label_manifest = _bind_labels_to_run(artifacts, forged_hard_manifest)
    with pytest.raises(RiskCoverageContractError, match="does not exactly recompute"):
        _build(
            artifacts,
            observations=forged_hard_records,
            run_manifest=forged_hard_manifest,
            label_manifest=forged_hard_label_manifest,
        )

    reordered = first.model_copy(update={"signals": tuple(reversed(first.signals))})
    reordered_records = (reordered,) + artifacts.observations[1:]
    reordered_manifest = artifacts.run_manifest.model_copy(
        update={"observation_fingerprint": shadow_observation_fingerprint(reordered_records)}
    )
    reordered_label_manifest = _bind_labels_to_run(artifacts, reordered_manifest)
    with pytest.raises(RiskCoverageContractError, match="canonical policy order"):
        _build(
            artifacts,
            observations=reordered_records,
            run_manifest=reordered_manifest,
            label_manifest=reordered_label_manifest,
        )

    fake_policy = artifacts.run_manifest.model_copy(update={"confidence_policy_sha256": "a" * 64})
    fake_policy_label_manifest = _bind_labels_to_run(artifacts, fake_policy)
    with pytest.raises(RiskCoverageContractError, match="canonical policy artifact"):
        _build(
            artifacts,
            run_manifest=fake_policy,
            label_manifest=fake_policy_label_manifest,
        )


def test_manifest_and_report_invariants_reject_incomparable_artifacts(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path)
    wrong_run = artifacts.observations[0].model_copy(update={"run_id": "different-run"})
    wrong_run_records = (wrong_run,) + artifacts.observations[1:]
    wrong_run_manifest = artifacts.run_manifest.model_copy(
        update={"observation_fingerprint": shadow_observation_fingerprint(wrong_run_records)}
    )
    wrong_run_label_manifest = _bind_labels_to_run(artifacts, wrong_run_manifest)
    with pytest.raises(RiskCoverageContractError, match="run ID"):
        _build(
            artifacts,
            observations=wrong_run_records,
            run_manifest=wrong_run_manifest,
            label_manifest=wrong_run_label_manifest,
        )

    changed_target = artifacts.observations[0].model_copy(
        update={"agent1_result_fingerprint": "e" * 64}
    )
    changed_target_records = (changed_target,) + artifacts.observations[1:]
    changed_target_run_manifest = artifacts.run_manifest.model_copy(
        update={"observation_fingerprint": shadow_observation_fingerprint(changed_target_records)}
    )
    changed_target_label_manifest = artifacts.label_manifest.model_copy(
        update={
            "observation_fingerprint": (changed_target_run_manifest.observation_fingerprint),
            "run_manifest_fingerprint": shadow_run_manifest_fingerprint(
                changed_target_run_manifest
            ),
        }
    )
    with pytest.raises(RiskCoverageContractError, match="exact Agent 1 result"):
        _build(
            artifacts,
            observations=changed_target_records,
            run_manifest=changed_target_run_manifest,
            label_manifest=changed_target_label_manifest,
        )

    report = _build(artifacts)
    payload = report.model_dump(mode="json")
    payload["points"][2]["accepted"] = 2
    with pytest.raises(ValidationError, match="explicit denominator|increase"):
        RiskCoverageReport.model_validate(payload)

    payload = report.model_dump(mode="json")
    payload["points"][1]["unsafe_accepted"] = 1
    payload["points"][1]["selective_risk"] = 1.0
    payload["points"][1]["unsafe_accept_rate_over_population"] = 1 / 30
    payload["points"][2]["unsafe_accepted"] = 0
    payload["points"][2]["selective_risk"] = 0.0
    payload["points"][2]["unsafe_accept_rate_over_population"] = 0.0
    with pytest.raises(ValidationError, match="cannot decrease"):
        RiskCoverageReport.model_validate(payload)

    all_hard_artifacts = _write_artifacts(tmp_path / "all-hard", all_hard=True)
    all_hard_report = _build(all_hard_artifacts)
    assert all_hard_report.eligible_count == 0
    assert len(all_hard_report.points) == 1
    assert all_hard_report.points[0].point_kind == "accept_none"


def test_label_policy_is_precise_complete_and_deterministic(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path)
    label_policy = artifacts.label_manifest.label_policy
    assert label_policy.target == "safe_for_agent1_automatic_acceptance"
    assert label_policy.required_dimensions == tuple(AutomaticAcceptanceDimension)

    incomplete = label_policy.model_dump(mode="json")
    incomplete["required_dimensions"] = incomplete["required_dimensions"][:-1]
    with pytest.raises(ValidationError, match="at least 5 items"):
        AutomaticAcceptanceLabelPolicy.model_validate(incomplete)

    non_boolean = artifacts.labels[0].model_dump(mode="json")
    non_boolean["safe_for_agent1_automatic_acceptance"] = 1
    with pytest.raises(ValidationError):
        AutomaticAcceptanceLabel.model_validate(non_boolean)

    first = automatic_acceptance_label_fingerprint(artifacts.labels)
    second = automatic_acceptance_label_fingerprint(tuple(reversed(artifacts.labels)))
    assert first == second

    fixture = json.loads(CONTRACT_FIXTURE.read_text(encoding="utf-8"))
    evaluation = Agent1Evaluation.model_validate(fixture["agent1_evaluation"])
    evaluation_fingerprint = agent1_result_fingerprint(evaluation)
    changed_evaluation = evaluation.model_copy(
        update={"limitations": (*evaluation.limitations, "Fingerprint change fixture.")}
    )
    assert evaluation_fingerprint == agent1_result_fingerprint(evaluation)
    assert evaluation_fingerprint != agent1_result_fingerprint(changed_evaluation)


def test_cli_rejects_fixture_labels_by_default_and_emits_aggregate_only(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    artifacts = _write_artifacts(tmp_path)
    command = [
        "risk-coverage",
        "--dataset",
        str(DATASET_DIRECTORY),
        "--confidence-policy",
        str(DEFAULT_CONFIDENCE_POLICY_PATH),
        "--run-manifest",
        str(artifacts.run_manifest_path),
        "--label-set-manifest",
        str(artifacts.label_manifest_path),
    ]
    assert main(command) == EXIT_CONTRACT_FAILURE
    error = json.loads(capsys.readouterr().err)
    assert error["status"] == "contract_failure"
    assert "fixture-only labels" in error["error"]

    assert main([*command, "--allow-fixture-labels"]) == EXIT_OK
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    serialized = json.dumps(payload)
    assert payload["result_status"] == "fixture_only_analysis"
    assert payload["threshold_selected"] is False
    assert payload["contains_case_ids"] is False
    assert payload["contains_resume_text"] is False
    assert payload["contains_candidate_identifiers"] is False
    assert artifacts.observations[0].case_id not in serialized
    assert artifacts.population.cases[0].input.resume_markdown not in serialized

    observation_path = tmp_path / artifacts.run_manifest.observations_file
    observation_path.write_bytes(observation_path.read_bytes() + b"\n")
    assert main([*command, "--allow-fixture-labels"]) == EXIT_CONTRACT_FAILURE
    error = json.loads(capsys.readouterr().err)
    assert "SHA-256" in error["error"]
