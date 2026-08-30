"""Exact decimal arithmetic for predicted coordination-cost budgets."""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal, InvalidOperation


def to_decimal(value: object) -> Decimal:
    """Convert a JSON-style number using its stable decimal spelling."""
    if isinstance(value, bool):
        raise ValueError("cost must be a finite decimal number")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError("cost must be a finite decimal number") from error
    if not result.is_finite():
        raise ValueError("cost must be a finite decimal number")
    return result


def sum_costs(values: Iterable[object]) -> Decimal:
    """Sum cost values without binary floating-point tolerance."""
    return sum((to_decimal(value) for value in values), start=Decimal("0"))


def fits_cost_budget(current: object, addition: object, maximum: object) -> bool:
    """Return whether adding a cost stays at or below the exact bound."""
    return sum_costs((current, addition)) <= to_decimal(maximum)


def remaining_cost(maximum: object, spent: object) -> Decimal:
    """Return the exact unspent portion of a predicted-cost budget."""
    return to_decimal(maximum) - to_decimal(spent)
