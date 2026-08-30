"""Black-box contracts for the local coordination command line."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from sharednet.coordination.models import CoordinationResult, TerminalStatus
from sharednet.coordination.service import CoordinationService


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_REQUEST = REPOSITORY_ROOT / "examples" / "four-agent-task.json"


def run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "sharednet.cli", *arguments],
        cwd=REPOSITORY_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class CliTests(unittest.TestCase):
    def test_list_outputs_canonical_backends_and_aliases_without_runtime(self) -> None:
        completed = run_cli("coord", "list")

        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(
            [item["id"] for item in payload["mechanisms"]],
            ["discovery-and-use", "rac-rge", "rac-adaptive", "peer-forum"],
        )
        self.assertEqual(payload["aliases"], {"rac-adpt": "rac-adaptive"})

    def test_plan_example_selects_four_participants_without_constructing_runtime(self) -> None:
        from sharednet import cli

        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.object(cli, "CodexRuntime", side_effect=AssertionError("plan must not construct a runtime")):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = cli.main(
                    [
                        "coord",
                        "plan",
                        "--mechanism",
                        "rac-rge",
                        "--request",
                        str(EXAMPLE_REQUEST),
                    ]
                )

        self.assertEqual(code, 0, stderr.getvalue())
        payload = json.loads(stdout.getvalue())
        self.assertEqual(
            [participant["candidate_id"] for participant in payload["participants"]],
            ["self", "research-agent", "architecture-agent", "risk-agent"],
        )

    def test_run_returns_one_for_terminal_runtime_failure_and_uses_requested_model(self) -> None:
        from sharednet import cli

        observed_models: list[str] = []

        class FailingRuntime:
            def __init__(self, *, model: str) -> None:
                observed_models.append(model)

            def execute(self, plan):
                return CoordinationResult(status=TerminalStatus.FAILED, plan=plan, error="codex_unavailable")

        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.object(cli, "CodexRuntime", FailingRuntime):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = cli.main(
                    [
                        "coord",
                        "run",
                        "--mechanism",
                        "rac-rge",
                        "--request",
                        str(EXAMPLE_REQUEST),
                        "--model",
                        "gpt-5.6-luna",
                    ]
                )

        self.assertEqual(code, 1, stderr.getvalue())
        self.assertEqual(observed_models, ["gpt-5.6-luna"])
        self.assertEqual(json.loads(stdout.getvalue())["status"], "failed")

    def test_invalid_request_returns_structured_caller_error(self) -> None:
        from sharednet import cli

        with tempfile.TemporaryDirectory() as directory:
            request_path = Path(directory) / "invalid.json"
            request_path.write_text('{"mechanism": "rac-rge"}', encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = cli.main(["coord", "plan", "--mechanism", "rac-rge", "--request", str(request_path)])

        self.assertEqual(code, 2)
        self.assertEqual(stdout.getvalue(), "")
        payload = json.loads(stderr.getvalue())
        self.assertEqual(payload["type"], "ValueError")
        self.assertTrue(payload["error"])

    def test_unknown_mechanism_returns_structured_caller_error(self) -> None:
        completed = run_cli("coord", "plan", "--mechanism", "missing", "--request", "examples/four-agent-task.json")

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, "")
        payload = json.loads(completed.stderr)
        self.assertEqual(payload["type"], "UnknownMechanism")
        self.assertIn("unknown coordination mechanism", payload["error"])


if __name__ == "__main__":
    unittest.main()
