"""Marginal-utility adaptive RAC planner."""

from __future__ import annotations

from ..models import CandidateMode, CoordinationPlan, CoordinationRequest, GraphEdge, ParticipantPlan
from ..primitives import candidate_utility
from .common import abstained_plan, add_edge, eligibility_trace, make_plan, participant, participant_depth, ranked_candidates, select_parent


class RacAdaptiveBackend:
    """Keep short work local and add only positive marginal utility participants."""

    mechanism_id = "rac-adaptive"
    coordination_overhead = 0.10

    def plan(self, request: CoordinationRequest, *, excluded: frozenset[str] = frozenset()) -> CoordinationPlan:
        eligible, trace = eligibility_trace(request, excluded)
        if not eligible:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "no_eligible_candidates")

        self_candidate = next((candidate for candidate in eligible if candidate.mode is CandidateMode.SELF), None)
        root = self_candidate or ranked_candidates(eligible)[0]
        selected = [root]
        participants: list[ParticipantPlan] = [participant(root, role="root", assignment="coordinate the task", reason="requester_root" if self_candidate else "best_available_root")]
        edges: list[GraphEdge] = []
        trace.append({"event": "candidate_selected", "candidate_id": root.candidate_id, "reason": "requester_root" if self_candidate else "best_available_root"})
        uncovered = set(request.task.required_capabilities) - set(root.capabilities)
        added = False
        for candidate in ranked_candidates(candidate for candidate in eligible if candidate.candidate_id != root.candidate_id):
            if len(selected) >= request.budget.max_participants:
                trace.append({"event": "planning_stopped", "reason": "participant_limit_reached"})
                break
            if not (set(candidate.capabilities) & uncovered):
                trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "no_new_capability_coverage"})
                continue
            if candidate_utility(candidate, self.coordination_overhead) <= 0:
                trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "no_positive_marginal_utility"})
                continue
            available_parents = [item for item in selected if participant_depth(item.candidate_id, participants) < request.budget.max_depth]
            if not available_parents:
                trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "maximum_depth_reached"})
                continue
            parent = select_parent(candidate, available_parents)
            selected.append(candidate)
            participants.append(participant(candidate, role="worker", assignment="cover independent capability", dependencies=(parent.candidate_id,), reason="positive_marginal_utility"))
            trace.append({"event": "candidate_selected", "candidate_id": candidate.candidate_id, "reason": "positive_marginal_utility"})
            add_edge(trace, edges, parent.candidate_id, candidate.candidate_id, "delegates")
            uncovered -= set(candidate.capabilities)
            added = True
            if not uncovered:
                break
        trace.append({"event": "planning_stopped", "reason": "coverage_complete" if not uncovered and added else "no_positive_marginal_utility"})
        return make_plan(self.mechanism_id, request, excluded, participants, edges, trace, {"coordination": "marginal-utility"})
