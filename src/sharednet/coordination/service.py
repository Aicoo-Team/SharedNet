"""Bounded planning, execution, and attributable recovery for coordination."""

from __future__ import annotations

from dataclasses import replace
from typing import Mapping

from .interface import CoordinationBackend, CoordinationRuntime
from .models import AttemptSummary, CoordinationPlan, CoordinationRequest, CoordinationResult, TerminalStatus
from .registry import get_backend


class CoordinationService:
    """Execute a bounded sequence of attributable coordination attempts."""

    def plan(self, request: CoordinationRequest) -> CoordinationPlan:
        """Resolve the request's backend and produce its initial plan."""
        return self._plan(get_backend(request.mechanism), request, frozenset(), attempt=0)

    def execute(self, request: CoordinationRequest, runtime: CoordinationRuntime) -> CoordinationResult:
        """Execute at most one initial attempt plus the configured attributable retries."""
        backend = get_backend(request.mechanism)
        excluded = frozenset()
        attempts: list[AttemptSummary] = []
        usage: dict[str, int | float] = {}

        for attempt in range(request.budget.max_retries + 1):
            plan = self._plan(backend, request, excluded, attempt)
            if plan.terminal_status is TerminalStatus.ABSTAINED:
                return CoordinationResult(
                    status=TerminalStatus.ABSTAINED,
                    plan=plan,
                    attempts=tuple(attempts),
                    usage=usage,
                )

            result = runtime.execute(plan)
            attempts.append(
                AttemptSummary(
                    attempt=plan.attempt,
                    status=result.status,
                    failed_participant_ids=result.failed_participant_ids,
                    usage=result.usage,
                    error=result.error,
                )
            )
            self._accumulate_numeric_usage(usage, result.usage)
            completed = replace(result, attempts=tuple(attempts), usage=usage)

            if result.status is TerminalStatus.ACCEPTED:
                return completed
            if not result.failed_participant_ids:
                return completed
            if attempt == request.budget.max_retries:
                return replace(
                    completed,
                    status=TerminalStatus.EXHAUSTED,
                    error="retry_budget_exhausted",
                )
            excluded = excluded | frozenset(result.failed_participant_ids)

        raise RuntimeError("bounded coordination execution reached an unreachable state")

    @staticmethod
    def _plan(
        backend: CoordinationBackend,
        request: CoordinationRequest,
        excluded: frozenset[str],
        attempt: int,
    ) -> CoordinationPlan:
        return replace(backend.plan(request, excluded=excluded), attempt=attempt)

    @staticmethod
    def _accumulate_numeric_usage(total: dict[str, int | float], usage: Mapping[str, object]) -> None:
        for key, value in usage.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                total[key] = total.get(key, 0) + value
