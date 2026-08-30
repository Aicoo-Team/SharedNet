"""Frozen, JSON-safe contracts for one bounded coordination run."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import json
import math
from types import MappingProxyType
from typing import Any, Mapping

from .costs import fits_cost_budget, sum_costs, to_decimal


JsonValue = None | bool | int | float | str | tuple["JsonValue", ...] | Mapping[str, "JsonValue"]


def _nonempty_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a nonempty string")
    return value


def _string_tuple(value: object, name: str, *, allow_empty: bool = False) -> tuple[str, ...]:
    if not isinstance(value, (tuple, list)):
        raise ValueError(f"{name} must be a sequence of nonempty strings")
    result = tuple(_nonempty_string(item, name) for item in value)
    if not allow_empty and not result:
        raise ValueError(f"{name} must not be empty")
    return result


def _positive_number(value: object, name: str) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f"{name} must be positive")
    try:
        finite_value = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError(f"{name} must be finite") from error
    if not math.isfinite(finite_value):
        raise ValueError(f"{name} must be finite")
    return value


def _nonnegative_number(value: object, name: str) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ValueError(f"{name} must be nonnegative")
    try:
        finite_value = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError(f"{name} must be finite") from error
    if not math.isfinite(finite_value):
        raise ValueError(f"{name} must be finite")
    return value


def _freeze_json(value: object, name: str = "value") -> JsonValue:
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{name} must be JSON-safe")
        return value
    if isinstance(value, Mapping):
        frozen: dict[str, JsonValue] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{name} keys must be strings")
            frozen[key] = _freeze_json(item, f"{name}.{key}")
        return MappingProxyType(frozen)
    if isinstance(value, (tuple, list)):
        return tuple(_freeze_json(item, name) for item in value)
    raise ValueError(f"{name} must be JSON-safe")


def _thaw_json(value: JsonValue) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw_json(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw_json(item) for item in value]
    return value


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    if not all(isinstance(key, str) for key in value):
        raise ValueError(f"{name} keys must be strings")
    return value


def _required(data: Mapping[str, object], key: str, context: str) -> object:
    if key not in data:
        raise ValueError(f"{context}.{key} is required")
    return data[key]


class _JsonEnum(str, Enum):
    """String enum with the same explicit JSON boundary as the dataclasses."""

    def to_dict(self) -> str:
        return self.value


class CandidateMode(_JsonEnum):
    SELF = "self"
    RECRUIT = "recruit"
    SPAWN = "spawn"


class TerminalStatus(_JsonEnum):
    ACCEPTED = "accepted"
    PARTIAL = "partial"
    ABSTAINED = "abstained"
    DENIED = "denied"
    EXHAUSTED = "exhausted"
    FAILED = "failed"


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    goal: str
    required_capabilities: tuple[str, ...]
    acceptance_criteria: tuple[str, ...]
    input_data: Mapping[str, JsonValue]

    def __post_init__(self) -> None:
        object.__setattr__(self, "task_id", _nonempty_string(self.task_id, "task_id"))
        object.__setattr__(self, "goal", _nonempty_string(self.goal, "goal"))
        object.__setattr__(self, "required_capabilities", _string_tuple(self.required_capabilities, "required_capabilities"))
        object.__setattr__(self, "acceptance_criteria", _string_tuple(self.acceptance_criteria, "acceptance_criteria", allow_empty=True))
        object.__setattr__(self, "input_data", _freeze_json(_mapping(self.input_data, "input_data"), "input_data"))

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "TaskSpec":
        data = _mapping(payload, "task")
        try:
            return cls(
                _required(data, "task_id", "task"),
                _required(data, "goal", "task"),
                _required(data, "required_capabilities", "task"),
                data.get("acceptance_criteria", ()),
                data.get("input_data", {}),
            )
        except ValueError as error:
            if str(error).startswith("task."):
                raise
            raise ValueError(f"task.{error}") from error

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "goal": self.goal,
            "required_capabilities": list(self.required_capabilities),
            "acceptance_criteria": list(self.acceptance_criteria),
            "input_data": _thaw_json(self.input_data),
        }


@dataclass(frozen=True)
class CoordinationBudget:
    max_wall_seconds: float = 300
    max_turns: int = 16
    max_depth: int = 2
    max_participants: int = 4
    max_retries: int = 1
    max_disclosure_bytes: int = 65536
    max_cost: float = 1.0

    def __post_init__(self) -> None:
        _positive_number(self.max_wall_seconds, "max_wall_seconds")
        _positive_number(self.max_cost, "max_cost")
        to_decimal(self.max_cost)
        for name in ("max_turns", "max_depth", "max_participants", "max_retries", "max_disclosure_bytes"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be positive")

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "CoordinationBudget":
        data = _mapping(payload, "budget")
        unknown = sorted(set(data) - set(cls.__dataclass_fields__))
        if unknown:
            raise ValueError(f"budget.unknown field: {unknown[0]}")
        known = {field_name: data[field_name] for field_name in cls.__dataclass_fields__ if field_name in data}
        try:
            return cls(**known)
        except ValueError as error:
            raise ValueError(f"budget.{error}") from error

    def to_dict(self) -> dict[str, float | int]:
        return {
            "max_wall_seconds": self.max_wall_seconds,
            "max_turns": self.max_turns,
            "max_depth": self.max_depth,
            "max_participants": self.max_participants,
            "max_retries": self.max_retries,
            "max_disclosure_bytes": self.max_disclosure_bytes,
            "max_cost": self.max_cost,
        }


@dataclass(frozen=True)
class Candidate:
    candidate_id: str
    mode: CandidateMode
    capabilities: tuple[str, ...]
    admitted: bool
    admission_reason: str
    predicted_quality: float
    predicted_cost: float
    predicted_latency: float
    predicted_risk: float
    verified_successes: int = 0
    verified_failures: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(self, "candidate_id", _nonempty_string(self.candidate_id, "candidate_id"))
        if not isinstance(self.mode, CandidateMode):
            try:
                object.__setattr__(self, "mode", CandidateMode(self.mode))
            except (TypeError, ValueError) as error:
                raise ValueError("mode must be a candidate mode") from error
        object.__setattr__(self, "capabilities", _string_tuple(self.capabilities, "capabilities"))
        if not isinstance(self.admitted, bool):
            raise ValueError("admitted must be a boolean")
        object.__setattr__(self, "admission_reason", _nonempty_string(self.admission_reason, "admission_reason"))
        for name in ("predicted_quality", "predicted_cost", "predicted_latency", "predicted_risk"):
            _nonnegative_number(getattr(self, name), name)
        for name in ("verified_successes", "verified_failures"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a nonnegative integer")

    @property
    def successes(self) -> int:
        return self.verified_successes

    @property
    def failures(self) -> int:
        return self.verified_failures

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "Candidate":
        data = _mapping(payload, "candidate")
        try:
            return cls(
                _required(data, "candidate_id", "candidate"),
                _required(data, "mode", "candidate"),
                _required(data, "capabilities", "candidate"),
                _required(data, "admitted", "candidate"),
                _required(data, "admission_reason", "candidate"),
                _required(data, "predicted_quality", "candidate"),
                _required(data, "predicted_cost", "candidate"),
                _required(data, "predicted_latency", "candidate"),
                _required(data, "predicted_risk", "candidate"),
                data.get("verified_successes", data.get("successes", 0)),
                data.get("verified_failures", data.get("failures", 0)),
            )
        except ValueError as error:
            if str(error).startswith("candidate."):
                raise
            raise ValueError(f"candidate.{error}") from error

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "mode": self.mode.value,
            "capabilities": list(self.capabilities),
            "admitted": self.admitted,
            "admission_reason": self.admission_reason,
            "predicted_quality": self.predicted_quality,
            "predicted_cost": self.predicted_cost,
            "predicted_latency": self.predicted_latency,
            "predicted_risk": self.predicted_risk,
            "verified_successes": self.verified_successes,
            "verified_failures": self.verified_failures,
        }


@dataclass(frozen=True)
class CoordinationRequest:
    task: TaskSpec
    candidates: tuple[Candidate, ...]
    budget: CoordinationBudget
    mechanism: str
    trace_id: str

    def __post_init__(self) -> None:
        if not isinstance(self.task, TaskSpec):
            raise ValueError("task must be a TaskSpec")
        if not isinstance(self.budget, CoordinationBudget):
            raise ValueError("budget must be a CoordinationBudget")
        task_payload = json.dumps(
            self.task.to_dict(),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        if len(task_payload) > self.budget.max_disclosure_bytes:
            raise ValueError("task exceeds max_disclosure_bytes")
        candidates = tuple(self.candidates)
        if not all(isinstance(candidate, Candidate) for candidate in candidates):
            raise ValueError("candidates must contain Candidate values")
        identifiers = [candidate.candidate_id for candidate in candidates]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("duplicate candidate id")
        admitted_self = [candidate for candidate in candidates if candidate.admitted and candidate.mode is CandidateMode.SELF]
        if len(admitted_self) > 1:
            raise ValueError("multiple admitted SELF candidates")
        object.__setattr__(self, "candidates", candidates)
        object.__setattr__(self, "mechanism", _nonempty_string(self.mechanism, "mechanism"))
        object.__setattr__(self, "trace_id", _nonempty_string(self.trace_id, "trace_id"))

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "CoordinationRequest":
        data = _mapping(payload, "request")
        try:
            raw_candidates = _required(data, "candidates", "request")
            if not isinstance(raw_candidates, (list, tuple)):
                raise ValueError("request.candidates must be a sequence")
            return cls(
                TaskSpec.from_dict(_required(data, "task", "request")),
                tuple(Candidate.from_dict(_mapping(item, "candidate")) for item in raw_candidates),
                CoordinationBudget.from_dict(_mapping(data.get("budget", {}), "budget")),
                _required(data, "mechanism", "request"),
                _required(data, "trace_id", "request"),
            )
        except ValueError as error:
            raise error

    def to_dict(self) -> dict[str, Any]:
        return {
            "task": self.task.to_dict(),
            "candidates": [candidate.to_dict() for candidate in self.candidates],
            "budget": self.budget.to_dict(),
            "mechanism": self.mechanism,
            "trace_id": self.trace_id,
        }


@dataclass(frozen=True)
class ParticipantPlan:
    candidate_id: str
    role: str
    assignment: str
    dependencies: tuple[str, ...]
    selection_reason: str
    capabilities: tuple[str, ...] = ()
    predicted_cost: float = 0
    mode: CandidateMode = CandidateMode.RECRUIT

    def __post_init__(self) -> None:
        for name in ("candidate_id", "role", "assignment", "selection_reason"):
            object.__setattr__(self, name, _nonempty_string(getattr(self, name), name))
        object.__setattr__(self, "dependencies", _string_tuple(self.dependencies, "dependencies", allow_empty=True))
        object.__setattr__(self, "capabilities", _string_tuple(self.capabilities, "capabilities", allow_empty=True))
        _nonnegative_number(self.predicted_cost, "predicted_cost")
        to_decimal(self.predicted_cost)
        if not isinstance(self.mode, CandidateMode):
            try:
                object.__setattr__(self, "mode", CandidateMode(self.mode))
            except (TypeError, ValueError) as error:
                raise ValueError("mode must be a candidate mode") from error

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "mode": self.mode.value,
            "role": self.role,
            "assignment": self.assignment,
            "dependencies": list(self.dependencies),
            "selection_reason": self.selection_reason,
            "capabilities": list(self.capabilities),
            "predicted_cost": self.predicted_cost,
        }


@dataclass(frozen=True)
class GraphEdge:
    source: str
    target: str
    relation: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "source", _nonempty_string(self.source, "source"))
        object.__setattr__(self, "target", _nonempty_string(self.target, "target"))
        object.__setattr__(self, "relation", _nonempty_string(self.relation, "relation"))

    def to_dict(self) -> dict[str, str]:
        return {"source": self.source, "target": self.target, "relation": self.relation}


@dataclass(frozen=True)
class CoordinationPlan:
    mechanism_id: str
    task_id: str
    trace_id: str
    attempt: int
    exclusions: frozenset[str]
    participants: tuple[ParticipantPlan, ...]
    edges: tuple[GraphEdge, ...]
    decision_trace: tuple[Mapping[str, JsonValue], ...]
    runtime_instructions: Mapping[str, JsonValue]
    budget: CoordinationBudget = field(default_factory=CoordinationBudget)
    terminal_status: TerminalStatus = TerminalStatus.ACCEPTED

    def __post_init__(self) -> None:
        for name in ("mechanism_id", "task_id", "trace_id"):
            object.__setattr__(self, name, _nonempty_string(getattr(self, name), name))
        if isinstance(self.attempt, bool) or not isinstance(self.attempt, int) or self.attempt < 0:
            raise ValueError("attempt must be a nonnegative integer")
        if not isinstance(self.budget, CoordinationBudget):
            raise ValueError("budget must be a CoordinationBudget")
        if not isinstance(self.terminal_status, TerminalStatus):
            try:
                object.__setattr__(self, "terminal_status", TerminalStatus(self.terminal_status))
            except (TypeError, ValueError) as error:
                raise ValueError("terminal_status must be a terminal status") from error
        if self.attempt > self.budget.max_retries:
            raise ValueError("attempt exceeds retry budget")
        exclusions = frozenset(_nonempty_string(item, "exclusions") for item in self.exclusions)
        participants = tuple(self.participants)
        if not all(isinstance(item, ParticipantPlan) for item in participants):
            raise ValueError("participants must contain ParticipantPlan values")
        identifiers = [item.candidate_id for item in participants]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("duplicate participant id")
        if len(participants) > self.budget.max_participants:
            raise ValueError("maximum participant count exceeded")
        if not fits_cost_budget(0, sum_costs(item.predicted_cost for item in participants), self.budget.max_cost):
            raise ValueError("maximum predicted cost exceeded")
        known = set(identifiers)
        for participant in participants:
            unknown = set(participant.dependencies) - known
            if unknown:
                raise ValueError(f"unknown dependency: {sorted(unknown)[0]}")
            if participant.candidate_id in participant.dependencies:
                raise ValueError("participant cannot depend on itself")
        dependencies = {participant.candidate_id: participant.dependencies for participant in participants}
        visiting: set[str] = set()
        depths: dict[str, int] = {}

        def depth_of(participant_id: str) -> int:
            if participant_id in depths:
                return depths[participant_id]
            if participant_id in visiting:
                raise ValueError("participant dependencies must not contain a cycle")
            visiting.add(participant_id)
            depth = 0
            if dependencies[participant_id]:
                depth = 1 + max(depth_of(dependency) for dependency in dependencies[participant_id])
            visiting.remove(participant_id)
            depths[participant_id] = depth
            return depth

        if any(depth_of(participant_id) > self.budget.max_depth for participant_id in dependencies):
            raise ValueError("maximum dependency depth exceeded")
        edges = tuple(self.edges)
        if not all(isinstance(edge, GraphEdge) for edge in edges):
            raise ValueError("edges must contain GraphEdge values")
        for edge in edges:
            if edge.source not in known or edge.target not in known:
                raise ValueError("unknown edge endpoint")
        trace = tuple(_freeze_json(_mapping(item, "decision_trace"), "decision_trace") for item in self.decision_trace)
        instructions = _freeze_json(_mapping(self.runtime_instructions, "runtime_instructions"), "runtime_instructions")
        object.__setattr__(self, "exclusions", exclusions)
        object.__setattr__(self, "participants", participants)
        object.__setattr__(self, "edges", edges)
        object.__setattr__(self, "decision_trace", trace)
        object.__setattr__(self, "runtime_instructions", instructions)

    @property
    def participant_ids(self) -> tuple[str, ...]:
        return tuple(item.candidate_id for item in self.participants)

    @property
    def covered_capabilities(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(capability for item in self.participants for capability in item.capabilities))

    @property
    def total_predicted_cost(self) -> float:
        return float(sum_costs(item.predicted_cost for item in self.participants))

    @property
    def stop_reason(self) -> str | None:
        for event in reversed(self.decision_trace):
            if event.get("event") == "planning_stopped" and isinstance(event.get("reason"), str):
                return event["reason"]
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "mechanism_id": self.mechanism_id,
            "task_id": self.task_id,
            "trace_id": self.trace_id,
            "attempt": self.attempt,
            "exclusions": sorted(self.exclusions),
            "participants": [item.to_dict() for item in self.participants],
            "total_predicted_cost": self.total_predicted_cost,
            "edges": [edge.to_dict() for edge in self.edges],
            "decision_trace": [_thaw_json(item) for item in self.decision_trace],
            "runtime_instructions": _thaw_json(self.runtime_instructions),
            "budget": self.budget.to_dict(),
            "terminal_status": self.terminal_status.value,
        }


@dataclass(frozen=True)
class AgentOutput:
    participant_id: str
    content: str
    marker: str
    evidence: Mapping[str, JsonValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in ("participant_id", "content", "marker"):
            object.__setattr__(self, name, _nonempty_string(getattr(self, name), name))
        object.__setattr__(self, "evidence", _freeze_json(_mapping(self.evidence, "evidence"), "evidence"))

    def to_dict(self) -> dict[str, Any]:
        return {"participant_id": self.participant_id, "content": self.content, "marker": self.marker, "evidence": _thaw_json(self.evidence)}


@dataclass(frozen=True)
class AttemptSummary:
    attempt: int
    status: TerminalStatus
    failed_participant_ids: tuple[str, ...] = ()
    usage: Mapping[str, JsonValue] = field(default_factory=dict)
    error: str | None = None
    outputs: tuple[AgentOutput, ...] = ()
    synthesis: str = ""
    runtime_evidence: Mapping[str, JsonValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if isinstance(self.attempt, bool) or not isinstance(self.attempt, int) or self.attempt < 0:
            raise ValueError("attempt must be a nonnegative integer")
        if not isinstance(self.status, TerminalStatus):
            object.__setattr__(self, "status", TerminalStatus(self.status))
        object.__setattr__(self, "failed_participant_ids", _string_tuple(self.failed_participant_ids, "failed_participant_ids", allow_empty=True))
        if self.error is not None:
            object.__setattr__(self, "error", _nonempty_string(self.error, "error"))
        outputs = tuple(self.outputs)
        if not all(isinstance(item, AgentOutput) for item in outputs):
            raise ValueError("outputs must contain AgentOutput values")
        object.__setattr__(self, "outputs", outputs)
        if not isinstance(self.synthesis, str):
            raise ValueError("synthesis must be a string")
        object.__setattr__(self, "runtime_evidence", _freeze_json(_mapping(self.runtime_evidence, "runtime_evidence"), "runtime_evidence"))
        object.__setattr__(self, "usage", _freeze_json(_mapping(self.usage, "usage"), "usage"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt": self.attempt,
            "status": self.status.value,
            "outputs": [item.to_dict() for item in self.outputs],
            "synthesis": self.synthesis,
            "runtime_evidence": _thaw_json(self.runtime_evidence),
            "failed_participant_ids": list(self.failed_participant_ids),
            "usage": _thaw_json(self.usage),
            "error": self.error,
        }


@dataclass(frozen=True)
class CoordinationResult:
    status: TerminalStatus
    plan: CoordinationPlan
    outputs: tuple[AgentOutput, ...] = ()
    synthesis: str = ""
    runtime_evidence: Mapping[str, JsonValue] = field(default_factory=dict)
    failed_participant_ids: tuple[str, ...] = ()
    attempts: tuple[AttemptSummary, ...] = ()
    usage: Mapping[str, JsonValue] = field(default_factory=dict)
    error: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.status, TerminalStatus):
            object.__setattr__(self, "status", TerminalStatus(self.status))
        if not isinstance(self.plan, CoordinationPlan):
            raise ValueError("plan must be a CoordinationPlan")
        outputs = tuple(self.outputs)
        if not all(isinstance(item, AgentOutput) for item in outputs):
            raise ValueError("outputs must contain AgentOutput values")
        object.__setattr__(self, "outputs", outputs)
        if not isinstance(self.synthesis, str):
            raise ValueError("synthesis must be a string")
        object.__setattr__(self, "failed_participant_ids", _string_tuple(self.failed_participant_ids, "failed_participant_ids", allow_empty=True))
        attempts = tuple(self.attempts)
        if not all(isinstance(item, AttemptSummary) for item in attempts):
            raise ValueError("attempts must contain AttemptSummary values")
        if len(attempts) > self.plan.budget.max_retries + 1:
            raise ValueError("attempt history exceeds plan retry bound")
        object.__setattr__(self, "attempts", attempts)
        if self.error is not None:
            object.__setattr__(self, "error", _nonempty_string(self.error, "error"))
        object.__setattr__(self, "runtime_evidence", _freeze_json(_mapping(self.runtime_evidence, "runtime_evidence"), "runtime_evidence"))
        object.__setattr__(self, "usage", _freeze_json(_mapping(self.usage, "usage"), "usage"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "plan": self.plan.to_dict(),
            "outputs": [item.to_dict() for item in self.outputs],
            "synthesis": self.synthesis,
            "runtime_evidence": _thaw_json(self.runtime_evidence),
            "failed_participant_ids": list(self.failed_participant_ids),
            "attempts": [item.to_dict() for item in self.attempts],
            "usage": _thaw_json(self.usage),
            "error": self.error,
        }
