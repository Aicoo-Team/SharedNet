"""Small, bounded coordination primitives derived from RAC research.

Adapted from ``Aicoo-Team/runtime-agent-coordination`` under the MIT License:
``utils/guards/budget.py``, ``utils/guards/attenuation.py``, and
``utils/forum.py`` (commit 1ecab6b5471f82337cbd574d61d606606a56737a).
This module retains the per-child ledger and attributable append-only transcript
semantics while exposing SharedNet's smaller product-facing contracts.
"""

from __future__ import annotations

from dataclasses import dataclass
import threading
import time
from typing import Any, Callable, Mapping

from .models import Candidate


class BudgetExceeded(Exception):
    """A local budget operation was refused with a stable reason code."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def verified_experience(candidate: Candidate) -> float:
    """Return centered Beta(1, 1) experience without an unseen-candidate bonus."""
    return (
        (candidate.verified_successes + 1)
        / (candidate.verified_successes + candidate.verified_failures + 2)
        - 0.5
    )


def candidate_utility(candidate: Candidate, coordination_overhead: float = 0.0) -> float:
    """Return deterministic-score input; callers provide ID tie-breaking separately."""
    if coordination_overhead < 0:
        raise ValueError("coordination_overhead must be nonnegative")
    return round(
        candidate.predicted_quality
        + verified_experience(candidate)
        - candidate.predicted_cost
        - candidate.predicted_latency
        - candidate.predicted_risk
        - coordination_overhead,
        12,
    )


class LocalBudget:
    """Thread-safe child reservations within one parent cost/deadline envelope.

    The explicit child ledger prevents concurrent children from consuming or
    refunding one another's reservation. It is adapted from the upstream RAC
    ``utils/guards/budget.py`` primitive, which is MIT-licensed.
    """

    def __init__(
        self,
        cost_limit: float,
        deadline_ms: int | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if cost_limit < 0:
            raise ValueError("cost_limit must be nonnegative")
        if deadline_ms is not None and deadline_ms < 0:
            raise ValueError("deadline_ms must be nonnegative")
        self._lock = threading.Lock()
        self._clock = clock
        self._cost_limit = float(cost_limit)
        self._unreserved_cost = float(cost_limit)
        self._deadline_ms = deadline_ms
        self._unreserved_deadline_ms = deadline_ms
        self._spent_cost = 0.0
        self._reservations: dict[str, dict[str, Any]] = {}

    @property
    def cost_limit(self) -> float:
        return self._cost_limit

    @property
    def spent_cost(self) -> float:
        with self._lock:
            return self._spent_cost

    @property
    def unreserved_cost(self) -> float:
        with self._lock:
            return self._unreserved_cost

    @property
    def remaining_cost(self) -> float:
        return self.unreserved_cost

    @property
    def remaining_deadline_ms(self) -> int | None:
        with self._lock:
            return self._unreserved_deadline_ms

    def reserve(self, child_id: str, cost_limit: float, deadline_ms: int | None = None) -> None:
        """Reserve a child's declared envelope before allowing it to run."""
        if not isinstance(child_id, str) or not child_id:
            raise ValueError("child_id must be a nonempty string")
        if cost_limit < 0:
            raise ValueError("cost_limit must be nonnegative")
        if deadline_ms is not None and deadline_ms < 0:
            raise ValueError("deadline_ms must be nonnegative")
        with self._lock:
            if child_id in self._reservations:
                raise BudgetExceeded("duplicate_child_requirement_id")
            if cost_limit > self._unreserved_cost:
                raise BudgetExceeded("insufficient_unreserved_cost")
            if self._unreserved_deadline_ms is not None:
                if deadline_ms is None or deadline_ms > self._unreserved_deadline_ms:
                    raise BudgetExceeded("insufficient_unreserved_deadline")
            self._unreserved_cost -= float(cost_limit)
            if self._unreserved_deadline_ms is not None:
                self._unreserved_deadline_ms -= int(deadline_ms)
            self._reservations[child_id] = {
                "reserved_cost": float(cost_limit),
                "spent_cost": 0.0,
                "deadline_ms": deadline_ms,
                "started": self._clock(),
                "open": True,
            }

    def charge(self, child_id: str, cost: float) -> None:
        """Charge actual spend to exactly one open reservation."""
        if cost < 0:
            raise ValueError("cost must be nonnegative")
        with self._lock:
            reservation = self._reservations.get(child_id)
            if reservation is None or not reservation["open"]:
                raise BudgetExceeded("reservation_not_found")
            proposed = reservation["spent_cost"] + float(cost)
            if proposed > reservation["reserved_cost"]:
                raise BudgetExceeded("child_spend_exceeds_reservation")
            reservation["spent_cost"] = proposed
            self._spent_cost += float(cost)

    def release(self, child_id: str) -> dict[str, float | int | str]:
        """Close a reservation and return its unused capacity to the parent."""
        with self._lock:
            reservation = self._reservations.get(child_id)
            if reservation is None or not reservation["open"]:
                raise BudgetExceeded("reservation_not_found")
            reservation["open"] = False
            elapsed_ms = int((self._clock() - reservation["started"]) * 1000)
            refunded_cost = reservation["reserved_cost"] - reservation["spent_cost"]
            self._unreserved_cost += refunded_cost
            refunded_deadline_ms = 0
            if self._unreserved_deadline_ms is not None and reservation["deadline_ms"] is not None:
                refunded_deadline_ms = max(0, reservation["deadline_ms"] - elapsed_ms)
                self._unreserved_deadline_ms += refunded_deadline_ms
            return {
                "child_id": child_id,
                "spent_cost": reservation["spent_cost"],
                "elapsed_ms": elapsed_ms,
                "refunded_cost": refunded_cost,
                "refunded_deadline_ms": refunded_deadline_ms,
            }


