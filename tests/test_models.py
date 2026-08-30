"""Behavioral tests for immutable coordination contracts."""

from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
from decimal import Decimal
import unittest

from sharednet.coordination.models import (
    AgentOutput,
    AttemptSummary,
    Candidate,
    CandidateMode,
    CoordinationBudget,
    CoordinationPlan,
    CoordinationRequest,
    CoordinationResult,
    GraphEdge,
    ParticipantPlan,
    TaskSpec,
    TerminalStatus,
)


def candidate(candidate_id: str, **overrides: object) -> Candidate:
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


def request_with(candidates: tuple[Candidate, ...]) -> CoordinationRequest:
    return CoordinationRequest(
        task=TaskSpec("task-1", "goal", ("analysis",), ("correct",), {"scope": "local"}),
        candidates=candidates,
        budget=CoordinationBudget(),
        mechanism="rac-rge",
        trace_id="trace-1",
    )


def plan_with(*participants: ParticipantPlan) -> CoordinationPlan:
    return CoordinationPlan(
        mechanism_id="rac-rge",
        task_id="task-1",
        trace_id="trace-1",
        attempt=0,
        exclusions=frozenset(),
        participants=participants,
        edges=(),
        decision_trace=(),
        runtime_instructions={},
        budget=CoordinationBudget(),
    )


