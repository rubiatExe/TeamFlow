from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from pydantic import ValidationError

from teamflow_hiring_agent.evaluation.cli import (
    EXIT_CONTRACT_FAILURE,
    EXIT_OK,
    EXIT_OPERATIONAL_ERROR,
    main,
)
from teamflow_hiring_agent.evaluation.fingerprints import (
    case_input_fingerprint,
    case_record_fingerprint,
    ordered_digest,
)
from teamflow_hiring_agent.evaluation.loader import (
    CrossSplitLeakageError,
    DatasetContractError,
    DatasetIOError,
    DigestMismatchError,
    DuplicateCaseError,
    JSONLLineError,
    ManifestMismatchError,
    PurposeViolationError,
    create_split_manifest,
    load_dataset_split,
    read_jsonl,
    validate_no_cross_split_leakage,
    validate_no_duplicates,
    verify_dataset,
)
from teamflow_hiring_agent.evaluation.metrics import summarize_records
from teamflow_hiring_agent.evaluation.models import (
    CaseSource,
    DatasetPurpose,
    DatasetSplit,
    EvaluationCase,
    ReviewStatus,
    ScenarioCategory,
)
from teamflow_hiring_agent.evaluation.records import (
    EvaluationFailure,
    EvaluationRecord,
    EvaluationResult,
    FailureCategory,
)
from teamflow_hiring_agent.evaluation.reporting import build_report, report_markdown
from teamflow_hiring_agent.evaluation.serialization import artifact_json, jsonl_bytes

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DATASET_DIRECTORY = SERVICE_ROOT / "evals" / "resume_review_v1"


def make_case(
    *,
    case_id: str = "TF-RRV1-VA-901",
    split: DatasetSplit = DatasetSplit.VALIDATION,
    resume_markdown: str = "# Candidate Example\nWorked at Northstar Cafe for three years.",
    scenario: ScenarioCategory = ScenarioCategory.CLEAR_FIT,
    equivalence_group: str | None = None,
) -> EvaluationCase:
    return EvaluationCase.model_validate(
        {
            "schema_version": "1.0",
            "case_id": case_id,
            "split": split.value,
            "scenario": scenario.value,
            "title": "Synthetic barista review",
            "input": {
                "document_id": "doc-synthetic-901",
                "request_merchant_id": "00000000-0000-0000-0000-000000000001",
                "candidate_merchant_id": "00000000-0000-0000-0000-000000000001",
                "role_merchant_id": "00000000-0000-0000-0000-000000000001",
                "retrieved_merchant_ids": ["00000000-0000-0000-0000-000000000001"],
                "resume_markdown": resume_markdown,
                "role": {
                    "role_id": "00000000-0000-0000-0000-000000000010",
                    "title": "Barista",
                    "criteria": [
                        {
                            "criterion_id": "customer-service",
                            "description": "Customer service experience",
                            "weight": 60,
                            "required": True,
                        },
                        {
                            "criterion_id": "beverage-preparation",
                            "description": "Beverage preparation experience",
                            "weight": 40,
                            "required": False,
                        },
                    ],
                },
            },
            "expected": {
                "status": "complete",
                "critical_fields": [
                    {"field": "employer", "value": "Northstar Cafe"},
                ],
                "accepted_fit_score": {"minimum": 55, "maximum": 85},
                "must_cite": ["Worked at Northstar Cafe for three years."],
                "must_not_claim": ["managed a regional coffee program"],
                "review_required": False,
            },
            "provenance": {
                "source": "synthetic",
                "generator": "teamflow-phase1-tests",
                "generator_version": "1.0.0",
                "template_id": "test-barista",
                "seed": 901,
            },
            "review_status": "pending_human_review",
            "equivalence_group": equivalence_group,
        }
    )


def copy_dataset(tmp_path: Path) -> Path:
    destination = tmp_path / "resume_review_v1"
    shutil.copytree(DATASET_DIRECTORY, destination)
    return destination


