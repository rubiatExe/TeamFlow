import math
from pathlib import Path

import pytest

from teamflow_hiring_agent.config import Settings
from teamflow_hiring_agent.telemetry import _bounded_sample_ratio


@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "0", "-1", "31", "bad"])
def test_model_deadline_rejects_nonfinite_or_out_of_range_values(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("HIRING_AGENT_MODEL_TIMEOUT_SECONDS", value)

    with pytest.raises(ValueError, match="HIRING_AGENT_MODEL_TIMEOUT_SECONDS"):
        Settings.from_env()


@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "0", "-1", "56", "bad"])
def test_workflow_deadline_rejects_nonfinite_or_out_of_range_values(
    monkeypatch: pytest.MonkeyPatch,
    value: str,
) -> None:
    monkeypatch.setenv("HIRING_AGENT_TIMEOUT_SECONDS", value)

    with pytest.raises(ValueError, match="HIRING_AGENT_TIMEOUT_SECONDS"):
        Settings.from_env()


def test_default_deadlines_are_finite_and_inside_the_route_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "HIRING_AGENT_MODEL_TIMEOUT_SECONDS",
        "HIRING_AGENT_TIMEOUT_SECONDS",
        "HIRING_AGENT_QUEUE_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = Settings.from_env()

    assert math.isfinite(settings.model_timeout_seconds)
    assert math.isfinite(settings.workflow_timeout_seconds)
    assert math.isfinite(settings.queue_timeout_seconds)
    assert settings.workflow_timeout_seconds <= 55


@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "-0.1", "1.1", "bad"])
def test_trace_sample_ratio_is_finite_and_bounded(value: str) -> None:
    with pytest.raises(RuntimeError, match="OTEL_TRACES_SAMPLER_ARG_invalid"):
        _bounded_sample_ratio(value)


def test_shadow_logging_omits_candidate_decision_metadata() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "teamflow_hiring_agent"
        / "resume_review"
        / "graph"
        / "nodes.py"
    ).read_text(encoding="utf-8")
    logging_block = source.split('"Résumé-review confidence finalized in shadow mode"', 1)[1].split(
        "except Exception:", 1
    )[0]

    for forbidden in (
        '"confidence_score"',
        '"confidence_hard_failure"',
        '"confidence_reason_count"',
        '"confidence_status"',
        '"confidence_review_required"',
    ):
        assert forbidden not in logging_block


def test_review_tracing_omits_candidate_decision_metadata() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "teamflow_hiring_agent"
        / "resume_review"
        / "runtime.py"
    ).read_text(encoding="utf-8")

    for forbidden in (
        "teamflow.review_status",
        "teamflow.review_required",
        "teamflow.reason_count",
        "teamflow.confidence.score",
        "teamflow.confidence.hard_failure",
    ):
        assert forbidden not in source
