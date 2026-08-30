"""Opt-in proof that Codex executes the checked-in four-agent plan."""

from __future__ import annotations

import json
import os
from pathlib import Path
import unittest

from sharednet.coordination.models import CoordinationRequest, TerminalStatus
from sharednet.coordination.service import CoordinationService
from sharednet.runtime.codex import CodexRuntime


EXAMPLE_REQUEST = Path(__file__).resolve().parents[1] / "examples" / "four-agent-task.json"
EXPECTED_PARTICIPANTS = ("self", "research-agent", "architecture-agent", "risk-agent")
INCIDENT_IDS = ("INC-101", "INC-102", "INC-103", "INC-104")
ROLE_SIGNALS = {
    "research-agent": ("evidence", "assumption"),
    "architecture-agent": ("owner", "remediation"),
    "risk-agent": ("risk", "priorit"),
}


def load_example() -> CoordinationRequest:
    """Load the checked-in request through the public request boundary."""
    return CoordinationRequest.from_dict(json.loads(EXAMPLE_REQUEST.read_text(encoding="utf-8")))


@unittest.skipUnless(os.environ.get("RUN_CODEX_E2E") == "1", "real Codex E2E is opt-in")
class CodexLiveE2E(unittest.TestCase):
    def test_rge_executes_one_root_and_three_native_subagents(self) -> None:
        request = load_example()
        service = CoordinationService()
        plan = service.plan(request)

        self.assertEqual(plan.participant_ids, EXPECTED_PARTICIPANTS)
        self.assertEqual(len(plan.participants), 4)
        self.assertEqual(plan.to_dict()["runtime_instructions"]["task"], request.task.to_dict())

        result = service.execute(
            request,
            CodexRuntime(model="gpt-5.6-luna", artifact_dir=Path(".codex-live-artifacts")),
        )
        context = json.dumps(result.to_dict(), sort_keys=True, default=str)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED, context)
        self.assertEqual(result.plan.participant_ids, EXPECTED_PARTICIPANTS, context)
        self.assertEqual(result.plan.to_dict()["runtime_instructions"]["task"], request.task.to_dict(), context)
        self.assertEqual(len(result.outputs), 4, context)

        root_thread_id = result.runtime_evidence["thread_id"]
        child_thread_ids = result.runtime_evidence["spawned_agent_ids"]
        completed_child_ids = result.runtime_evidence["completed_child_ids"]
        contributing_child_ids = result.runtime_evidence["contributing_child_ids"]
        self.assertTrue(root_thread_id, context)
        self.assertEqual(len(child_thread_ids), 3, context)
        self.assertEqual(len(set(child_thread_ids)), 3, context)
        self.assertNotIn(root_thread_id, child_thread_ids, context)
        self.assertEqual(set(completed_child_ids), set(child_thread_ids), context)
        self.assertEqual(set(contributing_child_ids), set(child_thread_ids), context)
        self.assertEqual(
            set(result.runtime_evidence["child_participant_bindings"].values()),
            set(EXPECTED_PARTICIPANTS[1:]),
            context,
        )
        self.assertTrue(result.runtime_evidence["native_proof_complete"], context)
        self.assertTrue(result.runtime_evidence["child_output_proof_complete"], context)
        self.assertEqual(result.runtime_evidence["disallowed_tool_events"], (), context)
        self.assertGreater(result.usage["input_tokens"] + result.usage["output_tokens"], 0, context)

        outputs = {output.participant_id: output for output in result.outputs}
        self.assertEqual(set(outputs), set(EXPECTED_PARTICIPANTS), context)
        for output in result.outputs:
            self.assertIn(output.marker, result.synthesis, context)
            for incident_id in INCIDENT_IDS:
                self.assertIn(incident_id, output.content, context)
        for incident_id in INCIDENT_IDS:
            self.assertIn(incident_id, result.synthesis, context)

        participants = {participant.candidate_id: participant for participant in result.plan.participants}
        bindings = {
            binding["participant_id"]: binding
            for binding in result.runtime_evidence["child_output_bindings"]
        }
        self.assertEqual(set(bindings), set(EXPECTED_PARTICIPANTS[1:]), context)
        for participant_id, signals in ROLE_SIGNALS.items():
            binding = bindings[participant_id]
            participant = participants[participant_id]
            self.assertTrue(binding["output_content_match"], context)
            self.assertEqual(binding["assignment"], participant.assignment, context)
            self.assertEqual(tuple(binding["capabilities"]), participant.capabilities, context)
            contribution = outputs[participant_id].content.lower()
            for signal in signals:
                self.assertIn(signal, contribution, context)


if __name__ == "__main__":
    unittest.main()
