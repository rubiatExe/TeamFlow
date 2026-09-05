"""Bounded canonical JSON and atomic artifact I/O helpers."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable, Mapping
from enum import Enum
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import BaseModel


def _json_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_json_value(item) for item in value]
    return value


def canonical_json(value: Any) -> str:
    """Return deterministic, compact, finite JSON without a trailing newline."""

    return json.dumps(
        _json_value(value),
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )


def artifact_json(value: Any) -> str:
    """Return canonical JSON with one LF terminator for artifact storage."""

    return canonical_json(value) + "\n"


def jsonl_bytes(records: Iterable[BaseModel]) -> bytes:
    """Serialize models in stable ``case_id`` order with exactly one LF per record."""

    values = list(records)
    if not values:
        raise ValueError("refusing to serialize an empty JSONL artifact")
    try:
        ordered = sorted(values, key=lambda item: str(item.case_id))
    except AttributeError as exc:
        raise TypeError("JSONL records must expose case_id") from exc
    identifiers = [str(item.case_id) for item in ordered]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("JSONL records must have unique case_id values")
    return ("\n".join(canonical_json(item) for item in ordered) + "\n").encode("utf-8")


def atomic_write_bytes(path: str | Path, payload: bytes) -> None:
    """Write through a same-directory temporary file and atomically replace."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        directory_descriptor = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def write_json_artifact(path: str | Path, value: Any) -> None:
    atomic_write_bytes(path, artifact_json(value).encode("utf-8"))


def write_jsonl_artifact(path: str | Path, records: Iterable[BaseModel]) -> None:
    atomic_write_bytes(path, jsonl_bytes(records))
