"""Smallest-path specialist discovery planner."""

from __future__ import annotations

from ..models import CandidateMode, CoordinationPlan, CoordinationRequest, GraphEdge, ParticipantPlan
from .common import abstained_plan, add_edge, cost_fits_budget, eligibility_trace, make_plan, participant, ranked_candidates, required_coverage


class DiscoveryAndUseBackend:
    """Select one complete-coverage specialist, retaining the requester when needed."""

    mechanism_id = "discovery-and-use"
    _SELF_INTEGRATION_REASON = "accountable_requester_integrator_consumes_specialist_output"

    def plan(self, request: CoordinationRequest, *, excluded: frozenset[str] = frozenset()) -> CoordinationPlan:
        requester = next(
            (candidate for candidate in request.candidates if candidate.mode is CandidateMode.SELF and candidate.admitted),
            None,
        )
        eligible, trace = eligibility_trace(request, excluded)
        if requester is not None:
            if requester.candidate_id in excluded:
                return abstained_plan(self.mechanism_id, request, excluded, trace, "requester_excluded")
            if not cost_fits_budget(0, requester.predicted_cost, request.budget.max_cost):
                return abstained_plan(self.mechanism_id, request, excluded, trace, "cost_budget_exhausted")
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

        compatible_specialists = []
        for candidate in specialists:
            if (
                requester is not None
                and candidate.candidate_id != requester.candidate_id
                and not cost_fits_budget(candidate.predicted_cost, requester.predicted_cost, request.budget.max_cost)
            ):
                trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "cumulative_cost_exceeds_budget"})
            else:
                compatible_specialists.append(candidate)
        if not compatible_specialists:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "cost_budget_exhausted")

        selected = ranked_candidates(compatible_specialists)[0]
        if (
            requester is not None
            and requester.candidate_id != selected.candidate_id
            and request.budget.max_participants < 2
        ):
            return abstained_plan(self.mechanism_id, request, excluded, trace, "participant_limit_reached")
        trace.append({"event": "candidate_selected", "candidate_id": selected.candidate_id, "reason": "complete_coverage_specialist"})
        participants: list[ParticipantPlan] = []
        edges: list[GraphEdge] = []
        if (
            requester is not None
            and requester.candidate_id != selected.candidate_id
        ):
            participants.append(
                participant(
                    requester,
                    role="requester-integrator",
                    assignment="retain accountability and integrate recruited specialist output",
                    reason=self._SELF_INTEGRATION_REASON,
                )
            )
            trace.append({"event": "candidate_selected", "candidate_id": requester.candidate_id, "reason": self._SELF_INTEGRATION_REASON})
            participants.append(participant(selected, role="specialist", assignment="complete the task", dependencies=(requester.candidate_id,), reason="complete_coverage_specialist"))
            add_edge(trace, edges, requester.candidate_id, selected.candidate_id, "delegates")
        else:
            participants.append(participant(selected, role="specialist", assignment="complete the task", reason="complete_coverage_specialist"))
        trace.append({"event": "planning_stopped", "reason": "complete_coverage_selected"})
        return make_plan(self.mechanism_id, request, excluded, participants, edges, trace, {"coordination": "specialist-use"})
