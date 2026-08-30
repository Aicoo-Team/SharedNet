"""Behavioral tests for bounded coordination execution and recovery."""

from __future__ import annotations

from dataclasses import replace
import unittest

from sharednet.coordination.models import (
    Candidate,
    CandidateMode,
    CoordinationPlan,
    CoordinationBudget,
    CoordinationRequest,
    CoordinationResult,
    ParticipantPlan,
    TaskSpec,
    TerminalStatus,
)
from tests.fixtures import four_agent_request, linear_request


def adaptive_request(*, max_retries: int = 1) -> CoordinationRequest:
    request = four_agent_request(mechanism="rac-adaptive")
    return replace(request, budget=replace(request.budget, max_retries=max_retries))


def adaptive_request_with_costs(first_cost: float, retry_cost: float, *, max_retries: int = 1) -> CoordinationRequest:
    request = adaptive_request(max_retries=max_retries)
    candidates = tuple(
        replace(
            candidate,
            predicted_cost=first_cost if candidate.candidate_id == "self" else retry_cost if candidate.candidate_id == "architect" else candidate.predicted_cost,
        )
        for candidate in request.candidates
    )
    return replace(request, candidates=candidates)


def discovery_cost_replan_request() -> CoordinationRequest:
    return CoordinationRequest(
        TaskSpec("discovery-cost-replan", "Use accountable specialist output.", ("analysis",), (), {}),
        (
            Candidate("self", CandidateMode.SELF, ("accountability",), True, "trusted", 0.5, 0.6, 0.1, 0.1),
            Candidate("first-specialist", CandidateMode.RECRUIT, ("analysis",), True, "trusted", 1.0, 0.2, 0.1, 0.1),
            Candidate("second-specialist", CandidateMode.RECRUIT, ("analysis",), True, "trusted", 0.8, 0.1, 0.1, 0.1),
        ),
        CoordinationBudget(max_cost=0.9, max_participants=2, max_retries=1),
        "discovery-and-use",
        "trace-discovery-cost-replan",
    )


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
    def __init__(self, delegate) -> None:
        self.delegate = delegate
        self.mechanism_id = delegate.mechanism_id
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
                {"reason": "cost_budget_exhausted", "task": request.task.to_dict()}, request.budget, TerminalStatus.ABSTAINED,
            )
        participant_id = "self" if self.calls == 1 else "architect"
        candidate = next(candidate for candidate in request.candidates if candidate.candidate_id == participant_id)
        return CoordinationPlan(
            self.mechanism_id, request.task.task_id, request.trace_id, 0, excluded,
            (ParticipantPlan(participant_id, "root", "work", (), "selected", candidate.capabilities, cost, candidate.mode),),
            (), ({"event": "planning_stopped", "reason": "coverage_complete"},), {"task": request.task.to_dict()}, request.budget,
        )


class MutatingBackend:
    """Return a structurally valid plan with one authority field forged."""

    mechanism_id = "rac-adaptive"

    def __init__(self, mutate) -> None:
        from sharednet.coordination.backends.rac_adaptive import RacAdaptiveBackend

        self.delegate = RacAdaptiveBackend()
        self.mutate = mutate

    def plan(self, request, *, excluded=frozenset()):
        return self.mutate(self.delegate.plan(request, excluded=excluded), request, excluded)


