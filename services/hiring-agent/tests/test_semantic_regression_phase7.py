from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from teamflow_hiring_agent.evaluation.cli import (
    EXIT_CONTRACT_FAILURE,
    EXIT_QUALITY_FAILURE,
    main,
)
from teamflow_hiring_agent.evaluation.diagnostic_judge import (
    CachedJudgeInput,
    CachedJudgeOutput,
    DiagnosticJudgeRunManifest,
    JudgeConfiguration,
    JudgeDimension,
    JudgeDimensionResult,
    JudgeExecutionStatus,
    JudgeFailure,
    JudgeFailureCategory,
    JudgeFailureCode,
    JudgeProducerKind,
    JudgeReasonCode,
    JudgeVerdict,
    build_diagnostic_judge_run_manifest,
    cached_judge_input_fingerprint,
    cached_judge_output_fingerprint,
    cached_judge_output_schema_fingerprint,
    canonical_judge_adapter_sha256,
    canonical_judge_generation_configuration_sha256,
    canonical_judge_prompt_sha256,
    canonical_judge_rubric_sha256,
    canonical_judge_safety_configuration_sha256,
    canonical_judge_tool_policy_sha256,
    diagnostic_judge_model_output_schema_fingerprint,
    judge_configuration_fingerprint,
    judge_run_manifest_fingerprint,
    transient_judge_payload_schema_fingerprint,
)
from teamflow_hiring_agent.evaluation.fingerprints import (
    case_input_fingerprint,
    ordered_digest,
    sha256_bytes,
)
from teamflow_hiring_agent.evaluation.loader import sha256_file
from teamflow_hiring_agent.evaluation.risk_coverage import (
    VerifiedValidationPopulation,
    load_verified_validation_population,
)
from teamflow_hiring_agent.evaluation.semantic_regression import (
    GateDecision,
    HumanDimensionLabel,
    HumanLabelApproval,
    HumanSemanticLabel,
    HumanSemanticLabelSetManifest,
    KappaStatus,
    SemanticRegressionBaselineLock,
    SemanticRegressionContractError,
    baseline_lock_fingerprint,
    build_semantic_regression_report,
    canonical_semantic_regression_policy,
    human_label_fingerprint,
    semantic_regression_policy_sha256,
    semantic_target_fingerprint,
)
from teamflow_hiring_agent.evaluation.serialization import (
    artifact_json,
    jsonl_bytes,
    write_json_artifact,
    write_jsonl_artifact,
)

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DATASET = SERVICE_ROOT / "evals" / "resume_review_v1"


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _configuration(*, live: bool, candidate: bool) -> JudgeConfiguration:
    provider = "google-gemini" if live else "teamflow-fixture"
    return JudgeConfiguration(
        judge_id="semantic-judge-v1",
        judge_adapter_version="1.0.0",
        judge_adapter_sha256=canonical_judge_adapter_sha256(provider),
        provider=provider,
        model=("candidate-judge" if candidate else "baseline-judge"),
        model_version=("2.0.0" if candidate else "1.0.0"),
        prompt_id="resume-review-semantic-v1",
        prompt_version="1.0.0",
        prompt_sha256=canonical_judge_prompt_sha256(),
        rubric_id="grounding-relevance-consistency-v1",
        rubric_version="1.0.0",
        rubric_sha256=canonical_judge_rubric_sha256(),
        transient_input_schema_version="1.0",
        transient_input_schema_sha256=transient_judge_payload_schema_fingerprint(),
        model_output_schema_version="1.0",
        model_output_schema_sha256=diagnostic_judge_model_output_schema_fingerprint(),
        output_schema_version="1.0",
        output_schema_sha256=cached_judge_output_schema_fingerprint(),
        safety_configuration_version="1.0.0",
        safety_configuration_sha256=canonical_judge_safety_configuration_sha256(),
        generation_configuration_version="1.0.0",
        generation_configuration_sha256=canonical_judge_generation_configuration_sha256(),
        tool_policy_version="1.0.0",
        tool_policy_sha256=canonical_judge_tool_policy_sha256(),
        temperature=0,
        top_p=1.0,
        top_k=1,
        seed=0,
        candidate_count=1,
        max_output_tokens=512,
        timeout_milliseconds=10_000,
        retry_attempts=1,
        response_mime_type="application/json",
        tool_access="none",
        database_access=False,
        diagnostic_only=True,
    )


