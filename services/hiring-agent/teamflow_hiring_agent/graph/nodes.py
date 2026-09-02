"""Node implementations for the bounded LangGraph workflow."""

import asyncio
import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.errors import NodeError
from langgraph.types import Command

from ..contracts import (
    HiringAgentAnalysis,
    HiringAgentDraft,
    HiringAgentOutput,
    HiringOperation,
)
from ..prompts import (
    FINAL_RESPONSE_PROMPT,
    SYSTEM_PROMPT,
    build_reasoning_input,
    project_candidate_context,
    project_role_context,
)
from ..reliability import InvalidModelOutputError, ModelSafetyError, validate_ai_message
from ..security import (
    contains_instructional_manipulation,
    contains_unsafe_hiring_language,
    redact_sensitive_text,
    sanitize_output_json,
)
from .state import HiringState

logger = logging.getLogger(__name__)

SEARCH_TOOLS = ("list_candidates", "semantic_search_candidates")
MAX_TOOL_ARGUMENT_BYTES = 8_192
MAX_TOOL_RESULT_BYTES = 32_768
MAX_TOOL_CALL_ID_LENGTH = 128
HUMAN_REVIEW_NOTICE = "A human reviewer must make the final hiring decision."
_SAFE_TOOL_CALL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_AUTONOMOUS_DECISION_RE = re.compile(
    r"(?is)\b(?:hire|hired|hiring|reject|rejected|rejecting)\b.{0,50}"
    r"\b(?:automatically|immediately|without\s+(?:human|manager)\s+review)\b|"
    r"\b(?:candidate|applicant)\b.{0,30}\bmust\s+be\s+(?:hired|rejected)\b|"
    r"\bno\s+(?:human|manager)\s+review\s+(?:is\s+)?"
    r"(?:needed|necessary|required)\b"
)
_PERSISTENCE_CLAIM_RE = re.compile(
    r"(?is)\b(?:score|record|data|application|candidate)\b.{0,40}"
    r"\b(?:saved|updated|persisted|written)\b|"
    r"\b(?:saved|persisted|written)\b.{0,40}"
    r"\b(?:score|record|data|application|candidate)\b"
)


class AsyncRunnable(Protocol):
    async def ainvoke(self, input: Any, **kwargs: Any) -> Any: ...


class AsyncTool(Protocol):
    name: str

    async def ainvoke(self, input: dict[str, Any], **kwargs: Any) -> Any: ...


@dataclass(frozen=True, slots=True)
class GraphDependencies:
    reasoning_model: AsyncRunnable
    structured_model: AsyncRunnable
    tools: Mapping[str, AsyncTool]


def _jsonable_tool_result(result: Any) -> Any:
    """Normalize MCP/LangChain tool responses without leaking wrapper objects."""
    if isinstance(result, ToolMessage):
        artifact = result.artifact
        if isinstance(artifact, dict) and "structured_content" in artifact:
            return artifact["structured_content"]
        result = result.content

    if isinstance(result, str):
        if len(result.encode("utf-8")) > MAX_TOOL_RESULT_BYTES:
            raise ValueError("tool result exceeded the safe limit")
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
            if len(text_blocks[0].encode("utf-8")) > MAX_TOOL_RESULT_BYTES:
                raise ValueError("tool result exceeded the safe limit")
            try:
                return json.loads(text_blocks[0])
            except json.JSONDecodeError:
                return text_blocks[0]
        return result
    if isinstance(result, dict | int | float | bool) or result is None:
        return result
    if hasattr(result, "model_dump"):
        return result.model_dump()
    return str(result)


def _project_search_result(result: Any, *, merchant_id: str) -> list[dict[str, Any]] | None:
    if not isinstance(result, list) or len(result) > 20:
        return None
    projected: list[dict[str, Any]] = []
    for row in result:
        if not isinstance(row, dict) or "error" in row:
            return None
        returned_scope = row.get("merchant_id")
        if returned_scope is not None and str(returned_scope) != merchant_id:
            return None
        clean = sanitize_output_json(row)
        if not isinstance(clean, dict):
            return None
        for circular_field in ("analysis", "fit_score", "red_flags", "summary"):
            clean.pop(circular_field, None)
        serialized = json.dumps(clean, ensure_ascii=False, separators=(",", ":"))
        if contains_unsafe_hiring_language(serialized) or contains_instructional_manipulation(
            serialized
        ):
            return None
        projected.append(clean)
    return projected


