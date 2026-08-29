"""Behavioral tests for default coordination planners."""

from __future__ import annotations

import unittest

from sharednet.coordination.backends.discovery_and_use import DiscoveryAndUseBackend
from sharednet.coordination.backends.peer_forum import PeerForumBackend
from sharednet.coordination.backends.rac_adaptive import RacAdaptiveBackend
from sharednet.coordination.backends.rac_rge import RacRgeBackend
from sharednet.coordination.models import Candidate, CandidateMode, CoordinationBudget, CoordinationRequest, TaskSpec
from tests.fixtures import four_agent_request, linear_request, specialist_request


class BackendTests(unittest.TestCase):
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

    def test_empty_eligible_set_abstains_with_inspectable_reason(self) -> None:
        request = four_agent_request(mechanism="rac-rge", include_denied_superstar=True)
        plan = RacRgeBackend().plan(request, excluded=frozenset(candidate.candidate_id for candidate in request.candidates if candidate.admitted))
        self.assertEqual(plan.participants, ())
        self.assertEqual(plan.runtime_instructions["terminal_status"], "abstained")
        self.assertEqual(plan.stop_reason, "no_eligible_candidates")

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


if __name__ == "__main__":
    unittest.main()