_REASONS = {
    (JudgeDimension.GROUNDEDNESS, JudgeVerdict.PASS): JudgeReasonCode.EVIDENCE_SUPPORTED,
    (JudgeDimension.GROUNDEDNESS, JudgeVerdict.FAIL): JudgeReasonCode.EVIDENCE_NOT_SUPPORTED,
    (JudgeDimension.GROUNDEDNESS, JudgeVerdict.UNCERTAIN): (
        JudgeReasonCode.SOURCE_CONTEXT_INSUFFICIENT
    ),
    (JudgeDimension.CRITERIA_RELEVANCE, JudgeVerdict.PASS): JudgeReasonCode.CRITERIA_RELEVANT,
    (JudgeDimension.CRITERIA_RELEVANCE, JudgeVerdict.FAIL): (
        JudgeReasonCode.CRITERION_EVIDENCE_IRRELEVANT
    ),
    (JudgeDimension.CRITERIA_RELEVANCE, JudgeVerdict.UNCERTAIN): (
        JudgeReasonCode.CRITERIA_CONTEXT_INSUFFICIENT
    ),
    (JudgeDimension.INTERNAL_CONSISTENCY, JudgeVerdict.PASS): (
        JudgeReasonCode.INTERNALLY_CONSISTENT
    ),
    (JudgeDimension.INTERNAL_CONSISTENCY, JudgeVerdict.FAIL): (
        JudgeReasonCode.SCORE_EVIDENCE_CONFLICT
    ),
    (JudgeDimension.INTERNAL_CONSISTENCY, JudgeVerdict.UNCERTAIN): (
        JudgeReasonCode.CONSISTENCY_CONTEXT_INSUFFICIENT
    ),
}


def _dimensions(overall: JudgeVerdict) -> tuple[JudgeDimensionResult, ...]:
    verdicts = (
        (overall, JudgeVerdict.PASS, JudgeVerdict.PASS)
        if overall is not JudgeVerdict.UNCERTAIN
        else (JudgeVerdict.UNCERTAIN,) * 3
    )
    return tuple(
        JudgeDimensionResult(
            dimension=dimension,
            verdict=verdict,
            reason_codes=(_REASONS[(dimension, verdict)],),
        )
        for dimension, verdict in zip(JudgeDimension, verdicts, strict=True)
    )


def _human_dimensions(verdict: JudgeVerdict) -> tuple[HumanDimensionLabel, ...]:
    verdicts = (
        (verdict, JudgeVerdict.PASS, JudgeVerdict.PASS)
        if verdict is not JudgeVerdict.UNCERTAIN
        else (JudgeVerdict.UNCERTAIN,) * 3
    )
    return tuple(
        HumanDimensionLabel(
            dimension=dimension,
            verdict=item,
            pass_votes=2 if item is JudgeVerdict.PASS else 0,
            fail_votes=2 if item is JudgeVerdict.FAIL else 0,
            abstain_votes=2 if item is JudgeVerdict.UNCERTAIN else 0,
            adjudicated=False,
        )
        for dimension, item in zip(JudgeDimension, verdicts, strict=True)
    )


@dataclass(frozen=True)
class Artifacts:
    root: Path
    population: VerifiedValidationPopulation
    baseline_inputs: tuple[CachedJudgeInput, ...]
    baseline_outputs: tuple[CachedJudgeOutput, ...]
    candidate_inputs: tuple[CachedJudgeInput, ...]
    candidate_outputs: tuple[CachedJudgeOutput, ...]
    labels: tuple[HumanSemanticLabel, ...]
    baseline_manifest: DiagnosticJudgeRunManifest
    candidate_manifest: DiagnosticJudgeRunManifest
    label_manifest: HumanSemanticLabelSetManifest
    baseline_lock: SemanticRegressionBaselineLock
    lock_path: Path
    candidate_manifest_path: Path
    label_manifest_path: Path

    def report(self, *, allow_fixture: bool = True):  # type: ignore[no-untyped-def]
        return build_semantic_regression_report(
            self.baseline_inputs,
            self.baseline_outputs,
            self.candidate_inputs,
            self.candidate_outputs,
            self.labels,
            baseline_manifest=self.baseline_manifest,
            candidate_manifest=self.candidate_manifest,
            label_manifest=self.label_manifest,
            baseline_lock=self.baseline_lock,
            dataset_directory=DATASET,
            allow_fixture_labels=allow_fixture,
        )


