"""Fail-closed loading, manifest verification, and split-isolation checks."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from .fingerprints import (
    case_input_fingerprint,
    case_record_fingerprint,
    case_schema_fingerprint,
    ordered_digest,
    sha256_bytes,
)
from .models import (
    DatasetManifest,
    DatasetPurpose,
    DatasetSplit,
    EvaluationCase,
    ScenarioCategory,
    SplitManifest,
    TestSetLock,
)
from .serialization import artifact_json, canonical_json, jsonl_bytes

ModelT = TypeVar("ModelT", bound=BaseModel)
DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_LINE_BYTES = 64 * 1024


class EvaluationDatasetError(Exception):
    """Base class for safe CLI error classification."""


class DatasetIOError(EvaluationDatasetError):
    """The verifier could not reliably read the requested artifact."""


class DatasetContractError(EvaluationDatasetError):
    """The artifact was readable but violated the dataset contract."""


class JSONLLineError(DatasetContractError):
    def __init__(self, path: Path, line_number: int, message: str) -> None:
        self.path = path
        self.line_number = line_number
        self.message = message
        super().__init__(f"{path}:{line_number}: {message}")


class DigestMismatchError(DatasetContractError):
    pass


class ManifestMismatchError(DatasetContractError):
    pass


class DuplicateCaseError(DatasetContractError):
    pass


class CrossSplitLeakageError(DatasetContractError):
    pass


class PurposeViolationError(DatasetContractError):
    pass


def _reject_nonstandard_number(value: str) -> None:
    raise ValueError(f"non-standard JSON number is forbidden: {value}")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key is forbidden: {key!r}")
        result[key] = value
    return result


def _regular_file(path: Path, *, max_file_bytes: int) -> None:
    if path.is_symlink():
        raise ManifestMismatchError(f"artifact may not be a symlink: {path}")
    if not path.exists():
        raise DatasetIOError(f"artifact does not exist: {path}")
    if not path.is_file():
        raise DatasetIOError(f"artifact is not a regular file: {path}")
    if path.stat().st_size > max_file_bytes:
        raise ManifestMismatchError(f"artifact exceeds {max_file_bytes} bytes: {path}")


def _safe_artifact(dataset_directory: Path, relative_name: str) -> Path:
    root = dataset_directory.resolve()
    unresolved = root / relative_name
    if unresolved.is_symlink():
        raise ManifestMismatchError(f"artifact may not be a symlink: {unresolved}")
    candidate = unresolved.resolve()
    if candidate.parent != root:
        raise ManifestMismatchError(f"artifact must be directly inside {root}: {relative_name}")
    return candidate


def _parse_json_object(payload: str, *, description: str) -> dict[str, Any]:
    try:
        value = json.loads(
            payload,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_nonstandard_number,
        )
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ManifestMismatchError(f"invalid JSON in {description}: {exc}") from exc
    if not isinstance(value, dict):
        raise ManifestMismatchError(f"{description} must contain a JSON object")
    return value


def read_jsonl(
    path: str | Path,
    model_type: type[ModelT],
    *,
    require_canonical: bool = False,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_line_bytes: int = DEFAULT_MAX_LINE_BYTES,
) -> list[ModelT]:
    """Read bounded UTF-8 JSONL and retain the exact failing line number."""

    source = Path(path)
    _regular_file(source, max_file_bytes=max_file_bytes)
    records: list[ModelT] = []
    raw_artifact = source.read_bytes()
    for line_number, raw_line in enumerate(raw_artifact.splitlines(keepends=True), start=1):
        if len(raw_line) > max_line_bytes:
            raise JSONLLineError(source, line_number, f"line exceeds {max_line_bytes} bytes")
        if not raw_line.endswith(b"\n"):
            raise JSONLLineError(source, line_number, "line must end with a newline")
        payload = raw_line[:-1]
        if payload.endswith(b"\r"):
            payload = payload[:-1]
        if not payload.strip():
            raise JSONLLineError(source, line_number, "blank lines are forbidden")
        try:
            text = payload.decode("utf-8", errors="strict")
            value = json.loads(
                text,
                object_pairs_hook=_reject_duplicate_keys,
                parse_constant=_reject_nonstandard_number,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
            raise JSONLLineError(source, line_number, f"invalid JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise JSONLLineError(source, line_number, "JSON value must be an object")
        try:
            records.append(model_type.model_validate(value))
        except ValidationError as exc:
            errors = exc.errors(include_input=False, include_url=False)
            raise JSONLLineError(
                source,
                line_number,
                f"schema validation failed: {errors}",
            ) from exc
    if not records:
        raise DatasetContractError(f"JSONL artifact is empty: {source}")
    if require_canonical:
        identifiers = [str(getattr(record, "case_id", "")) for record in records]
        if identifiers != sorted(identifiers):
            raise DatasetContractError(f"JSONL is not in canonical case_id order: {source}")
        try:
            expected = jsonl_bytes(records)
        except (TypeError, ValueError) as exc:
            raise DatasetContractError(
                f"cannot canonicalize JSONL artifact {source}: {exc}"
            ) from exc
        if raw_artifact != expected:
            raise DatasetContractError(f"JSONL is not canonically serialized: {source}")
    return records


def _read_model(path: Path, model_type: type[ModelT]) -> ModelT:
    _regular_file(path, max_file_bytes=DEFAULT_MAX_FILE_BYTES)
    try:
        payload = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ManifestMismatchError(f"artifact is not valid UTF-8: {path}") from exc
    value = _parse_json_object(payload, description=str(path))
    try:
        model = model_type.model_validate(value)
    except ValidationError as exc:
        errors = exc.errors(include_input=False, include_url=False)
        raise ManifestMismatchError(f"schema validation failed for {path}: {errors}") from exc
    if payload != artifact_json(model):
        raise ManifestMismatchError(f"artifact is not canonically serialized: {path}")
    return model


def read_json_artifact(path: str | Path, model_type: type[ModelT]) -> ModelT:
    """Read one bounded, canonical, non-symlink JSON model artifact."""

    return _read_model(Path(path), model_type)


def sha256_file(path: str | Path, *, max_file_bytes: int = DEFAULT_MAX_FILE_BYTES) -> str:
    source = Path(path)
    _regular_file(source, max_file_bytes=max_file_bytes)
    digest = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sha256(path: str | Path, expected: str) -> None:
    actual = sha256_file(path)
    if actual != expected:
        raise DigestMismatchError(f"SHA-256 mismatch for {path}: expected {expected}, got {actual}")


def load_manifest(dataset_directory: str | Path) -> DatasetManifest:
    root = Path(dataset_directory)
    return _read_model(_safe_artifact(root, "manifest.json"), DatasetManifest)


def load_test_lock(dataset_directory: str | Path, manifest: DatasetManifest) -> TestSetLock:
    root = Path(dataset_directory)
    lock = _read_model(_safe_artifact(root, manifest.test_lock_file), TestSetLock)
    if (
        lock.dataset_name != manifest.dataset_name
        or lock.dataset_version != manifest.dataset_version
    ):
        raise ManifestMismatchError("test lock dataset identity does not match manifest")
    return lock


def validate_no_duplicates(cases: Sequence[EvaluationCase]) -> None:
    seen_ids: set[str] = set()
    seen_inputs: dict[str, str] = {}
    for case in cases:
        if case.case_id in seen_ids:
            raise DuplicateCaseError(f"duplicate case_id: {case.case_id}")
        seen_ids.add(case.case_id)
        fingerprint = case_input_fingerprint(case)
        if fingerprint in seen_inputs:
            raise DuplicateCaseError(
                "duplicate canonical input "
                f"{fingerprint}: {seen_inputs[fingerprint]} and {case.case_id}"
            )
        seen_inputs[fingerprint] = case.case_id


def validate_no_cross_split_leakage(
    splits: Mapping[DatasetSplit, Sequence[EvaluationCase]],
) -> None:
    seen_ids: dict[str, DatasetSplit] = {}
    seen_inputs: dict[str, tuple[DatasetSplit, str]] = {}
    seen_groups: dict[str, tuple[DatasetSplit, str]] = {}
    for split in DatasetSplit:
        for case in splits.get(split, ()):
            if case.split is not split:
                raise ManifestMismatchError(
                    f"{case.case_id} declares {case.split.value}, loaded as {split.value}"
                )
            prior_id = seen_ids.get(case.case_id)
            if prior_id is not None and prior_id is not split:
                raise CrossSplitLeakageError(
                    f"case_id {case.case_id} appears in {prior_id.value} and {split.value}"
                )
            seen_ids[case.case_id] = split

            fingerprint = case_input_fingerprint(case)
            prior_input = seen_inputs.get(fingerprint)
            if prior_input is not None and prior_input[0] is not split:
                raise CrossSplitLeakageError(
                    "canonical input leaks across splits "
                    f"{prior_input[0].value}/{prior_input[1]} and {split.value}/{case.case_id}"
                )
            seen_inputs[fingerprint] = (split, case.case_id)

            if case.equivalence_group is not None:
                prior_group = seen_groups.get(case.equivalence_group)
                if prior_group is not None and prior_group[0] is not split:
                    raise CrossSplitLeakageError(
                        "equivalence group leaks across splits "
                        f"{case.equivalence_group}: {prior_group[0].value}/{prior_group[1]} "
                        f"and {split.value}/{case.case_id}"
                    )
                seen_groups[case.equivalence_group] = (split, case.case_id)


def _split_digests(cases: Sequence[EvaluationCase]) -> tuple[str, str, str]:
    validate_no_duplicates(cases)
    return (
        ordered_digest(case_record_fingerprint(case) for case in cases),
        ordered_digest(case_input_fingerprint(case) for case in cases),
        ordered_digest(case.case_id for case in cases),
    )


def create_split_manifest(
    *, split: DatasetSplit, file: str, artifact_path: str | Path, cases: Sequence[EvaluationCase]
) -> SplitManifest:
    record_digest, input_digest, case_id_digest = _split_digests(cases)
    return SplitManifest(
        split=split,
        file=file,
        count=len(cases),
        sha256=sha256_file(artifact_path),
        record_fingerprint_sha256=record_digest,
        input_fingerprint_sha256=input_digest,
        case_id_sha256=case_id_digest,
    )


def verify_test_lock(dataset_directory: str | Path, manifest: DatasetManifest) -> TestSetLock:
    root = Path(dataset_directory)
    lock = load_test_lock(root, manifest)
    test_manifest = next(item for item in manifest.splits if item.split is DatasetSplit.TEST)
    fields = (
        "file",
        "count",
        "sha256",
        "record_fingerprint_sha256",
        "input_fingerprint_sha256",
        "case_id_sha256",
    )
    if any(getattr(lock, field) != getattr(test_manifest, field) for field in fields):
        raise ManifestMismatchError("test lock does not match the test split manifest")
    if lock.case_schema_sha256 != case_schema_fingerprint():
        raise ManifestMismatchError("test lock case schema fingerprint does not match runtime")
    verify_sha256(_safe_artifact(root, lock.file), lock.sha256)
    return lock


def load_dataset_split(
    dataset_directory: str | Path,
    split: DatasetSplit,
    *,
    purpose: DatasetPurpose,
    manifest: DatasetManifest | None = None,
) -> tuple[EvaluationCase, ...]:
    allowed_splits = {
        DatasetPurpose.VALIDATION: frozenset({DatasetSplit.VALIDATION}),
        DatasetPurpose.TEST_EVALUATION: frozenset({DatasetSplit.TEST}),
        DatasetPurpose.ADVERSARIAL_EVALUATION: frozenset({DatasetSplit.ADVERSARIAL}),
        DatasetPurpose.INTEGRITY_VERIFICATION: frozenset(DatasetSplit),
    }
    if split not in allowed_splits[purpose]:
        raise PurposeViolationError(
            f"purpose {purpose.value!r} may not load the {split.value!r} split"
        )
    root = Path(dataset_directory)
    resolved_manifest = manifest or load_manifest(root)
    if split is DatasetSplit.TEST:
        verify_test_lock(root, resolved_manifest)
    split_manifest = next(item for item in resolved_manifest.splits if item.split is split)
    artifact = _safe_artifact(root, split_manifest.file)
    verify_sha256(artifact, split_manifest.sha256)
    cases = tuple(read_jsonl(artifact, EvaluationCase, require_canonical=True))
    if any(case.split is not split for case in cases):
        raise ManifestMismatchError(f"{artifact} contains a record from another split")
    if any(case.review_status is not resolved_manifest.review_status for case in cases):
        raise ManifestMismatchError(f"{split.value} review status differs from the manifest")
    if len(cases) != split_manifest.count:
        raise ManifestMismatchError(
            f"{split.value} count mismatch: expected {split_manifest.count}, got {len(cases)}"
        )
    record_digest, input_digest, case_id_digest = _split_digests(cases)
    if record_digest != split_manifest.record_fingerprint_sha256:
        raise ManifestMismatchError(f"{split.value} record fingerprint mismatch")
    if input_digest != split_manifest.input_fingerprint_sha256:
        raise ManifestMismatchError(f"{split.value} input fingerprint mismatch")
    if case_id_digest != split_manifest.case_id_sha256:
        raise ManifestMismatchError(f"{split.value} case ID fingerprint mismatch")
    return cases


@dataclass(frozen=True)
class VerifiedDataset:
    manifest: DatasetManifest
    test_lock: TestSetLock
    cases: tuple[EvaluationCase, ...]
    dataset_fingerprint: str

    @property
    def counts(self) -> dict[DatasetSplit, int]:
        return {split: sum(case.split is split for case in self.cases) for split in DatasetSplit}


def verify_dataset(dataset_directory: str | Path) -> VerifiedDataset:
    root = Path(dataset_directory)
    manifest = load_manifest(root)
    lock = verify_test_lock(root, manifest)
    splits = {
        split: load_dataset_split(
            root,
            split,
            purpose=DatasetPurpose.INTEGRITY_VERIFICATION,
            manifest=manifest,
        )
        for split in DatasetSplit
    }
    validate_no_cross_split_leakage(splits)
    cases = tuple(case for split in DatasetSplit for case in splits[split])
    if len(cases) != manifest.total_count:
        raise ManifestMismatchError(
            f"manifest total_count={manifest.total_count}, loaded={len(cases)}"
        )
    covered = {case.scenario for case in cases}
    if covered != set(ScenarioCategory):
        missing = sorted(scenario.value for scenario in set(ScenarioCategory) - covered)
        raise ManifestMismatchError(f"dataset is missing required scenarios: {missing}")
    identity = sha256_bytes(
        (canonical_json(manifest) + "\n" + canonical_json(lock)).encode("utf-8")
    )
    return VerifiedDataset(
        manifest=manifest,
        test_lock=lock,
        cases=cases,
        dataset_fingerprint=identity,
    )