def _contract_value(contract: object, name: str) -> object | None:
    if isinstance(contract, Mapping):
        return contract.get(name)
    return getattr(contract, name, None)


def attenuation_failure(parent: object, child: object) -> str | None:
    """Return a typed reason when a child widens rather than narrows its parent.

    The checks adapt the narrowing rule from upstream RAC's
    ``utils/guards/attenuation.py`` (MIT License). ``None`` means the child is
    attenuated relative to the provided parent contract.
    """
    scalar_limits = (
        ("cost_limit", "wider_cost_limit"),
        ("deadline_seconds", "wider_deadline"),
        ("deadline_ms", "wider_deadline"),
        ("max_disclosure_bytes", "wider_disclosure"),
        ("max_depth", "wider_depth"),
    )
    for field, reason in scalar_limits:
        parent_value = _contract_value(parent, field)
        child_value = _contract_value(child, field)
        if parent_value is not None and child_value is not None and child_value > parent_value:
            return reason
    parent_effects = _contract_value(parent, "allowed_effects")
    child_effects = _contract_value(child, "allowed_effects")
    if parent_effects is not None and child_effects is not None:
        if not set(child_effects).issubset(set(parent_effects)):
            return "wider_effects"
    return None


@dataclass(frozen=True)
class ForumPost:
    """One attributable, immutable forum note."""

    sequence: int
    author_id: str
    note: str

    @property
    def agent_id(self) -> str:
        return self.author_id

    def to_dict(self) -> dict[str, str | int]:
        return {"sequence": self.sequence, "author_id": self.author_id, "note": self.note}


@dataclass(frozen=True)
class ForumRead:
    """Attributable evidence of what one reader could observe."""

    reader_id: str
    visible_sequences: tuple[int, ...]

    def to_dict(self) -> dict[str, object]:
        return {"reader_id": self.reader_id, "visible_sequences": list(self.visible_sequences)}


class AppendOnlyForum:
    """A bounded, attributable, append-only peer transcript.

    Adapted from the upstream RAC ``utils/forum.py`` append-only board under
    the MIT License; unlike its evaluation modes, SharedNet exposes just the
    production full-transcript discipline.
    """

    def __init__(self, max_posts: int, max_note_bytes: int) -> None:
        if not isinstance(max_posts, int) or max_posts <= 0:
            raise ValueError("max_posts must be positive")
        if not isinstance(max_note_bytes, int) or max_note_bytes <= 0:
            raise ValueError("max_note_bytes must be positive")
        self._max_posts = max_posts
        self._max_note_bytes = max_note_bytes
        self._lock = threading.Lock()
        self._posts: list[ForumPost] = []
        self._reads: list[ForumRead] = []

    @property
    def posts(self) -> tuple[ForumPost, ...]:
        with self._lock:
            return tuple(self._posts)

    @property
    def reads(self) -> tuple[ForumRead, ...]:
        with self._lock:
            return tuple(self._reads)

    def post(self, author_id: str, note: str) -> ForumPost:
        if not isinstance(author_id, str) or not author_id:
            raise ValueError("author_id must be a nonempty string")
        if not isinstance(note, str) or not note:
            raise ValueError("note must be a nonempty string")
        if len(note.encode("utf-8")) > self._max_note_bytes:
            raise ValueError("note exceeds max_note_bytes")
        with self._lock:
            if len(self._posts) >= self._max_posts:
                raise BudgetExceeded("forum_post_limit")
            post = ForumPost(len(self._posts), author_id, note)
            self._posts.append(post)
            return post

    def read(self, reader_id: str) -> tuple[ForumPost, ...]:
        if not isinstance(reader_id, str) or not reader_id:
            raise ValueError("reader_id must be a nonempty string")
        with self._lock:
            visible = tuple(post for post in self._posts if post.author_id != reader_id)
            self._reads.append(ForumRead(reader_id, tuple(post.sequence for post in visible)))
            return visible