def test_fingerprint_is_stable_and_ignores_record_metadata() -> None:
    first = make_case()
    second_payload = make_case(
        case_id="TF-RRV1-VA-902",
        resume_markdown="# candidate example\nWorked  at  Northstar Cafe for three years.",
    ).model_dump(mode="json")
    second_payload["input"]["request_merchant_id"] = "10000000-0000-0000-0000-000000000001"
    second_payload["input"]["candidate_merchant_id"] = "10000000-0000-0000-0000-000000000001"
    second_payload["input"]["role_merchant_id"] = "10000000-0000-0000-0000-000000000001"
    second_payload["input"]["retrieved_merchant_ids"] = ["10000000-0000-0000-0000-000000000001"]
    second_payload["input"]["role"]["role_id"] = "10000000-0000-0000-0000-000000000010"
    second = EvaluationCase.model_validate(second_payload)

    assert case_input_fingerprint(first) == case_input_fingerprint(second)
    assert case_input_fingerprint(first) == case_input_fingerprint(first)
    assert len(case_input_fingerprint(first)) == 64


def test_canonical_serialization_is_deterministic_and_finite() -> None:
    assert artifact_json({"z": 2, "a": "résumé"}) == '{"a":"résumé","z":2}\n'
    with pytest.raises(ValueError):
        artifact_json({"invalid": float("nan")})

    first = make_case(case_id="TF-RRV1-VA-901")
    second = make_case(
        case_id="TF-RRV1-VA-902",
        resume_markdown="# Candidate Two\nWorked at Northstar Cafe for three years.",
    )
    assert jsonl_bytes([second, first]) == jsonl_bytes([first, second])
    serialized_ids = [
        json.loads(line)["case_id"] for line in jsonl_bytes([second, first]).splitlines()
    ]
    assert serialized_ids == ["TF-RRV1-VA-901", "TF-RRV1-VA-902"]


def test_valid_case_is_strict_and_immutable() -> None:
    case = make_case()
    assert case.review_status is ReviewStatus.PENDING_HUMAN_REVIEW
    assert case.provenance.source is CaseSource.SYNTHETIC

    with pytest.raises(ValidationError):
        EvaluationCase.model_validate({**case.model_dump(mode="json"), "unknown": True})
    with pytest.raises(ValidationError):
        case.title = "mutated"  # type: ignore[misc]


def test_phase7_validation_expansion_preserves_locked_test_bytes() -> None:
    verified = verify_dataset(DATASET_DIRECTORY)
    split_counts = {item.split: item.count for item in verified.manifest.splits}
    test_split = next(item for item in verified.manifest.splits if item.split is DatasetSplit.TEST)

    assert verified.manifest.dataset_version == "1.1.0"
    assert split_counts[DatasetSplit.VALIDATION] == 30
    assert test_split.count == 20
    assert test_split.sha256 == ("4df3b9a42a7bf472344ab28a4bfc63bd8cef70dc7d433fd38d1de1b9766f5d9c")
    assert verified.test_lock.sha256 == test_split.sha256

    validation_cases = tuple(
        case for case in verified.cases if case.split is DatasetSplit.VALIDATION
    )
    original_cases = validation_cases[:25]
    assert ordered_digest(case.case_id for case in original_cases) == (
        "7123f7e5d427768e0edbc1a681771f617c08f2ebb45906b6c13b6f3bc4d0dffc"
    )
    assert ordered_digest(case_input_fingerprint(case) for case in original_cases) == (
        "7f0cc1a5b5936ae681202c1941cc675e654f0715a6561017642d994ad813d59b"
    )
    assert ordered_digest(case_record_fingerprint(case) for case in original_cases) == (
        "177ac1f91d7c069196f920d173537963611d2535f77ca9f8e3479c1d5423099e"
    )
    assert [case.case_id for case in validation_cases[25:]] == [
        f"TF-RRV1-VA-{index:03d}" for index in range(26, 31)
    ]
    assert all("semantic-entailment-edge" in case.tags for case in validation_cases[25:])


