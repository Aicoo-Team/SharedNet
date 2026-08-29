"""Complementary peer selection with append-only forum instructions."""

from __future__ import annotations

from ..models import CandidateMode, CoordinationPlan, CoordinationRequest, GraphEdge, ParticipantPlan
from .common import abstained_plan, add_edge, contribution_score, eligibility_trace, make_plan, participant, ranked_candidates


class PeerForumBackend:
    """Select complementary peers and place one admitted integrator last."""

    mechanism_id = "peer-forum"

    def plan(self, request: CoordinationRequest, *, excluded: frozenset[str] = frozenset()) -> CoordinationPlan:
        eligible, trace = eligibility_trace(request, excluded)
        if not eligible:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "no_eligible_candidates")

        uncovered = set(request.task.required_capabilities)
        self_candidates = [candidate for candidate in eligible if candidate.mode is CandidateMode.SELF]
        integrator = ranked_candidates(self_candidates)[0] if self_candidates else None
        selected = [integrator] if integrator is not None else []
        if integrator is not None:
            uncovered -= set(integrator.capabilities)
            trace.append({"event": "candidate_selected", "candidate_id": integrator.candidate_id, "reason": "accountable_requester_integrator"})
        while len(selected) < request.budget.max_participants:
            choices = [candidate for candidate in eligible if candidate not in selected and contribution_score(candidate, uncovered) > 0]
            if not choices:
                break
            choice = min(choices, key=lambda candidate: (-contribution_score(candidate, uncovered), candidate.candidate_id))
            selected.append(choice)
            uncovered -= set(choice.capabilities)
            trace.append({"event": "candidate_selected", "candidate_id": choice.candidate_id, "reason": "complementary_coverage"})
        if not selected:
            return abstained_plan(self.mechanism_id, request, excluded, trace, "no_positive_information_gain")

        integrator = integrator or ranked_candidates(selected)[0]
        ordered = [candidate for candidate in selected if candidate.candidate_id != integrator.candidate_id] + [integrator]
        participants: list[ParticipantPlan] = []
        edges: list[GraphEdge] = []
        for candidate in ordered[:-1]:
            participants.append(participant(candidate, role="peer", assignment="contribute an independent perspective", reason="complementary_coverage"))
        dependencies = tuple(candidate.candidate_id for candidate in ordered[:-1])
        participants.append(participant(integrator, role="integrator", assignment="synthesize peer contributions", dependencies=dependencies, reason="designated_integrator"))
        for peer_id in dependencies:
            add_edge(trace, edges, peer_id, integrator.candidate_id, "contributes_to")
        trace.append({"event": "planning_stopped", "reason": "coverage_complete" if not uncovered else "no_positive_information_gain"})
        return make_plan(
            self.mechanism_id,
            request,
            excluded,
            participants,
            edges,
            trace,
            {"coordination": "append-only-forum", "forum_discipline": "announce-focus-challenge-extend-preserve-authorship"},
        )
