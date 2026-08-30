"""Integration contracts for carrying bounded task data into the Codex prompt."""

from __future__ import annotations

import json
from pathlib import Path
import unittest

from sharednet.coordination.models import CoordinationBudget, CoordinationRequest, TaskSpec
from sharednet.coordination.backends.common import make_plan
from sharednet.coordination.service import CoordinationService
from sharednet.runtime.codex import build_codex_prompt


EXAMPLE_REQUEST = Path(__file__).resolve().parents[1] / "examples" / "four-agent-task.json"


def compact_task_bytes(task: TaskSpec) -> int:
    return len(json.dumps(task.to_dict(), ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8"))


class TaskPayloadTests(unittest.TestCase):
    def test_planning_carries_the_full_task_payload_into_the_codex_prompt(self) -> None:
        request = CoordinationRequest.from_dict(json.loads(EXAMPLE_REQUEST.read_text(encoding="utf-8")))

        plan = CoordinationService().plan(request)

        self.assertEqual(plan.to_dict()["runtime_instructions"]["task"], request.task.to_dict())
        prompt = build_codex_prompt(plan, "payload-nonce")
        self.assertIn(request.task.goal, prompt)
        for criterion in request.task.acceptance_criteria:
            self.assertIn(criterion, prompt)
        for incident_id in ("INC-101", "INC-102", "INC-103", "INC-104"):
            self.assertIn(incident_id, prompt)

    def test_request_rejects_a_task_payload_that_exceeds_its_disclosure_limit(self) -> None:
        task = TaskSpec("bounded-task", "Keep the immutable payload bounded.", ("analysis",), (), {"evidence": "x" * 100})
        task_bytes = compact_task_bytes(task)

        with self.assertRaisesRegex(ValueError, "max_disclosure_bytes"):
            CoordinationRequest(
                task,
                (),
                CoordinationBudget(max_disclosure_bytes=task_bytes - 1),
                "rac-rge",
                "bounded-trace",
            )

        request_at_exact_limit = CoordinationRequest(
            task,
            (),
            CoordinationBudget(max_disclosure_bytes=task_bytes),
            "rac-rge",
            "bounded-trace",
        )
        self.assertEqual(request_at_exact_limit.task, task)

    def test_shared_plan_construction_preserves_task_when_mechanism_instructions_conflict(self) -> None:
        task = TaskSpec("authoritative-task", "Keep the task authoritative.", ("analysis",), (), {"scope": "local"})
        request = CoordinationRequest(task, (), CoordinationBudget(), "rac-rge", "authoritative-trace")

        plan = make_plan(
            "rac-rge",
            request,
            frozenset(),
            (),
            (),
            [],
            {"coordination": "organization-graph", "task": "mechanism-supplied value"},
        )

        instructions = plan.to_dict()["runtime_instructions"]
        self.assertEqual(instructions["coordination"], "organization-graph")
        self.assertEqual(instructions["task"], task.to_dict())


if __name__ == "__main__":
    unittest.main()
