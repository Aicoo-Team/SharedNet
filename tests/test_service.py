"""Behavioral tests for bounded coordination execution and recovery."""

from __future__ import annotations

from dataclasses import replace
import unittest

from sharednet.coordination.models import (
    CoordinationRequest,
    CoordinationResult,
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


class ServiceTests(unittest.TestCase):
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
        self.assertEqual(result.usage, {"tokens": 4})
        self.assertEqual(len(result.attempts), 1)

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
        self.assertEqual(result.usage, {"tokens": 7, "seconds": 2.0})
        self.assertEqual([attempt.error for attempt in result.attempts], ["participant_failed", "second_failure"])


if __name__ == "__main__":
    unittest.main()
