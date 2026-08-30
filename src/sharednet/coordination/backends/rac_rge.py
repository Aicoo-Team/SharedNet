"""Greedy organization-graph expansion planner."""

from __future__ import annotations

from ..models import CoordinationPlan, CoordinationRequest, GraphEdge, ParticipantPlan
from .common import abstained_plan, add_edge, contribution_score, cost_fits_budget, eligibility_trace, make_plan, participant, participant_depth, ranked_candidates, select_parent


class RacRgeBackend:
    """Build a bounded graph by expanding positive, uncovered capability value."""

    mechanism_id = "rac-rge"

    def plan(self, request: CoordinationRequest, *, excluded: frozenset[str] = frozenset()) -> CoordinationPlan:
        eligible, trace = eligibility_trace(request, excluded)
        if not eligible:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "no_eligible_candidates")

        root = ranked_candidates(eligible)[0]
        selected = [root]
        participants: list[ParticipantPlan] = [participant(root, role="root", assignment="coordinate the task", reason="strongest_generalist_root")]
        edges: list[GraphEdge] = []
        trace.append({"event": "candidate_selected", "candidate_id": root.candidate_id, "reason": "strongest_generalist_root"})
        uncovered = set(request.task.required_capabilities) - set(root.capabilities)
        selected_cost = root.predicted_cost

        while uncovered and len(selected) < request.budget.max_participants:
            choices = [candidate for candidate in eligible if candidate not in selected and contribution_score(candidate, uncovered) > 0]
            affordable_choices = [candidate for candidate in choices if cost_fits_budget(selected_cost, candidate.predicted_cost, request.budget.max_cost)]
            for candidate in choices:
                if candidate not in affordable_choices:
                    trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "cumulative_cost_exceeds_budget"})
            if not affordable_choices:
                trace.append({"event": "planning_stopped", "reason": "cost_budget_exhausted" if choices else "no_positive_information_gain"})
                break
            choice = min(affordable_choices, key=lambda candidate: (-contribution_score(candidate, uncovered), -len(set(candidate.capabilities) & uncovered), candidate.candidate_id))
            available_parents = [candidate for candidate in selected if participant_depth(candidate.candidate_id, participants) < request.budget.max_depth]
            if not available_parents:
                trace.append({"event": "candidate_rejected", "candidate_id": choice.candidate_id, "reason": "maximum_depth_reached"})
                eligible = tuple(candidate for candidate in eligible if candidate.candidate_id != choice.candidate_id)
                continue
            parent = select_parent(choice, available_parents)
            selected.append(choice)
            selected_cost += choice.predicted_cost
            participants.append(participant(choice, role="worker", assignment="cover assigned capabilities", dependencies=(parent.candidate_id,), reason="positive_information_gain"))
            trace.append({"event": "candidate_selected", "candidate_id": choice.candidate_id, "reason": "positive_information_gain"})
            add_edge(trace, edges, parent.candidate_id, choice.candidate_id, "delegates")
            uncovered -= set(choice.capabilities)
        else:
            trace.append({"event": "planning_stopped", "reason": "coverage_complete" if not uncovered else "participant_limit_reached"})
        return make_plan(self.mechanism_id, request, excluded, participants, edges, trace, {"coordination": "organization-graph"})
