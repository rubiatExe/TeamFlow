"""LangGraph assembly for TeamFlow's hiring workflow."""

import math
from functools import partial
from typing import Any

from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

from ..reliability import InvalidModelOutputError
from .nodes import GraphDependencies, create_nodes
from .routing import route_after_context, route_after_reasoning
from .state import HiringState


def build_hiring_graph(
    dependencies: GraphDependencies,
    *,
    max_tool_rounds: int = 2,
    max_tool_calls_per_round: int = 3,
    model_timeout_seconds: float = 15.0,
    tool_timeout_seconds: float = 10.0,
) -> Any:
    """Compile a graph with bounded model retries and read-only tool execution."""
    if (
        isinstance(max_tool_rounds, bool)
        or not isinstance(max_tool_rounds, int)
        or not 0 <= max_tool_rounds <= 4
    ):
        raise ValueError("max_tool_rounds must be between 0 and 4")
    if (
        isinstance(max_tool_calls_per_round, bool)
        or not isinstance(max_tool_calls_per_round, int)
        or not 1 <= max_tool_calls_per_round <= 5
    ):
        raise ValueError("max_tool_calls_per_round must be between 1 and 5")
    if (
        isinstance(model_timeout_seconds, bool)
        or not isinstance(model_timeout_seconds, int | float)
        or not math.isfinite(model_timeout_seconds)
        or not 0.1 <= model_timeout_seconds <= 30.0
    ):
        raise ValueError("model_timeout_seconds must be between 0.1 and 30")
    if (
        isinstance(tool_timeout_seconds, bool)
        or not isinstance(tool_timeout_seconds, int | float)
        or not math.isfinite(tool_timeout_seconds)
        or not 0.01 <= tool_timeout_seconds <= 30.0
    ):
        raise ValueError("tool_timeout_seconds must be between 0.01 and 30")

    nodes = create_nodes(
        dependencies,
        max_tool_calls_per_round=max_tool_calls_per_round,
        model_timeout_seconds=float(model_timeout_seconds),
        tool_timeout_seconds=float(tool_timeout_seconds),
    )
    builder = StateGraph(HiringState)

    builder.add_node("load_required_context", nodes["load_required_context"])
    builder.add_node("build_context_failure", nodes["build_context_failure"])
    builder.add_node("seed_messages", nodes["seed_messages"])
    builder.add_node(
        "reason",
        nodes["reason"],
        retry_policy=RetryPolicy(
            max_attempts=2,
            retry_on=InvalidModelOutputError,
        ),
        error_handler=nodes["handle_model_failure"],
        destinations=("assemble_output",),
        timeout=model_timeout_seconds,
    )
    builder.add_node("execute_search_tools", nodes["execute_search_tools"])
    builder.add_node("close_tool_loop", nodes["close_tool_loop"])
    builder.add_node(
        "finalize_structured",
        nodes["finalize_structured"],
        retry_policy=RetryPolicy(
            max_attempts=2,
            retry_on=InvalidModelOutputError,
        ),
        error_handler=nodes["handle_model_failure"],
        destinations=("assemble_output",),
        timeout=model_timeout_seconds,
    )
    builder.add_node("assemble_output", nodes["assemble_output"])

    builder.add_edge(START, "load_required_context")
    builder.add_conditional_edges("load_required_context", route_after_context)
    builder.add_edge("build_context_failure", "assemble_output")
    builder.add_edge("seed_messages", "reason")
    builder.add_conditional_edges(
        "reason",
        partial(route_after_reasoning, max_tool_rounds=max_tool_rounds),
    )
    builder.add_edge("execute_search_tools", "reason")
    builder.add_edge("close_tool_loop", "finalize_structured")
    builder.add_edge("finalize_structured", "assemble_output")
    builder.add_edge("assemble_output", END)

    return builder.compile()
