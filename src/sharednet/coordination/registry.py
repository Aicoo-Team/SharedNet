"""Canonical mechanism ordering, aliases, and backend lookup."""

from __future__ import annotations

from .backends import DiscoveryAndUseBackend, PeerForumBackend, RacAdaptiveBackend, RacRgeBackend
from .interface import CoordinationBackend


DEFAULT_MECHANISMS = (
    "discovery-and-use",
    "rac-rge",
    "rac-adaptive",
    "peer-forum",
)
MECHANISM_ALIASES = {"rac-adpt": "rac-adaptive"}

_BACKEND_TYPES: dict[str, type[CoordinationBackend]] = {
    "discovery-and-use": DiscoveryAndUseBackend,
    "rac-rge": RacRgeBackend,
    "rac-adaptive": RacAdaptiveBackend,
    "peer-forum": PeerForumBackend,
}


class UnknownMechanism(ValueError):
    """Raised when the public registry cannot resolve a requested mechanism."""


def list_mechanisms() -> list[dict[str, str]]:
    """Return canonical mechanisms in their public, stable order."""
    return [{"id": mechanism_id} for mechanism_id in DEFAULT_MECHANISMS]


def get_backend(name: str) -> CoordinationBackend:
    """Construct the canonical backend selected by a canonical ID or alias."""
    canonical_name = MECHANISM_ALIASES.get(name, name) if isinstance(name, str) else name
    backend_type = _BACKEND_TYPES.get(canonical_name)
    if backend_type is None:
        raise UnknownMechanism(f"unknown coordination mechanism: {name!r}")
    return backend_type()
