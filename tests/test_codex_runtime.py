"""Unit tests for the bounded Codex JSONL runtime adapter."""

from __future__ import annotations

import json
from dataclasses import replace
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings
from unittest.mock import patch

from sharednet.coordination.models import CoordinationBudget, CoordinationPlan, ParticipantPlan, TerminalStatus
from sharednet.coordination.backends import PeerForumBackend
from sharednet.runtime.codex import (
    CodexRuntime,
    ProcessOutcome,
    _CHATGPT_CODEX_PATHS,
    _default_runner,
    build_codex_prompt,
    parse_codex_events,
)
from tests.fixtures import four_agent_request


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
        runtime_instructions={
            "goal": "Produce a bounded synthesis.",
            "task": {
                "task_id": "runtime-task",
                "goal": "Produce a bounded synthesis.",
                "required_capabilities": ["analysis"],
                "acceptance_criteria": ["Ground every participant finding in the supplied record."],
                "input_data": {"records": [{"id": "REC-1", "fact": "A bounded runtime fact."}]},
            },
        },
        budget=CoordinationBudget(max_participants=4),
    )


def markers_for(nonce: str, target_plan: CoordinationPlan | None = None) -> list[str]:
    selected_plan = target_plan or plan()
    return [f"[[sharednet:{nonce}:{candidate_id}]]" for candidate_id in selected_plan.participant_ids]


def expected_child_spawn_prompt(
    target_plan: CoordinationPlan,
    participant: ParticipantPlan,
    marker: str,
) -> str:
    """Mirror the complete provider-boundary payload used by a native child."""
    runtime_instructions = target_plan.to_dict()["runtime_instructions"]
    task = runtime_instructions.get("task")
    if not isinstance(task, dict):
        task = {"task_id": target_plan.task_id, "runtime_instructions": runtime_instructions}
    return json.dumps(
        {
            "task": task,
            "participant": {
                "candidate_id": participant.candidate_id,
                "role": participant.role,
                "assignment": participant.assignment,
                "capabilities": list(participant.capabilities),
            },
            "marker": marker,
            "response_contract": {
                "format": "marker-first-line-then-content",
                "content": (
                    "Complete the assigned work, satisfy every task acceptance criterion, and ground a nonempty "
                    "contribution in the task payload."
                ),
            },
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def success_events(markers: list[str], target_plan: CoordinationPlan | None = None) -> list[dict[str, object]]:
    selected_plan = target_plan or plan()
    participant_ids = selected_plan.participant_ids
    if len(markers) != len(participant_ids):
        raise ValueError("one marker is required for every participant")
    final = {
        "synthesis": "The contributors agree on a bounded result. " + " ".join(markers),
        "outputs": [
            {"candidate_id": participant_id, "marker": marker, "content": f"Finding from {participant_id}."}
            for participant_id, marker in zip(participant_ids, markers)
        ],
    }
    child_ids = tuple(f"child-{index}" for index in range(1, len(participant_ids)))
    events: list[dict[str, object]] = [{"type": "thread.started", "thread_id": "thread-root"}]
    for index, (child_id, participant, marker) in enumerate(
        zip(child_ids, selected_plan.participants[1:], markers[1:]),
        start=1,
    ):
        prompt = expected_child_spawn_prompt(selected_plan, participant, marker)
        item = {
            "id": f"spawn-{index}",
            "type": "collab_tool_call",
            "tool": "spawn_agent",
            "sender_thread_id": "thread-root",
            "receiver_thread_ids": [child_id],
            "prompt": prompt,
            "agents_states": {child_id: {"status": "pending_init", "message": None}},
        }
        events.append({"type": "item.started", "item": {**item, "receiver_thread_ids": [], "agents_states": {}, "status": "in_progress"}})
        events.append({"type": "item.completed", "item": {**item, "status": "completed"}})

    if child_ids:
        events.append(
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "Workers are running; waiting for completed results."},
            }
        )
    wait_groups = (child_ids[:1], child_ids[1:]) if len(child_ids) > 1 else (child_ids,)
    contribution_by_child = {
        child_id: (marker, f"Finding from {participant.candidate_id}.")
        for child_id, participant, marker in zip(child_ids, selected_plan.participants[1:], markers[1:])
    }
    for index, group in enumerate(wait_groups, start=1):
        if not group:
            continue
        item = {
            "id": f"wait-{index}",
            "type": "collab_tool_call",
            "tool": "wait",
            "sender_thread_id": "thread-root",
            "receiver_thread_ids": list(group),
            "prompt": None,
        }
        started_receivers = child_ids if index == 1 else group
        events.append(
            {
                "type": "item.started",
                "item": {
                    **item,
                    "receiver_thread_ids": list(started_receivers),
                    "agents_states": {},
                    "status": "in_progress",
                },
            }
        )
        events.append(
            {
                "type": "item.completed",
                "item": {
                    **item,
                    "agents_states": {
                        child_id: {
                            "status": "completed",
                            "message": "\n".join(contribution_by_child[child_id]),
                        }
                        for child_id in group
                    },
                    "status": "completed",
                },
            }
        )
        if index == 1 and len(wait_groups) > 1:
            events.append(
                {
                    "type": "item.completed",
                    "item": {"type": "agent_message", "text": "One worker completed; waiting for the remaining workers."},
                }
            )
    events.extend(
        (
            {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(final)}},
            {"type": "turn.completed", "usage": {"input_tokens": 100, "output_tokens": 40}},
        )
    )
    return events


def structured_final_event(events: list[dict[str, object]]) -> dict[str, object]:
    return next(
        event
        for event in reversed(events)
        if isinstance(event.get("item"), dict) and event["item"].get("type") == "agent_message"
    )


def success_jsonl(markers: list[str], target_plan: CoordinationPlan | None = None) -> str:
    events = success_events(markers, target_plan)
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


class ManualClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class SequenceClock:
    def __init__(self, values: list[float]) -> None:
        self._values = iter(values)

    def __call__(self) -> float:
        return next(self._values)