def _project_tool_result(name: str, result: Any, *, merchant_id: str) -> Any:
    if name == "get_candidate":
        return project_candidate_context(result, merchant_id=merchant_id)
    if name == "get_job_requirements":
        return project_role_context(result, merchant_id=merchant_id)
    if name in SEARCH_TOOLS:
        return _project_search_result(result, merchant_id=merchant_id)
    return None


async def _invoke_tool(
    tools: Mapping[str, AsyncTool],
    name: str,
    arguments: dict[str, Any],
    *,
    timeout_seconds: float,
) -> Any:
    tool = tools.get(name)
    if tool is None:
        return {"error": f"Required tool is unavailable: {name}"}

    try:
        async with asyncio.timeout(timeout_seconds):
            normalized = _jsonable_tool_result(await tool.ainvoke(arguments))
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # Tool failures become explicit context, not false success.
        logger.warning("Tool %s failed with %s", name, type(exc).__name__)
        return {"error": f"{name} is temporarily unavailable"}

    # Never relay connector error details into model context or public output.
    if isinstance(normalized, dict) and "error" in normalized:
        return {"error": f"{name} is temporarily unavailable"}
    if isinstance(normalized, list) and any(
        isinstance(item, dict) and "error" in item for item in normalized
    ):
        return {"error": f"{name} is temporarily unavailable"}

    try:
        raw_encoded = json.dumps(
            normalized,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        return {"error": f"{name} returned an invalid result"}
    if len(raw_encoded) > MAX_TOOL_RESULT_BYTES:
        return {"error": f"{name} result exceeded the safe limit"}

    projected = _project_tool_result(
        name,
        normalized,
        merchant_id=str(arguments.get("merchant_id", "")),
    )
    if projected is None:
        return {"error": f"{name} returned unusable evidence"}
    try:
        encoded = json.dumps(
            projected,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        return {"error": f"{name} returned an invalid result"}
    if len(encoded) > MAX_TOOL_RESULT_BYTES:
        return {"error": f"{name} result exceeded the safe limit"}
    return projected


def _result_error(result: Any) -> str | None:
    if isinstance(result, dict) and "error" in result:
        return str(result["error"] or "tool result unavailable")
    return None


def _required_context_matches(
    result: Any,
    *,
    expected_id: str,
    expected_merchant_id: str,
    id_fields: tuple[str, ...],
) -> bool:
    """Require deterministic reads to return the exact requested record."""
    if not isinstance(result, dict) or _result_error(result):
        return False
    returned_scope = result.get("merchant_id")
    if returned_scope is not None and str(returned_scope) != expected_merchant_id:
        return False
    return any(str(result.get(field, "")) == expected_id for field in id_fields)


def _validated_tool_call_id(call: Mapping[str, Any], index: int) -> str:
    call_id = call.get("id")
    if (
        not isinstance(call_id, str)
        or len(call_id) > MAX_TOOL_CALL_ID_LENGTH
        or _SAFE_TOOL_CALL_ID_RE.fullmatch(call_id) is None
    ):
        raise InvalidModelOutputError(f"model tool call {index} had an invalid identifier")
    return call_id


def _validate_model_tool_calls(message: AIMessage, *, maximum: int) -> None:
    if len(message.tool_calls) > maximum:
        raise InvalidModelOutputError("model exceeded the tool-call budget")
    seen_call_ids: set[str] = set()
    for index, call in enumerate(message.tool_calls):
        name = call.get("name")
        if name not in SEARCH_TOOLS:
            raise InvalidModelOutputError("model selected a tool outside the read-only allowlist")
        call_id = _validated_tool_call_id(call, index)
        if call_id in seen_call_ids:
            raise InvalidModelOutputError("model emitted duplicate tool-call identifiers")
        seen_call_ids.add(call_id)
        arguments = call.get("args")
        if not isinstance(arguments, dict):
            raise InvalidModelOutputError("model emitted invalid tool arguments")
        try:
            encoded = json.dumps(
                arguments,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError):
            raise InvalidModelOutputError("model emitted invalid tool arguments") from None
        if len(encoded) > MAX_TOOL_ARGUMENT_BYTES:
            raise InvalidModelOutputError("model tool arguments exceeded the safe limit")


def _safe_failure_draft() -> HiringAgentDraft:
    return HiringAgentDraft(
        summary="Automated review unavailable.",
        recommendation=(
            "Do not make an automated hiring decision. Verify the candidate and role "
            "records, then complete a structured human review."
        ),
        fit_score=None,
        analysis=HiringAgentAnalysis(
            limitations=["The automated model did not produce a verified response."],
            confidence="low",
        ),
    )


def create_nodes(
    dependencies: GraphDependencies,
    *,
    max_tool_calls_per_round: int,
    model_timeout_seconds: float,
    tool_timeout_seconds: float,
) -> dict[str, Any]:
    """Create graph nodes with model and tool dependencies injected for testability."""

    async def load_required_context(state: HiringState) -> dict[str, Any]:
        request = state["request"]
        merchant_id = str(request.merchant_id)
        if request.has_explicit_write:
            return {
                "required_context": {},
                "context_errors": ["legacy_score_write_disabled"],
                "scoring_evidence_ready": False,
                "tool_calls": [],
            }
        if request.instructions and (
            contains_unsafe_hiring_language(request.instructions)
            or contains_instructional_manipulation(request.instructions)
        ):
            return {
                "required_context": {},
                "context_errors": ["unsafe_request_instructions"],
                "scoring_evidence_ready": False,
                "tool_calls": [],
            }
        calls: list[tuple[str, dict[str, Any], str]] = []
        if request.candidate_id:
            calls.append(
                (
                    "get_candidate",
                    {
                        "candidate_id": str(request.candidate_id),
                        "merchant_id": merchant_id,
                    },
                    "candidate",
                )
            )
        if request.role_id:
            calls.append(
                (
                    "get_job_requirements",
                    {"role_id": str(request.role_id), "merchant_id": merchant_id},
                    "job_requirements",
                )
            )

        if not calls:
            return {
                "required_context": {},
                "scoring_evidence_ready": False,
                "tool_calls": [],
            }

        results = await asyncio.gather(
            *(
                _invoke_tool(
                    dependencies.tools,
                    tool_name,
                    arguments,
                    timeout_seconds=tool_timeout_seconds,
                )
                for tool_name, arguments, _ in calls
            )
        )
        context: dict[str, Any] = {
            context_key: result for (_, _, context_key), result in zip(calls, results, strict=True)
        }
        errors: list[str] = []
        if request.candidate_id and not _required_context_matches(
            context.get("candidate"),
            expected_id=str(request.candidate_id),
            expected_merchant_id=merchant_id,
            id_fields=("id", "candidate_id"),
        ):
            errors.append("candidate")
        if request.role_id and not _required_context_matches(
            context.get("job_requirements"),
            expected_id=str(request.role_id),
            expected_merchant_id=merchant_id,
            id_fields=("id", "role_id"),
        ):
            errors.append("job_requirements")
        mock_warnings = [
            f"mock_context:{context_key}"
            for (_, _, context_key), result in zip(calls, results, strict=True)
            if isinstance(result, dict) and result.get("mock") is True
        ]
        return {
            "required_context": context,
            "context_errors": errors,
            "scoring_evidence_ready": bool(not errors and request.candidate_id and request.role_id),
            "tool_calls": [tool_name for tool_name, _, _ in calls],
            "warnings": mock_warnings,
        }

    async def build_context_failure(state: HiringState) -> dict[str, Any]:
        if state["request"].has_explicit_write:
            return {
                "draft": HiringAgentDraft(
                    summary="Legacy candidate score write was not performed.",
                    recommendation=(
                        "Use the authenticated human-review workflow for any hiring "
                        "decision or score change."
                    ),
                    fit_score=None,
                    analysis=HiringAgentAnalysis(
                        limitations=["Legacy automated score writes are disabled."],
                        confidence="low",
                    ),
                ),
                "status": "degraded",
                "write_status": "failed",
                "warnings": ["legacy_score_write_disabled"],
            }
        return {
            "draft": _safe_failure_draft(),
            "status": "degraded",
            "write_status": "not_requested",
            "warnings": [
                (
                    "unsafe_request_instructions"
                    if name == "unsafe_request_instructions"
                    else f"required_context_unavailable:{name}"
                )
                for name in state.get("context_errors", [])
            ],
        }

    async def seed_messages(state: HiringState) -> dict[str, Any]:
        return {
            "messages": [
                SystemMessage(content=SYSTEM_PROMPT),
                HumanMessage(
                    content=build_reasoning_input(
                        state["request"],
                        state.get("required_context", {}),
                    )
                ),
            ],
            "tool_rounds": 0,
        }

    async def reason(state: HiringState) -> dict[str, Any]:
        async with asyncio.timeout(model_timeout_seconds):
            response = await dependencies.reasoning_model.ainvoke(state["messages"])
        if not isinstance(response, AIMessage):
            raise InvalidModelOutputError("reasoning model returned an invalid message")
        validate_ai_message(response)
        _validate_model_tool_calls(response, maximum=max_tool_calls_per_round)
        return {"messages": [response]}

    async def execute_search_tools(state: HiringState) -> dict[str, Any]:
        request = state["request"]
        last_message = state["messages"][-1]
        if not isinstance(last_message, AIMessage):
            return {"messages": [], "tool_rounds": state.get("tool_rounds", 0) + 1}

        tool_messages: list[ToolMessage] = []
        executed_names: list[str] = []
        warnings: list[str] = []
        for index, call in enumerate(last_message.tool_calls):
            raw_name = call.get("name")
            name = raw_name if isinstance(raw_name, str) else ""
            try:
                call_id = _validated_tool_call_id(call, index)
            except InvalidModelOutputError:
                call_id = f"blocked-tool-{index}"
            raw_arguments = call.get("args")
            arguments = dict(raw_arguments) if isinstance(raw_arguments, dict) else {}
            message_name = name if name in SEARCH_TOOLS else "blocked_tool"

            if index >= max_tool_calls_per_round:
                result = {"error": "Search tool-call limit exceeded"}
                warnings.append("tool_call_budget_exceeded")
            elif request.operation != HiringOperation.SEARCH_CANDIDATES:
                result = {"error": "Candidate search is not allowed in review mode"}
                warnings.append("search_not_allowed_in_review")
            elif name not in SEARCH_TOOLS:
                result: Any = {"error": "This workflow only permits read-only search tools"}
                warnings.append("tool_not_allowlisted")
            else:
                # Tenant scope always comes from the validated request, never model arguments.
                arguments["merchant_id"] = str(request.merchant_id)
                if name == "semantic_search_candidates":
                    query = str(arguments.get("query") or request.instructions or "").strip()
                    arguments["query"] = query[:4_000]
                result = await _invoke_tool(
                    dependencies.tools,
                    name,
                    arguments,
                    timeout_seconds=tool_timeout_seconds,
                )
                executed_names.append(name)
                if _result_error(result):
                    warnings.append(f"tool_unavailable:{name}")

            tool_messages.append(
                ToolMessage(
                    content=json.dumps(result, default=str, ensure_ascii=False),
                    tool_call_id=call_id,
                    name=message_name,
                )
            )

        return {
            "messages": tool_messages,
            "tool_calls": executed_names,
            "tool_rounds": state.get("tool_rounds", 0) + 1,
            "warnings": warnings,
        }

    async def close_tool_loop(state: HiringState) -> dict[str, Any]:
        """Answer pending calls so provider message history remains structurally valid."""
        last_message = state["messages"][-1]
        if not isinstance(last_message, AIMessage):
            return {"messages": []}
        return {
            "messages": [
                ToolMessage(
                    content=json.dumps({"error": "Search tool budget exhausted"}),
                    tool_call_id=(
                        _validated_tool_call_id(call, index)
                        if isinstance(call, dict)
                        else f"blocked-tool-{index}"
                    ),
                    name=(
                        str(call.get("name"))
                        if isinstance(call, dict) and call.get("name") in SEARCH_TOOLS
                        else "blocked_tool"
                    ),
                )
                for index, call in enumerate(last_message.tool_calls)
            ]
        }

    async def finalize_structured(state: HiringState) -> dict[str, Any]:
        messages = list(state["messages"])
        messages.append(HumanMessage(content=FINAL_RESPONSE_PROMPT))

        async with asyncio.timeout(model_timeout_seconds):
            raw_result = await dependencies.structured_model.ainvoke(messages)
        if isinstance(raw_result, dict) and "raw" in raw_result:
            raw_message = raw_result.get("raw")
            if isinstance(raw_message, AIMessage):
                validate_ai_message(raw_message, require_content=False)
            if raw_result.get("parsing_error") is not None:
                raise InvalidModelOutputError("structured model output failed validation")
            raw_draft = raw_result.get("parsed")
        else:
            raw_draft = raw_result

        if raw_draft is None:
            raise InvalidModelOutputError("structured model output was empty")
        try:
            draft = (
                raw_draft
                if isinstance(raw_draft, HiringAgentDraft)
                else HiringAgentDraft.model_validate(raw_draft)
            )
        except ValueError:
            raise InvalidModelOutputError("structured model output failed validation") from None
        if contains_unsafe_hiring_language(draft.model_dump_json()):
            raise ModelSafetyError("model used a protected or medical characteristic")
        public_text = f"{draft.summary}\n{draft.recommendation}"
        if _AUTONOMOUS_DECISION_RE.search(public_text):
            raise ModelSafetyError("model claimed autonomous hiring authority")
        if _PERSISTENCE_CLAIM_RE.search(public_text):
            raise InvalidModelOutputError("model claimed unverified persistence")
        return {"draft": draft}

    async def handle_model_failure(
        state: HiringState,
        error: NodeError,
    ) -> Command[Literal["assemble_output"]]:
        refused = isinstance(error.error, ModelSafetyError)
        return Command(
            update={
                "draft": _safe_failure_draft(),
                "status": "refused" if refused else "degraded",
                "write_status": (
                    "skipped" if state["request"].has_explicit_write else "not_requested"
                ),
                "warnings": ["model_safety_refusal" if refused else "model_unavailable"],
            },
            goto="assemble_output",
        )

    async def assemble_output(state: HiringState) -> dict[str, Any]:
        draft = state["draft"]
        # Preserve execution order while avoiding noisy duplicate names from search loops.
        actual_tool_calls = list(dict.fromkeys(state.get("tool_calls", [])))
        request = state["request"]
        warnings = list(dict.fromkeys(state.get("warnings", [])))
        write_status = state.get(
            "write_status",
            "not_requested" if not request.has_explicit_write else "skipped",
        )

        has_scoring_evidence = bool(state.get("scoring_evidence_ready", False))
        fit_score = (
            draft.fit_score if not request.has_explicit_write and has_scoring_evidence else None
        )
        if draft.fit_score is not None and not has_scoring_evidence:
            warnings.append("score_suppressed_missing_evidence")

        clean_analysis = HiringAgentAnalysis.model_validate(
            sanitize_output_json(draft.analysis.model_dump())
        )
        recommendation_prefix = redact_sensitive_text(
            draft.recommendation,
            max_length=1_000 - len(HUMAN_REVIEW_NOTICE) - 1,
        ).rstrip()
        recommendation = (
            f"{recommendation_prefix} {HUMAN_REVIEW_NOTICE}"
            if recommendation_prefix
            else HUMAN_REVIEW_NOTICE
        )
        status = state.get("status", "complete")
        if warnings and status == "complete":
            status = "degraded"

        output = HiringAgentOutput(
            summary=redact_sensitive_text(draft.summary, max_length=500),
            recommendation=recommendation,
            fit_score=fit_score,
            analysis=clean_analysis,
            status=status,
            write_status=write_status,
            warnings=list(dict.fromkeys(warnings)),
            request_id=str(request.request_id),
            tool_calls=actual_tool_calls,
        )
        return {"output": output}

    return {
        "load_required_context": load_required_context,
        "build_context_failure": build_context_failure,
        "seed_messages": seed_messages,
        "reason": reason,
        "execute_search_tools": execute_search_tools,
        "close_tool_loop": close_tool_loop,
        "finalize_structured": finalize_structured,
        "handle_model_failure": handle_model_failure,
        "assemble_output": assemble_output,
    }