def _write_artifacts(
    tmp_path: Path,
    *,
    human_approved: bool = False,
    all_human_pass: bool = False,
    regressions: bool = False,
) -> Artifacts:
    population = load_verified_validation_population(DATASET)
    assert len(population.cases) == 30
    producer = (
        JudgeProducerKind.LIVE_PROVIDER if human_approved else JudgeProducerKind.SCRIPTED_FIXTURE
    )
    baseline_config = _configuration(live=human_approved, candidate=False)
    candidate_config = _configuration(live=human_approved, candidate=True)
    dataset = population.verified_dataset

    def inputs_for(run_id: str, config: JudgeConfiguration) -> tuple[CachedJudgeInput, ...]:
        return tuple(
            CachedJudgeInput(
                run_id=run_id,
                case_id=case.case_id,
                dataset_name=dataset.manifest.dataset_name,
                dataset_version=dataset.manifest.dataset_version,
                dataset_fingerprint=dataset.dataset_fingerprint,
                split="validation",
                purpose="validation",
                source_kind="synthetic",
                anonymization_approval_fingerprint=None,
                case_input_fingerprint=case_input_fingerprint(case),
                generator_run_manifest_fingerprint="a" * 64,
                generator_configuration_fingerprint="b" * 64,
                agent1_result_fingerprint=_sha(f"agent1:{case.case_id}"),
                question_plan_fingerprint=_sha(f"questions:{case.case_id}"),
                transient_payload_sha256=_sha(f"payload:{case.case_id}"),
                judge_configuration_fingerprint=judge_configuration_fingerprint(config),
                contains_resume_text=False,
                contains_prompt_text=False,
                contains_free_form_rationale=False,
                contains_candidate_identifiers=False,
                contains_tenant_identifiers=False,
                contains_contact_details=False,
                contains_hiring_scores=False,
            )
            for case in population.cases
        )

    baseline_inputs = inputs_for("baseline-run-001", baseline_config)
    candidate_inputs = inputs_for("candidate-run-001", candidate_config)
    human_verdicts = tuple(
        JudgeVerdict.PASS if all_human_pass or index < 15 else JudgeVerdict.FAIL
        for index in range(30)
    )

    def outputs_for(
        inputs: tuple[CachedJudgeInput, ...],
        config: JudgeConfiguration,
        *,
        candidate: bool,
    ) -> tuple[CachedJudgeOutput, ...]:
        values = []
        for index, (record, human) in enumerate(zip(inputs, human_verdicts, strict=True)):
            verdict = human
            if regressions and not candidate and index == 1:
                verdict = JudgeVerdict.FAIL
            if regressions and candidate and index == 0:
                verdict = JudgeVerdict.FAIL
            if regressions and candidate and index == 15:
                verdict = JudgeVerdict.PASS
            dimensions = _dimensions(verdict)
            values.append(
                CachedJudgeOutput(
                    run_id=record.run_id,
                    case_id=record.case_id,
                    judge_input_fingerprint=cached_judge_input_fingerprint(record),
                    agent1_result_fingerprint=record.agent1_result_fingerprint,
                    question_plan_fingerprint=record.question_plan_fingerprint,
                    judge_configuration_fingerprint=judge_configuration_fingerprint(config),
                    producer_kind=producer,
                    execution_status="completed",
                    failure=None,
                    dimensions=dimensions,
                    overall_verdict=verdict,
                    diagnostic_only=True,
                    threshold_applied=False,
                    contains_resume_text=False,
                    contains_prompt_text=False,
                    contains_raw_model_output=False,
                    contains_free_form_rationale=False,
                    contains_candidate_identifiers=False,
                    contains_tenant_identifiers=False,
                    contains_contact_details=False,
                    contains_hiring_scores=False,
                )
            )
        return tuple(values)

    baseline_outputs = outputs_for(baseline_inputs, baseline_config, candidate=False)
    candidate_outputs = outputs_for(candidate_inputs, candidate_config, candidate=True)
    baseline_dir = tmp_path / "baseline"
    candidate_dir = tmp_path / "candidate"
    label_dir = tmp_path / "labels"
    for directory in (baseline_dir, candidate_dir, label_dir):
        directory.mkdir(parents=True)
    write_jsonl_artifact(baseline_dir / "inputs.jsonl", baseline_inputs)
    write_jsonl_artifact(baseline_dir / "outputs.jsonl", baseline_outputs)
    write_jsonl_artifact(candidate_dir / "inputs.jsonl", candidate_inputs)
    write_jsonl_artifact(candidate_dir / "outputs.jsonl", candidate_outputs)

    def manifest_for(
        inputs: tuple[CachedJudgeInput, ...],
        outputs: tuple[CachedJudgeOutput, ...],
        config: JudgeConfiguration,
    ) -> DiagnosticJudgeRunManifest:
        return build_diagnostic_judge_run_manifest(
            inputs,
            outputs,
            configuration=config,
            split_file_sha256=population.split_manifest.sha256,
            population_case_input_fingerprint_sha256=(
                population.split_manifest.input_fingerprint_sha256
            ),
            generator_provider="fixture-generator",
            generator_model="fixture-generator-v1",
            inputs_file="inputs.jsonl",
            outputs_file="outputs.jsonl",
        )

    baseline_manifest = manifest_for(baseline_inputs, baseline_outputs, baseline_config)
    candidate_manifest = manifest_for(candidate_inputs, candidate_outputs, candidate_config)
    baseline_manifest_path = baseline_dir / "run-manifest.json"
    candidate_manifest_path = candidate_dir / "run-manifest.json"
    write_json_artifact(baseline_manifest_path, baseline_manifest)
    write_json_artifact(candidate_manifest_path, candidate_manifest)

    labels = tuple(
        HumanSemanticLabel(
            label_set_id="semantic-labels-001",
            case_id=record.case_id,
            split="validation",
            case_input_fingerprint=record.case_input_fingerprint,
            semantic_target_fingerprint=semantic_target_fingerprint(record),
            generator_run_manifest_fingerprint=record.generator_run_manifest_fingerprint,
            generator_configuration_fingerprint=record.generator_configuration_fingerprint,
            agent1_result_fingerprint=record.agent1_result_fingerprint,
            question_plan_fingerprint=record.question_plan_fingerprint,
            dimensions=_human_dimensions(verdict),
            overall_verdict=verdict,
        )
        for record, verdict in zip(baseline_inputs, human_verdicts, strict=True)
    )
    label_path = label_dir / "labels.jsonl"
    write_jsonl_artifact(label_path, labels)
    label_manifest = HumanSemanticLabelSetManifest(
        label_set_id="semantic-labels-001",
        status="human_approved" if human_approved else "fixture_only",
        dataset_name=dataset.manifest.dataset_name,
        dataset_version=dataset.manifest.dataset_version,
        dataset_fingerprint=dataset.dataset_fingerprint,
        split="validation",
        purpose="validation",
        split_file_sha256=population.split_manifest.sha256,
        population_case_id_sha256=population.split_manifest.case_id_sha256,
        population_case_input_fingerprint_sha256=(
            population.split_manifest.input_fingerprint_sha256
        ),
        full_split_count=30,
        generator_run_manifest_fingerprint="a" * 64,
        generator_configuration_fingerprint="b" * 64,
        rubric_id=baseline_config.rubric_id,
        rubric_version=baseline_config.rubric_version,
        rubric_sha256=baseline_config.rubric_sha256,
        required_dimensions=tuple(JudgeDimension),
        labels_file=label_path.name,
        labels_sha256=sha256_file(label_path),
        label_record_fingerprint_sha256=ordered_digest(
            human_label_fingerprint(item) for item in labels
        ),
        label_count=30,
        approval=(
            HumanLabelApproval(
                approved_at=datetime(2026, 8, 28, tzinfo=UTC),
                reviewer_count=2,
                adjudicator_count=1,
                approval_reference="approval-001",
            )
            if human_approved
            else None
        ),
        contains_resume_text=False,
        contains_free_form_rationale=False,
        contains_candidate_identifiers=False,
        contains_tenant_identifiers=False,
        contains_contact_details=False,
        contains_hiring_scores=False,
    )
    label_manifest_path = label_dir / "label-manifest.json"
    write_json_artifact(label_manifest_path, label_manifest)
    policy = canonical_semantic_regression_policy()
    lock = SemanticRegressionBaselineLock(
        lock_id="semantic-baseline-001",
        lock_version="1.0.0",
        baseline_run_id=baseline_manifest.run_id,
        baseline_run_manifest_file=baseline_manifest_path.name,
        baseline_run_manifest_sha256=sha256_file(baseline_manifest_path),
        baseline_run_manifest_fingerprint=judge_run_manifest_fingerprint(baseline_manifest),
        baseline_judge_configuration_fingerprint=(
            baseline_manifest.judge_configuration_fingerprint
        ),
        baseline_input_record_fingerprint_sha256=(
            baseline_manifest.input_record_fingerprint_sha256
        ),
        baseline_output_record_fingerprint_sha256=(
            baseline_manifest.output_record_fingerprint_sha256
        ),
        dataset_fingerprint=dataset.dataset_fingerprint,
        split="validation",
        full_split_count=30,
        regression_policy=policy,
        regression_policy_sha256=semantic_regression_policy_sha256(policy),
        allowed_candidate_change_fields=("model", "model_version"),
        automatic_baseline_update=False,
    )
    lock_path = baseline_dir / "baseline.lock.json"
    write_json_artifact(lock_path, lock)
    return Artifacts(
        tmp_path,
        population,
        baseline_inputs,
        baseline_outputs,
        candidate_inputs,
        candidate_outputs,
        labels,
        baseline_manifest,
        candidate_manifest,
        label_manifest,
        lock,
        lock_path,
        candidate_manifest_path,
        label_manifest_path,
    )


