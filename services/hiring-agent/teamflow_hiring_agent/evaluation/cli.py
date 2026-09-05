"""Read-only command-line verification for offline evaluation artifacts."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from ..resume_review.confidence import ConfidencePolicyError, load_confidence_policy
from .diagnostic_judge import CachedJudgeInput, CachedJudgeOutput, DiagnosticJudgeRunManifest
from .loader import (
    DatasetContractError,
    DatasetIOError,
    read_json_artifact,
    read_jsonl,
    sha256_file,
    verify_dataset,
)
from .risk_coverage import (
    AutomaticAcceptanceLabel,
    AutomaticAcceptanceLabelSetManifest,
    RiskCoverageContractError,
    ShadowConfidenceObservation,
    ShadowConfidenceRunManifest,
    build_risk_coverage_report,
    load_verified_validation_population,
    resolve_direct_artifact,
)
from .semantic_regression import (
    GateDecision,
    HumanSemanticLabel,
    HumanSemanticLabelSetManifest,
    SemanticRegressionBaselineLock,
    SemanticRegressionContractError,
    build_semantic_regression_report,
    verify_baseline_manifest_file,
)
from .semantic_regression import (
    resolve_direct_artifact as resolve_regression_artifact,
)
from .serialization import artifact_json

EXIT_OK = 0
EXIT_QUALITY_FAILURE = 1
EXIT_CONTRACT_FAILURE = 2
EXIT_OPERATIONAL_ERROR = 3


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="teamflow-evaluation")
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify = subparsers.add_parser("verify", help="verify an offline evaluation corpus")
    verify.add_argument("dataset_path", nargs="?", type=Path)
    verify.add_argument("--dataset", dest="dataset_option", type=Path)
    risk_coverage = subparsers.add_parser(
        "risk-coverage",
        help="build a comparable validation-only curve without selecting a threshold",
    )
    risk_coverage.add_argument("--dataset", required=True, type=Path)
    risk_coverage.add_argument("--confidence-policy", required=True, type=Path)
    risk_coverage.add_argument("--run-manifest", required=True, type=Path)
    risk_coverage.add_argument("--label-set-manifest", required=True, type=Path)
    risk_coverage.add_argument(
        "--allow-fixture-labels",
        action="store_true",
        help="permit fixture-only labels for local tooling tests; disabled by default",
    )
    regression = subparsers.add_parser(
        "semantic-regression",
        help="compare immutable cached diagnostic-judge runs against exact human labels",
    )
    regression.add_argument("--dataset", required=True, type=Path)
    regression.add_argument("--baseline-lock", required=True, type=Path)
    regression.add_argument("--candidate-run-manifest", required=True, type=Path)
    regression.add_argument("--label-set-manifest", required=True, type=Path)
    regression.add_argument(
        "--allow-fixture-labels",
        action="store_true",
        help="permit fixture-only mechanics; output can never pass the evidence gate",
    )
    return parser


def _dataset_path(arguments: argparse.Namespace) -> Path:
    if arguments.dataset_path is not None and arguments.dataset_option is not None:
        raise DatasetContractError("provide the dataset either positionally or with --dataset")
    return arguments.dataset_option or arguments.dataset_path or Path("evals/resume_review_v1")


def _error_payload(status: str, error: Exception) -> str:
    return artifact_json({"error": str(error), "status": status})


def _verified_member(manifest_path: Path, file_name: str, expected_sha256: str) -> Path:
    member = resolve_regression_artifact(manifest_path, file_name)
    if sha256_file(member) != expected_sha256:
        raise SemanticRegressionContractError("cached artifact SHA-256 differs from manifest")
    return member


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    quality_failure = False
    try:
        if arguments.command == "verify":
            verified = verify_dataset(_dataset_path(arguments))
            result: object = {
                "counts": {split.value: count for split, count in verified.counts.items()},
                "dataset_fingerprint": verified.dataset_fingerprint,
                "dataset_name": verified.manifest.dataset_name,
                "dataset_version": verified.manifest.dataset_version,
                "review_status": verified.manifest.review_status.value,
                "status": "verified",
            }
        elif arguments.command == "risk-coverage":
            run_manifest = read_json_artifact(
                arguments.run_manifest,
                ShadowConfidenceRunManifest,
            )
            label_manifest = read_json_artifact(
                arguments.label_set_manifest,
                AutomaticAcceptanceLabelSetManifest,
            )
            observation_path = resolve_direct_artifact(
                arguments.run_manifest,
                run_manifest.observations_file,
            )
            label_path = resolve_direct_artifact(
                arguments.label_set_manifest,
                label_manifest.labels_file,
            )
            if sha256_file(observation_path) != run_manifest.observations_sha256:
                raise RiskCoverageContractError(
                    "observation file SHA-256 differs from the run manifest"
                )
            if sha256_file(label_path) != label_manifest.labels_sha256:
                raise RiskCoverageContractError(
                    "label file SHA-256 differs from the label-set manifest"
                )
            observations = read_jsonl(
                observation_path,
                ShadowConfidenceObservation,
                require_canonical=True,
            )
            labels = read_jsonl(
                label_path,
                AutomaticAcceptanceLabel,
                require_canonical=True,
            )
            result = build_risk_coverage_report(
                observations,
                labels,
                run_manifest=run_manifest,
                label_manifest=label_manifest,
                population=load_verified_validation_population(arguments.dataset),
                confidence_policy=load_confidence_policy(arguments.confidence_policy),
                allow_fixture_labels=arguments.allow_fixture_labels,
            )
        else:
            baseline_lock = read_json_artifact(
                arguments.baseline_lock, SemanticRegressionBaselineLock
            )
            baseline_manifest_path = verify_baseline_manifest_file(
                arguments.baseline_lock, baseline_lock
            )
            baseline_manifest = read_json_artifact(
                baseline_manifest_path, DiagnosticJudgeRunManifest
            )
            candidate_manifest = read_json_artifact(
                arguments.candidate_run_manifest, DiagnosticJudgeRunManifest
            )
            label_manifest = read_json_artifact(
                arguments.label_set_manifest, HumanSemanticLabelSetManifest
            )
            baseline_input_path = _verified_member(
                baseline_manifest_path,
                baseline_manifest.inputs_file,
                baseline_manifest.inputs_sha256,
            )
            baseline_output_path = _verified_member(
                baseline_manifest_path,
                baseline_manifest.outputs_file,
                baseline_manifest.outputs_sha256,
            )
            candidate_input_path = _verified_member(
                arguments.candidate_run_manifest,
                candidate_manifest.inputs_file,
                candidate_manifest.inputs_sha256,
            )
            candidate_output_path = _verified_member(
                arguments.candidate_run_manifest,
                candidate_manifest.outputs_file,
                candidate_manifest.outputs_sha256,
            )
            label_path = _verified_member(
                arguments.label_set_manifest,
                label_manifest.labels_file,
                label_manifest.labels_sha256,
            )
            result = build_semantic_regression_report(
                read_jsonl(baseline_input_path, CachedJudgeInput, require_canonical=True),
                read_jsonl(baseline_output_path, CachedJudgeOutput, require_canonical=True),
                read_jsonl(candidate_input_path, CachedJudgeInput, require_canonical=True),
                read_jsonl(candidate_output_path, CachedJudgeOutput, require_canonical=True),
                read_jsonl(label_path, HumanSemanticLabel, require_canonical=True),
                baseline_manifest=baseline_manifest,
                candidate_manifest=candidate_manifest,
                label_manifest=label_manifest,
                baseline_lock=baseline_lock,
                dataset_directory=arguments.dataset,
                allow_fixture_labels=arguments.allow_fixture_labels,
            )
            quality_failure = result.gate_decision is not GateDecision.PASS
    except (
        ConfidencePolicyError,
        DatasetContractError,
        RiskCoverageContractError,
        SemanticRegressionContractError,
    ) as exc:
        sys.stderr.write(_error_payload("contract_failure", exc))
        return EXIT_CONTRACT_FAILURE
    except (DatasetIOError, OSError) as exc:
        sys.stderr.write(_error_payload("operational_error", exc))
        return EXIT_OPERATIONAL_ERROR
    except Exception as exc:  # pragma: no cover - last-resort CLI boundary
        sys.stderr.write(
            artifact_json(
                {
                    "error": f"unexpected {type(exc).__name__}",
                    "status": "operational_error",
                }
            )
        )
        return EXIT_OPERATIONAL_ERROR

    sys.stdout.write(artifact_json(result))
    return EXIT_QUALITY_FAILURE if quality_failure else EXIT_OK
