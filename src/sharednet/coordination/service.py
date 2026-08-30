"""Bounded planning, execution, and attributable recovery for coordination."""

from __future__ import annotations

from dataclasses import replace
import time
from typing import Callable, Mapping

from .interface import CoordinationBackend, CoordinationRuntime
from .models import AttemptSummary, CoordinationPlan, CoordinationRequest, CoordinationResult, TerminalStatus
from .registry import get_backend


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

        for attempt in range(request.budget.max_retries + 1):
            plan = self._plan(
                backend,
                request,
                excluded,
                attempt,
                remaining_wall_seconds=remaining_wall_seconds,
                remaining_turns=remaining_turns,
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

    @staticmethod
    def _plan(
        backend: CoordinationBackend,
        request: CoordinationRequest,
        excluded: frozenset[str],
        attempt: int,
        *,
        remaining_wall_seconds: float,
        remaining_turns: int,
    ) -> CoordinationPlan:
        effective_budget = replace(
            request.budget,
            max_wall_seconds=remaining_wall_seconds,
            max_turns=remaining_turns,
            max_participants=min(request.budget.max_participants, remaining_turns),
        )
        effective_request = replace(request, budget=effective_budget)
        return replace(backend.plan(effective_request, excluded=excluded), attempt=attempt)

    @staticmethod
    def _accumulate_numeric_usage(total: dict[str, int | float], usage: Mapping[str, object]) -> None:
        for key, value in usage.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                total[key] = total.get(key, 0) + value