def test_malformed_case_and_jsonl_are_rejected_with_line_context(tmp_path: Path) -> None:
    malformed = make_case().model_dump(mode="json")
    malformed["expected"]["must_cite"] = ["text that is absent from the résumé"]
    with pytest.raises(ValidationError, match="must_cite"):
        EvaluationCase.model_validate(malformed)

    path = tmp_path / "malformed.jsonl"
    path.write_text('{"case_id":"one","case_id":"two"}\n', encoding="utf-8")
    with pytest.raises(JSONLLineError) as captured:
        read_jsonl(path, EvaluationCase)
    assert captured.value.line_number == 1
    assert "duplicate JSON object key" in str(captured.value)


def test_duplicate_detection_uses_normalized_input_content() -> None:
    first = make_case()
    duplicate = make_case(
        case_id="TF-RRV1-VA-902",
        resume_markdown="# candidate example\nWorked  at Northstar Cafe for three years.",
    )
    with pytest.raises(DuplicateCaseError, match="duplicate canonical input"):
        validate_no_duplicates([first, duplicate])


def test_cross_split_leakage_detects_content_and_equivalence_groups() -> None:
    validation = make_case()
    leaked_payload = make_case(
        case_id="TF-RRV1-TE-901",
        split=DatasetSplit.TEST,
    ).model_dump(mode="json")
    leaked_payload["input"]["request_merchant_id"] = "10000000-0000-0000-0000-000000000001"
    leaked_payload["input"]["candidate_merchant_id"] = "10000000-0000-0000-0000-000000000001"
    leaked_payload["input"]["role_merchant_id"] = "10000000-0000-0000-0000-000000000001"
    leaked_payload["input"]["retrieved_merchant_ids"] = ["10000000-0000-0000-0000-000000000001"]
    leaked_payload["input"]["role"]["role_id"] = "10000000-0000-0000-0000-000000000010"
    leaked = EvaluationCase.model_validate(leaked_payload)
    with pytest.raises(CrossSplitLeakageError, match="canonical input leaks"):
        validate_no_cross_split_leakage(
            {DatasetSplit.VALIDATION: [validation], DatasetSplit.TEST: [leaked]}
        )

    pair_a = make_case(equivalence_group="pair-tenant-neutrality-901")
    pair_b = make_case(
        case_id="TF-RRV1-TE-902",
        split=DatasetSplit.TEST,
        resume_markdown="# Candidate Variant\nWorked at Northstar Cafe for three years.",
        equivalence_group="pair-tenant-neutrality-901",
    )
    with pytest.raises(CrossSplitLeakageError, match="equivalence group"):
        validate_no_cross_split_leakage(
            {DatasetSplit.VALIDATION: [pair_a], DatasetSplit.TEST: [pair_b]}
        )


def test_manifest_tampering_fails_closed(tmp_path: Path) -> None:
    dataset = copy_dataset(tmp_path)
    manifest_path = dataset / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["total_count"] += 1
    manifest_path.write_text(artifact_json(manifest), encoding="utf-8", newline="\n")

    with pytest.raises(ManifestMismatchError, match="total_count"):
        verify_dataset(dataset)


def test_locked_test_set_detects_byte_mutation(tmp_path: Path) -> None:
    dataset = copy_dataset(tmp_path)
    with (dataset / "test.jsonl").open("ab") as sink:
        sink.write(b" \n")

    with pytest.raises(DigestMismatchError, match="SHA-256 mismatch"):
        verify_dataset(dataset)


