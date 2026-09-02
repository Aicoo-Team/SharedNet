"""Greedy organization-graph expansion planner."""

from __future__ import annotations

from ..costs import fits_cost_budget, sum_costs
from ..models import Candidate, CoordinationPlan, CoordinationRequest, GraphEdge, ParticipantPlan
from .common import abstained_plan, add_edge, contribution_score, eligibility_trace, empty_eligibility_stop_reason, make_plan, participant, participant_depth, select_parent


class RacRgeBackend:
    """Build a bounded graph by expanding positive, uncovered capability value."""

    mechanism_id = "rac-rge"

    def plan(self, request: CoordinationRequest, *, excluded: frozenset[str] = frozenset()) -> CoordinationPlan:
        eligible, trace = eligibility_trace(request, excluded)
        if not eligible:
            return abstained_plan(self.mechanism_id, request, excluded, trace, empty_eligibility_stop_reason(trace))

        required = set(request.task.required_capabilities)
        root_candidates: list[Candidate] = []
        for candidate in eligible:
            if contribution_score(candidate, required) > 0:
                root_candidates.append(candidate)
            else:
                trace.append(
                    {
                        "event": "candidate_rejected",
                        "candidate_id": candidate.candidate_id,
                        "reason": "no_positive_task_contribution",
                    }
                )
        if not root_candidates:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "no_positive_information_gain")

        root = min(
            root_candidates,
            key=lambda candidate: (
                -contribution_score(candidate, required),
                -len(set(candidate.capabilities) & required),
                candidate.candidate_id,
            ),
        )
        selected = [root]
        participants: list[ParticipantPlan] = [participant(root, role="root", assignment="coordinate the task", reason="strongest_task_contribution_root")]
        edges: list[GraphEdge] = []
        trace.append({"event": "candidate_selected", "candidate_id": root.candidate_id, "reason": "strongest_task_contribution_root"})
        uncovered = required - set(root.capabilities)
        selected_cost = sum_costs((root.predicted_cost,))

        while uncovered and len(selected) < request.budget.max_participants:
            choices = [candidate for candidate in eligible if candidate not in selected and contribution_score(candidate, uncovered) > 0]
            affordable_choices = [candidate for candidate in choices if fits_cost_budget(selected_cost, candidate.predicted_cost, request.budget.max_cost)]
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
            selected_cost = sum_costs((selected_cost, choice.predicted_cost))
            participants.append(participant(choice, role="worker", assignment="cover assigned capabilities", dependencies=(parent.candidate_id,), reason="positive_information_gain"))
            trace.append({"event": "candidate_selected", "candidate_id": choice.candidate_id, "reason": "positive_information_gain"})
            add_edge(trace, edges, parent.candidate_id, choice.candidate_id, "delegates")
            uncovered -= set(choice.capabilities)
        else:
            trace.append({"event": "planning_stopped", "reason": "coverage_complete" if not uncovered else "participant_limit_reached"})
        return make_plan(self.mechanism_id, request, excluded, participants, edges, trace, {"coordination": "organization-graph"})
