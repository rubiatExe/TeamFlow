"""Validated adapters from the shared read-only MCP catalog to review loaders."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from types import MappingProxyType
from typing import Any

from langchain_core.messages import ToolMessage
from opentelemetry import trace

from ..mcp.client import MCP_TOOL_NAMES
from .contracts import RoleScoringPolicy
from .workflow_contracts import DocumentMetadata, DocumentSourceBlock, ExtractionSummary

tracer = trace.get_tracer("teamflow.resume_review.mcp_client", "1.0.0")

_DOCUMENT_TOOL = "get_resume_document"
_ROLE_TOOL = "load_active_role_policies"
RESUME_REVIEW_TOOL_NAMES = (_DOCUMENT_TOOL, _ROLE_TOOL)


class ResumeReviewToolCatalogError(RuntimeError):
    """The injected MCP catalog did not match the application-owned inventory."""


def _normalize_result(result: Any) -> Any:
    """Normalize only the pinned adapter's documented result envelopes."""

    if isinstance(result, ToolMessage):
        artifact = result.artifact
        if isinstance(artifact, dict) and "structured_content" in artifact:
            result = artifact["structured_content"]
        else:
            result = result.content
    if isinstance(result, str):
        try:
            return json.loads(result)
        except json.JSONDecodeError:
            return result
    if isinstance(result, list):
        text_blocks = [
            block.get("text", "")
            for block in result
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        if len(text_blocks) == 1:
            try:
                result = json.loads(text_blocks[0])
            except json.JSONDecodeError:
                result = text_blocks[0]
    if isinstance(result, dict) and set(result) == {"result"}:
        return result["result"]
    return result


def select_resume_review_tools(catalog: object) -> Mapping[str, Any]:
    """Select two loaders only after re-checking the complete pinned catalog."""

    try:
        items = tuple(catalog.items())
    except Exception:
        raise ResumeReviewToolCatalogError("resume_review_tool_catalog_invalid") from None
    names = tuple(name for name, _ in items)
    if (
        len(names) != len(set(names))
        or set(names) != set(MCP_TOOL_NAMES)
        or any(type(name) is not str for name in names)
    ):
        raise ResumeReviewToolCatalogError("resume_review_tool_catalog_invalid")

    selected: dict[str, Any] = {}
    for name, tool in items:
        try:
            declared_name = tool.name
            invocation = tool.ainvoke
        except Exception:
            raise ResumeReviewToolCatalogError("resume_review_tool_catalog_invalid") from None
        if declared_name != name or not callable(invocation):
            raise ResumeReviewToolCatalogError("resume_review_tool_catalog_invalid")
        if name in RESUME_REVIEW_TOOL_NAMES:
            selected[name] = tool
    if set(selected) != set(RESUME_REVIEW_TOOL_NAMES):
        raise ResumeReviewToolCatalogError("resume_review_tool_catalog_invalid")
    return MappingProxyType(selected)


class MCPDocumentLoader:
    """Expose one canonical document projection and cache it per invocation."""

    def __init__(self, tools: Mapping[str, Any]) -> None:
        self._tool = tools[_DOCUMENT_TOOL]
        self._cache: dict[tuple[str, str, str | None], dict[str, Any]] = {}

    async def _load(
        self,
        merchant_id: str,
        document_id: str,
        candidate_id: str | None,
    ) -> dict[str, Any]:
        key = (merchant_id, document_id, candidate_id)
        if key not in self._cache:
            with tracer.start_as_current_span(
                "resume_review.get_document",
                record_exception=False,
                set_status_on_exception=False,
            ):
                result = _normalize_result(
                    await self._tool.ainvoke(
                        {
                            "merchant_id": merchant_id,
                            "document_id": document_id,
                            "candidate_id": candidate_id,
                        }
                    )
                )
            if not isinstance(result, dict) or result.get("error"):
                raise RuntimeError("resume_review_document_unavailable")
            self._cache[key] = result
        return self._cache[key]

    async def load_metadata(
        self,
        *,
        merchant_id: str,
        document_id: str,
        candidate_id: str | None,
    ) -> DocumentMetadata:
        row = await self._load(merchant_id, document_id, candidate_id)
        return DocumentMetadata.model_validate(
            {
                key: row.get(key)
                for key in (
                    "schema_version",
                    "document_id",
                    "merchant_id",
                    "content_sha256",
                    "mock",
                )
            }
        )

    async def ensure_extraction(
        self,
        *,
        merchant_id: str,
        document_id: str,
        candidate_id: str | None,
    ) -> ExtractionSummary:
        row = await self._load(merchant_id, document_id, candidate_id)
        quality = row.get("quality")
        if not isinstance(quality, dict):
            raise RuntimeError("resume_review_document_invalid")
        return ExtractionSummary.model_validate(
            {
                "schema_version": row.get("schema_version"),
                "document_id": row.get("document_id"),
                "merchant_id": row.get("merchant_id"),
                "status": row.get("status"),
                "extraction_method": row.get("extraction_method"),
                "model_id": row.get("model_id"),
                "embedding_available": row.get("embedding_available"),
                "mock": row.get("mock"),
                "quality": quality.get("assessment"),
                "character_count": quality.get("character_count"),
                "block_count": quality.get("block_count"),
                "page_count": quality.get("page_count"),
                "warnings": row.get("warnings"),
                "snapshot_sha256": row.get("snapshot_sha256"),
            }
        )

    async def load_source_blocks(
        self,
        *,
        merchant_id: str,
        document_id: str,
        candidate_id: str | None,
    ) -> Iterable[DocumentSourceBlock]:
        row = await self._load(merchant_id, document_id, candidate_id)
        blocks = row.get("source_blocks")
        if not isinstance(blocks, list):
            raise RuntimeError("resume_review_document_invalid")
        return tuple(DocumentSourceBlock.model_validate(block) for block in blocks)


class MCPActiveRoleLoader:
    """Load the complete bounded scoring catalog through one pinned tool."""

    def __init__(self, tools: Mapping[str, Any]) -> None:
        self._tool = tools[_ROLE_TOOL]

    async def load_active_roles(
        self,
        *,
        merchant_id: str,
        limit: int,
    ) -> Iterable[RoleScoringPolicy]:
        with tracer.start_as_current_span(
            "resume_review.load_active_roles",
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            span.set_attribute("teamflow.role_limit", limit)
            result = _normalize_result(
                await self._tool.ainvoke({"merchant_id": merchant_id, "limit": limit})
            )
        if isinstance(result, dict) and result.get("error"):
            raise RuntimeError("resume_review_role_catalog_unavailable")
        if not isinstance(result, list) or len(result) > limit:
            raise RuntimeError("resume_review_role_catalog_invalid")
        policies = tuple(RoleScoringPolicy.model_validate(policy) for policy in result)
        if len({policy.role_id for policy in policies}) != len(policies):
            raise RuntimeError("resume_review_role_catalog_invalid")
        return policies


__all__ = [
    "MCPActiveRoleLoader",
    "MCPDocumentLoader",
    "RESUME_REVIEW_TOOL_NAMES",
    "ResumeReviewToolCatalogError",
    "select_resume_review_tools",
]
