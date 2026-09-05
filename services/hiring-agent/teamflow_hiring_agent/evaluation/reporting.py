"""Aggregate-only deterministic reports that do not echo résumé or provider text."""

from __future__ import annotations

from collections.abc import Sequence

from .metrics import EvaluationMetrics, summarize_records
from .models import FrozenModel, Identifier, Sha256, Version
from .records import EvaluationRecord, EvaluationResult, FailureCategory


class ReportIssue(FrozenModel):
    case_id: Identifier
    category: FailureCategory
    code: Identifier


class EvaluationReport(FrozenModel):
    schema_version: str = "1.0"
    dataset_name: Identifier
    dataset_version: Version
    dataset_fingerprint: Sha256
    metrics: EvaluationMetrics
    issues: tuple[ReportIssue, ...]


def build_report(
    *,
    dataset_name: str,
    dataset_version: str,
    dataset_fingerprint: str,
    records: Sequence[EvaluationRecord],
) -> EvaluationReport:
    issues = tuple(
        sorted(
            (
                ReportIssue(
                    case_id=record.case_id,
                    category=record.failure.category,
                    code=record.failure.code,
                )
                for record in records
                if record.result is not EvaluationResult.PASSED and record.failure is not None
            ),
            key=lambda issue: (issue.category.value, issue.code, issue.case_id),
        )
    )
    return EvaluationReport(
        dataset_name=dataset_name,
        dataset_version=dataset_version,
        dataset_fingerprint=dataset_fingerprint,
        metrics=summarize_records(records),
        issues=issues,
    )


def _cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def report_markdown(report: EvaluationReport) -> str:
    """Render counts and safe reason codes only; never render failure messages."""

    metrics = report.metrics
    lines = [
        f"# Evaluation report: {_cell(report.dataset_name)} {_cell(report.dataset_version)}",
        "",
        f"Dataset fingerprint: `{report.dataset_fingerprint}`",
        "",
        "| Outcome | Count |",
        "|---|---:|",
        f"| Passed | {metrics.passed} |",
        f"| Operational errors | {metrics.operational_errors} |",
        f"| Contract failures | {metrics.contract_failures} |",
        f"| Quality failures | {metrics.quality_failures} |",
        "",
        "Operational errors are excluded from the quality denominator.",
    ]
    if report.issues:
        lines.extend(
            [
                "",
                "| Case | Category | Reason code |",
                "|---|---|---|",
                *(
                    f"| {_cell(issue.case_id)} | {_cell(issue.category.value)} | "
                    f"{_cell(issue.code)} |"
                    for issue in report.issues
                ),
            ]
        )
    return "\n".join(lines) + "\n"