def test_direct_test_loader_rejects_manifest_refresh_without_lock_update(
    tmp_path: Path,
) -> None:
    dataset = copy_dataset(tmp_path)
    test_path = dataset / "test.jsonl"
    cases = read_jsonl(test_path, EvaluationCase, require_canonical=True)
    cases[0] = cases[0].model_copy(update={"title": "Changed locked test title"})
    test_path.write_bytes(jsonl_bytes(cases))

    manifest_path = dataset / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    replacement = create_split_manifest(
        split=DatasetSplit.TEST,
        file="test.jsonl",
        artifact_path=test_path,
        cases=cases,
    ).model_dump(mode="json")
    manifest["splits"] = [
        replacement if item["split"] == DatasetSplit.TEST.value else item
        for item in manifest["splits"]
    ]
    manifest_path.write_text(artifact_json(manifest), encoding="utf-8", newline="\n")

    with pytest.raises(ManifestMismatchError, match="test lock does not match"):
        load_dataset_split(
            dataset,
            DatasetSplit.TEST,
            purpose=DatasetPurpose.TEST_EVALUATION,
        )


def test_validation_purpose_cannot_load_locked_test_cases() -> None:
    with pytest.raises(PurposeViolationError, match="may not load"):
        load_dataset_split(
            DATASET_DIRECTORY,
            DatasetSplit.TEST,
            purpose=DatasetPurpose.VALIDATION,
        )


def test_committed_dataset_is_verified_private_safe_and_not_gold() -> None:
    verified = verify_dataset(DATASET_DIRECTORY)
    assert verified.counts == {
        DatasetSplit.VALIDATION: 30,
        DatasetSplit.TEST: 20,
        DatasetSplit.ADVERSARIAL: 15,
    }
    assert verified.manifest.total_count == 65
    assert verified.manifest.review_status is ReviewStatus.PENDING_HUMAN_REVIEW
    assert {case.scenario for case in verified.cases} == set(ScenarioCategory)
    assert all(case.provenance.source is CaseSource.SYNTHETIC for case in verified.cases)
    assert all(case.review_status is ReviewStatus.PENDING_HUMAN_REVIEW for case in verified.cases)
    assert "golden" not in (DATASET_DIRECTORY / "README.md").read_text(encoding="utf-8").casefold()


def test_committed_adversarial_cases_encode_fail_closed_expectations() -> None:
    cases = verify_dataset(DATASET_DIRECTORY).cases
    prompt_injections = [
        case for case in cases if case.scenario is ScenarioCategory.PROMPT_INJECTION
    ]
    wrong_tenant = [
        case for case in cases if case.scenario is ScenarioCategory.WRONG_TENANT_CONTEXT
    ]
    provider_failures = [
        case for case in cases if case.scenario is ScenarioCategory.PROVIDER_FAILURE
    ]

    assert len(prompt_injections) == 4
    assert all(not case.expected.allow_writes for case in prompt_injections)
    assert all(case.expected.must_not_claim for case in prompt_injections)
    assert len(wrong_tenant) == 3
    assert all(not case.expected.allow_model_calls for case in wrong_tenant)
    assert all(not case.expected.allow_writes for case in wrong_tenant)
    assert len(provider_failures) == 4
    assert all(case.input.provider_fault is not None for case in provider_failures)


