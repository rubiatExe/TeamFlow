"""Run pytest while treating every collected skip as a release-gate failure."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


class _FailOnSkippedTests:
    def __init__(self) -> None:
        self._skipped: list[pytest.CollectReport | pytest.TestReport] = []

    def pytest_collectreport(self, report: pytest.CollectReport) -> None:
        if report.skipped:
            self._skipped.append(report)

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        if report.skipped:
            self._skipped.append(report)

    @pytest.hookimpl(trylast=True)
    def pytest_sessionfinish(self, session: pytest.Session, exitstatus: int) -> None:
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")
        if not self._skipped:
            return

        if reporter is not None:
            reporter.write_sep(
                "=",
                f"release gate rejected {len(self._skipped)} skipped test(s)",
                red=True,
            )
            for report in self._skipped:
                reason = getattr(report, "longrepr", "skip reason unavailable")
                reporter.write_line(f"{report.nodeid}: {reason}", red=True)

        session.exitstatus = pytest.ExitCode.TESTS_FAILED


if __name__ == "__main__":
    sys.path.insert(0, str(Path.cwd()))
    raise SystemExit(pytest.main(sys.argv[1:], plugins=[_FailOnSkippedTests()]))
