"""A safe, JSONL-only adapter for bounded native Codex coordination."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
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
    explicit_spawn_count: int
    final_message: str
    usage: Mapping[str, int | float]
    raw_event_count: int
    collaboration_events: tuple[Mapping[str, Any], ...]
    root_thread_started: bool
    turn_completed: bool
    final_message_completed: bool
    invalid_spawn_sender: bool


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
        "do not delegate spawning to a child. Wait for every child before replying. "
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
    """Parse JSONL while retaining only JSON records and ignoring diagnostics."""
    thread_id: str | None = None
    final_message = ""
    usage: dict[str, int | float] = {}
    collaboration_events: list[Mapping[str, Any]] = []
    spawn_records: list[tuple[str | None, tuple[str, ...]]] = []
    raw_event_count = 0
    explicit_spawn_count = 0
    root_thread_started = False
    turn_completed = False
    final_message_completed = False

    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, Mapping):
            continue
        raw_event_count += 1
        event_type = _event_type(event)
        if thread_id is None and (event_type == "thread.started" or event_type.endswith("thread.started")):
            thread_id = _first_string(event, "thread_id")
            root_thread_started = thread_id is not None
        if thread_id is None:
            candidate_root = _first_string(event, "thread_id")
            if candidate_root is not None and "thread" in event_type and "agent" not in event_type:
                thread_id = candidate_root

        event_usage = _first_mapping(event, "usage")
        if event_usage is not None:
            for key, value in event_usage.items():
                if isinstance(key, str) and isinstance(value, (int, float)) and not isinstance(value, bool):
                    usage[key] = usage.get(key, 0) + value
        if event_type == "turn.completed":
            turn_completed = True

        item = event.get("item")
        item_type = item.get("type", "").lower() if isinstance(item, Mapping) and isinstance(item.get("type"), str) else ""
        is_collaboration = "collaboration" in event_type or item_type == "collab_tool_call"
        is_completed_collab_spawn = (
            event_type == "item.completed"
            and item_type == "collab_tool_call"
            and isinstance(item, Mapping)
            and item.get("tool") == "spawn_agent"
            and item.get("status") == "completed"
        )
        is_compatible_collab_spawn = "collaboration" in event_type and "spawn" in event_type and bool(
            _strings_for_key(event, "agent_thread_id")
        )
        if is_collaboration:
            collaboration_events.append(dict(event))
            if is_completed_collab_spawn or is_compatible_collab_spawn:
                spawned = _strings_for_key(event, "agent_thread_id")
                receiver_ids = _strings_for_key(event, "receiver_thread_ids")
                spawn_records.append((_first_string(event, "sender_thread_id"), tuple(spawned + receiver_ids)))

        message = _agent_message(event)
        if message is not None:
            final_message = message
            final_message_completed = True

    root_ids = {thread_id} if thread_id is not None else set()
    invalid_spawn_sender = any(sender_thread_id != thread_id for sender_thread_id, _ in spawn_records)
    raw_spawned_agent_ids = [
        agent_id
        for sender_thread_id, agent_ids in spawn_records
        if sender_thread_id == thread_id
        for agent_id in agent_ids
        if agent_id not in root_ids
    ]
    spawned_agent_ids = tuple(dict.fromkeys(raw_spawned_agent_ids))
    explicit_spawn_count = len(raw_spawned_agent_ids)
    return CodexEventEvidence(
        thread_id=thread_id,
        spawned_agent_ids=spawned_agent_ids,
        explicit_spawn_count=explicit_spawn_count,
        final_message=final_message,
        usage=usage,
        raw_event_count=raw_event_count,
        collaboration_events=tuple(collaboration_events),
        root_thread_started=root_thread_started,
        turn_completed=turn_completed,
        final_message_completed=final_message_completed,
        invalid_spawn_sender=invalid_spawn_sender,
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
        runtime_evidence = self._runtime_evidence(evidence, outcome, command)
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
        if not (evidence.root_thread_started and evidence.turn_completed and evidence.final_message_completed):
            return self._failure(plan, "incomplete_codex_lifecycle", evidence=runtime_evidence, usage=evidence.usage)

        decoded = _decode_final_output(evidence.final_message)
        if decoded is None:
            return self._failure(plan, "invalid_structured_output", evidence=runtime_evidence, usage=evidence.usage)
        synthesis, outputs = decoded
        expected_markers = {participant.candidate_id: f"[[sharednet:{nonce}:{participant.candidate_id}]]" for participant in plan.participants}
        parsed_outputs = _validated_outputs(outputs, expected_markers)
        if parsed_outputs is None:
            return self._failure(plan, "invalid_structured_output", evidence=runtime_evidence, usage=evidence.usage)
        if (
            {output.marker for output in parsed_outputs} != set(expected_markers.values())
            or any(output.marker != expected_markers[output.participant_id] for output in parsed_outputs)
            or any(marker not in synthesis for marker in expected_markers.values())
        ):
            return self._failure(plan, "missing_participant_markers", evidence=runtime_evidence, usage=evidence.usage)

        required_children = len(plan.participants) - 1
        if evidence.invalid_spawn_sender or (
            len(evidence.spawned_agent_ids) != required_children or evidence.explicit_spawn_count != required_children
        ):
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
            return self._configured_binary
        environment_binary = os.environ.get("SHAREDNET_CODEX_BINARY")
        if environment_binary:
            return environment_binary
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
            "explicit_spawn_count": evidence.explicit_spawn_count,
            "raw_event_count": evidence.raw_event_count,
            "collaboration_events": list(evidence.collaboration_events),
            "root_thread_started": evidence.root_thread_started,
            "turn_completed": evidence.turn_completed,
            "final_message_completed": evidence.final_message_completed,
            "invalid_spawn_sender": evidence.invalid_spawn_sender,
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
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        stdout, stderr = process.communicate(timeout=max(0.0, absolute_deadline - monotonic()))
        return ProcessOutcome(process.returncode or 0, stdout or "", stderr or "", False)
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
    process: subprocess.Popen[str],
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
        return value.decode(errors="replace")
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
    return value.lower() if isinstance(value, str) else ""


def _first_string(value: object, key: str) -> str | None:
    if isinstance(value, Mapping):
        direct = value.get(key)
        if isinstance(direct, str):
            return direct
        for nested in value.values():
            found = _first_string(nested, key)
            if found is not None:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _first_string(nested, key)
            if found is not None:
                return found
    return None


def _strings_for_key(value: object, key: str) -> list[str]:
    found: list[str] = []
    if isinstance(value, Mapping):
        direct = value.get(key)
        if isinstance(direct, str):
            found.append(direct)
        elif isinstance(direct, list):
            found.extend(item for item in direct if isinstance(item, str))
        for nested_key, nested in value.items():
            if nested_key != key:
                found.extend(_strings_for_key(nested, key))
    elif isinstance(value, list):
        for nested in value:
            found.extend(_strings_for_key(nested, key))
    return found


def _first_mapping(value: object, key: str) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        direct = value.get(key)
        if isinstance(direct, Mapping):
            return direct
        for nested in value.values():
            found = _first_mapping(nested, key)
            if found is not None:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _first_mapping(nested, key)
            if found is not None:
                return found
    return None


def _agent_message(event: Mapping[str, Any]) -> str | None:
    item = event.get("item")
    if event.get("type") == "item.completed" and isinstance(item, Mapping) and item.get("type") in {"agent_message", "assistant_message"}:
        for key in ("text", "content", "message"):
            value = item.get(key)
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
