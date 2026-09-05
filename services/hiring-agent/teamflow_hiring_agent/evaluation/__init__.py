"""Offline evaluation foundation; intentionally disconnected from production runtime."""

from .loader import verify_dataset
from .records import EvaluationRecord, EvaluationResult, FailureCategory

__all__ = [
    "EvaluationRecord",
    "EvaluationResult",
    "FailureCategory",
    "verify_dataset",
]