def test_evaluation_records_separate_operational_contract_and_quality_failures() -> None:
    input_fingerprint = "a" * 64
    records = [
        EvaluationRecord(
            case_id="pass",
            input_fingerprint=input_fingerprint,
            result=EvaluationResult.PASSED,
        ),
        EvaluationRecord(
            case_id="provider",
            input_fingerprint=input_fingerprint,
            result=EvaluationResult.OPERATIONAL_ERROR,
            failure=EvaluationFailure(
                category=FailureCategory.OPERATIONAL,
                code="provider_timeout",
                retryable=True,
            ),
        ),
        EvaluationRecord(
            case_id="schema",
            input_fingerprint=input_fingerprint,
            result=EvaluationResult.CONTRACT_FAILURE,
            failure=EvaluationFailure(
                category=FailureCategory.CONTRACT,
                code="malformed_output",
            ),
        ),
        EvaluationRecord(
            case_id="grounding",
            input_fingerprint=input_fingerprint,
            result=EvaluationResult.QUALITY_FAILURE,
            failure=EvaluationFailure(
                category=FailureCategory.QUALITY,
                code="unsupported_claim",
            ),
        ),
    ]

    metrics = summarize_records(records)
    assert metrics.total_cases == 4
    assert metrics.passed == 1
    assert metrics.operational_errors == 1
    assert metrics.contract_failures == 1
    assert metrics.quality_failures == 1
    assert metrics.quality_denominator == 2
    assert metrics.quality_pass_rate == 0.5

    with pytest.raises(ValidationError, match="passed record cannot contain a failure"):
        EvaluationRecord(
            case_id="invalid",
            input_fingerprint=input_fingerprint,
            result=EvaluationResult.PASSED,
            failure=EvaluationFailure(
                category=FailureCategory.QUALITY,
                code="impossible",
            ),
        )
    with pytest.raises(ValidationError, match="does not match result"):
        EvaluationRecord(
            case_id="mismatched",
            input_fingerprint=input_fingerprint,
            result=EvaluationResult.CONTRACT_FAILURE,
            failure=EvaluationFailure(
                category=FailureCategory.OPERATIONAL,
                code="wrong_category",
            ),
        )


def test_report_is_deterministic_and_excludes_failure_messages() -> None:
    record = EvaluationRecord(
        case_id="provider",
        input_fingerprint="a" * 64,
        result=EvaluationResult.OPERATIONAL_ERROR,
        failure=EvaluationFailure(
            category=FailureCategory.OPERATIONAL,
            code="provider_timeout",
            message="private résumé text must not appear",
            retryable=True,
        ),
    )
    report = build_report(
        dataset_name="resume_review_v1",
        dataset_version="1.0.0",
        dataset_fingerprint="b" * 64,
        records=[record],
    )

    assert artifact_json(report) == artifact_json(report)
    assert "private résumé text" not in artifact_json(record)
    rendered = report_markdown(report)
    assert "provider_timeout" in rendered
    assert "private résumé text" not in rendered


def test_cli_verifies_dataset_and_classifies_failures(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["verify", str(DATASET_DIRECTORY)]) == EXIT_OK
    success = json.loads(capsys.readouterr().out)
    assert success["status"] == "verified"
    assert success["counts"] == {"adversarial": 15, "test": 20, "validation": 30}

    tampered = copy_dataset(tmp_path)
    with (tampered / "test.jsonl").open("ab") as sink:
        sink.write(b" \n")
    assert main(["verify", str(tampered)]) == EXIT_CONTRACT_FAILURE
    failure_output = capsys.readouterr()
    assert "contract_failure" in failure_output.err

    missing = tmp_path / "missing"
    assert main(["verify", str(missing)]) == EXIT_OPERATIONAL_ERROR
    operational_output = capsys.readouterr()
    assert "operational_error" in operational_output.err
    assert not issubclass(DatasetContractError, DatasetIOError)


def test_loader_rejects_noncanonical_order_and_missing_newline(tmp_path: Path) -> None:
    first = make_case(case_id="TF-RRV1-VA-901")
    second = make_case(
        case_id="TF-RRV1-VA-902",
        resume_markdown="# Candidate Two\nWorked at Northstar Cafe for three years.",
    )
    reverse_order = tmp_path / "reverse.jsonl"
    reverse_order.write_text(
        artifact_json(second).rstrip("\n") + "\n" + artifact_json(first),
        encoding="utf-8",
        newline="\n",
    )
    with pytest.raises(DatasetContractError, match="canonical case_id order"):
        read_jsonl(reverse_order, EvaluationCase, require_canonical=True)

    missing_newline = tmp_path / "missing-newline.jsonl"
    missing_newline.write_bytes(artifact_json(first).rstrip("\n").encode("utf-8"))
    with pytest.raises(JSONLLineError, match="must end with a newline"):
        read_jsonl(missing_newline, EvaluationCase)
