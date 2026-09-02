"""Application services for account pairing and local connector authorization."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from urllib.parse import urlparse

from .models import ConnectorSession, ControlError, HumanDecision, PairingStart
from .store import ControlStore, utc_now


class ControlService:
    def __init__(
        self,
        store: ControlStore,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.store = store
        self.clock = clock

    def create_pairing(
        self,
        web_base_url: str,
        *,
        ttl_seconds: int = 600,
    ) -> PairingStart:
        normalized_base_url = self._web_base_url(web_base_url)
        if (
            isinstance(ttl_seconds, bool)
            or not isinstance(ttl_seconds, int)
            or not 1 <= ttl_seconds <= 3600
        ):
            raise ControlError(
                "invalid_pairing_ttl",
                "pairing TTL must be between 1 and 3600 seconds",
                400,
            )
        expires_at = self.clock() + timedelta(seconds=ttl_seconds)
        challenge, pairing_secret = self.store.create_pairing_challenge(expires_at)
        return PairingStart(
            challenge.pairing_id,
            pairing_secret,
            f"{normalized_base_url}/decisions?pairing={challenge.pairing_id}",
            challenge.expires_at,
        )

    def claim_pairing(self, pairing_id: str, auth_user_id: str) -> HumanDecision:
        return self.store.claim_pairing(pairing_id, auth_user_id)

    def resolve_pairing(
        self,
        decision_id: str,
        auth_user_id: str,
        outcome: str,
    ) -> HumanDecision:
        return self.store.resolve_pairing(decision_id, auth_user_id, outcome)

    def exchange_pairing(
        self,
        pairing_id: str,
        pairing_secret: str,
    ) -> ConnectorSession:
        return self.store.exchange_pairing(pairing_id, pairing_secret)

    @staticmethod
    def _web_base_url(value: object) -> str:
        if not isinstance(value, str):
            raise ControlError(
                "invalid_web_base_url",
                "web base URL must be an HTTP(S) origin",
                400,
            )
        parsed = urlparse(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.params
            or parsed.query
            or parsed.fragment
        ):
            raise ControlError(
                "invalid_web_base_url",
                "web base URL must be an HTTP(S) origin",
                400,
            )
        return value.rstrip("/")
