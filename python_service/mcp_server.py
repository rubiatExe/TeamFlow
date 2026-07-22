"""
TeamFlow — MCP Server (Model Context Protocol)
------------------------------------------------
Implements a FastMCP server that exposes secure Supabase database tools
to the LLM agent, replacing hard-coded prompt context with live tool calls.

The LLM agent (Gemini with function calling) decides which tools to invoke
rather than receiving a pre-baked prompt string with all context embedded.

Tools exposed:
  • get_job_requirements(role_id)       → dealbreakers + skill criteria for a role
  • get_candidate(candidate_id)         → a candidate's full stored profile
  • list_candidates(merchant_id)        → all candidates for a merchant
  • update_fit_score(candidate_id, ...) → write AI score back to candidates table

Usage:
  python mcp_server.py          # runs on port 8001
  
Security:
  Uses SUPABASE_SERVICE_KEY (server-only, never exposed to client).
  All Supabase access is authenticated via the service role key.
"""

import os
from typing import Any

import httpx
from fastmcp import FastMCP
from opentelemetry import trace

from telemetry import setup_telemetry

# ── Telemetry ──────────────────────────────────────────────────────────────────
setup_telemetry(service_name="teamflow-mcp-server")
tracer = trace.get_tracer("teamflow.mcp_server", "1.0.0")

# ── Supabase Config ────────────────────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")  # Server-only service role key

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("[MCP] WARNING: SUPABASE_URL or SUPABASE_SERVICE_KEY not set — DB tools will return mock data")


def supabase_headers() -> dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


async def supabase_get(table: str, query_params: str) -> list[dict[str, Any]]:
    """Helper: perform a GET against the Supabase REST API."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return []
    url = f"{SUPABASE_URL}/rest/v1/{table}?{query_params}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, headers=supabase_headers())
        resp.raise_for_status()
        return resp.json()


async def supabase_patch(table: str, match_col: str, match_val: str, payload: dict) -> bool:
    """Helper: perform a PATCH (update) against the Supabase REST API."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return False
    url = f"{SUPABASE_URL}/rest/v1/{table}?{match_col}=eq.{match_val}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(url, headers=supabase_headers(), json=payload)
        resp.raise_for_status()
        return True


# ── FastMCP Server ─────────────────────────────────────────────────────────────
mcp = FastMCP(
    name="TeamFlow Hiring Agent",
    instructions=(
        "You are a hiring assistant for TeamFlow. Use the provided tools to fetch "
        "job requirements and candidate data from the database before making decisions. "
        "Always call get_job_requirements first to understand the role's criteria."
    ),
)


@mcp.tool()
async def get_job_requirements(role_id: str) -> dict[str, Any]:
    """
    Fetch the hiring criteria for a specific job role.

    Returns dealbreakers (must-pass questions), essential skills, nice-to-have skills,
    wage range, and role description from the jobs table.

    Call this FIRST before evaluating any candidate.
    """
    with tracer.start_as_current_span("mcp.get_job_requirements") as span:
        span.set_attribute("teamflow.role_id", role_id)

        if not SUPABASE_URL:
            # Mock response for local dev without Supabase
            return {
                "role_id": role_id,
                "title": "Barista",
                "description": "Craft coffee drinks and deliver excellent customer service.",
                "wage_min": 16,
                "wage_max": 20,
                "dealbreakers": [
                    "Are you 18 or older?",
                    "Are you legally authorised to work?",
                    "Can you work weekends?",
                ],
                "nice_to_haves": ["Latte art", "POS experience"],
                "is_active": True,
            }

        rows = await supabase_get(
            table="jobs",
            query_params=f"id=eq.{role_id}&select=id,title,description,wage_min,wage_max,dealbreakers,nice_to_haves,is_active",
        )

        if not rows:
            span.set_attribute("teamflow.not_found", True)
            return {"error": f"No job found with id={role_id}"}

        row = rows[0]
        span.set_attribute("teamflow.role_title", row.get("title", ""))
        return row


