"""Typed outcomes that keep runtime, contract, and semantic failures separate."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictStr, StringConstraints, model_validator

from .models import FrozenModel, Identifier, Sha256


class FailureCategory(StrEnum):
    OPERATIONAL = "operational"
    CONTRACT = "contract"
    QUALITY = "quality"


class EvaluationResult(StrEnum):
    PASSED = "passed"
    OPERATIONAL_ERROR = "operational_error"
    CONTRACT_FAILURE = "contract_failure"
    QUALITY_FAILURE = "quality_failure"


class EvaluationFailure(FrozenModel):
    category: FailureCategory
    code: Identifier
    message: Annotated[StrictStr, StringConstraints(max_length=500)] = Field(
        default="", exclude=True, repr=False
    )
    retryable: StrictBool = False


_RESULT_CATEGORY: dict[EvaluationResult, FailureCategory] = {
    EvaluationResult.OPERATIONAL_ERROR: FailureCategory.OPERATIONAL,
    EvaluationResult.CONTRACT_FAILURE: FailureCategory.CONTRACT,
    EvaluationResult.QUALITY_FAILURE: FailureCategory.QUALITY,
}


class EvaluationRecord(FrozenModel):
    schema_version: Literal["1.0"] = "1.0"
    case_id: Identifier
    input_fingerprint: Sha256
    result: EvaluationResult
    failure: EvaluationFailure | None = None
    latency_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_outcome(self) -> EvaluationRecord:
        if self.result is EvaluationResult.PASSED:
            if self.failure is not None:
                raise ValueError("passed record cannot contain a failure")
            return self
        if self.failure is None:
            raise ValueError("failed record requires a failure")
        expected = _RESULT_CATEGORY[self.result]
        if self.failure.category is not expected:
            raise ValueError(
                f"failure category {self.failure.category.value} does not match result "
                f"{self.result.value}"
            )
        return self
