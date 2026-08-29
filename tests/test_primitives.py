"""Behavioral tests for RAC-derived coordination primitives."""

from __future__ import annotations

import unittest

from sharednet.coordination.models import Candidate, CandidateMode
from sharednet.coordination.primitives import (
    AppendOnlyForum,
    BudgetExceeded,
    LocalBudget,
    attenuation_failure,
    candidate_utility,
    verified_experience,
)


def candidate(candidate_id: str, **overrides: object) -> Candidate:
    if "successes" in overrides:
        overrides["verified_successes"] = overrides.pop("successes")
    if "failures" in overrides:
        overrides["verified_failures"] = overrides.pop("failures")
    values: dict[str, object] = {
        "candidate_id": candidate_id,
        "mode": CandidateMode.SELF,
        "capabilities": ("analysis",),
        "admitted": True,
        "admission_reason": "trusted",
        "predicted_quality": 0.8,
        "predicted_cost": 0.1,
        "predicted_latency": 0.1,
        "predicted_risk": 0.1,
        "verified_successes": 0,
        "verified_failures": 0,
    }
    values.update(overrides)
    return Candidate(**values)


class PrimitiveTests(unittest.TestCase):
    def test_unseen_candidate_has_no_experience_bonus(self) -> None:
        self.assertEqual(verified_experience(candidate("new", successes=0, failures=0)), 0.0)

    def test_failed_candidate_has_negative_experience(self) -> None:
        self.assertLess(verified_experience(candidate("bad", successes=0, failures=3)), 0.0)

    def test_candidate_utility_subtracts_each_operating_cost(self) -> None:
        self.assertEqual(candidate_utility(candidate("a"), coordination_overhead=0.2), 0.3)

    def test_child_budget_cannot_exceed_reserved_parent_remainder(self) -> None:
        budget = LocalBudget(cost_limit=5.0)
        budget.reserve("a", 4.0)
        with self.assertRaisesRegex(BudgetExceeded, "insufficient_unreserved_cost"):
            budget.reserve("b", 2.0)

    def test_budget_tracks_charge_and_release_per_child(self) -> None:
        budget = LocalBudget(cost_limit=5.0)
        budget.reserve("child", 4.0)
        budget.charge("child", 1.5)
        budget.release("child")
        self.assertEqual(budget.spent_cost, 1.5)
        self.assertEqual(budget.unreserved_cost, 3.5)
        with self.assertRaisesRegex(BudgetExceeded, "reservation_not_found"):
            budget.charge("child", 0.1)

    def test_forum_is_append_only_and_excludes_reader_own_posts(self) -> None:
        forum = AppendOnlyForum(max_posts=4, max_note_bytes=40)
        forum.post("a", "alpha")
        forum.post("b", "beta")
        self.assertEqual([post.note for post in forum.read("a")], ["beta"])
        self.assertEqual([post.sequence for post in forum.posts], [0, 1])

    def test_forum_enforces_note_and_post_bounds(self) -> None:
        forum = AppendOnlyForum(max_posts=1, max_note_bytes=4)
        with self.assertRaisesRegex(ValueError, "note exceeds"):
            forum.post("a", "five!")
        forum.post("a", "four")
        with self.assertRaisesRegex(BudgetExceeded, "forum_post_limit"):
            forum.post("b", "ok")

    def test_attenuation_returns_specific_widening_reason(self) -> None:
        parent = {
            "cost_limit": 3.0,
            "deadline_seconds": 10,
            "max_disclosure_bytes": 100,
            "allowed_effects": ("read",),
            "max_depth": 2,
        }
        self.assertEqual(
            attenuation_failure(parent, {**parent, "cost_limit": 3.1}),
            "wider_cost_limit",
        )
        self.assertIsNone(attenuation_failure(parent, {**parent, "max_depth": 1}))


if __name__ == "__main__":
    unittest.main()
