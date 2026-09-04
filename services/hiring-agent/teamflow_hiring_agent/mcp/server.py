"""Uncomposed, read-only FastMCP boundary for TeamFlow hiring evidence.

A later composition root must launch each non-mock process with one scoped token
and must not share that process across tenants. Database grants, the scoped search
RPC, and token refresh are intentionally deferred. The component nevertheless
fails closed and exposes the exact catalog pinned by the application-side adapter.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal
from uuid import UUID

import google.genai as genai
from fastmcp import FastMCP
from google.genai.types import EmbedContentConfig, HttpOptions, HttpRetryOptions
from mcp.types import ToolAnnotations
from opentelemetry import trace
from pydantic import Field, Strict

from ..security import (
    contains_instructional_manipulation,
    contains_sensitive_text,
    contains_unsafe_hiring_language,
    redact_sensitive_text,
)
from ..supabase_http import SupabaseJSONClient, scoped_merchant_id_from_jwt
from ..telemetry import setup_telemetry

logger = logging.getLogger("teamflow.mcp_server")
tracer = trace.get_tracer("teamflow.mcp_server", "2.1.0")

_EMBEDDING_MODEL = "models/gemini-embedding-001"
_UUID_PATTERN = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_UUID_ANYWHERE_RE = re.compile(_UUID_PATTERN.removeprefix("^").removesuffix("$"))
_PUBLISHABLE_KEY_RE = re.compile(r"^sb_publishable_[A-Za-z0-9_-]{20,8192}$")
_MAX_RESPONSE_BYTES = 262_144
_MAX_QUERY_BYTES = 4_096
_TOOL_DEADLINE_SECONDS = 9.0
_READ_TIMEOUT_SECONDS = 8.0
_RPC_TIMEOUT_SECONDS = 4.0
_EMBEDDING_TIMEOUT_SECONDS = 4.0
_EMBEDDING_HTTP_TIMEOUT_MS = 3_500

DatabaseId = Annotated[str, Strict(), Field(pattern=_UUID_PATTERN)]
SearchQuery = Annotated[str, Strict(), Field(min_length=1, max_length=4_000)]
CandidateLimit = Annotated[int, Strict(), Field(ge=1, le=20)]
SimilarityThreshold = Annotated[float, Strict(), Field(ge=0, le=1)]
CandidateStatus = Literal["", "new", "invited", "interviewed", "hired", "rejected"]

_READ_ONLY_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)


@dataclass(frozen=True, slots=True)
class _ServerSettings:
    """Validated process configuration with secret-safe diagnostics."""

    environment: str
    mock_tools: bool
    supabase_url: str = ""
    trusted_origin: str = ""
    publishable_key: str = field(default="", repr=False)
    reader_token: str = field(default="", repr=False)
    google_api_key: str = field(default="", repr=False)

    @property
    def production(self) -> bool:
        return self.environment == "production"

    @property
    def supabase_configured(self) -> bool:
        return bool(
            self.supabase_url and self.trusted_origin and self.publishable_key and self.reader_token
        )

    @classmethod
    def from_environment(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> _ServerSettings:
        environment_values = os.environ if environ is None else environ
        environment = environment_values.get("ENVIRONMENT", "development").strip().lower()
        if environment not in {"development", "test", "production"}:
            raise ValueError("mcp_server_configuration_invalid")

        raw_mock = environment_values.get("HIRING_AGENT_MOCK_TOOLS", "false")
        if raw_mock not in {"true", "false"}:
            raise ValueError("mcp_server_configuration_invalid")
        mock_tools = raw_mock == "true"
        if environment == "production" and mock_tools:
            raise ValueError("mcp_server_configuration_invalid")

        privileged_credential_names = (
            "SUPABASE_SERVICE_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_SECRET_KEY",
        )
        if any(environment_values.get(name, "") for name in privileged_credential_names):
            raise ValueError("mcp_server_configuration_invalid")

        if mock_tools:
            credential_names = (
                "GOOGLE_API_KEY",
                "SUPABASE_URL",
                "SUPABASE_TRUSTED_ORIGIN",
                "SUPABASE_PUBLISHABLE_KEY",
                "SUPABASE_HIRING_READER_TOKEN",
            )
            if any(environment_values.get(name, "") for name in credential_names):
                raise ValueError("mcp_server_configuration_invalid")
            return cls(environment=environment, mock_tools=True)

        supabase_values = (
            environment_values.get("SUPABASE_URL", ""),
            environment_values.get("SUPABASE_TRUSTED_ORIGIN", ""),
            environment_values.get("SUPABASE_PUBLISHABLE_KEY", ""),
            environment_values.get("SUPABASE_HIRING_READER_TOKEN", ""),
        )
        if any(supabase_values) and not all(supabase_values):
            raise ValueError("mcp_server_configuration_invalid")
        if any(
            value != value.strip() or any(character.isspace() for character in value)
            for value in supabase_values
        ):
            raise ValueError("mcp_server_configuration_invalid")
        if supabase_values[2] and _PUBLISHABLE_KEY_RE.fullmatch(supabase_values[2]) is None:
            raise ValueError("mcp_server_configuration_invalid")

        google_api_key = environment_values.get("GOOGLE_API_KEY", "")
        if (
            google_api_key != google_api_key.strip()
            or len(google_api_key) > 512
            or (google_api_key and not google_api_key.isprintable())
            or any(character.isspace() for character in google_api_key)
        ):
            raise ValueError("mcp_server_configuration_invalid")

        settings = cls(
            environment=environment,
            mock_tools=mock_tools,
            supabase_url=supabase_values[0],
            trusted_origin=supabase_values[1],
            publishable_key=supabase_values[2],
            reader_token=supabase_values[3],
            google_api_key=google_api_key,
        )
        if settings.supabase_configured:
            configuration_valid = True
            try:
                scoped_merchant_id_from_jwt(
                    settings.reader_token,
                    expected_role="teamflow_hiring_reader",
                )
                # Client construction validates deployment-owned origin agreement
                # and performs no network I/O.
                settings.supabase_client(timeout_seconds=_READ_TIMEOUT_SECONDS)
            except ValueError:
                configuration_valid = False
            if not configuration_valid:
                raise ValueError("mcp_server_configuration_invalid")
        return settings

    def supabase_client(self, *, timeout_seconds: float) -> SupabaseJSONClient:
        return SupabaseJSONClient(
            url=self.supabase_url,
            trusted_origin=self.trusted_origin,
            api_key=self.publishable_key,
            access_token=self.reader_token,
            production=self.production,
            timeout_seconds=timeout_seconds,
            max_response_bytes=_MAX_RESPONSE_BYTES,
        )


def _configuration_error() -> dict[str, str]:
    return {"error": "Hiring data source is not configured"}


def _unavailable_error() -> dict[str, str]:
    return {"error": "Hiring data source is temporarily unavailable"}


_SETTINGS: _ServerSettings | None = None


def _frozen_settings() -> _ServerSettings:
    global _SETTINGS
    if _SETTINGS is None:
        _SETTINGS = _ServerSettings.from_environment()
    return _SETTINGS


def _validated_startup_settings(
    environ: Mapping[str, str] | None = None,
) -> _ServerSettings:
    settings: _ServerSettings | None = None
    try:
        settings = _ServerSettings.from_environment(environ)
    except ValueError:
        pass
    if settings is None or (
        not settings.mock_tools
        and (not settings.supabase_configured or not settings.google_api_key)
    ):
        raise RuntimeError("mcp_server_configuration_invalid") from None
    return settings


def _settings_for(merchant_id: str) -> _ServerSettings | None:
    try:
        settings = _frozen_settings()
        if settings.mock_tools:
            return settings
        if not settings.supabase_configured:
            return None
        scoped_merchant_id = scoped_merchant_id_from_jwt(
            settings.reader_token,
            expected_role="teamflow_hiring_reader",
        )
    except ValueError:
        return None
    return settings if scoped_merchant_id == merchant_id else None


def _validated_uuid(value: str, field_name: str) -> tuple[str | None, dict[str, str] | None]:
    """Canonicalize identifiers before adding them to PostgREST filters."""

    try:
        return str(UUID(value)), None
    except (ValueError, AttributeError, TypeError):
        return None, {"error": f"{field_name} must be a valid UUID"}


def _project_job(
    row: dict[str, Any],
    *,
    role_id: str,
    merchant_id: str,
) -> dict[str, Any] | None:
    if row.get("id") != role_id or row.get("merchant_id") != merchant_id:
        return None
    projected: dict[str, Any] = {"id": role_id, "merchant_id": merchant_id}
    for name, maximum in (("title", 500), ("description", 4_000)):
        value = row.get(name)
        if value is not None:
            if not isinstance(value, str) or len(value) > maximum:
                return None
            projected[name] = redact_sensitive_text(value, max_length=maximum)
    for name in ("dealbreakers", "nice_to_haves"):
        value = row.get(name)
        if value is None:
            projected[name] = []
            continue
        if (
            not isinstance(value, list)
            or len(value) > 50
            or any(not isinstance(item, str) or len(item) > 500 for item in value)
        ):
            return None
        projected[name] = [redact_sensitive_text(item, max_length=500) for item in value]
    return projected


def _project_candidate(
    row: dict[str, Any],
    *,
    candidate_id: str,
    merchant_id: str,
) -> dict[str, Any] | None:
    if row.get("id") != candidate_id or row.get("merchant_id") != merchant_id:
        return None
    resume_text = row.get("resume_text")
    if not isinstance(resume_text, str) or not resume_text or len(resume_text) > 100_000:
        return None
    projected: dict[str, Any] = {
        "id": candidate_id,
        "merchant_id": merchant_id,
        "resume_text": redact_sensitive_text(resume_text, max_length=20_000),
    }
    job_id = row.get("job_id")
    if job_id is not None:
        normalized_job_id, error = _validated_uuid(job_id, "job_id")
        if error:
            return None
        projected["job_id"] = normalized_job_id
    status = row.get("status")
    if status is not None:
        if status not in {"new", "invited", "interviewed", "hired", "rejected"}:
            return None
        projected["status"] = status
    return projected


def _project_candidate_list(
    rows: list[dict[str, Any]],
    *,
    merchant_id: str,
    maximum: int,
) -> list[dict[str, Any]] | None:
    if len(rows) > maximum:
        return None
    projected: list[dict[str, Any]] = []
    for row in rows:
        status = row.get("status")
        if row.get("merchant_id") != merchant_id or status not in {
            "new",
            "invited",
            "interviewed",
            "hired",
            "rejected",
        }:
            return None
        projected.append({"merchant_id": merchant_id, "status": status})
    return projected


def _project_search_results(
    rows: list[dict[str, Any]],
    *,
    merchant_id: str,
    maximum: int,
) -> list[dict[str, Any]] | None:
    if len(rows) > maximum:
        return None
    projected: list[dict[str, Any]] = []
    for row in rows:
        similarity = row.get("similarity")
        if (
            row.get("merchant_id") != merchant_id
            or type(similarity) not in {int, float}
            or not math.isfinite(float(similarity))
            or not 0 <= float(similarity) <= 1
        ):
            return None
        projected.append({"merchant_id": merchant_id, "similarity": float(similarity)})
    return projected


async def _supabase_get(
    settings: _ServerSettings,
    *,
    table: Literal["jobs", "candidates"],
    query_params: str,
) -> list[dict[str, Any]]:
    response = await settings.supabase_client(timeout_seconds=_READ_TIMEOUT_SECONDS).request_json(
        "GET",
        f"/rest/v1/{table}?{query_params}",
    )
    if not isinstance(response.payload, list) or any(
        not isinstance(row, dict) for row in response.payload
    ):
        raise RuntimeError("hiring_data_response_invalid")
    return response.payload


async def _match_candidates(
    settings: _ServerSettings,
    params: dict[str, Any],
) -> list[dict[str, Any]]:
    response = await settings.supabase_client(timeout_seconds=_RPC_TIMEOUT_SECONDS).request_json(
        "POST",
        "/rest/v1/rpc/teamflow_match_candidates?select=merchant_id,similarity",
        json_body=params,
    )
    if not isinstance(response.payload, list) or any(
        not isinstance(row, dict) for row in response.payload
    ):
        raise RuntimeError("hiring_data_response_invalid")
    return response.payload


async def _get_query_embedding(
    settings: _ServerSettings,
    query: str,
) -> list[float] | None:
    """Generate one bounded, 768-dimensional retrieval-query embedding."""

    if not settings.google_api_key:
        return None
    client: genai.Client | None = None
    try:
        client = genai.Client(
            api_key=settings.google_api_key,
            http_options=HttpOptions(
                timeout=_EMBEDDING_HTTP_TIMEOUT_MS,
                retry_options=HttpRetryOptions(attempts=1),
            ),
        )
        async with asyncio.timeout(_EMBEDDING_TIMEOUT_SECONDS):
            result = await client.aio.models.embed_content(
                model=_EMBEDDING_MODEL,
                contents=query,
                config=EmbedContentConfig(
                    task_type="RETRIEVAL_QUERY",
                    output_dimensionality=768,
                ),
            )
        embedding = result.embeddings[0].values if result.embeddings else None
        if (
            embedding is None
            or len(embedding) != 768
            or any(
                type(value) not in {int, float} or not math.isfinite(float(value))
                for value in embedding
            )
            or not any(float(value) != 0 for value in embedding)
        ):
            return None
        return [float(value) for value in embedding]
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("Query embedding failed with %s", type(exc).__name__)
        return None
    finally:
        if client is not None:
            try:
                async with asyncio.timeout(0.5):
                    await client.aio.aclose()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Embedding client cleanup failed with %s", type(exc).__name__)


mcp = FastMCP(
    name="TeamFlow Hiring Tools",
    instructions=(
        "Read-only, merchant-scoped hiring evidence. Candidate score mutations and "
        "other writes are unavailable through this MCP boundary."
    ),
    strict_input_validation=True,
    mask_error_details=True,
    on_duplicate="error",
    tasks=False,
)


@mcp.tool(annotations=_READ_ONLY_ANNOTATIONS, output_schema=None)
async def get_job_requirements(role_id: DatabaseId, merchant_id: DatabaseId) -> dict[str, Any]:
    """Fetch configured hiring criteria for one role."""

    with tracer.start_as_current_span(
        "mcp.get_job_requirements",
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        normalized_role_id, error = _validated_uuid(role_id, "role_id")
        if error:
            return error
        assert normalized_role_id is not None
        normalized_merchant_id, error = _validated_uuid(merchant_id, "merchant_id")
        if error:
            return error
        assert normalized_merchant_id is not None

        settings = _settings_for(normalized_merchant_id)
        if settings is None:
            return _configuration_error()
        if settings.mock_tools:
            return {
                "mock": True,
                "id": normalized_role_id,
                "merchant_id": normalized_merchant_id,
                "title": "Barista",
                "description": "Craft coffee drinks and deliver customer service.",
                "dealbreakers": [
                    "Has current work authorization.",
                    "Can work the role's posted weekend schedule.",
                ],
                "nice_to_haves": ["Latte art", "Point-of-sale experience"],
            }

        try:
            async with asyncio.timeout(_TOOL_DEADLINE_SECONDS):
                rows = await _supabase_get(
                    settings,
                    table="jobs",
                    query_params=(
                        f"id=eq.{normalized_role_id}&merchant_id=eq.{normalized_merchant_id}"
                        "&is_active=eq.true"
                        "&select=id,merchant_id,title,description,dealbreakers,nice_to_haves"
                    ),
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Job read failed with %s", type(exc).__name__)
            return _unavailable_error()
        if not rows:
            span.set_attribute("teamflow.not_found", True)
            return {"error": "Job not found"}
        if len(rows) != 1:
            return _unavailable_error()
        projected = _project_job(
            rows[0],
            role_id=normalized_role_id,
            merchant_id=normalized_merchant_id,
        )
        return projected if projected is not None else _unavailable_error()


@mcp.tool(annotations=_READ_ONLY_ANNOTATIONS, output_schema=None)
async def get_candidate(candidate_id: DatabaseId, merchant_id: DatabaseId) -> dict[str, Any]:
    """Fetch one candidate's bounded evidence for review."""

    with tracer.start_as_current_span(
        "mcp.get_candidate",
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        normalized_candidate_id, error = _validated_uuid(candidate_id, "candidate_id")
        if error:
            return error
        assert normalized_candidate_id is not None
        normalized_merchant_id, error = _validated_uuid(merchant_id, "merchant_id")
        if error:
            return error
        assert normalized_merchant_id is not None

        settings = _settings_for(normalized_merchant_id)
        if settings is None:
            return _configuration_error()
        if settings.mock_tools:
            return {
                "mock": True,
                "id": normalized_candidate_id,
                "merchant_id": normalized_merchant_id,
                "job_id": "00000000-0000-0000-0000-000000000010",
                "status": "new",
                "resume_text": "Two years of customer service and espresso preparation.",
            }

        try:
            async with asyncio.timeout(_TOOL_DEADLINE_SECONDS):
                rows = await _supabase_get(
                    settings,
                    table="candidates",
                    query_params=(
                        f"id=eq.{normalized_candidate_id}&merchant_id=eq.{normalized_merchant_id}"
                        "&select=id,merchant_id,job_id,status,resume_text"
                    ),
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Candidate read failed with %s", type(exc).__name__)
            return _unavailable_error()
        if not rows:
            span.set_attribute("teamflow.not_found", True)
            return {"error": "Candidate not found"}
        if len(rows) != 1:
            return _unavailable_error()
        projected = _project_candidate(
            rows[0],
            candidate_id=normalized_candidate_id,
            merchant_id=normalized_merchant_id,
        )
        return projected if projected is not None else _unavailable_error()


@mcp.tool(annotations=_READ_ONLY_ANNOTATIONS, output_schema=None)
async def list_candidates(
    merchant_id: DatabaseId,
    status_filter: CandidateStatus = "",
    limit: CandidateLimit = 10,
) -> list[dict[str, Any]] | dict[str, str]:
    """List bounded candidate summaries for one merchant."""

    with tracer.start_as_current_span(
        "mcp.list_candidates",
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        normalized_merchant_id, error = _validated_uuid(merchant_id, "merchant_id")
        if error:
            return error
        assert normalized_merchant_id is not None
        if status_filter not in {"", "new", "invited", "interviewed", "hired", "rejected"}:
            return {"error": "status_filter is not supported"}
        if not 1 <= limit <= 20:
            return {"error": "limit must be between 1 and 20"}

        settings = _settings_for(normalized_merchant_id)
        if settings is None:
            return _configuration_error()
        if settings.mock_tools:
            return {"error": "Candidate listing is unavailable in mock mode"}

        params = (
            f"merchant_id=eq.{normalized_merchant_id}&select=merchant_id,status"
            f"&order=created_at.desc&limit={limit}"
        )
        if status_filter:
            params += f"&status=eq.{status_filter}"
        try:
            async with asyncio.timeout(_TOOL_DEADLINE_SECONDS):
                rows = await _supabase_get(
                    settings,
                    table="candidates",
                    query_params=params,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Candidate list failed with %s", type(exc).__name__)
            return _unavailable_error()
        span.set_attribute("teamflow.candidate_count", len(rows))
        projected = _project_candidate_list(
            rows,
            merchant_id=normalized_merchant_id,
            maximum=limit,
        )
        return projected if projected is not None else _unavailable_error()


@mcp.tool(annotations=_READ_ONLY_ANNOTATIONS, output_schema=None)
async def semantic_search_candidates(
    query: SearchQuery,
    merchant_id: DatabaseId,
    top_k: CandidateLimit = 5,
    threshold: SimilarityThreshold = 0.5,
) -> list[dict[str, Any]] | dict[str, str]:
    """Search one merchant's candidates using pgvector cosine similarity."""

    with tracer.start_as_current_span(
        "mcp.semantic_search_candidates",
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        normalized_merchant_id, error = _validated_uuid(merchant_id, "merchant_id")
        if error:
            return error
        assert normalized_merchant_id is not None
        if not query.strip() or len(query) > 4_000:
            return {"error": "query is required and must not exceed 4000 characters"}
        if (
            query != query.strip()
            or not query.isprintable()
            or len(query.encode("utf-8")) > _MAX_QUERY_BYTES
            or _UUID_ANYWHERE_RE.search(query) is not None
            or contains_sensitive_text(query)
            or contains_unsafe_hiring_language(query)
            or contains_instructional_manipulation(query)
        ):
            return {"error": "Candidate search query is not permitted"}
        if not 1 <= top_k <= 20:
            return {"error": "top_k must be between 1 and 20"}
        if not 0 <= threshold <= 1:
            return {"error": "threshold must be between 0 and 1"}

        settings = _settings_for(normalized_merchant_id)
        if settings is None:
            return _configuration_error()
        if settings.mock_tools:
            return {"error": "Candidate search is unavailable in mock mode"}

        try:
            async with asyncio.timeout(_TOOL_DEADLINE_SECONDS):
                embedding = await _get_query_embedding(settings, query)
                if embedding is None:
                    span.set_attribute("teamflow.embedding_failed", True)
                    return {"error": "Candidate search embedding is unavailable"}
                span.set_attribute("teamflow.embedding_dims", len(embedding))
                results = await _match_candidates(
                    settings,
                    {
                        "candidate_query": embedding,
                        "match_merchant_id": normalized_merchant_id,
                        "match_threshold": threshold,
                        "match_count": top_k,
                    },
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Candidate search failed with %s", type(exc).__name__)
            span.set_attribute("teamflow.rpc_error", True)
            return _unavailable_error()
        span.set_attribute("teamflow.results_count", len(results))
        projected = _project_search_results(
            results,
            merchant_id=normalized_merchant_id,
            maximum=top_k,
        )
        return projected if projected is not None else _unavailable_error()


def run() -> None:
    """Validate startup configuration and serve the stdio transport."""

    global _SETTINGS
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    _SETTINGS = _validated_startup_settings()
    setup_telemetry()
    logger.info("Starting TeamFlow read-only MCP server over stdio")
    mcp.run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    run()
