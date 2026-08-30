"""Unit tests for the bounded Codex JSONL runtime adapter."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from sharednet.coordination.models import CoordinationBudget, CoordinationPlan, ParticipantPlan, TerminalStatus
from sharednet.runtime.codex import (
    CodexRuntime,
    ProcessOutcome,
    _CHATGPT_CODEX_PATHS,
    _default_runner,
    build_codex_prompt,
    parse_codex_events,
)


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
        "synthesis": "The contributors agree on a bounded result. " + " ".join(markers),
        "outputs": [
            {"candidate_id": participant_id, "marker": marker, "content": f"Finding from {participant_id}."}
            for participant_id, marker in zip(participant_ids, markers)
        ],
    }
    events = [
        {"type": "thread.started", "thread_id": "thread-root"},
        {"type": "collaboration.agent.spawned", "sender_thread_id": "thread-root", "agent_thread_id": "child-1"},
        {"type": "collaboration.agent.spawned", "sender_thread_id": "thread-root", "agent_thread_id": "child-2"},
        {"type": "collaboration.agent.spawned", "sender_thread_id": "thread-root", "agent_thread_id": "child-3"},
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


class TimeoutProcess:
    def __init__(self, *, kill_required: bool = False) -> None:
        self.kill_required = kill_required
        self.returncode = -15
        self.communicate_calls: list[float | None] = []
        self.terminated = False
        self.killed = False

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        self.communicate_calls.append(timeout)
        if len(self.communicate_calls) == 1:
            raise subprocess.TimeoutExpired("codex", timeout, output="prefix", stderr="prefix-error")
        if self.kill_required and len(self.communicate_calls) == 2:
            raise subprocess.TimeoutExpired("codex", timeout, output="grace-prefix", stderr="grace-error")
        self.returncode = -9 if self.kill_required else -15
        return "authoritative-out", "authoritative-err"

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True


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

    def test_command_uses_validated_model_and_skips_git_check(self) -> None:
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))

        CodexRuntime(
            binary="/real/codex",
            model="gpt-test",
            runner=runner,
            nonce_factory=lambda: "nonce-1",
        ).execute(plan())

        self.assertEqual(runner.command[runner.command.index("-m") + 1], "gpt-test")
        self.assertIn("--skip-git-repo-check", runner.command)
        with self.assertRaises(ValueError):
            CodexRuntime(model="  ")

    def test_binary_lookup_uses_only_the_documented_chatgpt_bundle_before_path(self) -> None:
        self.assertEqual(_CHATGPT_CODEX_PATHS, ("/Applications/ChatGPT.app/Contents/Resources/codex",))

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
                            "status": "completed",
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

    def test_synthesis_must_repeat_every_participant_marker(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        final = json.loads(events[-1]["item"]["text"])
        final["synthesis"] = "The contributors agree on a bounded result."
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

    def test_transient_json_error_does_not_override_success_and_stderr_is_tailed(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        events.insert(1, {"type": "error", "message": "Reconnecting"})
        stderr = "x" * 1_001 + "y" * 4_000
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), stderr, False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(result.runtime_evidence["stderr"], "y" * 4_000)

    def test_final_message_requires_exact_structured_outputs(self) -> None:
        malformed = "\n".join(
            json.dumps(event)
            for event in (
                {"type": "thread.started", "thread_id": "thread-root"},
                {"type": "turn.completed", "usage": {}},
                {"type": "item.completed", "item": {"type": "agent_message", "text": "not json"}},
            )
        )
        runner = RecordingRunner(ProcessOutcome(0, malformed, "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner).execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "invalid_structured_output")

    def test_acceptance_requires_completed_root_lifecycle(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        runner = RecordingRunner(
            ProcessOutcome(0, "\n".join(json.dumps(event) for event in events if event["type"] != "turn.completed"), "", False)
        )

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "incomplete_codex_lifecycle")

    def test_marker_text_does_not_prove_native_spawning(self) -> None:
        events = success_jsonl(markers_for("nonce-1")).splitlines()
        no_spawn_events = "\n".join(line for line in events if "collaboration.agent.spawned" not in line)
        runner = RecordingRunner(ProcessOutcome(0, no_spawn_events, "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_unrelated_agent_thread_ids_do_not_prove_or_pad_native_spawns(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        events = [event for event in events if event.get("agent_thread_id") != "child-3"]
        events.insert(4, {"type": "turn.progress", "agent_thread_id": "unrelated-thread"})
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_duplicate_native_child_id_fails_closed(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        events.insert(4, {"type": "collaboration.agent.spawned", "agent_thread_id": "child-1"})
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_nonroot_spawn_sender_fails_closed(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        events.insert(
            4,
            {
                "type": "collaboration.agent.spawned",
                "sender_thread_id": "child-1",
                "agent_thread_id": "child-4",
            },
        )
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_one_participant_plan_rejects_any_spawn_evidence(self) -> None:
        single_participant_plan = replace(plan(), participants=plan().participants[:1])
        marker = "[[sharednet:nonce-1:root]]"
        final = {
            "synthesis": f"The root completed the task. {marker}",
            "outputs": [{"candidate_id": "root", "marker": marker, "content": "Root finding."}],
        }
        events = (
            {"type": "thread.started", "thread_id": "thread-root"},
            {
                "type": "collaboration.agent.spawned",
                "sender_thread_id": "thread-root",
                "agent_thread_id": "unexpected-child",
            },
            {"type": "turn.completed", "usage": {}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(final)}},
        )
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(single_participant_plan)

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_senderless_spawn_event_cannot_prove_root_authorship(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        for event in events:
            event.pop("sender_thread_id", None)
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

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

    def test_oversized_capture_fails_before_json_parsing(self) -> None:
        runner = RecordingRunner(ProcessOutcome(0, "x" * 40, "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, max_capture_bytes=32).execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "codex_output_too_large")

    def test_artifact_paths_are_collision_safe(self) -> None:
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "diagnostic", False))
        with tempfile.TemporaryDirectory() as directory:
            runtime = CodexRuntime(
                binary="/real/codex",
                runner=runner,
                nonce_factory=lambda: "nonce-1",
                artifact_dir=directory,
            )
            first = runtime.execute(plan())
            second = runtime.execute(plan())

            self.assertNotEqual(first.runtime_evidence["stdout_artifact"], second.runtime_evidence["stdout_artifact"])
            self.assertEqual(len(list(Path(directory).iterdir())), 4)

    def test_default_runner_uses_authoritative_output_after_terminate(self) -> None:
        process = TimeoutProcess()
        with patch("sharednet.runtime.codex.subprocess.Popen", return_value=process):
            outcome = _default_runner(["codex"], 1.0)

        self.assertTrue(process.terminated)
        self.assertFalse(process.killed)
        self.assertEqual(outcome.stdout, "authoritative-out")
        self.assertEqual(outcome.stderr, "authoritative-err")
        self.assertTrue(outcome.timed_out)

    def test_default_runner_kills_after_terminate_grace_timeout(self) -> None:
        process = TimeoutProcess(kill_required=True)
        with patch("sharednet.runtime.codex.subprocess.Popen", return_value=process):
            outcome = _default_runner(["codex"], 1.0)

        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertEqual(outcome.stdout, "authoritative-out")
        self.assertEqual(outcome.stderr, "authoritative-err")


if __name__ == "__main__":
    unittest.main()