@mcp.tool()
async def get_candidate(candidate_id: str) -> dict[str, Any]:
    """
    Fetch a candidate's full profile from the database.

    Returns name, email, phone, city, status, fit_score, analysis, red_flags,
    and resume text for the candidate with the given ID.
    """
    with tracer.start_as_current_span("mcp.get_candidate") as span:
        span.set_attribute("teamflow.candidate_id", candidate_id)

        if not SUPABASE_URL:
            return {
                "id": candidate_id,
                "name": "Mock Candidate",
                "email": "mock@example.com",
                "status": "new",
                "fit_score": None,
                "analysis": None,
            }

        rows = await supabase_get(
            table="candidates",
            query_params=f"id=eq.{candidate_id}&select=id,name,email,phone,city,status,fit_score,analysis,red_flags,summary,resume_text",
        )

        if not rows:
            span.set_attribute("teamflow.not_found", True)
            return {"error": f"No candidate found with id={candidate_id}"}

        return rows[0]


@mcp.tool()
async def list_candidates(merchant_id: str, status_filter: str = "") -> list[dict[str, Any]]:
    """
    List all candidates for a merchant, optionally filtered by status.

    Args:
        merchant_id: The merchant/manager's ID.
        status_filter: Optional. One of: 'new', 'invited', 'interviewed', 'hired', 'rejected'.
                       If empty, returns all candidates.

    Returns a list of candidate summaries (name, status, fit_score, applied role).
    """
    with tracer.start_as_current_span("mcp.list_candidates") as span:
        span.set_attribute("teamflow.merchant_id", merchant_id)
        span.set_attribute("teamflow.status_filter", status_filter or "all")

        if not SUPABASE_URL:
            return [{"id": "mock-id", "name": "Mock Candidate", "status": "new", "fit_score": 72}]

        params = f"merchant_id=eq.{merchant_id}&select=id,name,status,fit_score,summary,created_at&order=created_at.desc"
        if status_filter:
            params += f"&status=eq.{status_filter}"

        rows = await supabase_get(table="candidates", query_params=params)
        span.set_attribute("teamflow.candidate_count", len(rows))
        return rows


@mcp.tool()
async def update_fit_score(
    candidate_id: str,
    score: int,
    analysis: dict[str, Any],
    summary: str = "",
    red_flags: list[str] | None = None,
) -> dict[str, Any]:
    """
    Write an AI-generated fit score and analysis back to the candidates table.

    Args:
        candidate_id: ID of the candidate to update.
        score:        Integer fit score 0–100.
        analysis:     Full analysis JSON (skills, breakdown, explanation).
        summary:      Optional one-line summary for the dashboard card.
        red_flags:    Optional list of concern strings.

    Returns {"success": true} or {"error": "..."}.
    """
    with tracer.start_as_current_span("mcp.update_fit_score") as span:
        span.set_attribute("teamflow.candidate_id", candidate_id)
        span.set_attribute("teamflow.fit_score", score)

        if not SUPABASE_URL:
            print(f"[MCP Mock] Would update candidate {candidate_id} with score={score}")
            return {"success": True, "mock": True}

        payload: dict[str, Any] = {
            "fit_score": score,
            "analysis": analysis,
        }
        if summary:
            payload["summary"] = summary
        if red_flags is not None:
            payload["red_flags"] = red_flags

        success = await supabase_patch(
            table="candidates",
            match_col="id",
            match_val=candidate_id,
            payload=payload,
        )

        if success:
            span.set_attribute("teamflow.update_success", True)
            return {"success": True}
        else:
            span.set_attribute("teamflow.update_success", False)
            return {"error": "Failed to update candidate"}


# ── Entry Point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("[MCP] Starting TeamFlow MCP Server on port 8001...")
    mcp.run(transport="streamable-http", host="0.0.0.0", port=8001)
