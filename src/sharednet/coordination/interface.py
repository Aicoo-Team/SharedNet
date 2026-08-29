"""Narrow planning and execution boundaries for coordination implementations."""

from __future__ import annotations

from typing import Protocol

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