class ServiceTests(unittest.TestCase):
    def test_execute_accepts_a_valid_tiny_cost_budget(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = CoordinationRequest(
            TaskSpec("tiny-cost", "Analyze", ("analysis",), (), {}),
            (Candidate("self", CandidateMode.SELF, ("analysis",), True, "trusted", 0.8, 1e-13, 0.1, 0.1),),
            CoordinationBudget(max_cost=1e-13),
            "rac-adaptive",
            "trace-tiny-cost",
        )
        runtime = ScriptedRuntime([accepted_result])

        result = CoordinationService().execute(request, runtime)

        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runtime.calls, 1)

    def test_service_rejects_authority_forgery_before_runtime(self) -> None:
        import sharednet.coordination.service as service_module

        validation_error = getattr(service_module, "PlanValidationError", None)
        self.assertIsNotNone(validation_error, "service must expose a typed plan validation failure")
        request = four_agent_request(mechanism="rac-adaptive", include_denied_superstar=True)
        candidate_by_id = {candidate.candidate_id: candidate for candidate in request.candidates}

        def forged_participant(candidate_id: str, *, cost: float | None = None, mode: CandidateMode | None = None, capabilities: tuple[str, ...] | None = None):
            candidate = candidate_by_id[candidate_id]
            return ParticipantPlan(
                candidate.candidate_id,
                "worker",
                "forged work",
                (),
                "forged",
                candidate.capabilities if capabilities is None else capabilities,
                candidate.predicted_cost if cost is None else cost,
                candidate.mode if mode is None else mode,
            )

        mutations = {
            "unknown_participant": (
                lambda plan, req, exc: replace(
                    plan,
                    participants=(ParticipantPlan("fabricated", "worker", "work", (), "forged", ("research",), 0.1, CandidateMode.RECRUIT),),
                    edges=(),
                ),
                "unknown_participant:fabricated",
            ),
            "denied_participant": (
                lambda plan, req, exc: replace(plan, participants=(forged_participant("denied-superstar"),), edges=()),
                "participant_not_admitted:denied-superstar",
            ),
            "underreported_cost": (
                lambda plan, req, exc: replace(plan, participants=(forged_participant("architect", cost=0.01),), edges=()),
                "participant_cost_mismatch:architect",
            ),
            "mode_mismatch": (
                lambda plan, req, exc: replace(plan, participants=(forged_participant("self", mode=CandidateMode.RECRUIT),), edges=()),
                "participant_mode_mismatch:self",
            ),
            "capability_mismatch": (
                lambda plan, req, exc: replace(plan, participants=(forged_participant("architect", capabilities=("research",)),), edges=()),
                "participant_capabilities_mismatch:architect",
            ),
            "task_identity": (
                lambda plan, req, exc: replace(plan, task_id="forged-task"),
                "task_id_mismatch",
            ),
            "trace_identity": (
                lambda plan, req, exc: replace(plan, trace_id="forged-trace"),
                "trace_id_mismatch",
            ),
            "mechanism_identity": (
                lambda plan, req, exc: replace(plan, mechanism_id="forged-mechanism"),
                "mechanism_id_mismatch",
            ),
            "exclusions": (
                lambda plan, req, exc: replace(plan, exclusions=frozenset({"architect"})),
                "exclusions_mismatch",
            ),
            "budget": (
                lambda plan, req, exc: replace(plan, budget=replace(plan.budget, max_participants=plan.budget.max_participants + 1)),
                "budget_mismatch",
            ),
            "task_payload": (
                lambda plan, req, exc: replace(plan, runtime_instructions={**plan.to_dict()["runtime_instructions"], "task": {"task_id": "forged"}}),
                "task_payload_mismatch",
            ),
        }

        original_get_backend = service_module.get_backend
        try:
            for name, (mutate, expected_reason) in mutations.items():
                with self.subTest(name=name):
                    runtime = ScriptedRuntime([accepted_result])
                    service_module.get_backend = lambda mechanism, mutate=mutate: MutatingBackend(mutate)
                    with self.assertRaises(validation_error) as raised:
                        service_module.CoordinationService().execute(request, runtime)
                    self.assertEqual(raised.exception.reason, expected_reason)
                    self.assertEqual(runtime.calls, 0)
        finally:
            service_module.get_backend = original_get_backend

    def test_post_attempt_adaptive_abstention_preserves_completed_evidence(self) -> None:
        from sharednet.coordination.service import CoordinationService

        base = linear_request()
        request = replace(
            base,
            candidates=(base.candidates[0],),
            budget=replace(base.budget, max_retries=1),
        )
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",), usage={"tokens": 7}, error="raw_failure"),
        ])

        result = CoordinationService().execute(request, runtime)

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "replan_no_eligible_candidates")
        self.assertEqual(result.plan, runtime.plans[0])
        self.assertEqual(result.synthesis, "partial synthesis")
        self.assertEqual(result.failed_participant_ids, ("self",))
        self.assertEqual(result.usage, {"tokens": 7, "planned_turns": 1})
        self.assertEqual(result.runtime_evidence["source"], "scripted")
        terminal_replan = result.runtime_evidence["terminal_replan"]
        self.assertEqual(terminal_replan["reason"], "no_eligible_candidates")
        self.assertEqual(terminal_replan["plan"]["terminal_status"], "abstained")
        self.assertEqual(len(result.attempts), 1)

    def test_post_attempt_discovery_requester_exclusion_preserves_completed_evidence(self) -> None:
        from sharednet.coordination.service import CoordinationService

        request = replace(discovery_cost_replan_request(), budget=replace(discovery_cost_replan_request().budget, max_cost=1.0))
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",), usage={"tokens": 5}, error="requester_failed"),
        ])

        result = CoordinationService().execute(request, runtime)

        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "replan_requester_excluded")
        self.assertEqual(result.plan, runtime.plans[0])
        self.assertEqual(result.failed_participant_ids, ("self",))
        self.assertEqual(result.runtime_evidence["source"], "scripted")
        self.assertEqual(result.runtime_evidence["terminal_replan"]["reason"], "requester_excluded")
        self.assertEqual(result.runtime_evidence["terminal_replan"]["plan"]["exclusions"], ("self",))
        self.assertEqual(result.usage, {"tokens": 5, "planned_turns": 2})
        self.assertEqual(len(result.attempts), 1)

    def test_execute_reserves_failed_attempt_predicted_cost_before_exact_bound_retry(self) -> None:
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        backend = CostAwareRetryBackend((0.4, 0.6))
        request = adaptive_request_with_costs(0.4, 0.6)
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
        request = adaptive_request_with_costs(0.7, 0.4)
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
        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "cost_budget_exhausted")
        self.assertEqual(result.plan, runtime.plans[0])
        self.assertEqual(result.attempts[0].status, TerminalStatus.FAILED)

    def test_execute_preserves_failed_evidence_when_discovery_cannot_afford_requester_on_replan(self) -> None:
        from sharednet.coordination.service import CoordinationService

        runtime = ScriptedRuntime([lambda plan: failed_result(plan, ("first-specialist",), usage={"tokens": 7})])
        result = CoordinationService().execute(discovery_cost_replan_request(), runtime)

        self.assertEqual(runtime.calls, 1)
        self.assertEqual(runtime.plans[0].participant_ids, ("self", "first-specialist"))
        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(result.error, "cost_budget_exhausted")
        self.assertEqual(result.plan, runtime.plans[0])
        self.assertEqual(result.runtime_evidence["source"], "scripted")
        self.assertEqual(result.runtime_evidence["attempt"], 0)
        self.assertEqual(result.runtime_evidence["terminal_replan"]["reason"], "cost_budget_exhausted")
        self.assertEqual(result.usage, {"tokens": 7, "planned_turns": 2})
        self.assertEqual(len(result.attempts), 1)

    def test_execute_exhausts_when_a_failed_attempt_reserves_the_entire_cost_budget(self) -> None:
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        backend = CostAwareRetryBackend((1.0,))
        request = adaptive_request_with_costs(1.0, 0.1)
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

    def test_late_post_attempt_abstention_records_replan_evidence_before_wall_exhaustion(self) -> None:
        from sharednet.coordination.backends.discovery_and_use import DiscoveryAndUseBackend
        import sharednet.coordination.service as service_module
        from sharednet.coordination.service import CoordinationService

        clock = ManualClock()
        backend = ReplanDeadlineBackend(DiscoveryAndUseBackend(), clock)
        request = replace(
            discovery_cost_replan_request(),
            budget=replace(discovery_cost_replan_request().budget, max_cost=1.0, max_wall_seconds=10),
        )
        runtime = ScriptedRuntime([
            lambda plan: failed_result(plan, ("self",), error="requester_failed"),
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
        self.assertEqual(result.plan, runtime.plans[0])
        self.assertEqual(result.runtime_evidence["source"], "scripted")
        self.assertEqual(result.runtime_evidence["terminal_replan"]["reason"], "requester_excluded")
        self.assertEqual(result.attempts[0].error, "requester_failed")

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
