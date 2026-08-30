"""Narrow planning and execution boundaries for coordination implementations."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .models import CoordinationPlan, CoordinationRequest, CoordinationResult


class CoordinationBackend(Protocol):
    mechanism_id: str

    def plan(
        self,
        request: CoordinationRequest,
        *,
        excluded: frozenset[str] = frozenset(),
    ) -> CoordinationPlan:
        """Produce a bounded, inspectable plan without executing it."""


class CoordinationRuntime(Protocol):
    def execute(self, plan: CoordinationPlan) -> CoordinationResult:
        """Execute one plan and return attributable runtime evidence."""


@runtime_checkable
class DeadlineAwareCoordinationRuntime(CoordinationRuntime, Protocol):
    """Optional capability using the caller's process-wide ``time.monotonic`` domain.

    Injected clocks must use the same coordinate system as the calling service.
    """

    def execute_until(
        self,
        plan: CoordinationPlan,
        *,
        monotonic_deadline: float,
    ) -> CoordinationResult:
        """Execute without model work after the caller-owned absolute deadline."""
