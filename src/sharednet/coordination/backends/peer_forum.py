"""Complementary peer selection with append-only forum instructions."""

from __future__ import annotations

from ..costs import fits_cost_budget, sum_costs
from ..models import CandidateMode, CoordinationPlan, CoordinationRequest, GraphEdge, ParticipantPlan
from .common import abstained_plan, add_edge, contribution_score, eligibility_trace, empty_eligibility_stop_reason, make_plan, participant, ranked_candidates


class PeerForumBackend:
    """Select complementary peers with the runtime root as designated integrator."""

    mechanism_id = "peer-forum"

    def plan(self, request: CoordinationRequest, *, excluded: frozenset[str] = frozenset()) -> CoordinationPlan:
        eligible, trace = eligibility_trace(request, excluded)
        if not eligible:
            return abstained_plan(self.mechanism_id, request, excluded, trace, empty_eligibility_stop_reason(trace))

        uncovered = set(request.task.required_capabilities)
        self_candidates = [candidate for candidate in eligible if candidate.mode is CandidateMode.SELF]
        integrator = ranked_candidates(self_candidates)[0] if self_candidates else None
        selected = [integrator] if integrator is not None else []
        if integrator is not None:
            uncovered -= set(integrator.capabilities)
            trace.append({"event": "candidate_selected", "candidate_id": integrator.candidate_id, "reason": "accountable_requester_integrator"})
        selected_cost = sum_costs((integrator.predicted_cost,)) if integrator is not None else sum_costs(())
        while len(selected) < request.budget.max_participants:
            choices = [candidate for candidate in eligible if candidate not in selected and contribution_score(candidate, uncovered) > 0]
            if not choices:
                break
            affordable_choices = [candidate for candidate in choices if fits_cost_budget(selected_cost, candidate.predicted_cost, request.budget.max_cost)]
            for candidate in choices:
                if candidate not in affordable_choices:
                    trace.append({"event": "candidate_rejected", "candidate_id": candidate.candidate_id, "reason": "cumulative_cost_exceeds_budget"})
            if not affordable_choices:
                break
            choice = min(affordable_choices, key=lambda candidate: (-contribution_score(candidate, uncovered), candidate.candidate_id))
            selected.append(choice)
            selected_cost = sum_costs((selected_cost, choice.predicted_cost))
            uncovered -= set(choice.capabilities)
            trace.append({"event": "candidate_selected", "candidate_id": choice.candidate_id, "reason": "complementary_coverage"})
        if not selected:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "no_positive_information_gain")

        integrator = integrator or ranked_candidates(selected)[0]
        peers = [candidate for candidate in selected if candidate.candidate_id != integrator.candidate_id]
        participants: list[ParticipantPlan] = []
        edges: list[GraphEdge] = []
        dependencies = tuple(candidate.candidate_id for candidate in peers)
        participants.append(participant(integrator, role="integrator", assignment="synthesize peer contributions", dependencies=dependencies, reason="designated_integrator"))
        for candidate in peers:
            participants.append(participant(candidate, role="peer", assignment="contribute an independent perspective", reason="complementary_coverage"))
        for peer_id in dependencies:
            add_edge(trace, edges, peer_id, integrator.candidate_id, "contributes_to")
        if not uncovered:
            stop_reason = "coverage_complete"
        elif len(selected) >= request.budget.max_participants:
            stop_reason = "participant_limit_reached"
        elif any(event.get("reason") == "cumulative_cost_exceeds_budget" for event in trace):
            stop_reason = "cost_budget_exhausted"
        else:
            stop_reason = "no_positive_information_gain"
        trace.append({"event": "planning_stopped", "reason": stop_reason})
        return make_plan(
            self.mechanism_id,
            request,
            excluded,
            participants,
            edges,
            trace,
            {"coordination": "append-only-forum", "forum_discipline": "announce-focus-challenge-extend-preserve-authorship"},
        )
