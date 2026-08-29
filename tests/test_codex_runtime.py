"""Unit tests for the bounded Codex JSONL runtime adapter."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from sharednet.coordination.models import CoordinationBudget, CoordinationPlan, ParticipantPlan, TerminalStatus
from sharednet.runtime.codex import CodexRuntime, ProcessOutcome, build_codex_prompt, parse_codex_events


def plan() -> CoordinationPlan:
    participants = tuple(
        ParticipantPlan(
            candidate_id=candidate_id,
            role="contributor",
            assignment=f"Contribute {candidate_id} findings.",
            dependencies=(),
            selection_reason="selected",
            capabilities=("analysis",),
        )
        for candidate_id in ("root", "child-a", "child-b", "child-c")
    )
    return CoordinationPlan(
        mechanism_id="peer-forum",
        task_id="runtime-task",
        trace_id="runtime-trace",
        attempt=0,
        exclusions=frozenset(),
        participants=participants,
        edges=(),
        decision_trace=(),
        runtime_instructions={"goal": "Produce a bounded synthesis."},
        budget=CoordinationBudget(max_participants=4),
    )


def markers_for(nonce: str) -> list[str]:
    return [f"[[sharednet:{nonce}:{candidate_id}]]" for candidate_id in plan().participant_ids]


def success_jsonl(markers: list[str]) -> str:
    participant_ids = plan().participant_ids
    final = {
        "synthesis": "The contributors agree on a bounded result.",
        "outputs": [
            {"candidate_id": participant_id, "marker": marker, "content": f"Finding from {participant_id}."}
            for participant_id, marker in zip(participant_ids, markers)
        ],
    }
    events = [
        {"type": "thread.started", "thread_id": "thread-root"},
        {"type": "collaboration.agent.spawned", "agent_thread_id": "child-1"},
        {"type": "collaboration.agent.spawned", "agent_thread_id": "child-2"},
        {"type": "collaboration.agent.spawned", "agent_thread_id": "child-3"},
        {"type": "turn.completed", "usage": {"input_tokens": 100, "output_tokens": 40}},
        {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(final)}},
    ]
    return "\n".join(json.dumps(event) for event in events)


def usage_only_jsonl() -> str:
    return json.dumps({"type": "turn.completed", "usage": {"input_tokens": 12}})


class RecordingRunner:
    def __init__(self, outcome: ProcessOutcome) -> None:
        self.outcome = outcome
        self.command: list[str] = []
        self.timeout: float | None = None

    def __call__(self, command: list[str], timeout: float) -> ProcessOutcome:
        self.command = command
        self.timeout = timeout
        return self.outcome


class CodexRuntimeTests(unittest.TestCase):
    def test_command_places_global_safety_flags_before_exec(self) -> None:
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))

        CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(
            runner.command[:7],
            ["/real/codex", "--enable", "multi_agent", "-a", "never", "-s", "read-only"],
        )
        self.assertEqual(runner.command[7], "exec")
        self.assertIn("--ephemeral", runner.command)
        self.assertIn("--ignore-user-config", runner.command)
        self.assertIn("--json", runner.command)
        self.assertEqual(runner.command[runner.command.index("--color") + 1], "never")

    def test_parser_collects_thread_usage_final_message_and_subagents(self) -> None:
        evidence = parse_codex_events(success_jsonl(markers_for("nonce-1")))

        self.assertEqual(evidence.thread_id, "thread-root")
        self.assertEqual(evidence.spawned_agent_ids, ("child-1", "child-2", "child-3"))
        self.assertEqual(evidence.usage["input_tokens"], 100)
        self.assertIn("nonce-1", evidence.final_message)
        self.assertEqual(evidence.raw_event_count, 6)

    def test_parser_collects_real_collab_tool_call_receivers(self) -> None:
        evidence = parse_codex_events(
            "\n".join(
                json.dumps(event)
                for event in (
                    {"type": "thread.started", "thread_id": "thread-root"},
                    {
                        "type": "item.completed",
                        "item": {
                            "type": "collab_tool_call",
                            "tool": "spawn_agent",
                            "sender_thread_id": "thread-root",
                            "receiver_thread_ids": ["child-1", "child-2", "child-3"],
                            "agents_states": {},
                        },
                    },
                )
            )
        )

        self.assertEqual(evidence.spawned_agent_ids, ("child-1", "child-2", "child-3"))
        self.assertEqual(evidence.explicit_spawn_count, 3)
        self.assertEqual(len(evidence.collaboration_events), 1)

    def test_missing_participant_marker_fails_closed(self) -> None:
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")[:-1]), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_participant_markers")

    def test_marker_must_belong_to_its_named_participant(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        final = json.loads(events[-1]["item"]["text"])
        final["outputs"][0]["marker"], final["outputs"][1]["marker"] = (
            final["outputs"][1]["marker"],
            final["outputs"][0]["marker"],
        )
        events[-1]["item"]["text"] = json.dumps(final)
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_participant_markers")

    def test_nonzero_exit_preserves_stderr_and_usage(self) -> None:
        runner = RecordingRunner(ProcessOutcome(7, usage_only_jsonl(), "provider unavailable", False))

        result = CodexRuntime(binary="/real/codex", runner=runner).execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "codex_exec_nonzero_exit")
        self.assertIn("provider unavailable", result.runtime_evidence["stderr"])
        self.assertEqual(result.usage["input_tokens"], 12)

    def test_final_message_requires_exact_structured_outputs(self) -> None:
        malformed = json.dumps(
            {"type": "item.completed", "item": {"type": "agent_message", "text": "not json"}}
        )
        runner = RecordingRunner(ProcessOutcome(0, malformed, "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner).execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "invalid_structured_output")

    def test_marker_text_does_not_prove_native_spawning(self) -> None:
        events = success_jsonl(markers_for("nonce-1")).splitlines()
        no_spawn_events = "\n".join(line for line in events if "collaboration.agent.spawned" not in line)
        runner = RecordingRunner(ProcessOutcome(0, no_spawn_events, "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_prompt_instructs_root_to_spawn_exactly_the_nonroot_participants(self) -> None:
        prompt = build_codex_prompt(plan(), "nonce-1")

        self.assertIn("participant zero", prompt)
        self.assertIn("exactly 3 parallel native spawn_agent calls", prompt)
        self.assertIn("Wait for every child", prompt)
        self.assertIn("Do not use file, shell, or web tools", prompt)
        self.assertIn("[[sharednet:nonce-1:root]]", prompt)

    def test_artifact_directory_receives_raw_process_logs(self) -> None:
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "diagnostic", False))
        with tempfile.TemporaryDirectory() as directory:
            result = CodexRuntime(
                binary="/real/codex",
                runner=runner,
                nonce_factory=lambda: "nonce-1",
                artifact_dir=directory,
            ).execute(plan())

            self.assertEqual(Path(result.runtime_evidence["stdout_artifact"]).read_text(), success_jsonl(markers_for("nonce-1")))
            self.assertEqual(Path(result.runtime_evidence["stderr_artifact"]).read_text(), "diagnostic")


if __name__ == "__main__":
    unittest.main()
