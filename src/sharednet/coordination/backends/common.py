"""Shared deterministic selection and plan-construction helpers."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

from ..costs import fits_cost_budget
from ..models import Candidate, CoordinationPlan, CoordinationRequest, GraphEdge, JsonValue, ParticipantPlan, TerminalStatus
from ..primitives import candidate_utility


def eligibility_trace(request: CoordinationRequest, excluded: frozenset[str]) -> tuple[tuple[Candidate, ...], list[dict[str, str]]]:
    """Filter before scoring and retain attributable admission decisions."""
    eligible: list[Candidate] = []
    trace: list[dict[str, str]] = []
    for candidate in request.candidates:
        if not candidate.admitted:
            trace.append(
                {
                    "event": "candidate_rejected",
                    "candidate_id": candidate.candidate_id,
                    "reason": "not_admitted",
                    "admission_reason": candidate.admission_reason,
                }
            )
        elif candidate.candidate_id in excluded:
            trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "attempt_excluded"})
        elif not fits_cost_budget(0, candidate.predicted_cost, request.budget.max_cost):
            trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "individual_cost_exceeds_budget"})
        else:
            eligible.append(candidate)
            trace.append({"event": "candidate_considered", "candidate_id": candidate.candidate_id})
    return tuple(eligible), trace


def empty_eligibility_stop_reason(trace: Sequence[Mapping[str, str]]) -> str:
    """Distinguish policy/search emptiness from hard individual-cost rejection."""
    if any(event.get("reason") == "individual_cost_exceeds_budget" for event in trace):
        return "cost_budget_exhausted"
    return "no_eligible_candidates"


def eligible_candidates(request: CoordinationRequest, excluded: frozenset[str] = frozenset()) -> tuple[Candidate, ...]:
    """Return only admitted candidates that are not attempt-local exclusions."""
    return eligibility_trace(request, excluded)[0]


def ranked_candidates(candidates: Iterable[Candidate], *, coordination_overhead: float = 0.0) -> tuple[Candidate, ...]:
    """Rank already-admitted candidates with stable candidate-ID tie breaking."""
    return tuple(sorted(candidates, key=lambda candidate: (-candidate_utility(candidate, coordination_overhead), candidate.candidate_id)))


def required_coverage(candidate: Candidate, required: Sequence[str]) -> tuple[str, ...]:
    """Keep only task-required capabilities in the candidate's declared order."""
    required_set = set(required)
    return tuple(capability for capability in candidate.capabilities if capability in required_set)


def contribution_score(candidate: Candidate, uncovered: set[str]) -> float:
    """Prefer useful candidates whose declared skills reduce remaining uncertainty."""
    return candidate_utility(candidate) * len(set(candidate.capabilities) & uncovered)


def select_parent(candidate: Candidate, selected: Sequence[Candidate]) -> Candidate:
    """Choose an existing node by capability overlap, utility, then ID."""
    candidate_capabilities = set(candidate.capabilities)
    return min(
        selected,
        key=lambda parent: (
            -len(candidate_capabilities & set(parent.capabilities)),
            -candidate_utility(parent),
            parent.candidate_id,
        ),
    )


def participant_depth(candidate_id: str, participants: Sequence[ParticipantPlan]) -> int:
    """Return the existing dependency depth for a selected participant."""
    dependencies = {participant.candidate_id: participant.dependencies for participant in participants}
    parents = dependencies[candidate_id]
    return 0 if not parents else 1 + max(participant_depth(parent, participants) for parent in parents)


def participant(candidate: Candidate, *, role: str, assignment: str, dependencies: tuple[str, ...] = (), reason: str = "selected") -> ParticipantPlan:
    return ParticipantPlan(
        candidate_id=candidate.candidate_id,
        role=role,
        assignment=assignment,
        dependencies=dependencies,
        selection_reason=reason,
        capabilities=candidate.capabilities,
        predicted_cost=candidate.predicted_cost,
        mode=candidate.mode,
    )


def add_edge(trace: list[dict[str, str]], edges: list[GraphEdge], source: str, target: str, relation: str) -> None:
    edges.append(GraphEdge(source, target, relation))
    trace.append({"event": "edge_added", "source": source, "target": target, "relation": relation})


def make_plan(
    mechanism_id: str,
    request: CoordinationRequest,
    excluded: frozenset[str],
    participants: Sequence[ParticipantPlan],
    edges: Sequence[GraphEdge],
    trace: list[dict[str, str]],
    runtime_instructions: Mapping[str, JsonValue],
    terminal_status: TerminalStatus = TerminalStatus.ACCEPTED,
) -> CoordinationPlan:
    return CoordinationPlan(
        mechanism_id=mechanism_id,
        task_id=request.task.task_id,
        trace_id=request.trace_id,
        attempt=0,
        exclusions=excluded,
        participants=tuple(participants),
        edges=tuple(edges),
        decision_trace=tuple(trace),
        runtime_instructions={**runtime_instructions, "task": request.task.to_dict()},
        budget=request.budget,
        terminal_status=terminal_status,
    )


def abstained_plan(mechanism_id: str, request: CoordinationRequest, excluded: frozenset[str], trace: list[dict[str, str]], reason: str) -> CoordinationPlan:
    trace.append({"event": "planning_stopped", "reason": reason})
    return make_plan(
        mechanism_id,
        request,
        excluded,
        (),
        (),
        trace,
        {"reason": reason},
        TerminalStatus.ABSTAINED,
    )