def test_fixture_report_is_deterministic_private_and_never_evidence(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path)
    report = artifacts.report()
    assert report == artifacts.report()
    assert report.gate_decision is GateDecision.FIXTURE_ONLY_NOT_EVIDENCE
    assert report.human_agreement_measured is False
    assert report.threshold_selected is False
    assert report.calibrated is False
    assert report.production_routing_authorized is False
    serialized = artifact_json(report)
    assert artifacts.labels[0].case_id not in serialized
    assert artifacts.population.cases[0].input.resume_markdown not in serialized
    assert report.baseline_lock_fingerprint == baseline_lock_fingerprint(artifacts.baseline_lock)


def test_cli_rejects_fixture_by_default_and_explicit_mode_is_not_green(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifacts = _write_artifacts(tmp_path)
    command = [
        "semantic-regression",
        "--dataset",
        str(DATASET),
        "--baseline-lock",
        str(artifacts.lock_path),
        "--candidate-run-manifest",
        str(artifacts.candidate_manifest_path),
        "--label-set-manifest",
        str(artifacts.label_manifest_path),
    ]
    assert main(command) == EXIT_CONTRACT_FAILURE
    assert "fixture-only" in capsys.readouterr().err
    assert main([*command, "--allow-fixture-labels"]) == EXIT_QUALITY_FAILURE
    payload = json.loads(capsys.readouterr().out)
    assert payload["gate_decision"] == "fixture_only_not_evidence"


def test_exact_population_subset_and_disguised_split_fail_closed(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path, human_approved=True)
    with pytest.raises(SemanticRegressionContractError, match="complete validation"):
        build_semantic_regression_report(
            artifacts.baseline_inputs[:-1],
            artifacts.baseline_outputs[:-1],
            artifacts.candidate_inputs,
            artifacts.candidate_outputs,
            artifacts.labels,
            baseline_manifest=artifacts.baseline_manifest,
            candidate_manifest=artifacts.candidate_manifest,
            label_manifest=artifacts.label_manifest,
            baseline_lock=artifacts.baseline_lock,
            dataset_directory=DATASET,
            allow_fixture_labels=False,
        )
    test_split = next(
        item
        for item in artifacts.population.verified_dataset.manifest.splits
        if item.split.value == "test"
    )
    disguised = artifacts.candidate_manifest.model_copy(
        update={
            "split": "test",
            "purpose": "test_evaluation",
            "split_file_sha256": test_split.sha256,
            "population_case_id_sha256": test_split.case_id_sha256,
            "population_case_input_fingerprint_sha256": (test_split.input_fingerprint_sha256),
            "full_split_count": test_split.count,
        }
    )
    with pytest.raises(SemanticRegressionContractError, match="verified validation population"):
        build_semantic_regression_report(
            artifacts.baseline_inputs,
            artifacts.baseline_outputs,
            artifacts.candidate_inputs,
            artifacts.candidate_outputs,
            artifacts.labels,
            baseline_manifest=artifacts.baseline_manifest,
            candidate_manifest=disguised,
            label_manifest=artifacts.label_manifest,
            baseline_lock=artifacts.baseline_lock,
            dataset_directory=DATASET,
            allow_fixture_labels=False,
        )


def test_failed_output_and_status_count_tamper_are_typed_contract_failures(
    tmp_path: Path,
) -> None:
    artifacts = _write_artifacts(tmp_path)
    failed = artifacts.candidate_outputs[0].model_copy(
        update={
            "execution_status": JudgeExecutionStatus.OPERATIONAL_ERROR,
            "failure": JudgeFailure(
                category=JudgeFailureCategory.OPERATIONAL,
                code=JudgeFailureCode.PROVIDER_TIMEOUT,
                retryable=True,
            ),
            "dimensions": (),
            "overall_verdict": None,
        }
    )
    outputs = (failed, *artifacts.candidate_outputs[1:])
    manifest = artifacts.candidate_manifest.model_copy(
        update={
            "outputs_sha256": sha256_bytes(jsonl_bytes(outputs)),
            "output_record_fingerprint_sha256": ordered_digest(
                cached_judge_output_fingerprint(item) for item in outputs
            ),
        }
    )
    with pytest.raises(SemanticRegressionContractError, match="execution-status counts"):
        build_semantic_regression_report(
            artifacts.baseline_inputs,
            artifacts.baseline_outputs,
            artifacts.candidate_inputs,
            outputs,
            artifacts.labels,
            baseline_manifest=artifacts.baseline_manifest,
            candidate_manifest=manifest,
            label_manifest=artifacts.label_manifest,
            baseline_lock=artifacts.baseline_lock,
            dataset_directory=DATASET,
            allow_fixture_labels=True,
        )


def test_policy_change_lock_and_label_target_tampering_fail_closed(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path)
    with pytest.raises(ValidationError, match="canonical"):
        artifacts.baseline_lock.model_copy(
            update={"regression_policy_sha256": "f" * 64}
        ).model_validate(
            {
                **artifacts.baseline_lock.model_dump(mode="json"),
                "regression_policy_sha256": "f" * 64,
            }
        )
    changed = artifacts.baseline_lock.model_copy(
        update={"allowed_candidate_change_fields": ("model",)}
    )
    with pytest.raises(SemanticRegressionContractError, match="lock declaration"):
        replace(artifacts, baseline_lock=changed).report()
    forged = artifacts.labels[0].model_copy(update={"semantic_target_fingerprint": "f" * 64})
    labels = (forged, *artifacts.labels[1:])
    manifest = artifacts.label_manifest.model_copy(
        update={
            "labels_sha256": sha256_bytes(jsonl_bytes(labels)),
            "label_record_fingerprint_sha256": ordered_digest(
                human_label_fingerprint(item) for item in labels
            ),
        }
    )
    with pytest.raises(SemanticRegressionContractError, match="exact target"):
        replace(artifacts, labels=labels, label_manifest=manifest).report()


def test_human_vote_totals_must_match_declared_reviewer_count(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path, human_approved=True)
    bad_dimension = artifacts.labels[0].dimensions[0].model_copy(update={"pass_votes": 3})
    bad_label = artifacts.labels[0].model_copy(
        update={"dimensions": (bad_dimension, *artifacts.labels[0].dimensions[1:])}
    )
    labels = (bad_label, *artifacts.labels[1:])
    manifest = artifacts.label_manifest.model_copy(
        update={
            "labels_sha256": sha256_bytes(jsonl_bytes(labels)),
            "label_record_fingerprint_sha256": ordered_digest(
                human_label_fingerprint(item) for item in labels
            ),
        }
    )
    with pytest.raises(SemanticRegressionContractError, match="vote totals"):
        replace(artifacts, labels=labels, label_manifest=manifest).report()


def test_human_regressions_fail_without_improvement_compensation(tmp_path: Path) -> None:
    report = _write_artifacts(tmp_path, human_approved=True, regressions=True).report(
        allow_fixture=False
    )
    assert report.gate_decision is GateDecision.FAIL
    assert "new_false_accept" in report.gate_failure_codes
    assert "new_false_reject" in report.gate_failure_codes
    assert "new_human_disagreement" in report.gate_failure_codes
    assert "pass_to_nonpass_regression" in report.gate_failure_codes
    assert any(item.resolved_disagreements for item in report.slices)


def test_kappa_degeneracy_and_balance_are_explicit(tmp_path: Path) -> None:
    report = _write_artifacts(tmp_path, all_human_pass=True).report()
    assert "human_label_balance_insufficient" in report.gate_failure_codes
    assert "kappa_undefined" in report.gate_failure_codes
    assert all(item.baseline.kappa_status is KappaStatus.DEGENERATE for item in report.slices)


def test_generator_provider_or_model_declaration_change_is_incomparable(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path)
    changed = artifacts.candidate_manifest.model_copy(
        update={"generator_provider": "another-generator"}
    )
    with pytest.raises(SemanticRegressionContractError, match="generator"):
        replace(artifacts, candidate_manifest=changed).report()
