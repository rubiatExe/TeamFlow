"""Cloud Vision remains a first-class, integrity-checked canonical source."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from teamflow_hiring_agent.resume_review.workflow_contracts import (
    ExtractionSummary,
    StoredDocumentExtraction,
    canonical_snapshot_sha256,
)


def snapshot(method: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": "1.0",
        "merchant_id": "00000000-0000-4000-8000-000000000001",
        "document_id": f"doc-{'a' * 64}",
        "content_sha256": "a" * 64,
        "status": "complete",
        "text": "Jordan Rivera",
        "source_blocks": [
            {
                "source_block_id": "src-aaaaaaaaaaaa-p0001-b0001-006cb820d755",
                "page_number": 1,
                "ordinal": 1,
                "text": "Jordan Rivera",
            }
        ],
        "extraction_method": method,
        "model_id": "google-cloud-vision-v1-document-text-detection",
        "embedding_available": True,
        "mock": False,
        "warnings": [],
        "quality": {
            "assessment": "usable",
            "character_count": 13,
            "block_count": 1,
            "page_count": 1,
            "reason_codes": [],
        },
    }
    payload["snapshot_sha256"] = canonical_snapshot_sha256(payload)
    return payload


@pytest.mark.parametrize("method", ["pdf_text", "gemini_vision", "google_cloud_vision"])
@pytest.mark.parametrize("degraded", [False, True])
def test_stored_document_and_summary_preserve_supported_provenance(
    method: str,
    degraded: bool,
) -> None:
    payload = snapshot(method)
    if degraded:
        payload.update(status="degraded", embedding_available=False, warnings=["embedding_failed"])
        payload["snapshot_sha256"] = canonical_snapshot_sha256(
            {key: value for key, value in payload.items() if key != "snapshot_sha256"}
        )
    document = StoredDocumentExtraction.model_validate(payload)
    assert document.extraction_method == method
    summary = {
        key: value
        for key, value in payload.items()
        if key not in {"text", "source_blocks", "content_sha256", "quality"}
    }
    summary.update(quality="usable", character_count=13, block_count=1, page_count=1)
    assert ExtractionSummary.model_validate(summary).extraction_method == method


@pytest.mark.parametrize(
    "update",
    [
        {"extraction_method": "unknown_ocr"},
        {"text": "Modified text"},
        {"mock": True},
        {"warnings": ["ocr_provider_failed"]},
        {"snapshot_sha256": "b" * 64},
        {"model_id": ""},
    ],
)
def test_vision_provenance_does_not_bypass_canonical_guards(update: dict[str, Any]) -> None:
    payload = snapshot("google_cloud_vision")
    payload.update(update)
    with pytest.raises(ValidationError):
        StoredDocumentExtraction.model_validate(payload)


def test_provenance_change_requires_new_snapshot_digest() -> None:
    payload = snapshot("gemini_vision")
    payload["extraction_method"] = "google_cloud_vision"
    with pytest.raises(ValidationError, match="snapshot_sha256 must match"):
        StoredDocumentExtraction.model_validate(payload)