class DeadlineProcess(TimeoutProcess):
    def __init__(self, clock: ManualClock, *, first_elapsed: float, terminate_elapsed: float = 0.0) -> None:
        super().__init__()
        self.clock = clock
        self.first_elapsed = first_elapsed
        self.terminate_elapsed = terminate_elapsed

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        self.communicate_calls.append(timeout)
        if len(self.communicate_calls) == 1:
            self.clock.advance(self.first_elapsed)
            raise subprocess.TimeoutExpired("codex", timeout, output="prefix", stderr="prefix-error")
        if not self.killed:
            self.clock.advance(self.terminate_elapsed)
            if timeout is not None and self.terminate_elapsed > timeout:
                raise subprocess.TimeoutExpired("codex", timeout, output="term-prefix", stderr="term-error")
        return "authoritative-out", "authoritative-err"


class SuccessfulProcess:
    def __init__(self, stdout: str) -> None:
        self.returncode = 0
        self.stdout = stdout
        self.communicate_calls: list[float | None] = []

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        self.communicate_calls.append(timeout)
        return self.stdout, ""


class ByteProcess:
    def __init__(self, stdout: bytes, stderr: bytes, *, returncode: int = 0) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
        return self.stdout, self.stderr


class FakePipe:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class KillCleanupProcess:
    def __init__(self) -> None:
        self.returncode: int | None = None
        self.stdout = FakePipe()
        self.stderr = FakePipe()
        self.communicate_calls: list[float | None] = []
        self.wait_calls: list[float | None] = []
        self.reaped = threading.Event()
        self.terminated = False
        self.killed = False

    def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
        self.communicate_calls.append(timeout)
        raise subprocess.TimeoutExpired("codex", timeout, output=b"partial-out", stderr=b"partial-err")

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls.append(timeout)
        self.returncode = -9
        self.reaped.set()
        return self.returncode


class BlockingReapProcess(KillCleanupProcess):
    def __init__(self) -> None:
        super().__init__()
        self.wait_started = threading.Event()
        self.release_wait = threading.Event()

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls.append(timeout)
        self.wait_started.set()
        self.release_wait.wait(2.0)
        self.returncode = -9
        self.reaped.set()
        return self.returncode


class NoParseText(str):
    def splitlines(self, keepends: bool = False):
        raise AssertionError("oversized process output must not be parsed")


