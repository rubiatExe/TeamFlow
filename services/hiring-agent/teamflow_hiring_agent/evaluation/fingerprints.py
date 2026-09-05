"""Content-addressed identities for evaluation records and datasets."""

from __future__ import annotations

import hashlib
import unicodedata
from collections.abc import Iterable
from typing import Any

from .models import EvaluationCase
from .serialization import canonical_json


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def normalize_for_fingerprint(value: str) -> str:
    """NFKC-normalize, case-fold, and collapse Unicode whitespace."""

    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _input_payload(case: EvaluationCase) -> dict[str, Any]:
    review_input = case.input
    criteria = sorted(review_input.role.criteria, key=lambda item: item.criterion_id)
    request_merchant_id = review_input.request_merchant_id
    retrieved_topology = sorted(
        "request_tenant" if merchant_id == request_merchant_id else "other_tenant"
        for merchant_id in review_input.retrieved_merchant_ids
    )
    return {
        "candidate_tenant_relation": (
            "request_tenant"
            if review_input.candidate_merchant_id == request_merchant_id
            else "other_tenant"
        ),
        "extraction_quality": review_input.extraction_quality,
        "instructions": (
            normalize_for_fingerprint(review_input.instructions)
            if review_input.instructions is not None
            else None
        ),
        "provider_fault": (
            review_input.provider_fault.value if review_input.provider_fault is not None else None
        ),
        "retrieved_tenant_topology": retrieved_topology,
        "resume_markdown": normalize_for_fingerprint(review_input.resume_markdown),
        "role_tenant_relation": (
            "unknown"
            if review_input.role_merchant_id is None
            else (
                "request_tenant"
                if review_input.role_merchant_id == request_merchant_id
                else "other_tenant"
            )
        ),
        "role": {
            "criteria": [
                {
                    "criterion_id": criterion.criterion_id,
                    "description": normalize_for_fingerprint(criterion.description),
                    "required": criterion.required,
                    "weight": criterion.weight,
                }
                for criterion in criteria
            ],
            "title": normalize_for_fingerprint(review_input.role.title),
        },
    }


def case_input_fingerprint(case: EvaluationCase) -> str:
    """Hash behavior-affecting input while excluding labels and record metadata."""

    return sha256_bytes(canonical_json(_input_payload(case)).encode("utf-8"))


def case_record_fingerprint(case: EvaluationCase) -> str:
    return sha256_bytes(canonical_json(case).encode("utf-8"))


def ordered_digest(values: Iterable[str]) -> str:
    """Hash all values in lexical order without silently deduplicating them."""

    payload = "".join(f"{value}\n" for value in sorted(values)).encode("utf-8")
    return sha256_bytes(payload)


def case_schema_fingerprint() -> str:
    return sha256_bytes(canonical_json(EvaluationCase.model_json_schema()).encode("utf-8"))
