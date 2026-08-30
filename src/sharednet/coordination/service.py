"""Bounded planning, execution, and attributable recovery for coordination."""

from __future__ import annotations

from dataclasses import replace
import time
from typing import Callable, Mapping

from .costs import remaining_cost as subtract_cost, sum_costs, to_decimal
from .interface import CoordinationBackend, CoordinationRuntime
from .models import AttemptSummary, CoordinationPlan, CoordinationRequest, CoordinationResult, TerminalStatus
from .registry import get_backend


def _plain_json(value: object) -> object:
    if isinstance(value, Mapping):
        return {key: _plain_json(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_plain_json(item) for item in value]
    return value


class PlanValidationError(ValueError):
    """A backend crossed the immutable request's planning authority boundary."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"invalid coordination plan: {reason}")


class CoordinationService:
    """Execute a bounded sequence of attributable coordination attempts."""

    def __init__(self, *, clock: Callable[[], float] | None = None) -> None:
        self._clock = clock if clock is not None else time.monotonic

    def plan(self, request: CoordinationRequest) -> CoordinationPlan:
        """Resolve the request's backend and produce its initial plan."""
        return self._plan(
            get_backend(request.mechanism),
            request,
            frozenset(),
            attempt=0,
            remaining_wall_seconds=request.budget.max_wall_seconds,
            remaining_turns=request.budget.max_turns,
            remaining_cost=request.budget.max_cost,
        )

    def execute(self, request: CoordinationRequest, runtime: CoordinationRuntime) -> CoordinationResult:
        """Execute at most one initial attempt plus the configured attributable retries."""
        backend = get_backend(request.mechanism)
        admitted_candidate_ids = frozenset(candidate.candidate_id for candidate in request.candidates if candidate.admitted)
        excluded = frozenset()
        attempts: list[AttemptSummary] = []
        usage: dict[str, int | float] = {}
        last_completed: CoordinationResult | None = None
        remaining_turns = request.budget.max_turns
        deadline = self._clock() + request.budget.max_wall_seconds
        remaining_wall_seconds = request.budget.max_wall_seconds
        remaining_cost = to_decimal(request.budget.max_cost)

        for attempt in range(request.budget.max_retries + 1):
            plan = self._plan(
                backend,
                request,
                excluded,
                attempt,
                remaining_wall_seconds=remaining_wall_seconds,
                remaining_turns=remaining_turns,
                remaining_cost=remaining_cost,
            )
            execution_wall_seconds = deadline - self._clock()
            if execution_wall_seconds <= 0:
                if last_completed is not None:
                    return replace(
                        last_completed,
                        status=TerminalStatus.EXHAUSTED,
                        error="wall_time_budget_exhausted",
                    )
                return CoordinationResult(
                    status=TerminalStatus.EXHAUSTED,
                    plan=plan,
                    attempts=tuple(attempts),
                    usage=usage,
                    error="wall_time_budget_exhausted",
                )
            plan = replace(plan, budget=replace(plan.budget, max_wall_seconds=execution_wall_seconds))
            if plan.terminal_status is TerminalStatus.ABSTAINED:
                if last_completed is not None:
                    return self._terminal_replan_result(last_completed, plan)
                return CoordinationResult(
                    status=TerminalStatus.ABSTAINED,
                    plan=plan,
                    attempts=tuple(attempts),
                    usage=usage,
                )

            result = runtime.execute(plan)
            planned_turns = len(plan.participants)
            attempt_usage = dict(result.usage)
            attempt_usage["planned_turns"] = planned_turns
            attempts.append(
                AttemptSummary(
                    attempt=plan.attempt,
                    status=result.status,
                    failed_participant_ids=result.failed_participant_ids,
                    usage=attempt_usage,
                    error=result.error,
                )
            )
            self._accumulate_numeric_usage(usage, attempt_usage)
            completed = replace(result, attempts=tuple(attempts), usage=usage)
            last_completed = completed
            remaining_turns -= planned_turns
            remaining_wall_seconds = deadline - self._clock()
            remaining_cost = subtract_cost(
                remaining_cost,
                sum_costs(participant.predicted_cost for participant in plan.participants),
            )

            if remaining_wall_seconds <= 0:
                return replace(
                    completed,
                    status=TerminalStatus.EXHAUSTED,
                    error="wall_time_budget_exhausted",
                )
            if result.status is TerminalStatus.ACCEPTED:
                return completed
            attributable_failures = (
                frozenset(result.failed_participant_ids)
                & admitted_candidate_ids
                & frozenset(plan.participant_ids)
            )
            if not attributable_failures:
                return completed
            if remaining_cost == 0:
                return replace(
                    completed,
                    status=TerminalStatus.EXHAUSTED,
                    error="cost_budget_exhausted",
                )
            if attempt == request.budget.max_retries:
                return replace(
                    completed,
                    status=TerminalStatus.EXHAUSTED,
                    error="retry_budget_exhausted",
                )
            if remaining_turns <= 0:
                return replace(
                    completed,
                    status=TerminalStatus.EXHAUSTED,
                    error="turn_budget_exhausted",
                )
            excluded = excluded | attributable_failures

        raise RuntimeError("bounded coordination execution reached an unreachable state")

    @classmethod
    def _plan(
        cls,
        backend: CoordinationBackend,
        request: CoordinationRequest,
        excluded: frozenset[str],
        attempt: int,
        *,
        remaining_wall_seconds: float,
        remaining_turns: int,
        remaining_cost: object,
    ) -> CoordinationPlan:
        effective_budget = replace(
            request.budget,
            max_wall_seconds=remaining_wall_seconds,
            max_turns=remaining_turns,
            max_participants=min(request.budget.max_participants, remaining_turns),
            max_cost=float(to_decimal(remaining_cost)),
        )
        effective_request = replace(request, budget=effective_budget)
        raw_plan = backend.plan(effective_request, excluded=excluded)
        cls._validate_plan(raw_plan, backend, effective_request, excluded)
        return replace(raw_plan, attempt=attempt)

    @staticmethod
    def _validate_plan(
        plan: object,
        backend: CoordinationBackend,
        request: CoordinationRequest,
        excluded: frozenset[str],
    ) -> None:
        if not isinstance(plan, CoordinationPlan):
            raise PlanValidationError("backend_returned_non_plan")
        if plan.mechanism_id != backend.mechanism_id:
            raise PlanValidationError("mechanism_id_mismatch")
        if plan.task_id != request.task.task_id:
            raise PlanValidationError("task_id_mismatch")
        if plan.trace_id != request.trace_id:
            raise PlanValidationError("trace_id_mismatch")
        if plan.exclusions != excluded:
            raise PlanValidationError("exclusions_mismatch")
        if plan.budget != request.budget:
            raise PlanValidationError("budget_mismatch")

        runtime_task = _plain_json(plan.runtime_instructions.get("task"))
        if runtime_task != request.task.to_dict():
            raise PlanValidationError("task_payload_mismatch")

        candidates = {candidate.candidate_id: candidate for candidate in request.candidates}
        for participant in plan.participants:
            candidate = candidates.get(participant.candidate_id)
            if candidate is None:
                raise PlanValidationError(f"unknown_participant:{participant.candidate_id}")
            if not candidate.admitted:
                raise PlanValidationError(f"participant_not_admitted:{participant.candidate_id}")
            if participant.candidate_id in excluded:
                raise PlanValidationError(f"participant_excluded:{participant.candidate_id}")
            if participant.mode != candidate.mode:
                raise PlanValidationError(f"participant_mode_mismatch:{participant.candidate_id}")
            if participant.capabilities != candidate.capabilities:
                raise PlanValidationError(f"participant_capabilities_mismatch:{participant.candidate_id}")
            if to_decimal(participant.predicted_cost) != to_decimal(candidate.predicted_cost):
                raise PlanValidationError(f"participant_cost_mismatch:{participant.candidate_id}")

    @staticmethod
    def _terminal_replan_result(last_completed: CoordinationResult, plan: CoordinationPlan) -> CoordinationResult:
        reason = plan.stop_reason or "abstained"
        evidence = dict(last_completed.runtime_evidence)
        if "terminal_replan" in evidence:
            evidence["runtime_terminal_replan"] = evidence["terminal_replan"]
        evidence["terminal_replan"] = {
            "reason": reason,
            "plan": plan.to_dict(),
        }
        error = "cost_budget_exhausted" if reason == "cost_budget_exhausted" else f"replan_{reason}"
        return replace(
            last_completed,
            status=TerminalStatus.EXHAUSTED,
            runtime_evidence=evidence,
            error=error,
        )

    @staticmethod
    def _accumulate_numeric_usage(total: dict[str, int | float], usage: Mapping[str, object]) -> None:
        for key, value in usage.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                total[key] = total.get(key, 0) + value
