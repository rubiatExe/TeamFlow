"""State shared by the hiring workflow's deterministic and model-powered nodes."""

import operator
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages

from ..contracts import HiringAgentDraft, HiringAgentOutput, HiringAgentRequest


class HiringState(TypedDict, total=False):
    request: HiringAgentRequest
    required_context: dict[str, Any]
    context_errors: list[str]
    scoring_evidence_ready: bool
    messages: Annotated[list[AnyMessage], add_messages]
    tool_calls: Annotated[list[str], operator.add]
    tool_rounds: int
    warnings: Annotated[list[str], operator.add]
    status: str
    write_status: str
    draft: HiringAgentDraft
    output: HiringAgentOutput
