"""Opt-in proof that Codex executes the checked-in four-agent plan."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import unittest

from sharednet.coordination.models import CoordinationRequest, TerminalStatus
from sharednet.coordination.service import CoordinationService
from sharednet.runtime.codex import CodexRuntime


EXAMPLE_REQUEST = Path(__file__).resolve().parents[1] / "examples" / "four-agent-task.json"
ARTIFACT_DIR = Path(__file__).resolve().parents[1] / ".codex-live-artifacts"
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
            CodexRuntime(model="gpt-5.6-luna", artifact_dir=ARTIFACT_DIR),
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
        self.assertTrue(result.runtime_evidence["native_output_hydration_complete"], context)
        self.assertEqual(result.runtime_evidence["disallowed_tool_events"], (), context)
        self.assertGreater(result.usage["input_tokens"] + result.usage["output_tokens"], 0, context)

        self.assertEqual(tuple(output.participant_id for output in result.outputs), EXPECTED_PARTICIPANTS, context)
        outputs = {output.participant_id: output for output in result.outputs}
        self.assertEqual(set(outputs), set(EXPECTED_PARTICIPANTS), context)
        root_output = result.outputs[0]
        self.assertEqual(root_output.content, result.synthesis, context)
        self.assertEqual(
            dict(root_output.evidence),
            {"source": "root_synthesis", "protocol": "native-output-receipt-v1"},
            context,
        )
        marker_prefix = root_output.marker.removesuffix(f":{EXPECTED_PARTICIPANTS[0]}]]")
        self.assertTrue(marker_prefix.startswith("[[sharednet:"), context)
        self.assertEqual(len({output.marker for output in result.outputs}), 4, context)
        for output in result.outputs:
            self.assertEqual(output.marker, f"{marker_prefix}:{output.participant_id}]]", context)
        for incident_id in INCIDENT_IDS:
            self.assertIn(incident_id, result.synthesis, context)

        child_by_participant = {
            participant_id: child_thread_id
            for child_thread_id, participant_id in result.runtime_evidence["child_participant_bindings"].items()
        }
        self.assertEqual(set(child_by_participant), set(EXPECTED_PARTICIPANTS[1:]), context)

        stdout_path = Path(result.runtime_evidence["stdout_artifact"])
        transcript = [
            json.loads(line) if line.strip() else None
            for line in stdout_path.read_text(encoding="utf-8").splitlines()
        ]
        completed_spawns = {
            item["receiver_thread_ids"][0]: item
            for event in transcript
            if isinstance(event, dict)
            and event.get("type") == "item.completed"
            and isinstance((item := event.get("item")), dict)
            and item.get("type") == "collab_tool_call"
            and item.get("tool") == "spawn_agent"
            and len(item.get("receiver_thread_ids", ())) == 1
        }
        completed_waits = [
            item
            for event in transcript
            if isinstance(event, dict)
            and event.get("type") == "item.completed"
            and isinstance((item := event.get("item")), dict)
            and item.get("type") == "collab_tool_call"
            and item.get("tool") == "wait"
        ]
        self.assertEqual(set(completed_spawns), set(child_thread_ids), context)
        self.assertEqual(len(completed_spawns), 3, context)
        self.assertGreaterEqual(len(completed_waits), 1, context)

        for participant_id, signals in ROLE_SIGNALS.items():
            output = outputs[participant_id]
            child_thread_id = child_by_participant[participant_id]
            evidence = dict(output.evidence)
            self.assertEqual(
                set(evidence),
                {
                    "source",
                    "protocol",
                    "child_thread_id",
                    "wait_event_index",
                    "sha256",
                    "byte_length",
                    "normalization_version",
                },
                context,
            )
            self.assertEqual(evidence["source"], "native_wait", context)
            self.assertEqual(evidence["protocol"], "native-output-receipt-v1", context)
            self.assertEqual(evidence["child_thread_id"], child_thread_id, context)
            self.assertEqual(evidence["normalization_version"], "crlf-to-lf-strip-v1", context)
            content_bytes = output.content.encode("utf-8")
            self.assertEqual(evidence["byte_length"], len(content_bytes), context)
            self.assertEqual(evidence["sha256"], hashlib.sha256(content_bytes).hexdigest(), context)

            wait_event_index = evidence["wait_event_index"]
            self.assertIsInstance(wait_event_index, int, context)
            self.assertGreaterEqual(wait_event_index, 0, context)
            wait_event = transcript[wait_event_index]
            self.assertIsInstance(wait_event, dict, context)
            wait_item = wait_event.get("item")
            self.assertEqual(wait_event.get("type"), "item.completed", context)
            self.assertIsInstance(wait_item, dict, context)
            self.assertEqual(wait_item.get("tool"), "wait", context)
            child_state = wait_item["agents_states"][child_thread_id]
            self.assertEqual(child_state["status"], "completed", context)
            normalized_message = child_state["message"].replace("\r\n", "\n").replace("\r", "\n").strip()
            child_marker, separator, child_body = normalized_message.partition("\n")
            self.assertTrue(separator, context)
            self.assertEqual(child_marker, output.marker, context)
            self.assertEqual(child_body.strip(), output.content, context)

            spawn_payload = json.loads(completed_spawns[child_thread_id]["prompt"])
            self.assertEqual(spawn_payload["participant"]["candidate_id"], participant_id, context)
            self.assertEqual(spawn_payload["marker"], output.marker, context)

            contribution = output.content.lower()
            for signal in signals:
                self.assertIn(signal, contribution, context)


if __name__ == "__main__":
    unittest.main()
