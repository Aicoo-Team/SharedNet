"""Smallest-path specialist discovery planner."""

from __future__ import annotations

from ..models import CandidateMode, CoordinationPlan, CoordinationRequest, GraphEdge, ParticipantPlan
from .common import abstained_plan, add_edge, eligibility_trace, make_plan, participant, ranked_candidates, required_coverage


class DiscoveryAndUseBackend:
    """Select one complete-coverage specialist, retaining the requester when needed."""

    mechanism_id = "discovery-and-use"

    def plan(self, request: CoordinationRequest, *, excluded: frozenset[str] = frozenset()) -> CoordinationPlan:
        eligible, trace = eligibility_trace(request, excluded)
        if not eligible:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "no_eligible_candidates")

        required = request.task.required_capabilities
        specialists = []
        for candidate in eligible:
            if set(required_coverage(candidate, required)) == set(required):
                specialists.append(candidate)
            else:
                trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "incomplete_capability_coverage"})
        if not specialists:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "no_complete_coverage_candidate")

        selected = ranked_candidates(specialists)[0]
        trace.append({"event": "candidate_selected", "candidate_id": selected.candidate_id, "reason": "complete_coverage_specialist"})
        participants: list[ParticipantPlan] = []
        edges: list[GraphEdge] = []
        requester = next((candidate for candidate in eligible if candidate.mode is CandidateMode.SELF), None)
        if requester is not None and requester.candidate_id != selected.candidate_id and request.budget.max_participants > 1:
            participants.append(participant(requester, role="requester", assignment="provide task context", reason="requester_context"))
            trace.append({"event": "candidate_selected", "candidate_id": requester.candidate_id, "reason": "requester_context"})
            participants.append(participant(selected, role="specialist", assignment="complete the task", dependencies=(requester.candidate_id,), reason="complete_coverage_specialist"))
            add_edge(trace, edges, requester.candidate_id, selected.candidate_id, "delegates")
        else:
            participants.append(participant(selected, role="specialist", assignment="complete the task", reason="complete_coverage_specialist"))
        trace.append({"event": "planning_stopped", "reason": "complete_coverage_selected"})
        return make_plan(self.mechanism_id, request, excluded, participants, edges, trace, {"coordination": "specialist-use"})
