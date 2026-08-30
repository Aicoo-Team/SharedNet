"""A safe, JSONL-only adapter for bounded native Codex coordination."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
from typing import Any, Callable, Mapping, Sequence

from sharednet.coordination.models import AgentOutput, CoordinationPlan, CoordinationResult, TerminalStatus


_CHATGPT_CODEX_PATHS = (
    "/Applications/ChatGPT.app/Contents/Resources/codex",
)
_STDERR_LIMIT = 4_000
_TERMINATE_GRACE_SECONDS = 10.0
_DEFAULT_MODEL = "gpt-5.3-codex"
_DEFAULT_MAX_CAPTURE_BYTES = 1_000_000
_MAX_RETAINED_DIAGNOSTIC_EVENTS = 128
_MAX_RETAINED_PROOF_RECORDS = 128
_SUCCESSFUL_SPAWN_CHILD_STATES = frozenset({"pending_init", "in_progress", "running", "completed"})


class CodexUnavailable(RuntimeError):
    """Raised when no usable local Codex executable can be found."""


@dataclass(frozen=True)
class ProcessOutcome:
    """Captured outcome of one bounded subprocess invocation."""

    returncode: int
    stdout: str
    stderr: str
    timed_out: bool


@dataclass(frozen=True)
class CodexEventEvidence:
    """JSONL facts retained from a Codex execution transcript."""

    thread_id: str | None
    spawned_agent_ids: tuple[str, ...]
    completed_child_ids: tuple[str, ...]
    explicit_spawn_count: int
    final_message: str
    usage: Mapping[str, int | float]
    raw_event_count: int
    collaboration_events: tuple[Mapping[str, Any], ...]
    disallowed_tool_events: tuple[Mapping[str, Any], ...]
    spawn_bindings: tuple[tuple[str, str], ...]
    completed_child_messages: tuple[tuple[str, str, int], ...]
    root_thread_started: bool
    turn_completed: bool
    final_message_completed: bool
    final_message_index: int | None
    turn_completed_indices: tuple[int, ...]
    collaboration_completion_indices: tuple[int, ...]
    invalid_spawn_sender: bool
    invalid_collaboration_evidence: bool
    disallowed_tool_evidence_present: bool
    diagnostic_events_truncated: bool


@dataclass(frozen=True)
class _StartedCollaborationCall:
    tool: str
    sender_thread_id: str
    prompt: str | None
    receiver_thread_ids: tuple[str, ...]
    event_index: int


Runner = Callable[[list[str], float], ProcessOutcome]


def build_codex_prompt(plan: CoordinationPlan, nonce: str) -> str:
    """Build a data-only coordination request with unforgeable run markers."""
    participants = plan.participants
    if not participants:
        raise ValueError("Codex runtime requires at least one participant")
    if not isinstance(nonce, str) or not nonce:
        raise ValueError("nonce must be a nonempty string")

    markers = {participant.candidate_id: f"[[sharednet:{nonce}:{participant.candidate_id}]]" for participant in participants}
    root_id = participants[0].candidate_id
    child_count = len(participants) - 1
    payload = {"plan": plan.to_dict(), "markers": markers}
    spawn_instruction = (
        f"Issue exactly {child_count} parallel native spawn_agent calls for the remaining planned participants; "
        "do not delegate spawning to a child. Each spawn prompt must name exactly one remaining candidate and include "
        "exactly that candidate's exact marker, with no other participant marker. Wait for every child before replying. "
        "After each completed wait, remove completed children from every later wait call. "
        "Never wait on the same completed child twice. "
        if child_count
        else "Do not spawn any child. "
    )
    return (
        "You are the root coordinator for a bounded SharedNet smoke. "
        f"Represent participant zero ({root_id}) yourself. "
        f"{spawn_instruction}"
        "Each planned participant consumes one reserved SharedNet turn. "
        "Do not execute or spawn any unplanned participant or turn. "
        "Do not use file, shell, or web tools for this data-only smoke. "
        "Your final response must be a JSON object with exactly the keys `synthesis` and `outputs`. "
        "`synthesis` must be a string. `outputs` must contain one object for every planned participant, and each object "
        "must contain `candidate_id`, `marker`, and `content` strings. Preserve the exact marker assigned to each participant "
        "and include every exact participant marker in `synthesis`.\n\n"
        "Plan and required markers:\n"
        f"{json.dumps(payload, sort_keys=True, separators=(',', ':'))}"
    )


def parse_codex_events(stdout: str) -> CodexEventEvidence:
    """Parse exact Codex JSONL shapes into bounded facts and private proof inputs."""
    thread_id: str | None = None
    final_message = ""
    final_message_index: int | None = None
    usage: dict[str, int | float] = {}
    collaboration_events: list[Mapping[str, Any]] = []
    disallowed_tool_events: list[Mapping[str, Any]] = []
    spawn_bindings: list[tuple[str, str]] = []
    completed_child_messages: list[tuple[str, str, int]] = []
    started_collaboration_calls: dict[str, _StartedCollaborationCall] = {}
    completed_collaboration_calls: set[str] = set()
    completed_wait_child_ids: set[str] = set()
    successfully_spawned_child_ids: set[str] = set()
    wait_phase_started = False
    turn_completed_indices: list[int] = []
    collaboration_completion_indices: list[int] = []
    raw_event_count = 0
    root_thread_started = False
    final_message_completed = False
    invalid_spawn_sender = False
    invalid_collaboration_evidence = False
    disallowed_tool_evidence_present = False
    diagnostic_events_truncated = False

    for event_index, line in enumerate(stdout.splitlines()):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, Mapping):
            continue
        raw_event_count += 1
        event_type = _event_type(event)
        if thread_id is None and event_type == "thread.started":
            candidate_thread_id = _bounded_identifier(event.get("thread_id"))
            if candidate_thread_id is not None:
                thread_id = candidate_thread_id
                root_thread_started = True

        event_usage = event.get("usage") if event_type == "turn.completed" else None
        if isinstance(event_usage, Mapping):
            for key, value in event_usage.items():
                if isinstance(key, str) and isinstance(value, (int, float)) and not isinstance(value, bool):
                    usage[key] = usage.get(key, 0) + value
        if event_type == "turn.completed":
            turn_completed_indices.append(event_index)

        item = event.get("item")
        item_type = item.get("type", "") if isinstance(item, Mapping) and isinstance(item.get("type"), str) else ""
        tool = item.get("tool", "") if isinstance(item, Mapping) and isinstance(item.get("tool"), str) else ""
        disallowed = _disallowed_event_diagnostic(event_type, item_type, tool, item)
        if disallowed is not None:
            disallowed_tool_evidence_present = True
            if len(collaboration_events) + len(disallowed_tool_events) < _MAX_RETAINED_DIAGNOSTIC_EVENTS:
                disallowed_tool_events.append(disallowed)
            else:
                diagnostic_events_truncated = True

        if item_type == "collab_tool_call" and disallowed is None and isinstance(item, Mapping):
            if len(collaboration_events) + len(disallowed_tool_events) < _MAX_RETAINED_DIAGNOSTIC_EVENTS:
                collaboration_events.append(_collaboration_diagnostic(event_type, tool, item, thread_id))
            else:
                diagnostic_events_truncated = True
            call_id = _bounded_identifier(item.get("id"))
            sender_thread_id = _bounded_identifier(item.get("sender_thread_id"))
            status = item.get("status")
            sender_is_root = thread_id is not None and sender_thread_id == thread_id
            receiver_ids = _bounded_identifier_sequence(item.get("receiver_thread_ids"))
            prompt = item.get("prompt")
            states = item.get("agents_states")
            if not sender_is_root:
                invalid_collaboration_evidence = True
                if tool == "spawn_agent":
                    invalid_spawn_sender = True
            if call_id is None or event_type not in {"item.started", "item.completed"}:
                invalid_collaboration_evidence = True
                continue
            if event_type == "item.started":
                if (
                    status != "in_progress"
                    or call_id in started_collaboration_calls
                    or call_id in completed_collaboration_calls
                    or not sender_is_root
                    or receiver_ids is None
                    or not isinstance(states, Mapping)
                    or states
                ):
                    invalid_collaboration_evidence = True
                    continue
                if tool == "spawn_agent":
                    if wait_phase_started or not isinstance(prompt, str) or not prompt or receiver_ids:
                        invalid_collaboration_evidence = True
                        continue
                else:
                    wait_phase_started = True
                    pending_child_ids = successfully_spawned_child_ids - completed_wait_child_ids
                    if (
                        prompt is not None
                        or not receiver_ids
                        or len(receiver_ids) != len(set(receiver_ids))
                        or set(receiver_ids) != pending_child_ids
                    ):
                        invalid_collaboration_evidence = True
                        continue
                started_collaboration_calls[call_id] = _StartedCollaborationCall(
                    tool=tool,
                    sender_thread_id=sender_thread_id,
                    prompt=prompt,
                    receiver_thread_ids=receiver_ids,
                    event_index=event_index,
                )
                continue
            collaboration_completion_indices.append(event_index)
            if call_id in completed_collaboration_calls:
                invalid_collaboration_evidence = True
                continue
            completed_collaboration_calls.add(call_id)
            started_call = started_collaboration_calls.get(call_id)
            if (
                status != "completed"
                or not sender_is_root
                or started_call is None
                or started_call.event_index >= event_index
                or started_call.tool != tool
                or started_call.sender_thread_id != sender_thread_id
            ):
                invalid_collaboration_evidence = True
                continue
            if tool == "spawn_agent":
                state_ids = _bounded_identifier_sequence(list(states.keys())) if isinstance(states, Mapping) else None
                child_state = states.get(receiver_ids[0]) if receiver_ids is not None and len(receiver_ids) == 1 and isinstance(states, Mapping) else None
                child_status = child_state.get("status") if isinstance(child_state, Mapping) else None
                if (
                    wait_phase_started
                    or receiver_ids is None
                    or len(receiver_ids) != 1
                    or not isinstance(prompt, str)
                    or prompt != started_call.prompt
                    or state_ids is None
                    or set(state_ids) != set(receiver_ids)
                    or child_status not in _SUCCESSFUL_SPAWN_CHILD_STATES
                ):
                    invalid_collaboration_evidence = True
                    continue
                if len(spawn_bindings) >= _MAX_RETAINED_PROOF_RECORDS:
                    invalid_collaboration_evidence = True
                    continue
                spawn_bindings.append((receiver_ids[0], prompt))
                successfully_spawned_child_ids.add(receiver_ids[0])
                continue

            if (
                prompt is not None
                or started_call.prompt is not None
                or receiver_ids is None
                or not receiver_ids
                or not set(receiver_ids).issubset(set(started_call.receiver_thread_ids))
                or not isinstance(states, Mapping)
            ):
                invalid_collaboration_evidence = True
                continue
            state_ids = _bounded_identifier_sequence(list(states.keys()))
            if state_ids is None or set(state_ids) != set(receiver_ids):
                invalid_collaboration_evidence = True
                continue
            for child_id in receiver_ids:
                state = states.get(child_id)
                child_status = state.get("status") if isinstance(state, Mapping) else None
                child_message = state.get("message") if isinstance(state, Mapping) else None
                if child_status != "completed" or not isinstance(child_message, str) or not child_message:
                    invalid_collaboration_evidence = True
                    continue
                if child_id in completed_wait_child_ids:
                    invalid_collaboration_evidence = True
                    continue
                if len(completed_child_messages) >= _MAX_RETAINED_PROOF_RECORDS:
                    invalid_collaboration_evidence = True
                    continue
                completed_wait_child_ids.add(child_id)
                completed_child_messages.append((child_id, child_message, event_index))

        message = _agent_message(event)
        if message is not None:
            final_message = message
            final_message_completed = True
            final_message_index = event_index

    if set(started_collaboration_calls) - completed_collaboration_calls:
        invalid_collaboration_evidence = True
    raw_spawned_agent_ids = [child_id for child_id, _ in spawn_bindings if child_id != thread_id]
    spawned_agent_ids = tuple(dict.fromkeys(raw_spawned_agent_ids))
    completed_child_ids = tuple(child_id for child_id, _, _ in completed_child_messages)
    return CodexEventEvidence(
        thread_id=thread_id,
        spawned_agent_ids=spawned_agent_ids,
        completed_child_ids=completed_child_ids,
        explicit_spawn_count=len(raw_spawned_agent_ids),
        final_message=final_message,
        usage=usage,
        raw_event_count=raw_event_count,
        collaboration_events=tuple(collaboration_events),
        disallowed_tool_events=tuple(disallowed_tool_events),
        spawn_bindings=tuple(spawn_bindings),
        completed_child_messages=tuple(completed_child_messages),
        root_thread_started=root_thread_started,
        turn_completed=bool(turn_completed_indices),
        final_message_completed=final_message_completed,
        final_message_index=final_message_index,
        turn_completed_indices=tuple(turn_completed_indices),
        collaboration_completion_indices=tuple(collaboration_completion_indices),
        invalid_spawn_sender=invalid_spawn_sender,
        invalid_collaboration_evidence=invalid_collaboration_evidence,
        disallowed_tool_evidence_present=disallowed_tool_evidence_present,
        diagnostic_events_truncated=diagnostic_events_truncated,
    )


class CodexRuntime:
    """Execute one plan through native Codex with no ambient user configuration."""

    def __init__(
        self,
        *,
        binary: str | None = None,
        model: str = _DEFAULT_MODEL,
        runner: Runner | None = None,
        nonce_factory: Callable[[], str] | None = None,
        artifact_dir: str | Path | None = None,
        max_capture_bytes: int = _DEFAULT_MAX_CAPTURE_BYTES,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if not isinstance(model, str) or not model.strip():
            raise ValueError("model must be a nonempty string")
        if isinstance(max_capture_bytes, bool) or not isinstance(max_capture_bytes, int) or max_capture_bytes <= 0:
            raise ValueError("max_capture_bytes must be a positive integer")
        self._configured_binary = binary
        self._model = model
        self._clock = clock if clock is not None else time.monotonic
        self._runner = runner
        self._nonce_factory = nonce_factory or (lambda: secrets.token_urlsafe(18))
        self._artifact_dir = Path(artifact_dir) if artifact_dir is not None else None
        self._max_capture_bytes = max_capture_bytes

    def availability(self) -> bool:
        """Return whether a resolved binary answers one cheap version request."""
        try:
            binary = self._resolve_binary()
            if self._runner is None:
                outcome = _default_runner([binary, "--version"], 10.0, clock=self._clock)
            else:
                outcome = self._runner([binary, "--version"], 10.0)
        except (CodexUnavailable, OSError):
            return False
        return outcome.returncode == 0 and not outcome.timed_out

    def execute(self, plan: CoordinationPlan) -> CoordinationResult:
        """Execute a plan once and return typed, attributable evidence."""
        deadline = self._clock() + float(plan.budget.max_wall_seconds)
        try:
            binary = self._resolve_binary()
        except CodexUnavailable:
            if self._clock() >= deadline:
                return self._setup_timeout(plan)
            return self._failure(plan, "codex_unavailable")

        nonce = self._nonce_factory()
        prompt = build_codex_prompt(plan, nonce)
        command = self._command(binary, prompt)
        remaining_wall_seconds = deadline - self._clock()
        if remaining_wall_seconds <= 0:
            return self._setup_timeout(plan)
        try:
            if self._runner is None:
                outcome = _default_runner(
                    command,
                    remaining_wall_seconds,
                    clock=self._clock,
                    deadline=deadline,
                )
            else:
                outcome = self._runner(command, remaining_wall_seconds)
        except OSError as error:
            return self._failure(plan, "codex_exec_os_error", stderr=str(error))

        stdout_bytes = len(outcome.stdout.encode("utf-8"))
        stderr_bytes = len(outcome.stderr.encode("utf-8"))
        capture_bytes = stdout_bytes + stderr_bytes
        if capture_bytes > self._max_capture_bytes:
            if outcome.timed_out:
                return self._failure(
                    plan,
                    "codex_exec_timeout",
                    evidence={
                        "exit_code": outcome.returncode,
                        "timed_out": True,
                        "captured_bytes": capture_bytes,
                        "max_capture_bytes": self._max_capture_bytes,
                        "stdout_bytes": stdout_bytes,
                        "stderr_bytes": stderr_bytes,
                    },
                    status=TerminalStatus.EXHAUSTED,
                )
            return self._failure(
                plan,
                "codex_output_too_large",
                evidence={
                    "exit_code": outcome.returncode,
                    "timed_out": outcome.timed_out,
                    "captured_bytes": capture_bytes,
                    "max_capture_bytes": self._max_capture_bytes,
                    "stderr": outcome.stderr[-_STDERR_LIMIT:],
                },
            )
        evidence = parse_codex_events(outcome.stdout)
        expected_markers = {
            participant.candidate_id: f"[[sharednet:{nonce}:{participant.candidate_id}]]"
            for participant in plan.participants
        }
        native_proof = _native_coordination_proof(evidence, expected_markers)
        runtime_evidence = self._runtime_evidence(evidence, outcome, command)
        runtime_evidence.update(native_proof)
        runtime_evidence.update(self._persist_artifacts(plan, outcome))
        if outcome.timed_out:
            return self._failure(
                plan,
                "codex_exec_timeout",
                evidence=runtime_evidence,
                usage=evidence.usage,
                status=TerminalStatus.EXHAUSTED,
            )
        if outcome.returncode != 0:
            return self._failure(plan, "codex_exec_nonzero_exit", evidence=runtime_evidence, usage=evidence.usage)
        if not _completed_lifecycle(evidence):
            return self._failure(plan, "incomplete_codex_lifecycle", evidence=runtime_evidence, usage=evidence.usage)
        if evidence.disallowed_tool_evidence_present:
            return self._failure(
                plan,
                "disallowed_runtime_tool_evidence",
                evidence=runtime_evidence,
                usage=evidence.usage,
            )

        decoded = _decode_final_output(evidence.final_message)
        if decoded is None:
            return self._failure(plan, "invalid_structured_output", evidence=runtime_evidence, usage=evidence.usage)
        synthesis, outputs = decoded
        parsed_outputs = _validated_outputs(outputs, expected_markers)
        if parsed_outputs is None:
            return self._failure(plan, "invalid_structured_output", evidence=runtime_evidence, usage=evidence.usage)
        if (
            {output.marker for output in parsed_outputs} != set(expected_markers.values())
            or any(output.marker != expected_markers[output.participant_id] for output in parsed_outputs)
            or any(marker not in synthesis for marker in expected_markers.values())
        ):
            return self._failure(plan, "missing_participant_markers", evidence=runtime_evidence, usage=evidence.usage)

        if not native_proof["native_proof_complete"]:
            return self._failure(plan, "missing_native_spawn_evidence", evidence=runtime_evidence, usage=evidence.usage)
        return CoordinationResult(
            status=TerminalStatus.ACCEPTED,
            plan=plan,
            outputs=parsed_outputs,
            synthesis=synthesis,
            runtime_evidence=runtime_evidence,
            usage=evidence.usage,
        )

    @staticmethod
    def _setup_timeout(plan: CoordinationPlan) -> CoordinationResult:
        return CoordinationResult(
            status=TerminalStatus.EXHAUSTED,
            plan=plan,
            runtime_evidence={"timed_out": True, "timeout_phase": "setup"},
            error="codex_exec_timeout",
        )

    def _resolve_binary(self) -> str:
        if self._configured_binary:
            return _absolute_if_path_like(self._configured_binary)
        environment_binary = os.environ.get("SHAREDNET_CODEX_BINARY")
        if environment_binary:
            return _absolute_if_path_like(environment_binary)
        for bundled_binary in _CHATGPT_CODEX_PATHS:
            if Path(bundled_binary).is_file():
                return bundled_binary
        path_binary = shutil.which("codex")
        if path_binary:
            return path_binary
        raise CodexUnavailable("no Codex binary found")

    def _command(self, binary: str, prompt: str) -> list[str]:
        return [
            binary,
            "--enable",
            "multi_agent",
            "-a",
            "never",
            "-s",
            "read-only",
            "exec",
            "-m",
            self._model,
            "--ephemeral",
            "--ignore-user-config",
            "--skip-git-repo-check",
            "--json",
            "--color",
            "never",
            prompt,
        ]

    @staticmethod
    def _failure(
        plan: CoordinationPlan,
        error: str,
        *,
        evidence: Mapping[str, Any] | None = None,
        usage: Mapping[str, int | float] | None = None,
        stderr: str = "",
        status: TerminalStatus = TerminalStatus.FAILED,
    ) -> CoordinationResult:
        runtime_evidence = dict(evidence or {})
        if stderr:
            runtime_evidence["stderr"] = stderr[-_STDERR_LIMIT:]
        return CoordinationResult(
            status=status,
            plan=plan,
            runtime_evidence=runtime_evidence,
            usage=dict(usage or {}),
            error=error,
        )

    @staticmethod
    def _runtime_evidence(evidence: CodexEventEvidence, outcome: ProcessOutcome, command: Sequence[str]) -> dict[str, Any]:
        return {
            "thread_id": evidence.thread_id,
            "spawned_agent_ids": list(evidence.spawned_agent_ids),
            "completed_child_ids": list(evidence.completed_child_ids),
            "explicit_spawn_count": evidence.explicit_spawn_count,
            "raw_event_count": evidence.raw_event_count,
            "collaboration_events": list(evidence.collaboration_events),
            "disallowed_tool_events": list(evidence.disallowed_tool_events),
            "root_thread_started": evidence.root_thread_started,
            "turn_completed": evidence.turn_completed,
            "final_message_completed": evidence.final_message_completed,
            "final_message_index": evidence.final_message_index,
            "turn_completed_count": len(evidence.turn_completed_indices),
            "last_collaboration_completion_index": (
                max(evidence.collaboration_completion_indices)
                if evidence.collaboration_completion_indices
                else None
            ),
            "invalid_spawn_sender": evidence.invalid_spawn_sender,
            "invalid_collaboration_evidence": evidence.invalid_collaboration_evidence,
            "disallowed_tool_evidence_present": evidence.disallowed_tool_evidence_present,
            "diagnostic_events_truncated": evidence.diagnostic_events_truncated,
            "exit_code": outcome.returncode,
            "timed_out": outcome.timed_out,
            "stderr": outcome.stderr[-_STDERR_LIMIT:],
            "command": list(command[:-1]),
            "captured_bytes": len(outcome.stdout.encode("utf-8")) + len(outcome.stderr.encode("utf-8")),
        }

    def _persist_artifacts(self, plan: CoordinationPlan, outcome: ProcessOutcome) -> dict[str, str]:
        if self._artifact_dir is None:
            return {}
        try:
            self._artifact_dir.mkdir(parents=True, exist_ok=True)
            safe_trace_id = "".join(character if character.isalnum() or character in "-_" else "_" for character in plan.trace_id)
            for _ in range(10):
                stem = f"{safe_trace_id}-attempt-{plan.attempt}-{secrets.token_hex(12)}"
                stdout_path = self._artifact_dir / f"{stem}.stdout.jsonl"
                stderr_path = self._artifact_dir / f"{stem}.stderr.log"
                try:
                    _write_exclusive(stdout_path, outcome.stdout)
                    _write_exclusive(stderr_path, outcome.stderr)
                except FileExistsError:
                    continue
                return {"stdout_artifact": str(stdout_path), "stderr_artifact": str(stderr_path)}
            return {"artifact_error": "artifact_name_collision"}
        except OSError as error:
            return {"artifact_error": str(error)}


def _default_runner(
    command: list[str],
    timeout: float,
    *,
    clock: Callable[[], float] | None = None,
    deadline: float | None = None,
) -> ProcessOutcome:
    """Run one process and escalate termination deterministically on timeout."""
    monotonic = clock if clock is not None else time.monotonic
    absolute_deadline = deadline if deadline is not None else monotonic() + timeout
    if absolute_deadline - monotonic() <= 0:
        return ProcessOutcome(124, "", "", True)
    with tempfile.TemporaryDirectory(prefix="sharednet-codex-") as runtime_cwd:
        process = subprocess.Popen(
            command,
            cwd=runtime_cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            stdout, stderr = process.communicate(timeout=max(0.0, absolute_deadline - monotonic()))
            return ProcessOutcome(process.returncode or 0, _as_text(stdout), _as_text(stderr), False)
        except subprocess.TimeoutExpired as timeout_error:
            process.terminate()
            remaining = max(0.0, absolute_deadline - monotonic())
            if remaining <= 0:
                process.kill()
                final_stdout, final_stderr = _communicate_within_deadline(process, absolute_deadline, monotonic, timeout_error)
                return ProcessOutcome(process.returncode or 0, final_stdout, final_stderr, True)
            try:
                final_stdout, final_stderr = process.communicate(timeout=min(_TERMINATE_GRACE_SECONDS, remaining))
            except subprocess.TimeoutExpired as terminate_error:
                process.kill()
                final_stdout, final_stderr = _communicate_within_deadline(process, absolute_deadline, monotonic, terminate_error)
            return ProcessOutcome(process.returncode or 0, _as_text(final_stdout), _as_text(final_stderr), True)


def _communicate_within_deadline(
    process: subprocess.Popen[bytes],
    deadline: float,
    clock: Callable[[], float],
    prior_timeout: subprocess.TimeoutExpired,
) -> tuple[str, str]:
    """Collect killed-process output without granting time beyond the attempt deadline."""
    remaining = max(0.0, deadline - clock())
    try:
        stdout, stderr = process.communicate(timeout=remaining)
        return _as_text(stdout), _as_text(stderr)
    except subprocess.TimeoutExpired as kill_error:
        stdout = kill_error.output if kill_error.output is not None else prior_timeout.output
        stderr = kill_error.stderr if kill_error.stderr is not None else prior_timeout.stderr
        return _as_text(stdout), _as_text(stderr)


def _as_text(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def _write_exclusive(path: Path, content: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as artifact:
        artifact.write(content)


def _event_type(event: Mapping[str, Any]) -> str:
    value = event.get("type")
    return value if isinstance(value, str) else ""


def _absolute_if_path_like(binary: str) -> str:
    separators = tuple(separator for separator in (os.sep, os.altsep) if separator)
    if any(separator in binary for separator in separators):
        return str(Path(binary).expanduser().resolve())
    return binary


def _bounded_identifier(value: object) -> str | None:
    if isinstance(value, str) and value and len(value) <= 256:
        return value
    return None


def _bounded_identifier_sequence(value: object) -> tuple[str, ...] | None:
    if not isinstance(value, list):
        return None
    identifiers: list[str] = []
    for item in value:
        identifier = _bounded_identifier(item)
        if identifier is None:
            return None
        identifiers.append(identifier)
    return tuple(identifiers)


def _bounded_diagnostic_text(value: object) -> str:
    return value[:80] if isinstance(value, str) else ""


def _disallowed_event_diagnostic(
    event_type: str,
    item_type: str,
    tool: str,
    item: object,
) -> Mapping[str, Any] | None:
    """Allow only observed passive lifecycle records and planned collaboration calls."""
    passive_top_level = {"thread.started", "turn.started", "turn.completed", "error"}
    if event_type in passive_top_level and not isinstance(item, Mapping):
        return None
    if event_type == "item.completed" and item_type in {"agent_message", "error", "reasoning"} and not tool:
        return None
    if (
        event_type in {"item.started", "item.completed"}
        and item_type == "collab_tool_call"
        and tool in {"spawn_agent", "wait"}
    ):
        return None
    status = item.get("status") if isinstance(item, Mapping) else None
    diagnostic: dict[str, Any] = {
        "event_type": _bounded_diagnostic_text(event_type),
        "item_type": _bounded_diagnostic_text(item_type),
    }
    if tool:
        diagnostic["tool"] = _bounded_diagnostic_text(tool)
    if isinstance(status, str):
        diagnostic["status"] = _bounded_diagnostic_text(status)
    return diagnostic


def _collaboration_diagnostic(
    event_type: str,
    tool: str,
    item: Mapping[str, Any],
    root_thread_id: str | None,
) -> Mapping[str, Any]:
    receivers = item.get("receiver_thread_ids")
    states = item.get("agents_states")
    return {
        "event_type": _bounded_diagnostic_text(event_type),
        "item_id": _bounded_diagnostic_text(item.get("id")),
        "tool": _bounded_diagnostic_text(tool),
        "status": _bounded_diagnostic_text(item.get("status")),
        "sender_is_root": root_thread_id is not None and item.get("sender_thread_id") == root_thread_id,
        "receiver_count": len(receivers) if isinstance(receivers, list) else 0,
        "state_count": len(states) if isinstance(states, Mapping) else 0,
    }


def _completed_lifecycle(evidence: CodexEventEvidence) -> bool:
    final_index = evidence.final_message_index
    if not evidence.root_thread_started or not evidence.final_message_completed or final_index is None:
        return False
    if len(evidence.turn_completed_indices) != 1 or evidence.turn_completed_indices[0] <= final_index:
        return False
    return all(completion_index < final_index for completion_index in evidence.collaboration_completion_indices)


def _native_coordination_proof(
    evidence: CodexEventEvidence,
    expected_markers: Mapping[str, str],
) -> dict[str, Any]:
    """Bind root spawns to planned markers and completed wait messages."""
    child_markers = dict(list(expected_markers.items())[1:])
    required_child_ids = set(child_markers)
    valid = not evidence.invalid_collaboration_evidence and not evidence.disallowed_tool_evidence_present
    spawned_ids = evidence.spawned_agent_ids
    if evidence.explicit_spawn_count != len(required_child_ids) or len(spawned_ids) != len(required_child_ids):
        valid = False

    participant_by_child: dict[str, str] = {}
    all_markers = tuple(expected_markers.items())
    for child_id, prompt in evidence.spawn_bindings:
        matches = [participant_id for participant_id, marker in all_markers if marker in prompt]
        if len(matches) != 1 or matches[0] not in required_child_ids:
            valid = False
            continue
        participant_id = matches[0]
        if child_id in participant_by_child or participant_id in participant_by_child.values():
            valid = False
            continue
        participant_by_child[child_id] = participant_id
    if set(participant_by_child.values()) != required_child_ids:
        valid = False

    completed_ids = evidence.completed_child_ids
    if set(completed_ids) != set(spawned_ids) or len(completed_ids) != len(spawned_ids):
        valid = False

    messages_by_child: dict[str, list[str]] = {}
    for child_id, message, _ in evidence.completed_child_messages:
        messages_by_child.setdefault(child_id, []).append(message)
    contributing_ids: list[str] = []
    for child_id in spawned_ids:
        participant_id = participant_by_child.get(child_id)
        marker = child_markers.get(participant_id, "") if participant_id is not None else ""
        messages = messages_by_child.get(child_id, [])
        if marker and messages and all(marker in message for message in messages):
            contributing_ids.append(child_id)
        else:
            valid = False

    if not required_child_ids and (
        evidence.spawn_bindings or evidence.completed_child_messages or evidence.collaboration_events
    ):
        valid = False
    return {
        "completed_child_ids": list(completed_ids),
        "contributing_child_ids": contributing_ids,
        "child_participant_bindings": participant_by_child,
        "native_proof_complete": valid,
    }


def _agent_message(event: Mapping[str, Any]) -> str | None:
    item = event.get("item")
    if event.get("type") == "item.completed" and isinstance(item, Mapping) and item.get("type") == "agent_message":
        value = item.get("text")
        if isinstance(value, str):
            return value
    return None


def _decode_final_output(message: str) -> tuple[str, list[Mapping[str, Any]]] | None:
    try:
        value = json.loads(message)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(value, Mapping) or set(value) != {"synthesis", "outputs"}:
        return None
    synthesis = value.get("synthesis")
    outputs = value.get("outputs")
    if not isinstance(synthesis, str) or not isinstance(outputs, list):
        return None
    if not all(isinstance(output, Mapping) for output in outputs):
        return None
    return synthesis, outputs


def _validated_outputs(outputs: list[Mapping[str, Any]], expected_markers: Mapping[str, str]) -> tuple[AgentOutput, ...] | None:
    parsed: list[AgentOutput] = []
    candidate_ids: set[str] = set()
    for output in outputs:
        if set(output) != {"candidate_id", "marker", "content"}:
            return None
        candidate_id = output.get("candidate_id")
        marker = output.get("marker")
        content = output.get("content")
        if not all(isinstance(value, str) and value for value in (candidate_id, marker, content)):
            return None
        if candidate_id not in expected_markers or candidate_id in candidate_ids:
            return None
        candidate_ids.add(candidate_id)
        parsed.append(AgentOutput(participant_id=candidate_id, marker=marker, content=content))
    return tuple(parsed)