class CodexRuntimeTests(unittest.TestCase):
    def test_execute_until_preserves_the_caller_deadline_after_handoff_delay(self) -> None:
        clock = ManualClock()
        clock.advance(4)
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))

        def nonce_after_two_more_seconds() -> str:
            clock.advance(2)
            return "nonce-1"

        runtime = CodexRuntime(
            binary="/real/codex",
            runner=runner,
            nonce_factory=nonce_after_two_more_seconds,
            clock=clock,
        )
        self.assertTrue(hasattr(runtime, "execute_until"))
        result = runtime.execute_until(plan(), monotonic_deadline=10.0)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runner.timeout, 4.0)

    def test_execute_until_never_widens_the_plan_wall_budget(self) -> None:
        clock = ManualClock()
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))

        def nonce_after_four_seconds() -> str:
            clock.advance(4)
            return "nonce-1"

        timed_plan = replace(plan(), budget=replace(plan().budget, max_wall_seconds=10))
        runtime = CodexRuntime(
            binary="/real/codex",
            runner=runner,
            nonce_factory=nonce_after_four_seconds,
            clock=clock,
        )
        self.assertTrue(hasattr(runtime, "execute_until"))
        result = runtime.execute_until(timed_plan, monotonic_deadline=100.0)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runner.timeout, 6.0)

    def test_execute_until_does_not_launch_when_the_caller_deadline_has_arrived(self) -> None:
        clock = ManualClock()
        clock.advance(10)
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))
        runtime = CodexRuntime(
            binary="/real/codex",
            runner=runner,
            nonce_factory=lambda: "nonce-1",
            clock=clock,
        )

        result = runtime.execute_until(plan(), monotonic_deadline=10.0)

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "codex_exec_timeout")
        self.assertEqual(result.runtime_evidence["timeout_phase"], "setup")
        self.assertEqual(runner.command, [])

    def test_setup_time_reduces_the_relative_allowance_passed_to_the_runner(self) -> None:
        clock = ManualClock()
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))

        def nonce_after_four_seconds() -> str:
            clock.advance(4)
            return "nonce-1"

        timed_plan = replace(plan(), budget=replace(plan().budget, max_wall_seconds=10))
        with patch("sharednet.runtime.codex.time.monotonic", clock):
            result = CodexRuntime(
                binary="/real/codex",
                runner=runner,
                nonce_factory=nonce_after_four_seconds,
            ).execute(timed_plan)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runner.timeout, 6.0)

    def test_setup_exhaustion_returns_typed_timeout_without_launching_runner(self) -> None:
        clock = ManualClock()
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))

        def nonce_at_deadline() -> str:
            clock.advance(10)
            return "nonce-1"

        timed_plan = replace(plan(), budget=replace(plan().budget, max_wall_seconds=10))
        with patch("sharednet.runtime.codex.time.monotonic", clock):
            result = CodexRuntime(
                binary="/real/codex",
                runner=runner,
                nonce_factory=nonce_at_deadline,
            ).execute(timed_plan)

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "codex_exec_timeout")
        self.assertEqual(result.runtime_evidence, {"timed_out": True, "timeout_phase": "setup"})
        self.assertEqual(runner.command, [])
        self.assertIsNone(runner.timeout)

    def test_default_runner_uses_the_runtime_deadline_remainder(self) -> None:
        clock = ManualClock()
        process = SuccessfulProcess(success_jsonl(markers_for("nonce-1")))

        def nonce_after_four_seconds() -> str:
            clock.advance(4)
            return "nonce-1"

        timed_plan = replace(plan(), budget=replace(plan().budget, max_wall_seconds=10))
        with (
            patch("sharednet.runtime.codex.time.monotonic", clock),
            patch("sharednet.runtime.codex.subprocess.Popen", return_value=process),
        ):
            result = CodexRuntime(
                binary="/real/codex",
                nonce_factory=nonce_after_four_seconds,
            ).execute(timed_plan)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(process.communicate_calls, [6.0])

    def test_default_runner_does_not_restart_deadline_during_runtime_handoff(self) -> None:
        clock = SequenceClock([0.0, 4.0, 5.0, 5.0])
        process = SuccessfulProcess(success_jsonl(markers_for("nonce-1")))
        timed_plan = replace(plan(), budget=replace(plan().budget, max_wall_seconds=10))
        with patch("sharednet.runtime.codex.subprocess.Popen", return_value=process):
            result = CodexRuntime(
                binary="/real/codex",
                nonce_factory=lambda: "nonce-1",
                clock=clock,
            ).execute(timed_plan)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(process.communicate_calls, [5.0])

    def test_deadline_exhaustion_at_default_runner_handoff_does_not_launch(self) -> None:
        clock = SequenceClock([0.0, 4.0, 10.0])
        launches: list[list[str]] = []

        def record_launch(command, **kwargs):
            launches.append(command)
            return SuccessfulProcess(success_jsonl(markers_for("nonce-1")))

        timed_plan = replace(plan(), budget=replace(plan().budget, max_wall_seconds=10))
        with patch("sharednet.runtime.codex.subprocess.Popen", side_effect=record_launch):
            result = CodexRuntime(
                binary="/real/codex",
                nonce_factory=lambda: "nonce-1",
                clock=clock,
            ).execute(timed_plan)

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "codex_exec_timeout")
        self.assertEqual(launches, [])

    def test_command_places_global_safety_flags_before_exec(self) -> None:
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))

        CodexRuntime(
            binary="/real/codex",
            runner=runner,
            nonce_factory=lambda: "nonce-1",
            clock=ManualClock(),
        ).execute(plan())

        self.assertEqual(
            runner.command[:7],
            ["/real/codex", "--enable", "multi_agent", "-a", "never", "-s", "read-only"],
        )
        self.assertEqual(runner.command[7], "exec")
        self.assertIn("--ephemeral", runner.command)
        self.assertIn("--ignore-user-config", runner.command)
        self.assertIn("--json", runner.command)
        self.assertEqual(runner.command[runner.command.index("--color") + 1], "never")
        self.assertEqual(runner.timeout, 300.0)

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

    def test_configured_relative_binary_is_resolved_before_runtime_cwd_changes(self) -> None:
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))

        CodexRuntime(
            binary="./tools/codex",
            runner=runner,
            nonce_factory=lambda: "nonce-1",
        ).execute(plan())

        self.assertEqual(runner.command[0], str((Path.cwd() / "tools" / "codex").resolve()))

    def test_environment_relative_binary_is_resolved_but_bare_path_name_is_preserved(self) -> None:
        relative_runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))
        with patch.dict(os.environ, {"SHAREDNET_CODEX_BINARY": "relative/codex"}):
            CodexRuntime(runner=relative_runner, nonce_factory=lambda: "nonce-1").execute(plan())

        bare_runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers_for("nonce-1")), "", False))
        CodexRuntime(binary="codex", runner=bare_runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(relative_runner.command[0], str((Path.cwd() / "relative" / "codex").resolve()))
        self.assertEqual(bare_runner.command[0], "codex")

    def test_binary_lookup_uses_only_the_documented_chatgpt_bundle_before_path(self) -> None:
        self.assertEqual(_CHATGPT_CODEX_PATHS, ("/Applications/ChatGPT.app/Contents/Resources/codex",))

    def test_parser_collects_thread_usage_final_message_and_subagents(self) -> None:
        evidence = parse_codex_events(success_jsonl(markers_for("nonce-1")))

        self.assertEqual(evidence.thread_id, "thread-root")
        self.assertEqual(evidence.spawned_agent_ids, ("child-1", "child-2", "child-3"))
        self.assertEqual(getattr(evidence, "completed_child_ids", ()), ("child-1", "child-2", "child-3"))
        self.assertEqual(evidence.usage["input_tokens"], 100)
        self.assertIn("nonce-1", evidence.final_message)
        self.assertEqual(evidence.raw_event_count, 15)

    def test_parser_retains_only_bounded_collaboration_diagnostics(self) -> None:
        evidence = parse_codex_events(success_jsonl(markers_for("nonce-1")))
        diagnostics = json.dumps(evidence.collaboration_events)

        self.assertNotIn("Your candidate_id", diagnostics)
        self.assertNotIn("Finding from child", diagnostics)
        self.assertLess(len(diagnostics), 4_000)

    def test_nonblank_malformed_or_non_object_jsonl_fails_closed_without_payload_retention(self) -> None:
        for malformed_line in ("injected-secret-not-json", "[]", '"injected-secret-scalar"'):
            with self.subTest(malformed_line=malformed_line):
                stdout = success_jsonl(markers_for("nonce-1")) + "\n" + malformed_line
                runner = RecordingRunner(ProcessOutcome(0, stdout, "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "malformed_codex_jsonl")
                self.assertEqual(result.runtime_evidence["malformed_record_count"], 1)
                self.assertFalse(result.runtime_evidence["malformed_records_truncated"])
                self.assertNotIn("injected-secret", json.dumps(result.to_dict()["runtime_evidence"]))

    def test_malformed_record_facts_are_bounded(self) -> None:
        stdout = success_jsonl(markers_for("nonce-1")) + "\n" + "\n".join(
            f"private-malformed-payload-{index}" for index in range(300)
        )
        runner = RecordingRunner(ProcessOutcome(0, stdout, "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.error, "malformed_codex_jsonl")
        self.assertEqual(result.runtime_evidence["malformed_record_count"], 128)
        self.assertTrue(result.runtime_evidence["malformed_records_truncated"])
        self.assertNotIn("private-malformed-payload", json.dumps(result.to_dict()["runtime_evidence"]))

    def test_blank_jsonl_lines_are_ignored(self) -> None:
        stdout = " \t\n" + success_jsonl(markers_for("nonce-1")).replace("\n", "\n\n") + "\n  "
        runner = RecordingRunner(ProcessOutcome(0, stdout, "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(result.runtime_evidence["malformed_record_count"], 0)
        self.assertFalse(result.runtime_evidence["malformed_records_truncated"])

    def test_missing_participant_marker_fails_closed(self) -> None:
        events = success_events(markers_for("nonce-1"))
        final_event = structured_final_event(events)
        final = json.loads(final_event["item"]["text"])
        final["outputs"] = final["outputs"][:-1]
        final_event["item"]["text"] = json.dumps(final)
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_participant_markers")

    def test_marker_must_belong_to_its_named_participant(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        final_event = structured_final_event(events)
        final = json.loads(final_event["item"]["text"])
        final["outputs"][0]["marker"], final["outputs"][1]["marker"] = (
            final["outputs"][1]["marker"],
            final["outputs"][0]["marker"],
        )
        final_event["item"]["text"] = json.dumps(final)
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_participant_markers")

    def test_synthesis_must_repeat_every_participant_marker(self) -> None:
        events = [json.loads(line) for line in success_jsonl(markers_for("nonce-1")).splitlines()]
        final_event = structured_final_event(events)
        final = json.loads(final_event["item"]["text"])
        final["synthesis"] = "The contributors agree on a bounded result."
        final_event["item"]["text"] = json.dumps(final)
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
                {"type": "item.completed", "item": {"type": "agent_message", "text": "not json"}},
                {"type": "turn.completed", "usage": {}},
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
        events = success_events(markers_for("nonce-1"))
        no_spawn_events = "\n".join(
            json.dumps(event)
            for event in events
            if not (isinstance(event.get("item"), dict) and event["item"].get("tool") == "spawn_agent")
        )
        runner = RecordingRunner(ProcessOutcome(0, no_spawn_events, "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_compatibility_event_names_cannot_prove_native_spawns(self) -> None:
        events = success_events(markers_for("nonce-1"))
        rewritten: list[dict[str, object]] = []
        for event in events:
            item = event.get("item")
            if isinstance(item, dict) and item.get("tool") == "spawn_agent":
                if event["type"] == "item.completed":
                    rewritten.append(
                        {
                            "type": "future.collaboration.agent.spawned",
                            "sender_thread_id": "thread-root",
                            "agent_thread_id": item["receiver_thread_ids"][0],
                        }
                    )
                continue
            rewritten.append(event)
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in rewritten), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)

    def test_unknown_top_level_event_fails_closed(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events.insert(-2, {"type": "turn.progress", "agent_thread_id": "unrelated-thread"})
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "disallowed_runtime_tool_evidence")

    def test_duplicate_native_child_id_fails_closed(self) -> None:
        events = success_events(markers_for("nonce-1"))
        duplicate = json.loads(json.dumps(events[2]))
        duplicate["item"]["id"] = "spawn-duplicate"
        events.insert(3, duplicate)
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_nonroot_spawn_sender_fails_closed(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events[2]["item"]["sender_thread_id"] = "child-1"
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
                "type": "item.started",
                "item": {
                    "id": "spawn-unplanned",
                    "type": "collab_tool_call",
                    "tool": "spawn_agent",
                    "sender_thread_id": "thread-root",
                    "receiver_thread_ids": [],
                    "prompt": "unplanned",
                    "agents_states": {},
                    "status": "in_progress",
                },
            },
            {
                "type": "item.completed",
                "item": {
                    "id": "spawn-unplanned",
                    "type": "collab_tool_call",
                    "tool": "spawn_agent",
                    "sender_thread_id": "thread-root",
                    "receiver_thread_ids": ["unexpected-child"],
                    "prompt": "unplanned",
                    "agents_states": {},
                    "status": "completed",
                },
            },
            {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(final)}},
            {"type": "turn.completed", "usage": {}},
        )
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(single_participant_plan)

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_senderless_spawn_event_cannot_prove_root_authorship(self) -> None:
        events = success_events(markers_for("nonce-1"))
        for event in events:
            item = event.get("item")
            if isinstance(item, dict) and item.get("tool") == "spawn_agent":
                item.pop("sender_thread_id", None)
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_completed_root_waits_must_cover_every_spawned_child(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events = [
            event
            for event in events
            if not (isinstance(event.get("item"), dict) and event["item"].get("tool") == "wait")
        ]
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_partial_wait_coverage_cannot_be_completed_by_root_final_output(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events = [
            event
            for event in events
            if not (isinstance(event.get("item"), dict) and event["item"].get("id") == "wait-2")
        ]
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_failed_wait_state_does_not_prove_child_completion(self) -> None:
        events = success_events(markers_for("nonce-1"))
        wait = next(event["item"] for event in events if isinstance(event.get("item"), dict) and event["type"] == "item.completed" and event["item"].get("id") == "wait-2")
        wait["agents_states"]["child-2"] = {"status": "failed", "message": "failed worker"}
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_child_must_return_the_marker_bound_by_its_spawn_prompt(self) -> None:
        events = success_events(markers_for("nonce-1"))
        wait = next(event["item"] for event in events if isinstance(event.get("item"), dict) and event["type"] == "item.completed" and event["item"].get("id") == "wait-2")
        wait["agents_states"]["child-2"]["message"] = "[[sharednet:nonce-1:child-c]] wrong child marker"
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")
        self.assertNotIn("child-2", result.runtime_evidence["contributing_child_ids"])

    def test_spawn_prompt_must_carry_the_complete_task_and_assigned_participant(self) -> None:
        events = success_events(markers_for("nonce-1"))
        incomplete_prompt = json.dumps(
            {
                "participant": {"candidate_id": "child-a"},
                "marker": "[[sharednet:nonce-1:child-a]]",
            }
        )
        for event in events:
            item = event.get("item")
            if isinstance(item, dict) and item.get("id") == "spawn-1":
                item["prompt"] = incomplete_prompt
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_spawn_prompt_json_must_preserve_value_types_and_reject_duplicate_keys(self) -> None:
        typed_plan = replace(
            plan(),
            runtime_instructions={
                **plan().to_dict()["runtime_instructions"],
                "task": {
                    **plan().to_dict()["runtime_instructions"]["task"],
                    "input_data": {"enabled": True},
                },
            },
        )
        for mutation in ("boolean_as_integer", "duplicate_marker"):
            with self.subTest(mutation=mutation):
                events = success_events(markers_for("nonce-1", typed_plan), typed_plan)
                for event in events:
                    item = event.get("item")
                    if not isinstance(item, dict) or item.get("id") != "spawn-1":
                        continue
                    prompt = item["prompt"]
                    if mutation == "boolean_as_integer":
                        payload = json.loads(prompt)
                        payload["task"]["input_data"]["enabled"] = 1
                        item["prompt"] = json.dumps(payload, sort_keys=True, separators=(",", ":"))
                    else:
                        marker = json.loads(prompt)["marker"]
                        item["prompt"] = f'{prompt[:-1]},"marker":{json.dumps(marker)}}}'
                runner = RecordingRunner(
                    ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False)
                )

                result = CodexRuntime(
                    binary="/real/codex",
                    runner=runner,
                    nonce_factory=lambda: "nonce-1",
                ).execute(typed_plan)

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_root_cannot_fabricate_a_worker_output_not_returned_by_that_child(self) -> None:
        events = success_events(markers_for("nonce-1"))
        final_event = structured_final_event(events)
        final = json.loads(final_event["item"]["text"])
        final["outputs"][1]["content"] = "Root-fabricated finding never returned by child-a."
        final_event["item"]["text"] = json.dumps(final)
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "unbound_child_output")
        binding = next(
            item for item in result.runtime_evidence["child_output_bindings"] if item["participant_id"] == "child-a"
        )
        self.assertFalse(binding["output_content_match"])

    def test_spawn_prompt_marker_binding_cannot_be_inferred_from_final_output(self) -> None:
        events = success_events(markers_for("nonce-1"))
        spawn = next(event["item"] for event in events if isinstance(event.get("item"), dict) and event["type"] == "item.completed" and event["item"].get("id") == "spawn-1")
        spawn["prompt"] = "Your exact marker is [[sharednet:nonce-1:child-b]]."
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_senderless_or_unplanned_wait_state_fails_closed(self) -> None:
        for mutation in ("senderless", "unplanned"):
            with self.subTest(mutation=mutation):
                events = success_events(markers_for("nonce-1"))
                wait = next(event["item"] for event in events if isinstance(event.get("item"), dict) and event["type"] == "item.completed" and event["item"].get("id") == "wait-1")
                if mutation == "senderless":
                    wait.pop("sender_thread_id")
                else:
                    wait["receiver_thread_ids"].append("unplanned-child")
                    wait["agents_states"]["unplanned-child"] = {
                        "status": "completed",
                        "message": "[[sharednet:nonce-1:child-a]] forged",
                    }
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_failed_in_progress_or_uncompleted_spawn_never_counts(self) -> None:
        for mutation in ("failed", "in_progress", "no_completion"):
            with self.subTest(mutation=mutation):
                events = success_events(markers_for("nonce-1"))
                completed_index = next(
                    index
                    for index, event in enumerate(events)
                    if isinstance(event.get("item"), dict)
                    and event["type"] == "item.completed"
                    and event["item"].get("id") == "spawn-1"
                )
                if mutation == "no_completion":
                    events.pop(completed_index)
                else:
                    events[completed_index]["item"]["status"] = mutation
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_completed_collaboration_requires_a_strictly_earlier_start(self) -> None:
        for mutation in ("completion_only", "completion_before_start"):
            with self.subTest(mutation=mutation):
                events = success_events(markers_for("nonce-1"))
                started_index = next(
                    index
                    for index, event in enumerate(events)
                    if isinstance(event.get("item"), dict)
                    and event["type"] == "item.started"
                    and event["item"].get("id") == "spawn-1"
                )
                started = events.pop(started_index)
                if mutation == "completion_before_start":
                    completed_index = next(
                        index
                        for index, event in enumerate(events)
                        if isinstance(event.get("item"), dict)
                        and event["type"] == "item.completed"
                        and event["item"].get("id") == "spawn-1"
                    )
                    events.insert(completed_index + 1, started)
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_started_and_completed_collaboration_shapes_must_match(self) -> None:
        for mutation in ("spawn_prompt", "wait_prompt", "wait_receiver_subset"):
            with self.subTest(mutation=mutation):
                events = success_events(markers_for("nonce-1"))
                if mutation == "spawn_prompt":
                    started = next(
                        event["item"]
                        for event in events
                        if isinstance(event.get("item"), dict)
                        and event["type"] == "item.started"
                        and event["item"].get("id") == "spawn-1"
                    )
                    started["prompt"] = "different prompt with [[sharednet:nonce-1:child-a]]"
                else:
                    started = next(
                        event["item"]
                        for event in events
                        if isinstance(event.get("item"), dict)
                        and event["type"] == "item.started"
                        and event["item"].get("id") == "wait-1"
                    )
                    if mutation == "wait_prompt":
                        started["prompt"] = "wait payload must be null"
                    else:
                        started["receiver_thread_ids"] = ["child-2", "child-3"]
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_wait_start_must_name_every_currently_pending_spawn_exactly_once(self) -> None:
        for mutation in ("unplanned", "duplicate", "already_completed", "partial", "spawn_after_wait"):
            with self.subTest(mutation=mutation):
                events = success_events(markers_for("nonce-1"))
                first_wait_index = next(
                    index
                    for index, event in enumerate(events)
                    if event["type"] == "item.started"
                    and isinstance(event.get("item"), dict)
                    and event["item"].get("id") == "wait-1"
                )
                first_wait = events[first_wait_index]["item"]
                if mutation == "unplanned":
                    first_wait["receiver_thread_ids"].append("unplanned-child")
                elif mutation == "duplicate":
                    first_wait["receiver_thread_ids"].append("child-1")
                elif mutation == "already_completed":
                    second_wait = next(
                        event["item"]
                        for event in events
                        if event["type"] == "item.started"
                        and isinstance(event.get("item"), dict)
                        and event["item"].get("id") == "wait-2"
                    )
                    second_wait["receiver_thread_ids"].append("child-1")
                elif mutation == "partial":
                    first_wait["receiver_thread_ids"].pop()
                else:
                    spawn_started = next(
                        event for event in events if event["type"] == "item.started" and event.get("item", {}).get("id") == "spawn-3"
                    )
                    spawn_completed = next(
                        event for event in events if event["type"] == "item.completed" and event.get("item", {}).get("id") == "spawn-3"
                    )
                    events.remove(spawn_started)
                    events.remove(spawn_completed)
                    events[first_wait_index:first_wait_index] = [spawn_started, spawn_completed]
                    moved_started = events.pop(first_wait_index)
                    moved_completed = events.pop(first_wait_index)
                    wait_completed_index = next(
                        index
                        for index, event in enumerate(events)
                        if event["type"] == "item.completed" and event.get("item", {}).get("id") == "wait-1"
                    )
                    events[wait_completed_index + 1:wait_completed_index + 1] = [moved_started, moved_completed]
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_completed_spawn_child_state_must_not_report_failure(self) -> None:
        for child_status in ("failed", "errored", "cancelled"):
            with self.subTest(child_status=child_status):
                events = success_events(markers_for("nonce-1"))
                spawn = next(
                    event["item"]
                    for event in events
                    if event["type"] == "item.completed"
                    and isinstance(event.get("item"), dict)
                    and event["item"].get("id") == "spawn-1"
                )
                spawn["agents_states"]["child-1"]["status"] = child_status
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_duplicate_start_or_completion_call_id_fails_closed(self) -> None:
        for event_type in ("item.started", "item.completed"):
            with self.subTest(event_type=event_type):
                events = success_events(markers_for("nonce-1"))
                source_index = next(
                    index
                    for index, event in enumerate(events)
                    if isinstance(event.get("item"), dict)
                    and event["type"] == event_type
                    and event["item"].get("id") == "spawn-1"
                )
                events.insert(source_index + 1, json.loads(json.dumps(events[source_index])))
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_each_child_may_complete_in_exactly_one_wait(self) -> None:
        events = success_events(markers_for("nonce-1"))
        wait_started = next(
            event["item"]
            for event in events
            if isinstance(event.get("item"), dict)
            and event["type"] == "item.started"
            and event["item"].get("id") == "wait-2"
        )
        wait_completed = next(
            event["item"]
            for event in events
            if isinstance(event.get("item"), dict)
            and event["type"] == "item.completed"
            and event["item"].get("id") == "wait-2"
        )
        wait_started["receiver_thread_ids"].append("child-1")
        wait_completed["receiver_thread_ids"].append("child-1")
        wait_completed["agents_states"]["child-1"] = {
            "status": "completed",
            "message": "[[sharednet:nonce-1:child-a]] duplicate completion",
        }
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_native_spawn_evidence")

    def test_final_message_and_turn_must_follow_all_collaboration_proof(self) -> None:
        for mutation in ("final_before_collaboration", "turn_before_final", "duplicate_turn"):
            with self.subTest(mutation=mutation):
                events = success_events(markers_for("nonce-1"))
                if mutation == "final_before_collaboration":
                    events = [
                        event
                        for event in events
                        if not (
                            isinstance(event.get("item"), dict)
                            and event["item"].get("type") == "agent_message"
                            and not event["item"].get("text", "").startswith("{")
                        )
                    ]
                    final_event = structured_final_event(events)
                    events.remove(final_event)
                    events.insert(1, final_event)
                elif mutation == "turn_before_final":
                    final_index = events.index(structured_final_event(events))
                    turn_index = next(index for index, event in enumerate(events) if event["type"] == "turn.completed")
                    events[final_index], events[turn_index] = events[turn_index], events[final_index]
                else:
                    turn = next(event for event in events if event["type"] == "turn.completed")
                    events.append(json.loads(json.dumps(turn)))
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "incomplete_codex_lifecycle")

    def test_disallowed_data_tools_fail_closed_without_retaining_payloads(self) -> None:
        variants = (
            ("command_execution", {"command": "cat /private/customer-secret"}),
            ("file_change", {"changes": "private patch payload"}),
            ("shell_command", {"command": "printf private"}),
            ("web_search", {"query": "private query"}),
            ("mcp_tool_call", {"tool": "private_mcp", "arguments": "private args"}),
            ("file_read", {"path": "/private/customer-secret"}),
        )
        for item_type, payload in variants:
            with self.subTest(item_type=item_type):
                events = success_events(markers_for("nonce-1"))
                events.insert(-2, {"type": "item.completed", "item": {"id": "forbidden", "type": item_type, **payload}})
                runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

                result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

                self.assertEqual(result.status, TerminalStatus.FAILED)
                self.assertEqual(result.error, "disallowed_runtime_tool_evidence")
                diagnostic_text = json.dumps(result.to_dict()["runtime_evidence"]["disallowed_tool_events"])
                self.assertNotIn("customer-secret", diagnostic_text)
                for sensitive_payload in ("private patch payload", "printf private", "private query", "private args"):
                    self.assertNotIn(sensitive_payload, diagnostic_text)
                self.assertLess(len(diagnostic_text), 1_000)

    def test_unknown_function_call_fails_closed_under_event_allowlist(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events.insert(
            -2,
            {
                "type": "item.completed",
                "item": {
                    "id": "function-1",
                    "type": "function_call",
                    "name": "browser_navigate",
                    "arguments": {"url": "https://private.example"},
                },
            },
        )
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "disallowed_runtime_tool_evidence")
        self.assertNotIn("private.example", json.dumps(result.to_dict()["runtime_evidence"]["disallowed_tool_events"]))

    def test_observed_passive_error_items_remain_allowed(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events.insert(
            1,
            {
                "type": "item.completed",
                "item": {"id": "warning-1", "type": "error", "message": "passive provider warning"},
            },
        )
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)

    def test_observed_completed_reasoning_item_is_passive_and_not_retained(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events.insert(
            -2,
            {
                "type": "item.completed",
                "item": {"id": "reasoning-1", "type": "reasoning", "text": "private chain of thought"},
            },
        )
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertNotIn("private chain of thought", json.dumps(result.to_dict()["runtime_evidence"]))

    def test_started_reasoning_item_remains_disallowed(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events.insert(-2, {"type": "item.started", "item": {"id": "reasoning-1", "type": "reasoning"}})
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "disallowed_runtime_tool_evidence")

    def test_unplanned_collaboration_action_is_disallowed(self) -> None:
        events = success_events(markers_for("nonce-1"))
        events.insert(
            -2,
            {
                "type": "item.completed",
                "item": {
                    "id": "send-1",
                    "type": "collab_tool_call",
                    "tool": "send_input",
                    "sender_thread_id": "thread-root",
                    "receiver_thread_ids": ["child-1"],
                    "status": "completed",
                },
            },
        )
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "disallowed_runtime_tool_evidence")

    def test_tool_diagnostics_are_bounded_for_adversarial_transcripts(self) -> None:
        events = success_events(markers_for("nonce-1"))
        for index in range(300):
            events.insert(
                -2,
                {
                    "type": "item.completed",
                    "item": {
                        "id": f"forbidden-{index}",
                        "type": "command_execution",
                        "command": f"cat /private/secret-{index}",
                    },
                },
            )
        runner = RecordingRunner(ProcessOutcome(0, "\n".join(json.dumps(event) for event in events), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())
        runtime_evidence = result.to_dict()["runtime_evidence"]

        self.assertEqual(result.error, "disallowed_runtime_tool_evidence")
        self.assertLessEqual(len(runtime_evidence["disallowed_tool_events"]), 128)
        self.assertTrue(runtime_evidence["diagnostic_events_truncated"])

    def test_disallowed_tool_presence_survives_a_full_diagnostic_buffer(self) -> None:
        events: list[dict[str, object]] = [{"type": "thread.started", "thread_id": "thread-root"}]
        for index in range(128):
            events.append(
                {
                    "type": "item.started",
                    "item": {
                        "id": f"spawn-{index}",
                        "type": "collab_tool_call",
                        "tool": "spawn_agent",
                        "sender_thread_id": "thread-root",
                        "receiver_thread_ids": [],
                        "prompt": "bounded",
                        "agents_states": {},
                        "status": "in_progress",
                    },
                }
            )
        events.append(
            {
                "type": "item.completed",
                "item": {"id": "forbidden", "type": "command_execution", "command": "cat /private/secret"},
            }
        )

        evidence = parse_codex_events("\n".join(json.dumps(event) for event in events))

        self.assertTrue(getattr(evidence, "disallowed_tool_evidence_present", False))
        self.assertEqual(evidence.disallowed_tool_events, ())
        self.assertTrue(evidence.diagnostic_events_truncated)

    def test_one_participant_succeeds_without_spawn_or_wait_evidence(self) -> None:
        single_participant_plan = replace(plan(), participants=plan().participants[:1])
        markers = markers_for("nonce-1", single_participant_plan)
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers, single_participant_plan), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(single_participant_plan)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(result.runtime_evidence["spawned_agent_ids"], ())
        self.assertEqual(result.runtime_evidence["completed_child_ids"], ())

    def test_peer_forum_integrator_is_runtime_root_and_peers_are_children(self) -> None:
        peer_plan = PeerForumBackend().plan(four_agent_request(mechanism="peer-forum"))
        markers = markers_for("nonce-peer", peer_plan)
        runner = RecordingRunner(ProcessOutcome(0, success_jsonl(markers, peer_plan), "", False))

        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-peer").execute(peer_plan)

        self.assertEqual(peer_plan.participants[0].role, "integrator")
        self.assertEqual(peer_plan.participants[0].candidate_id, "self")
        self.assertTrue(all(participant.role == "peer" for participant in peer_plan.participants[1:]))
        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertIn("Represent participant zero (self) yourself", runner.command[-1])
        self.assertIn("exactly 3 parallel native spawn_agent calls", runner.command[-1])

    def test_prompt_instructs_root_to_spawn_exactly_the_nonroot_participants(self) -> None:
        prompt = build_codex_prompt(plan(), "nonce-1")

        self.assertIn("participant zero", prompt)
        self.assertIn("exactly 3 parallel native spawn_agent calls", prompt)
        self.assertIn("Wait for every child", prompt)
        self.assertIn("Do not use file, shell, or web tools", prompt)
        self.assertIn("Each planned participant consumes one reserved SharedNet turn", prompt)
        self.assertIn("Do not execute or spawn any unplanned participant or turn", prompt)
        self.assertIn("exactly that candidate's exact marker", prompt)
        self.assertIn("remove completed children from every later wait call", prompt)
        self.assertIn("Never wait on the same completed child twice", prompt)
        self.assertIn("[[sharednet:nonce-1:root]]", prompt)

    def test_prompt_materializes_the_runtime_task_fallback_for_direct_legacy_plans(self) -> None:
        legacy_plan = replace(plan(), runtime_instructions={"goal": "Legacy direct plan."})

        prompt = build_codex_prompt(legacy_plan, "nonce-1")
        payload = json.loads(prompt.split("Plan and required markers:\n", 1)[1])

        self.assertEqual(
            payload["plan"]["runtime_instructions"]["task"],
            {
                "task_id": legacy_plan.task_id,
                "runtime_instructions": {"goal": "Legacy direct plan."},
            },
        )

        runner = RecordingRunner(
            ProcessOutcome(0, success_jsonl(markers_for("nonce-1", legacy_plan), legacy_plan), "", False)
        )
        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(legacy_plan)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)

    def test_one_turn_prompt_never_directs_a_child_spawn(self) -> None:
        single_participant_plan = replace(
            plan(),
            participants=plan().participants[:1],
            budget=replace(plan().budget, max_turns=1, max_participants=1),
        )

        prompt = build_codex_prompt(single_participant_plan, "nonce-1")

        self.assertNotIn("spawn_agent calls", prompt)
        self.assertIn("Do not spawn any child", prompt)

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

    def test_timeout_dominates_oversize_without_parsing_or_persisting_payload(self) -> None:
        runner = RecordingRunner(ProcessOutcome(-15, NoParseText("x" * 40), "y" * 10, True))
        with tempfile.TemporaryDirectory() as directory:
            result = CodexRuntime(
                binary="/real/codex",
                runner=runner,
                artifact_dir=directory,
                max_capture_bytes=32,
            ).execute(plan())

            self.assertEqual(list(Path(directory).iterdir()), [])

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "codex_exec_timeout")
        self.assertEqual(
            result.runtime_evidence,
            {
                "exit_code": -15,
                "timed_out": True,
                "captured_bytes": 50,
                "max_capture_bytes": 32,
                "stdout_bytes": 40,
                "stderr_bytes": 10,
            },
        )

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

    def test_default_runner_uses_an_empty_ephemeral_working_directory_and_inherited_auth(self) -> None:
        observed: dict[str, object] = {}

        def launch(command: list[str], **kwargs: object) -> SuccessfulProcess:
            cwd = kwargs.get("cwd")
            observed["cwd"] = cwd
            observed["cwd_exists_during_launch"] = isinstance(cwd, str) and Path(cwd).is_dir()
            observed["cwd_entries_during_launch"] = sorted(os.listdir(cwd)) if isinstance(cwd, str) else None
            observed["env_was_overridden"] = "env" in kwargs
            return SuccessfulProcess("process output")

        with patch("sharednet.runtime.codex.subprocess.Popen", side_effect=launch):
            outcome = _default_runner(["codex"], 1.0)

        cwd = observed["cwd"]
        self.assertIsInstance(cwd, str)
        self.assertTrue(observed["cwd_exists_during_launch"])
        self.assertEqual(observed["cwd_entries_during_launch"], [])
        self.assertFalse(observed["env_was_overridden"])
        self.assertNotEqual(cwd, os.getcwd())
        self.assertFalse(Path(cwd).exists())
        self.assertEqual(outcome.stdout, "process output")

    def test_invalid_utf8_from_default_process_returns_typed_failure(self) -> None:
        process = ByteProcess(b"\xff", b"\xfe")
        with patch("sharednet.runtime.codex.subprocess.Popen", return_value=process):
            try:
                result = CodexRuntime(
                    binary="/real/codex",
                    nonce_factory=lambda: "nonce-1",
                    clock=ManualClock(),
                ).execute(plan())
            except (AttributeError, UnicodeError) as error:
                self.fail(f"invalid process bytes escaped as an untyped decoding failure: {error}")

        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "malformed_codex_jsonl")
        self.assertIn("\ufffd", result.runtime_evidence["stderr"])

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

    def test_default_runner_uses_only_deadline_remainder_for_termination_grace(self) -> None:
        clock = ManualClock()
        process = DeadlineProcess(clock, first_elapsed=2.0, terminate_elapsed=3.0)
        with patch("sharednet.runtime.codex.subprocess.Popen", return_value=process):
            outcome = _default_runner(["codex"], 5.0, clock=clock)

        self.assertEqual(process.communicate_calls, [5.0, 3.0])
        self.assertEqual(clock.now, 5.0)
        self.assertTrue(process.terminated)
        self.assertFalse(process.killed)
        self.assertTrue(outcome.timed_out)

    def test_default_runner_kills_without_extra_grace_when_deadline_is_spent(self) -> None:
        clock = ManualClock()
        process = DeadlineProcess(clock, first_elapsed=5.0)
        with patch("sharednet.runtime.codex.subprocess.Popen", return_value=process):
            outcome = _default_runner(["codex"], 5.0, clock=clock)

        self.assertEqual(clock.now, 5.0)
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertTrue(outcome.timed_out)

    def test_default_runner_reaps_killed_process_and_closes_pipes_after_cleanup_communicate_timeout(self) -> None:
        process = KillCleanupProcess()
        clock = ManualClock()
        with patch("sharednet.runtime.codex.subprocess.Popen", return_value=process):
            outcome = _default_runner(["codex"], 0.01, clock=clock, deadline=0.01)

        self.assertTrue(outcome.timed_out)
        self.assertEqual(outcome.stdout, "partial-out")
        self.assertEqual(outcome.stderr, "partial-err")
        self.assertTrue(process.killed)
        self.assertTrue(process.reaped.wait(1.0))
        self.assertEqual(process.wait_calls, [None])
        self.assertEqual(process.returncode, -9)
        self.assertEqual(process.communicate_calls[-1], 1.0)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)

    def test_default_runner_uses_timeout_exit_sentinel_while_background_reap_is_pending(self) -> None:
        process = BlockingReapProcess()
        clock = ManualClock()
        try:
            with patch("sharednet.runtime.codex.subprocess.Popen", return_value=process):
                outcome = _default_runner(["codex"], 0.01, clock=clock, deadline=0.01)

            self.assertTrue(process.wait_started.wait(1.0))
            self.assertTrue(outcome.timed_out)
            self.assertEqual(outcome.returncode, 124)
            self.assertEqual(process.wait_calls, [None])
            self.assertIsNone(process.returncode)
            self.assertTrue(process.stdout.closed)
            self.assertTrue(process.stderr.closed)
        finally:
            process.release_wait.set()
        self.assertTrue(process.reaped.wait(1.0))
        self.assertEqual(process.returncode, -9)

    def test_default_runner_reaps_a_real_short_lived_process_after_timeout(self) -> None:
        started = time.monotonic()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", ResourceWarning)
            outcome = _default_runner(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                0.02,
            )

        self.assertTrue(outcome.timed_out)
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertFalse([warning for warning in caught if issubclass(warning.category, ResourceWarning)])


if __name__ == "__main__":
    unittest.main()
