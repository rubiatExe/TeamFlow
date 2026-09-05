"""Deterministic aggregate metrics with explicit denominators."""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import Field

from .models import FrozenModel
from .records import EvaluationRecord, EvaluationResult


class EvaluationMetrics(FrozenModel):
    total_cases: int = Field(ge=0)
    passed: int = Field(ge=0)
    operational_errors: int = Field(ge=0)
    contract_failures: int = Field(ge=0)
    quality_failures: int = Field(ge=0)
    quality_denominator: int = Field(ge=0)
    operational_error_rate: float | None = Field(default=None, ge=0, le=1)
    contract_failure_rate: float | None = Field(default=None, ge=0, le=1)
    quality_pass_rate: float | None = Field(default=None, ge=0, le=1)


def summarize_records(records: Sequence[EvaluationRecord]) -> EvaluationMetrics:
    """Separate execution health from contract validity and semantic quality."""

    total = len(records)
    passed = sum(record.result is EvaluationResult.PASSED for record in records)
    operational = sum(record.result is EvaluationResult.OPERATIONAL_ERROR for record in records)
    contract = sum(record.result is EvaluationResult.CONTRACT_FAILURE for record in records)
    quality = sum(record.result is EvaluationResult.QUALITY_FAILURE for record in records)
    quality_denominator = passed + quality
    return EvaluationMetrics(
        total_cases=total,
        passed=passed,
        operational_errors=operational,
        contract_failures=contract,
        quality_failures=quality,
        quality_denominator=quality_denominator,
        operational_error_rate=operational / total if total else None,
        contract_failure_rate=contract / total if total else None,
        quality_pass_rate=passed / quality_denominator if quality_denominator else None,
    )
