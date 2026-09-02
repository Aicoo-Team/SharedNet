"""Deterministic candidate snapshots for coordination backend tests."""

from __future__ import annotations

from sharednet.coordination.models import Candidate, CandidateMode, CoordinationBudget, CoordinationRequest, TaskSpec


def _candidate(candidate_id: str, mode: CandidateMode, capabilities: tuple[str, ...], *, quality: float = 0.8, admitted: bool = True) -> Candidate:
    return Candidate(
        candidate_id=candidate_id,
        mode=mode,
        capabilities=capabilities,
        admitted=admitted,
        admission_reason="trusted" if admitted else "policy_denied",
        predicted_quality=quality,
        predicted_cost=0.1,
        predicted_latency=0.1,
        predicted_risk=0.1,
    )


def four_agent_request(*, mechanism: str, include_denied_superstar: bool = False) -> CoordinationRequest:
    candidates = [
        _candidate("self", CandidateMode.SELF, ("research",), quality=0.9),
        _candidate("architect", CandidateMode.RECRUIT, ("architecture",), quality=0.7),
        _candidate("risk-analyst", CandidateMode.RECRUIT, ("risk",), quality=0.7),
        _candidate("generalist", CandidateMode.RECRUIT, ("research", "architecture", "risk", "synthesis"), quality=0.42),
    ]
    if include_denied_superstar:
        candidates.append(
            _candidate(
                "denied-superstar",
                CandidateMode.RECRUIT,
                ("research", "architecture", "risk", "synthesis"),
                quality=1.0,
                admitted=False,
            )
        )
    return CoordinationRequest(
        task=TaskSpec(
            "four-agent-task",
            "Investigate and synthesize the incident.",
            ("research", "architecture", "risk", "synthesis"),
            ("complete coverage",),
            {},
        ),
        candidates=tuple(candidates),
        budget=CoordinationBudget(max_participants=4, max_cost=1.0),
        mechanism=mechanism,
        trace_id="trace-four-agent",
    )


def linear_request() -> CoordinationRequest:
    return CoordinationRequest(
        task=TaskSpec("linear-task", "Summarize the local report.", ("research",), ("complete",), {}),
        candidates=(
            _candidate("self", CandidateMode.SELF, ("research",), quality=0.9),
            _candidate("helper", CandidateMode.RECRUIT, ("research",), quality=0.35),
        ),
        budget=CoordinationBudget(),
        mechanism="rac-adaptive",
        trace_id="trace-linear",
    )


def specialist_request() -> CoordinationRequest:
    return CoordinationRequest(
        task=TaskSpec("specialist-task", "Assess a specialized issue.", ("analysis",), ("complete",), {}),
        candidates=(
            _candidate("self", CandidateMode.SELF, ("coordination",), quality=0.6),
            _candidate("specialist-a", CandidateMode.RECRUIT, ("analysis",), quality=0.9),
            _candidate("specialist-b", CandidateMode.RECRUIT, ("analysis",), quality=0.8),
        ),
        budget=CoordinationBudget(),
        mechanism="rac-adaptive",
        trace_id="trace-specialist",
    )
