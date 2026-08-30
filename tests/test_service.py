"""Behavioral tests for bounded coordination execution and recovery."""

from __future__ import annotations

from dataclasses import replace
import unittest

from sharednet.coordination.models import (
    CoordinationPlan,
    CoordinationRequest,
    CoordinationResult,
    ParticipantPlan,
    TerminalStatus,
)
from tests.fixtures import four_agent_request, linear_request


def adaptive_request(*, max_retries: int = 1) -> CoordinationRequest:
    request = four_agent_request(mechanism="rac-adaptive")
    return replace(request, budget=replace(request.budget, max_retries=max_retries))


def accepted_result(plan, *, usage: dict[str, int | float] | None = None) -> CoordinationResult:
    return CoordinationResult(
        status=TerminalStatus.ACCEPTED,
        plan=plan,
        synthesis="accepted synthesis",
        runtime_evidence={"source": "scripted"},
        usage=usage or {"tokens": 3},
    )


def failed_result(
    plan,
    failed_participant_ids: tuple[str, ...],
    *,
    usage: dict[str, int | float] | None = None,
    error: str = "participant_failed",
) -> CoordinationResult:
    return CoordinationResult(
        status=TerminalStatus.FAILED,
        plan=plan,
        synthesis="partial synthesis",
        runtime_evidence={"source": "scripted", "attempt": plan.attempt},
        failed_participant_ids=failed_participant_ids,
        usage=usage or {"tokens": 2},
        error=error,
    )


class ScriptedRuntime:
    def __init__(self, outcomes) -> None:
        self._outcomes = iter(outcomes)
        self.calls = 0
        self.plans = []

    def execute(self, plan):
        self.calls += 1
        self.plans.append(plan)
        return next(self._outcomes)(plan)


class ManualClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class CountingBackend:
    mechanism_id = "counting"

    def __init__(self, delegate) -> None:
        self.delegate = delegate
        self.plan_calls = 0
        self.exclusions = []

    def plan(self, request, *, excluded=frozenset()):
        self.plan_calls += 1
        self.exclusions.append(excluded)
        return self.delegate.plan(request, excluded=excluded)


class ReplanDeadlineBackend(CountingBackend):
    def __init__(self, delegate, clock: ManualClock) -> None:
        super().__init__(delegate)
        self.clock = clock

    def plan(self, request, *, excluded=frozenset()):
        plan = super().plan(request, excluded=excluded)
        if self.plan_calls == 2:
            self.clock.advance(request.budget.max_wall_seconds)
        return plan


class CostAwareRetryBackend:
    mechanism_id = "cost-aware"

    def __init__(self, costs: tuple[float, ...]) -> None:
        self._costs = iter(costs)
        self.budgets: list[float] = []
        self.calls = 0

    def plan(self, request, *, excluded=frozenset()):
        cost = next(self._costs)
        self.calls += 1
        self.budgets.append(request.budget.max_cost)
        if cost > request.budget.max_cost:
            return CoordinationPlan(
                self.mechanism_id, request.task.task_id, request.trace_id, 0, excluded,
                (), (), ({"event": "planning_stopped", "reason": "cost_budget_exhausted"},),
                {"reason": "cost_budget_exhausted"}, request.budget, TerminalStatus.ABSTAINED,
            )
        participant_id = "self" if self.calls == 1 else "architect"
        return CoordinationPlan(
            self.mechanism_id, request.task.task_id, request.trace_id, 0, excluded,
            (ParticipantPlan(participant_id, "root", "work", (), "selected", (), cost),),
            (), ({"event": "planning_stopped", "reason": "coverage_complete"},), {}, request.budget,
        )


