"""Pure conditional routes for the résumé-review graph."""

from .state import ResumeReviewState


def route_or_assess(state: ResumeReviewState, success_node: str) -> str:
    return "assess_confidence" if state.get("failure_code") else success_node


def route_after_assessment(state: ResumeReviewState) -> str:
    return (
        "agent2_generate_questions" if state.get("agent2_ready", False) else "finalize_confidence"
    )


def route_after_agent2(state: ResumeReviewState) -> str:
    return "validate_questions" if "agent2_question_plan" in state else "finalize_confidence"
