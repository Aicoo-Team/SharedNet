"""Behavioral tests for default coordination planners."""

from __future__ import annotations

import unittest

from sharednet.coordination.backends.discovery_and_use import DiscoveryAndUseBackend
from sharednet.coordination.backends.peer_forum import PeerForumBackend
from sharednet.coordination.backends.rac_adaptive import RacAdaptiveBackend
from sharednet.coordination.backends.rac_rge import RacRgeBackend
from sharednet.coordination.models import Candidate, CandidateMode, CoordinationBudget, CoordinationRequest, TaskSpec, TerminalStatus
from tests.fixtures import four_agent_request, linear_request, specialist_request


class BackendTests(unittest.TestCase):
    @staticmethod
    def _request(
        mechanism: str,
        candidates: tuple[Candidate, ...],
        capabilities: tuple[str, ...],
        *,
        max_cost: float,
        max_participants: int = 4,
    ) -> CoordinationRequest:
        return CoordinationRequest(
            TaskSpec("cost-task", "Cover the requested work.", capabilities, (), {}),
            candidates,
            CoordinationBudget(max_cost=max_cost, max_participants=max_participants),
            mechanism,
            "trace-cost",
        )

    @staticmethod
    def _candidate(candidate_id: str, capabilities: tuple[str, ...], quality: float, cost: float, mode: CandidateMode = CandidateMode.RECRUIT) -> Candidate:
        return Candidate(candidate_id, mode, capabilities, True, "trusted", quality, cost, 0.1, 0.1)

    def test_unaffordable_superstar_is_rejected_before_discovery_ranking(self) -> None:
        request = self._request(
            "discovery-and-use",
            (
                self._candidate("self", ("accountability",), 0.5, 0.1, CandidateMode.SELF),
                self._candidate("unaffordable-superstar", ("analysis",), 1.0, 1.1),
                self._candidate("affordable-specialist", ("analysis",), 0.3, 0.4),
            ),
            ("analysis",),
            max_cost=1.0,
        )

        plan = DiscoveryAndUseBackend().plan(request)

        self.assertNotIn("unaffordable-superstar", plan.participant_ids)
        self.assertIn("affordable-specialist", plan.participant_ids)
        self.assertIn(
            {"event": "candidate_rejected", "candidate_id": "unaffordable-superstar", "reason": "individual_cost_exceeds_budget"},
            plan.decision_trace,
        )

    def test_discovery_chooses_lower_ranked_specialist_that_fits_required_requester(self) -> None:
        request = self._request(
            "discovery-and-use",
            (
                self._candidate("self", ("accountability",), 0.5, 0.3, CandidateMode.SELF),
                self._candidate("unaffordable-best", ("analysis",), 1.0, 0.8),
                self._candidate("affordable-second", ("analysis",), 0.8, 0.6),
            ),
            ("analysis",),
            max_cost=0.9,
        )

        plan = DiscoveryAndUseBackend().plan(request)

        self.assertEqual(plan.participant_ids, ("self", "affordable-second"))
        self.assertIn(
            {"event": "candidate_rejected", "candidate_id": "unaffordable-best", "reason": "cumulative_cost_exceeds_budget"},
            plan.decision_trace,
        )

    def test_discovery_abstains_when_no_specialist_fits_required_requester(self) -> None:
        request = self._request(
            "discovery-and-use",
            (
                self._candidate("self", ("accountability",), 0.5, 0.3, CandidateMode.SELF),
                self._candidate("specialist", ("analysis",), 0.8, 0.7),
            ),
            ("analysis",),
            max_cost=0.9,
        )

        plan = DiscoveryAndUseBackend().plan(request)

        self.assertEqual(plan.terminal_status, TerminalStatus.ABSTAINED)
        self.assertEqual(plan.stop_reason, "cost_budget_exhausted")
        self.assertEqual(plan.participants, ())

    def test_discovery_abstains_when_participant_limit_cannot_preserve_requester(self) -> None:
        request = self._request(
            "discovery-and-use",
            (
                self._candidate("self", ("accountability",), 0.5, 0.1, CandidateMode.SELF),
                self._candidate("specialist", ("analysis",), 0.8, 0.1),
            ),
            ("analysis",),
            max_cost=1.0,
            max_participants=1,
        )

        plan = DiscoveryAndUseBackend().plan(request)

        self.assertEqual(plan.terminal_status, TerminalStatus.ABSTAINED)
        self.assertEqual(plan.stop_reason, "participant_limit_reached")

    def test_every_planner_stops_at_cumulative_cost_budget(self) -> None:
        candidates = (
            self._candidate("self", ("a",), 1.0, 0.5, CandidateMode.SELF),
            self._candidate("b-worker", ("b",), 0.95, 0.5),
            self._candidate("c-worker", ("c",), 0.94, 0.5),
        )
        for mechanism, backend in (
            ("rac-rge", RacRgeBackend()),
            ("rac-adaptive", RacAdaptiveBackend()),
            ("peer-forum", PeerForumBackend()),
        ):
            with self.subTest(mechanism=mechanism):
                plan = backend.plan(self._request(mechanism, candidates, ("a", "b", "c"), max_cost=1.0))
                self.assertEqual(plan.total_predicted_cost, 1.0)
                self.assertEqual(plan.stop_reason, "cost_budget_exhausted")
                self.assertNotIn("c-worker", plan.participant_ids)

    def test_adaptive_and_forum_report_participant_limit_with_uncovered_work(self) -> None:
        candidates = (
            self._candidate("self", ("a",), 0.9, 0.1, CandidateMode.SELF),
            self._candidate("b-worker", ("b",), 0.8, 0.1),
        )
        for mechanism, backend in (("rac-adaptive", RacAdaptiveBackend()), ("peer-forum", PeerForumBackend())):
            with self.subTest(mechanism=mechanism):
                plan = backend.plan(self._request(mechanism, candidates, ("a", "b"), max_cost=1.0, max_participants=1))
                self.assertEqual(plan.stop_reason, "participant_limit_reached")

    def test_adaptive_reports_no_utility_before_cost_for_a_costly_unhelpful_candidate(self) -> None:
        request = self._request(
            "rac-adaptive",
            (
                self._candidate("self", ("a",), 0.9, 0.1, CandidateMode.SELF),
                self._candidate("unhelpful-worker", ("b",), 0.1, 0.5),
            ),
            ("a", "b"),
            max_cost=0.5,
        )

        plan = RacAdaptiveBackend().plan(request)

        self.assertEqual(plan.stop_reason, "no_positive_marginal_utility")
        self.assertIn(
            {"event": "candidate_rejected", "candidate_id": "unhelpful-worker", "reason": "no_positive_marginal_utility"},
            plan.decision_trace,
        )
    def test_discovery_filters_denied_candidate_before_ranking(self) -> None:
        request = four_agent_request(mechanism="discovery-and-use", include_denied_superstar=True)
        plan = DiscoveryAndUseBackend().plan(request)
        self.assertNotIn("denied-superstar", plan.participant_ids)
        self.assertEqual(plan.participant_ids, ("self", "generalist"))

    def test_rge_builds_four_node_graph_for_complementary_capabilities(self) -> None:
        plan = RacRgeBackend().plan(four_agent_request(mechanism="rac-rge"))
        self.assertEqual(len(plan.participants), 4)
        self.assertEqual(len(plan.edges), 3)
        self.assertEqual(set(plan.covered_capabilities), {"research", "architecture", "risk", "synthesis"})

    def test_adaptive_keeps_short_linear_task_with_self(self) -> None:
        plan = RacAdaptiveBackend().plan(linear_request())
        self.assertEqual(plan.participant_ids, ("self",))
        self.assertIn("no_positive_marginal_utility", plan.stop_reason)

    def test_adaptive_excludes_failed_candidate_on_replan(self) -> None:
        request = specialist_request()
        plan = RacAdaptiveBackend().plan(request, excluded=frozenset({"specialist-a"}))
        self.assertIn("specialist-b", plan.participant_ids)
        self.assertNotIn("specialist-a", plan.participant_ids)

    def test_peer_forum_selects_complementary_peers_and_integrator(self) -> None:
        plan = PeerForumBackend().plan(four_agent_request(mechanism="peer-forum"))
        self.assertEqual(len(plan.participants), 4)
        self.assertEqual(plan.runtime_instructions["coordination"], "append-only-forum")
        self.assertEqual(plan.participants[-1].role, "integrator")

    def test_peer_forum_keeps_admitted_self_as_final_integrator_when_generalist_covers_task(self) -> None:
        request = CoordinationRequest(
            TaskSpec("forum-accountability", "Synthesize findings.", ("research", "risk"), (), {}),
            (
                Candidate("self", CandidateMode.SELF, ("accountability",), True, "trusted", 0.4, 0.1, 0.1, 0.1),
                Candidate("generalist", CandidateMode.RECRUIT, ("research", "risk"), True, "trusted", 0.9, 0.1, 0.1, 0.1),
            ),
            CoordinationBudget(max_participants=2),
            "peer-forum",
            "trace-forum-accountability",
        )

        plan = PeerForumBackend().plan(request)

        self.assertEqual(plan.participant_ids, ("generalist", "self"))
        self.assertEqual(plan.participants[-1].role, "integrator")


    def test_empty_eligible_set_abstains_with_inspectable_reason(self) -> None:
        request = four_agent_request(mechanism="rac-rge", include_denied_superstar=True)
        plan = RacRgeBackend().plan(request, excluded=frozenset(candidate.candidate_id for candidate in request.candidates if candidate.admitted))
        self.assertEqual(plan.participants, ())
        self.assertEqual(plan.terminal_status, TerminalStatus.ABSTAINED)
        self.assertEqual(plan.to_dict()["terminal_status"], "abstained")
        self.assertEqual(plan.stop_reason, "no_eligible_candidates")

    def test_discovery_records_self_as_accountable_integrator_of_specialist_output(self) -> None:
        plan = DiscoveryAndUseBackend().plan(four_agent_request(mechanism="discovery-and-use"))
        self_participant = next(item for item in plan.participants if item.candidate_id == "self")
        self_event = next(
            event
            for event in plan.decision_trace
            if event.get("event") == "candidate_selected" and event.get("candidate_id") == "self"
        )
        expected_reason = "accountable_requester_integrator_consumes_specialist_output"
        self.assertEqual(self_participant.selection_reason, expected_reason)
        self.assertEqual(self_event["reason"], expected_reason)

    def test_decision_trace_records_rejections_before_scoring(self) -> None:
        plan = DiscoveryAndUseBackend().plan(
            four_agent_request(mechanism="discovery-and-use", include_denied_superstar=True)
        )
        denied = next(event for event in plan.decision_trace if event.get("candidate_id") == "denied-superstar")
        self.assertEqual(denied["event"], "candidate_rejected")
        self.assertEqual(denied["reason"], "not_admitted")

    def test_adaptive_does_not_build_dependencies_deeper_than_budget(self) -> None:
        def candidate(candidate_id: str, capabilities: tuple[str, ...], quality: float, mode: CandidateMode = CandidateMode.RECRUIT) -> Candidate:
            return Candidate(candidate_id, mode, capabilities, True, "trusted", quality, 0.1, 0.1, 0.1)

        request = CoordinationRequest(
            TaskSpec("depth-task", "Cover the chain.", ("a", "b", "c"), (), {}),
            (
                candidate("self", ("root",), 0.9, CandidateMode.SELF),
                candidate("one", ("a", "bridge-a"), 0.8),
                candidate("two", ("b", "bridge-a", "bridge-b"), 0.7),
                candidate("three", ("c", "bridge-b"), 0.6),
            ),
            CoordinationBudget(max_depth=2, max_participants=4),
            "rac-adaptive",
            "trace-depth",
        )

        plan = RacAdaptiveBackend().plan(request)

        dependencies = {item.candidate_id: item.dependencies for item in plan.participants}

        def depth(candidate_id: str) -> int:
            return 0 if not dependencies[candidate_id] else 1 + max(depth(parent) for parent in dependencies[candidate_id])

        self.assertLessEqual(max(depth(candidate_id) for candidate_id in dependencies), 2)
        self.assertEqual(plan.participant_ids, ("self", "one", "two", "three"))
        self.assertEqual(dependencies["three"], ("self",))

    def test_rge_records_one_stop_event_when_participant_limit_is_reached(self) -> None:
        request = four_agent_request(mechanism="rac-rge")
        limited_request = CoordinationRequest(
            request.task,
            request.candidates,
            CoordinationBudget(max_participants=2),
            request.mechanism,
            request.trace_id,
        )

        plan = RacRgeBackend().plan(limited_request)

        stop_events = [event for event in plan.decision_trace if event.get("event") == "planning_stopped"]
        self.assertEqual(stop_events, [{"event": "planning_stopped", "reason": "participant_limit_reached"}])

    def test_adaptive_records_one_participant_limit_stop_event(self) -> None:
        request = linear_request()
        limited_request = CoordinationRequest(
            request.task,
            request.candidates,
            CoordinationBudget(max_participants=1),
            request.mechanism,
            request.trace_id,
        )

        plan = RacAdaptiveBackend().plan(limited_request)

        stop_events = [event for event in plan.decision_trace if event.get("event") == "planning_stopped"]
        self.assertEqual(stop_events, [{"event": "planning_stopped", "reason": "participant_limit_reached"}])
        self.assertEqual(plan.stop_reason, "participant_limit_reached")


if __name__ == "__main__":
    unittest.main()
