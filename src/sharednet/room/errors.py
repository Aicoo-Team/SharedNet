"""Stable domain errors for the Room API."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RoomError(Exception):
    """A client-safe Room error with a machine-readable code."""

    code: str
    message: str
    status_code: int

    def __post_init__(self) -> None:
        Exception.__init__(self, self.code, self.message, self.status_code)

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"
