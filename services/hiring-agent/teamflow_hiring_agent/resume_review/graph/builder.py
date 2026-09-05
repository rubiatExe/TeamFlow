"""Graph assembly for the isolated two-agent résumé-review workflow."""

from functools import partial
from typing import Any

from langgraph.graph import END, START, StateGraph

from .nodes import ResumeReviewDependencies, create_resume_review_nodes
from .routing import route_after_agent2, route_after_assessment, route_or_assess
from .state import ResumeReviewState


def build_resume_review_graph(
    dependencies: ResumeReviewDependencies,
    *,
    model_timeout_seconds: float = 12.0,
) -> Any:
    if model_timeout_seconds <= 0:
        raise ValueError("model_timeout_seconds must be positive")
    nodes = create_resume_review_nodes(
        dependencies,
        model_timeout_seconds=model_timeout_seconds,
    )
    builder = StateGraph(ResumeReviewState)

    for name in (
        "load_document",
        "extract_document",
        "validate_extraction",
        "load_active_roles",
        "validate_evidence",
        "calculate_scores",
        "assess_confidence",
        "validate_questions",
        "finalize_confidence",
        "guarded_persistence",
        "assemble_response",
    ):
        builder.add_node(name, nodes[name])
    builder.add_node("agent1_evaluate", nodes["agent1_evaluate"])
    builder.add_node("agent2_generate_questions", nodes["agent2_generate_questions"])

    builder.add_edge(START, "load_document")
    builder.add_conditional_edges(
        "load_document", partial(route_or_assess, success_node="extract_document")
    )
    builder.add_conditional_edges(
        "extract_document", partial(route_or_assess, success_node="validate_extraction")
    )
    builder.add_conditional_edges(
        "validate_extraction", partial(route_or_assess, success_node="load_active_roles")
    )
    builder.add_conditional_edges(
        "load_active_roles", partial(route_or_assess, success_node="agent1_evaluate")
    )
    builder.add_conditional_edges(
        "agent1_evaluate", partial(route_or_assess, success_node="validate_evidence")
    )
    builder.add_conditional_edges(
        "validate_evidence", partial(route_or_assess, success_node="calculate_scores")
    )
    builder.add_conditional_edges(
        "calculate_scores", partial(route_or_assess, success_node="assess_confidence")
    )
    builder.add_conditional_edges("assess_confidence", route_after_assessment)
    builder.add_conditional_edges("agent2_generate_questions", route_after_agent2)
    builder.add_edge("validate_questions", "finalize_confidence")
    builder.add_edge("finalize_confidence", "guarded_persistence")
    builder.add_edge("guarded_persistence", "assemble_response")
    builder.add_edge("assemble_response", END)

    return builder.compile()
