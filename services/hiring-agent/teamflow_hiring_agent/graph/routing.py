"""Pure routing decisions for the hiring workflow."""

from typing import Literal

from langchain_core.messages import AIMessage

from .state import HiringState


def route_after_context(
    state: HiringState,
) -> Literal["build_context_failure", "seed_messages"]:
    """Do not invoke a model or writer when required tenant data is unavailable."""
    return "build_context_failure" if state.get("context_errors") else "seed_messages"


def route_after_reasoning(
    state: HiringState,
    *,
    max_tool_rounds: int,
) -> Literal["execute_search_tools", "close_tool_loop", "finalize_structured"]:
    """Bound the search loop and route without asking a model to control the graph."""
    messages = state.get("messages", [])
    last_message = messages[-1] if messages else None
    tool_calls = last_message.tool_calls if isinstance(last_message, AIMessage) else []

    if not tool_calls:
        return "finalize_structured"
    if state.get("tool_rounds", 0) >= max_tool_rounds:
        return "close_tool_loop"
    return "execute_search_tools"