class ModelTests(unittest.TestCase):
    def test_attempt_summary_preserves_immutable_runtime_evidence(self) -> None:
        source_evidence = {"provider": {"events": ["partial"]}}
        summary = AttemptSummary(
            0,
            TerminalStatus.PARTIAL,
            ("helper",),
            {"tokens": 5},
            "needs_retry",
            (AgentOutput("helper", "partial answer", "marker-1", {"source": "codex"}),),
            "partial synthesis",
            source_evidence,
        )
        source_evidence["provider"]["events"].append("mutated")

        self.assertEqual(summary.outputs[0].content, "partial answer")
        self.assertEqual(summary.synthesis, "partial synthesis")
        self.assertEqual(summary.runtime_evidence["provider"]["events"], ("partial",))
        self.assertEqual(
            summary.to_dict(),
            {
                "attempt": 0,
                "status": "partial",
                "outputs": [
                    {
                        "participant_id": "helper",
                        "content": "partial answer",
                        "marker": "marker-1",
                        "evidence": {"source": "codex"},
                    }
                ],
                "synthesis": "partial synthesis",
                "runtime_evidence": {"provider": {"events": ["partial"]}},
                "failed_participant_ids": ["helper"],
                "usage": {"tokens": 5},
                "error": "needs_retry",
            },
        )

    def test_numeric_contracts_reject_values_that_cannot_be_finite_floats(self) -> None:
        huge = 10**400

        with self.assertRaisesRegex(ValueError, "max_cost must be finite"):
            CoordinationBudget(max_cost=huge)
        with self.assertRaisesRegex(ValueError, "max_wall_seconds must be finite"):
            CoordinationBudget(max_wall_seconds=huge)
        with self.assertRaisesRegex(ValueError, "predicted_cost must be finite"):
            candidate("huge-cost", predicted_cost=huge)
        with self.assertRaisesRegex(ValueError, "predicted_quality must be finite"):
            candidate("huge-quality", predicted_quality=huge)
        with self.assertRaisesRegex(ValueError, "predicted_cost must be finite"):
            ParticipantPlan("helper", "worker", "work", (), "selected", (), huge)

    def test_result_rejects_attempt_history_beyond_plan_retry_bound(self) -> None:
        plan = plan_with()
        attempts = tuple(AttemptSummary(index, TerminalStatus.FAILED) for index in range(3))

        with self.assertRaisesRegex(ValueError, "attempt history exceeds plan retry bound"):
            CoordinationResult(TerminalStatus.FAILED, plan, attempts=attempts)

    def test_decimal_cost_utilities_enforce_exact_bounds(self) -> None:
        from sharednet.coordination.costs import fits_cost_budget, remaining_cost, sum_costs, to_decimal

        self.assertEqual(to_decimal(1e-13), Decimal("1E-13"))
        self.assertEqual(sum_costs((0.6, 0.4)), Decimal("1.0"))
        self.assertTrue(fits_cost_budget(0.6, 0.4, 1.0))
        self.assertFalse(fits_cost_budget(1.0, 0.0000000000005, 1.0))
        self.assertEqual(remaining_cost(1.0, 0.4), Decimal("0.6"))

    def test_budget_from_dict_rejects_unknown_fields(self) -> None:
        for unknown_field in ("max_turn", "max_costt"):
            with self.subTest(unknown_field=unknown_field):
                with self.assertRaisesRegex(ValueError, rf"budget\.unknown field: {unknown_field}"):
                    CoordinationBudget.from_dict({unknown_field: 1})

    def test_request_rejects_multiple_admitted_self_candidates(self) -> None:
        with self.assertRaisesRegex(ValueError, "multiple admitted SELF candidates"):
            request_with((candidate("self-a"), candidate("self-b")))

    def test_participant_plan_serializes_candidate_mode_with_compatible_default(self) -> None:
        participant = ParticipantPlan("helper", "worker", "work", (), "selected")

        self.assertEqual(participant.to_dict().get("mode"), "recruit")
        explicit = replace(participant, mode=CandidateMode.SPAWN)
        self.assertEqual(explicit.mode, CandidateMode.SPAWN)
        self.assertEqual(explicit.to_dict()["mode"], "spawn")

    def test_request_rejects_duplicate_candidate_ids(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate candidate id"):
            CoordinationRequest(
                task=TaskSpec("task-1", "goal", ("analysis",), ("correct",), {}),
                candidates=(candidate("same"), candidate("same")),
                budget=CoordinationBudget(),
                mechanism="rac-rge",
                trace_id="trace-1",
            )

    def test_plan_rejects_dependency_outside_selected_participants(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown dependency"):
            plan_with(ParticipantPlan("self", "root", "work", ("missing",), "best root"))

    def test_request_snapshot_does_not_change_when_source_list_changes(self) -> None:
        source = [candidate("self")]
        request = request_with(tuple(source))
        source.append(candidate("late"))
        self.assertEqual([item.candidate_id for item in request.candidates], ["self"])

    def test_contracts_are_frozen_and_json_safe(self) -> None:
        task = TaskSpec("task-1", "goal", ("analysis",), ("correct",), {"nested": ["value"]})
        with self.assertRaises(FrozenInstanceError):
            task.goal = "changed"  # type: ignore[misc]
        self.assertEqual(
            task.to_dict(),
            {
                "task_id": "task-1",
                "goal": "goal",
                "required_capabilities": ["analysis"],
                "acceptance_criteria": ["correct"],
                "input_data": {"nested": ["value"]},
            },
        )
        self.assertEqual(CandidateMode.SELF.to_dict(), "self")
        self.assertEqual(TerminalStatus.ACCEPTED.to_dict(), "accepted")

    def test_budget_defaults_and_bounds_are_enforced(self) -> None:
        self.assertEqual(
            CoordinationBudget().to_dict(),
            {
                "max_wall_seconds": 300,
                "max_turns": 16,
                "max_depth": 2,
                "max_participants": 4,
                "max_retries": 1,
                "max_disclosure_bytes": 65536,
                "max_cost": 1.0,
            },
        )
        with self.assertRaisesRegex(ValueError, "max_turns must be positive"):
            CoordinationBudget(max_turns=0)
        for invalid_cost in (0, -0.1, float("inf"), float("nan")):
            with self.subTest(invalid_cost=invalid_cost):
                with self.assertRaisesRegex(ValueError, "max_cost must be (positive|finite)"):
                    CoordinationBudget(max_cost=invalid_cost)
        self.assertEqual(CoordinationBudget(max_cost=1e-13).max_cost, 1e-13)

    def test_plan_exposes_exact_selected_predicted_cost(self) -> None:
        plan = plan_with(
            ParticipantPlan("self", "root", "work", (), "best", (), 0.25),
            ParticipantPlan("helper", "worker", "work", ("self",), "coverage", (), 0.75),
        )

        self.assertEqual(plan.total_predicted_cost, 1.0)
        self.assertEqual(plan.to_dict()["total_predicted_cost"], 1.0)

    def test_plan_rejects_selected_predicted_cost_above_budget(self) -> None:
        with self.assertRaisesRegex(ValueError, "maximum predicted cost exceeded"):
            CoordinationPlan(
                "rac-rge", "task-1", "trace-1", 0, frozenset(),
                (
                    ParticipantPlan("self", "root", "work", (), "best", (), 0.6),
                    ParticipantPlan("helper", "worker", "work", ("self",), "coverage", (), 0.5),
                ),
                (), (), {}, CoordinationBudget(max_cost=1.0),
            )

    def test_plan_uses_strict_decimal_cost_comparison(self) -> None:
        exact = CoordinationPlan(
            "rac-rge", "task-1", "trace-1", 0, frozenset(),
            (
                ParticipantPlan("self", "root", "work", (), "best", (), 0.6),
                ParticipantPlan("helper", "worker", "work", ("self",), "coverage", (), 0.4),
            ),
            (), (), {}, CoordinationBudget(max_cost=1.0),
        )
        self.assertEqual(exact.total_predicted_cost, 1.0)

        with self.assertRaisesRegex(ValueError, "maximum predicted cost exceeded"):
            CoordinationPlan(
                "rac-rge", "task-1", "trace-1", 0, frozenset(),
                (ParticipantPlan("self", "root", "work", (), "best", (), 1.0000000000005),),
                (), (), {}, CoordinationBudget(max_cost=1.0),
            )

    def test_plan_exposes_participants_coverage_and_stop_reason(self) -> None:
        plan = CoordinationPlan(
            mechanism_id="rac-rge",
            task_id="task-1",
            trace_id="trace-1",
            attempt=1,
            exclusions=frozenset({"excluded"}),
            participants=(
                ParticipantPlan("self", "root", "analyze", (), "best root", ("analysis",)),
                ParticipantPlan("writer", "worker", "write", ("self",), "coverage", ("writing",)),
            ),
            edges=(GraphEdge("self", "writer", "delegates"),),
            decision_trace=(
                {"event": "candidate_selected", "candidate_id": "self"},
                {"event": "planning_stopped", "reason": "coverage_complete"},
            ),
            runtime_instructions={"safe": True},
            budget=CoordinationBudget(),
        )
        self.assertEqual(plan.participant_ids, ("self", "writer"))
        self.assertEqual(plan.covered_capabilities, ("analysis", "writing"))
        self.assertEqual(plan.stop_reason, "coverage_complete")
        self.assertEqual(plan.to_dict()["exclusions"], ["excluded"])

    def test_plan_has_a_typed_terminal_status_with_json_serialization(self) -> None:
        accepted_plan = plan_with()
        self.assertEqual(accepted_plan.terminal_status, TerminalStatus.ACCEPTED)
        self.assertEqual(accepted_plan.to_dict()["terminal_status"], "accepted")

        abstained_plan = CoordinationPlan(
            mechanism_id="rac-rge",
            task_id="task-1",
            trace_id="trace-1",
            attempt=0,
            exclusions=frozenset(),
            participants=(),
            edges=(),
            decision_trace=(),
            runtime_instructions={},
            budget=CoordinationBudget(),
            terminal_status="abstained",
        )
        self.assertEqual(abstained_plan.terminal_status, TerminalStatus.ABSTAINED)
        self.assertEqual(abstained_plan.to_dict()["terminal_status"], "abstained")

    def test_plan_rejects_unknown_edge_and_too_many_participants(self) -> None:
        participant = ParticipantPlan("self", "root", "work", (), "best")
        with self.assertRaisesRegex(ValueError, "unknown edge endpoint"):
            CoordinationPlan(
                "rac-rge", "task-1", "trace-1", 0, frozenset(), (participant,),
                (GraphEdge("self", "missing", "delegates"),), (), {}, CoordinationBudget(),
            )
        participants = tuple(ParticipantPlan(str(index), "worker", "work", (), "selected") for index in range(5))
        with self.assertRaisesRegex(ValueError, "maximum participant count"):
            CoordinationPlan(
                "rac-rge", "task-1", "trace-1", 0, frozenset(), participants,
                (), (), {}, CoordinationBudget(),
            )

    def test_plan_rejects_dependency_depth_beyond_its_budget(self) -> None:
        participants = (
            ParticipantPlan("root", "root", "work", (), "selected"),
            ParticipantPlan("middle", "worker", "work", ("root",), "selected"),
            ParticipantPlan("leaf", "worker", "work", ("middle",), "selected"),
        )
        with self.assertRaisesRegex(ValueError, "maximum dependency depth"):
            CoordinationPlan(
                "rac-rge", "task-1", "trace-1", 0, frozenset(), participants,
                (), (), {}, CoordinationBudget(max_depth=1),
            )

    def test_plan_rejects_an_invalid_budget_value(self) -> None:
        with self.assertRaisesRegex(ValueError, "budget must be a CoordinationBudget"):
            CoordinationPlan(
                "rac-rge", "task-1", "trace-1", 0, frozenset(), (), (), (), {},
                "not-a-budget",  # type: ignore[arg-type]
            )

    def test_plan_allows_attempt_at_the_retry_limit(self) -> None:
        plan = CoordinationPlan(
            "rac-rge", "task-1", "trace-1", 2, frozenset(), (), (), (), {},
            CoordinationBudget(max_retries=2),
        )
        self.assertEqual(plan.attempt, 2)

    def test_plan_rejects_first_attempt_after_retry_limit(self) -> None:
        with self.assertRaisesRegex(ValueError, "attempt exceeds retry budget"):
            CoordinationPlan(
                "rac-rge", "task-1", "trace-1", 3, frozenset(), (), (), (), {},
                CoordinationBudget(max_retries=2),
            )

    def test_result_retains_structured_runtime_outputs(self) -> None:
        plan = plan_with(ParticipantPlan("self", "root", "work", (), "best"))
        result = CoordinationResult(
            status=TerminalStatus.PARTIAL,
            plan=plan,
            outputs=(AgentOutput("self", "answer", "marker-self", {"source": "runtime"}),),
            synthesis="partial answer",
            runtime_evidence={"stderr": ""},
            failed_participant_ids=("other",),
            attempts=(AttemptSummary(0, TerminalStatus.PARTIAL, ("other",), {"turns": 1}),),
            usage={"input_tokens": 12},
            error="provider_partial",
        )
        self.assertEqual(result.to_dict()["outputs"][0]["marker"], "marker-self")
        self.assertEqual(result.to_dict()["attempts"][0]["status"], "partial")

    def test_from_dict_reconstructs_nested_contracts(self) -> None:
        request = CoordinationRequest.from_dict(
            {
                "task": {
                    "task_id": "task-1",
                    "goal": "goal",
                    "required_capabilities": ["analysis"],
                    "acceptance_criteria": ["correct"],
                    "input_data": {"scope": "local"},
                },
                "candidates": [candidate("self").to_dict()],
                "budget": {"max_turns": 3},
                "mechanism": "rac-rge",
                "trace_id": "trace-1",
            }
        )
        self.assertEqual(request.candidates[0].mode, CandidateMode.SELF)
        self.assertEqual(request.budget.max_turns, 3)

    def test_from_dict_reports_invalid_nested_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "task.task_id"):
            CoordinationRequest.from_dict(
                {
                    "task": {"task_id": "", "goal": "goal", "required_capabilities": ["analysis"], "acceptance_criteria": [], "input_data": {}},
                    "candidates": [],
                    "budget": {},
                    "mechanism": "rac-rge",
                    "trace_id": "trace-1",
                }
            )


if __name__ == "__main__":
    unittest.main()