class ServiceTests(unittest.TestCase):
    def test_execute_reserves_failed_attempt_predicted_cost_before_exact_bound_retry(self) -> None:
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        backend = CostAwareRetryBackend((0.4, 0.6))
        request = replace(adaptive_request(max_retries=1), budget=replace(adaptive_request().budget, max_cost=1.0, max_retries=1))
        runtime = ScriptedRuntime([lambda plan: failed_result(plan, ("self",)), accepted_result])
        original_get_backend = service_module.get_backend
        service_module.get_backend = lambda mechanism: backend
        try:
            result = CoordinationService().execute(request, runtime)
        finally:
            service_module.get_backend = original_get_backend

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual([plan.total_predicted_cost for plan in runtime.plans], [0.4, 0.6])
        self.assertEqual(backend.budgets, [1.0, 0.6])

    def test_execute_does_not_run_an_over_budget_retry_after_reservation(self) -> None:
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        backend = CostAwareRetryBackend((0.7, 0.4))
        request = replace(adaptive_request(max_retries=1), budget=replace(adaptive_request().budget, max_cost=1.0, max_retries=1))
        runtime = ScriptedRuntime([lambda plan: failed_result(plan, ("self",)), accepted_result])
        original_get_backend = service_module.get_backend
        service_module.get_backend = lambda mechanism: backend
        try:
            result = CoordinationService().execute(request, runtime)
        finally:
            service_module.get_backend = original_get_backend

        self.assertEqual(runtime.calls, 1)
        self.assertEqual(backend.budgets[0], 1.0)
        self.assertAlmostEqual(backend.budgets[1], 0.3)
        self.assertEqual(result.status, TerminalStatus.ABSTAINED)
        self.assertEqual(result.plan.stop_reason, "cost_budget_exhausted")

    def test_execute_exhausts_when_a_failed_attempt_reserves_the_entire_cost_budget(self) -> None:
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        backend = CostAwareRetryBackend((1.0,))
        request = replace(adaptive_request(max_retries=1), budget=replace(adaptive_request().budget, max_cost=1.0, max_retries=1))
        runtime = ScriptedRuntime([lambda plan: failed_result(plan, ("self",))])
        original_get_backend = service_module.get_backend
        service_module.get_backend = lambda mechanism: backend
        try:
            result = CoordinationService().execute(request, runtime)
        finally:
            service_module.get_backend = original_get_backend

        self.assertEqual(runtime.calls, 1)
        self.assertEqual(backend.calls, 1)
        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "cost_budget_exhausted")

    def test_plan_returns_the_initial_backend_plan(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = adaptive_request()
        plan = CoordinationService().plan(request)

        self.assertEqual(plan.mechanism_id, "rac-adaptive")
        self.assertEqual(plan.attempt, 0)
        self.assertEqual(plan.exclusions, frozenset())

    def test_execute_returns_first_accepted_attempt(self) -> None:
        from sharednet.coordination.service import CoordinationService

        runtime = ScriptedRuntime([accepted_result])
        result = CoordinationService().execute(four_agent_request(mechanism="rac-rge"), runtime)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runtime.calls, 1)
        self.assertEqual(result.attempts[0].status, TerminalStatus.ACCEPTED)

    def test_execute_replans_after_attributable_failure(self) -> None:
        from sharednet.coordination.service import CoordinationService

        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("risk-analyst",)),
            accepted_result,
        ])
        result = CoordinationService().execute(adaptive_request(max_retries=1), runtime)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runtime.calls, 2)
        self.assertNotIn("risk-analyst", runtime.plans[1].participant_ids)
        self.assertEqual(len(result.attempts), 2)

    def test_execute_stops_when_retry_budget_is_exhausted(self) -> None:
        from sharednet.coordination.service import CoordinationService

        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",)),
            lambda plan: failed_result(plan, ("architect",)),
        ])
        result = CoordinationService().execute(adaptive_request(max_retries=1), runtime)

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "retry_budget_exhausted")
        self.assertEqual(runtime.calls, 2)

    def test_execute_stops_immediately_on_unattributed_failure(self) -> None:
        from sharednet.coordination.service import CoordinationService

        runtime = ScriptedRuntime([lambda plan: failed_result(plan, (), usage={"tokens": 4})])
        result = CoordinationService().execute(adaptive_request(max_retries=2), runtime)

        self.assertEqual(runtime.calls, 1)
        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.usage, {"tokens": 4, "planned_turns": 4})
        self.assertEqual(len(result.attempts), 1)

    def test_execute_stops_when_only_unknown_ids_are_reported_failed(self) -> None:
        from sharednet.coordination.service import CoordinationService

        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("unknown-agent",)),
            accepted_result,
        ])
        result = CoordinationService().execute(adaptive_request(max_retries=1), runtime)

        self.assertEqual(runtime.calls, 1)
        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.failed_participant_ids, ("unknown-agent",))

    def test_execute_stops_when_only_denied_ids_are_reported_failed(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = four_agent_request(mechanism="rac-adaptive", include_denied_superstar=True)
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("denied-superstar",)),
            accepted_result,
        ])
        result = CoordinationService().execute(request, runtime)

        self.assertEqual(runtime.calls, 1)
        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.failed_participant_ids, ("denied-superstar",))

    def test_execute_retries_only_with_admitted_ids_from_mixed_failure_evidence(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = four_agent_request(mechanism="rac-adaptive", include_denied_superstar=True)
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("risk-analyst", "unknown-agent", "denied-superstar")),
            accepted_result,
        ])
        result = CoordinationService().execute(request, runtime)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runtime.calls, 2)
        self.assertEqual(runtime.plans[1].exclusions, frozenset({"risk-analyst"}))

    def test_execute_does_not_retry_an_admitted_id_unselected_from_the_failed_plan(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = replace(
            adaptive_request(max_retries=1),
            budget=replace(adaptive_request().budget, max_participants=1, max_retries=1),
        )
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("generalist",), error="raw_unselected_failure"),
            accepted_result,
        ])

        result = CoordinationService().execute(request, runtime)

        self.assertEqual(runtime.calls, 1)
        self.assertNotIn("generalist", runtime.plans[0].participant_ids)
        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.failed_participant_ids, ("generalist",))
        self.assertEqual(result.error, "raw_unselected_failure")
        self.assertEqual(result.runtime_evidence, {"source": "scripted", "attempt": 0})

    def test_execute_accumulates_failed_ids_as_immutable_plan_exclusions(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = adaptive_request(max_retries=2)
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",)),
            lambda plan: failed_result(plan, ("architect",)),
            accepted_result,
        ])
        result = CoordinationService().execute(request, runtime)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runtime.plans[0].exclusions, frozenset())
        self.assertEqual(runtime.plans[1].exclusions, frozenset({"self"}))
        self.assertEqual(runtime.plans[2].exclusions, frozenset({"self", "architect"}))
        self.assertEqual(tuple(candidate.candidate_id for candidate in request.candidates), ("self", "architect", "risk-analyst", "generalist"))

    def test_execute_resolves_the_backend_once_for_all_attempts(self) -> None:
        from sharednet.coordination.backends.rac_adaptive import RacAdaptiveBackend
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        request = adaptive_request(max_retries=1)
        backend = CountingBackend(RacAdaptiveBackend())
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("risk-analyst",)),
            accepted_result,
        ])
        original_get_backend = service_module.get_backend
        resolver_calls = []

        def resolve(mechanism):
            resolver_calls.append(mechanism)
            return backend

        service_module.get_backend = resolve
        try:
            result = CoordinationService().execute(request, runtime)
        finally:
            service_module.get_backend = original_get_backend

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(resolver_calls, ["rac-adaptive"])
        self.assertEqual(backend.plan_calls, 2)
        self.assertEqual(backend.exclusions, [frozenset(), frozenset({"risk-analyst"})])

    def test_execute_does_not_call_runtime_for_an_abstained_plan(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = replace(
            linear_request(),
            candidates=tuple(replace(candidate, admitted=False, admission_reason="policy_denied") for candidate in linear_request().candidates),
        )
        runtime = ScriptedRuntime([])
        result = CoordinationService().execute(request, runtime)

        self.assertEqual(result.status, TerminalStatus.ABSTAINED)
        self.assertEqual(runtime.calls, 0)
        self.assertEqual(result.attempts, ())

    def test_plan_caps_participants_to_the_available_turn_budget(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = adaptive_request()
        request = replace(request, budget=replace(request.budget, max_turns=1))

        plan = CoordinationService().plan(request)

        self.assertEqual(len(plan.participants), 1)
        self.assertEqual(plan.budget.max_participants, 1)

    def test_execute_reserves_one_turn_per_planned_participant_across_retries(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = adaptive_request(max_retries=1)
        request = replace(request, budget=replace(request.budget, max_turns=5))
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",), usage={"tokens": 2}),
            accepted_result,
        ])

        result = CoordinationService().execute(request, runtime)

        self.assertEqual([len(plan.participants) for plan in runtime.plans], [4, 1])
        self.assertEqual([attempt.usage["planned_turns"] for attempt in result.attempts], [4, 1])
        self.assertEqual(result.usage["planned_turns"], 5)

    def test_execute_exhausts_before_attributable_retry_when_no_turns_remain(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = adaptive_request(max_retries=1)
        request = replace(request, budget=replace(request.budget, max_turns=4))
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",), error="raw_first_failure"),
            accepted_result,
        ])

        result = CoordinationService().execute(request, runtime)

        self.assertEqual(runtime.calls, 1)
        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "turn_budget_exhausted")
        self.assertEqual(result.failed_participant_ids, ("self",))
        self.assertEqual(result.runtime_evidence, {"source": "scripted", "attempt": 0})
        self.assertEqual(result.attempts[0].error, "raw_first_failure")
        self.assertEqual(result.attempts[0].usage["planned_turns"], 4)
        self.assertEqual(result.usage["planned_turns"], 4)

    def test_execute_shares_one_monotonic_wall_deadline_across_retries(self) -> None:
        from sharednet.coordination.service import CoordinationService

        clock = ManualClock()

        def fail_after_four_seconds(plan):
            clock.advance(4)
            return failed_result(plan, ("self",))

        request = adaptive_request(max_retries=1)
        request = replace(request, budget=replace(request.budget, max_wall_seconds=10))
        runtime = ScriptedRuntime([fail_after_four_seconds, accepted_result])

        result = CoordinationService(clock=clock).execute(request, runtime)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runtime.plans[0].budget.max_wall_seconds, 10)
        self.assertEqual(runtime.plans[1].budget.max_wall_seconds, 6)
        self.assertGreater(runtime.plans[1].budget.max_wall_seconds, 0)

    def test_execute_stops_before_replanning_when_wall_deadline_is_exhausted(self) -> None:
        from sharednet.coordination.backends.rac_adaptive import RacAdaptiveBackend
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        clock = ManualClock()
        backend = CountingBackend(RacAdaptiveBackend())

        def consume_deadline(plan):
            clock.advance(10)
            return failed_result(plan, ("self",), error="raw_deadline_failure")

        request = adaptive_request(max_retries=1)
        request = replace(request, budget=replace(request.budget, max_wall_seconds=10))
        runtime = ScriptedRuntime([consume_deadline, accepted_result])
        original_get_backend = service_module.get_backend
        service_module.get_backend = lambda mechanism: backend
        try:
            result = CoordinationService(clock=clock).execute(request, runtime)
        finally:
            service_module.get_backend = original_get_backend

        self.assertEqual(backend.plan_calls, 1)
        self.assertEqual(runtime.calls, 1)
        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "wall_time_budget_exhausted")
        self.assertEqual(result.attempts[0].error, "raw_deadline_failure")

    def test_deadline_expiring_during_replan_preserves_prior_failure_evidence(self) -> None:
        from sharednet.coordination.backends.rac_adaptive import RacAdaptiveBackend
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        clock = ManualClock()
        backend = ReplanDeadlineBackend(RacAdaptiveBackend(), clock)
        request = adaptive_request(max_retries=1)
        request = replace(request, budget=replace(request.budget, max_wall_seconds=10))
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",), error="raw_replan_failure"),
        ])
        original_get_backend = service_module.get_backend
        service_module.get_backend = lambda mechanism: backend
        try:
            result = CoordinationService(clock=clock).execute(request, runtime)
        finally:
            service_module.get_backend = original_get_backend

        self.assertEqual(runtime.calls, 1)
        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "wall_time_budget_exhausted")
        self.assertEqual(result.failed_participant_ids, ("self",))
        self.assertEqual(result.runtime_evidence, {"source": "scripted", "attempt": 0})
        self.assertEqual(result.attempts[0].error, "raw_replan_failure")

    def test_accepted_result_arriving_after_wall_deadline_becomes_exhausted(self) -> None:
        from sharednet.coordination.service import CoordinationService

        clock = ManualClock()

        def late_acceptance(plan):
            clock.advance(11)
            return accepted_result(plan, usage={"tokens": 9})

        request = adaptive_request(max_retries=1)
        request = replace(request, budget=replace(request.budget, max_wall_seconds=10))
        runtime = ScriptedRuntime([late_acceptance])

        result = CoordinationService(clock=clock).execute(request, runtime)

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "wall_time_budget_exhausted")
        self.assertEqual(result.runtime_evidence, {"source": "scripted"})
        self.assertEqual(result.attempts[0].status, TerminalStatus.ACCEPTED)
        self.assertEqual(result.attempts[0].usage, {"tokens": 9, "planned_turns": 4})
        self.assertEqual(result.usage, {"tokens": 9, "planned_turns": 4})

    def test_exhaustion_preserves_final_evidence_and_aggregates_numeric_usage(self) -> None:
        from sharednet.coordination.service import CoordinationService

        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",), usage={"tokens": 2, "seconds": 1.5}),
            lambda plan: failed_result(plan, ("architect",), usage={"tokens": 5, "seconds": 0.5}, error="second_failure"),
        ])
        result = CoordinationService().execute(adaptive_request(max_retries=1), runtime)

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "retry_budget_exhausted")
        self.assertEqual(result.failed_participant_ids, ("architect",))
        self.assertEqual(result.runtime_evidence, {"source": "scripted", "attempt": 1})
        self.assertEqual(result.usage, {"tokens": 7, "seconds": 2.0, "planned_turns": 7})
        self.assertEqual([attempt.error for attempt in result.attempts], ["participant_failed", "second_failure"])


if __name__ == "__main__":
    unittest.main()
