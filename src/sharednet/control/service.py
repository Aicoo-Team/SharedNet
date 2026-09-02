"""Application services for account pairing and local connector authorization."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from urllib.parse import urlparse

from .models import (
    ActorIdentity,
    AgentBinding,
    AgentInstance,
    ConnectorSession,
    ControlError,
    DecisionMode,
    DecisionStatus,
    HumanDecision,
    InstanceSession,
    PairingStart,
    RuntimeSession,
)
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

    def create_agent(
        self,
        connector_token: str,
        diagnostic_label: str,
        capabilities: list[str] | tuple[str, ...],
    ) -> AgentBinding:
        token = self._token(connector_token, "connector")
        label = self._bounded_text(diagnostic_label, "diagnostic_label", 200)
        normalized_capabilities = self._capabilities(capabilities)
        return self.store.create_agent(token, label, normalized_capabilities)

    def register_runtime(
        self,
        connector_token: str,
        agent_id: str,
        runtime_kind: str,
        workspace_label: str | None,
    ) -> RuntimeSession:
        token = self._token(connector_token, "connector")
        kind = self._bounded_text(runtime_kind, "runtime_kind", 100)
        workspace = self._optional_bounded_text(
            workspace_label,
            "workspace_label",
            4096,
        )
        return self.store.register_runtime(token, agent_id, kind, workspace)

    def start_instance(
        self,
        runtime_token: str,
        provider_session_id: str | None = None,
        *,
        lease_seconds: int = 90,
    ) -> InstanceSession:
        token = self._token(runtime_token, "runtime")
        provider_session = self._optional_bounded_text(
            provider_session_id,
            "provider_session_id",
            512,
        )
        lease = self._lease_seconds(lease_seconds)
        return self.store.start_instance(token, provider_session, lease)

    def heartbeat_instance(
        self,
        instance_token: str,
        *,
        lease_seconds: int = 90,
    ) -> AgentInstance:
        return self.store.heartbeat_instance(
            self._token(instance_token, "instance"),
            self._lease_seconds(lease_seconds),
        )

    def end_instance(self, instance_token: str) -> AgentInstance:
        return self.store.end_instance(self._token(instance_token, "instance"))

    def authenticate_instance(self, instance_token: str) -> ActorIdentity:
        return self.store.authenticate_instance(
            self._token(instance_token, "instance")
        )

    def request_decision(
        self,
        identity: ActorIdentity,
        mode: str,
        title: str,
        description: str,
        consequence: str | None = None,
        room_id: str | None = None,
    ) -> HumanDecision:
        if not isinstance(identity, ActorIdentity):
            raise ControlError(
                "invalid_instance_identity",
                "Decision requester must be an Instance identity",
                401,
            )
        try:
            response_mode = DecisionMode(mode)
        except (TypeError, ValueError) as error:
            raise ControlError(
                "invalid_decision_mode",
                "Decision mode must be approval or text",
                400,
            ) from error
        normalized_title = self._bounded_text(title, "title", 200)
        normalized_description = self._bounded_text(description, "description", 4000)
        normalized_consequence = self._optional_bounded_text(
            consequence,
            "consequence",
            4000,
        )
        if room_id is not None:
            room_id = self._bounded_text(room_id, "room_id", 128)
        return self.store.request_decision(
            identity,
            response_mode,
            normalized_title,
            normalized_description,
            normalized_consequence,
            room_id,
        )

    def list_decisions_for_account(
        self,
        auth_user_id: str,
        status: str | None = None,
    ) -> tuple[HumanDecision, ...]:
        normalized_status = None
        if status is not None:
            try:
                normalized_status = DecisionStatus(status)
            except (TypeError, ValueError) as error:
                raise ControlError(
                    "invalid_decision_status",
                    "Decision status is invalid",
                    400,
                ) from error
        return self.store.list_decisions_for_account(auth_user_id, normalized_status)

    def resolve_decision_for_account(
        self,
        auth_user_id: str,
        decision_id: str,
        outcome: str,
        response_text: str | None = None,
    ) -> HumanDecision:
        try:
            normalized_outcome = DecisionStatus(outcome)
        except (TypeError, ValueError) as error:
            raise ControlError(
                "invalid_decision_response",
                "Decision outcome is invalid",
                400,
            ) from error
        if normalized_outcome is DecisionStatus.PENDING:
            raise ControlError(
                "invalid_decision_response",
                "pending is not a Decision response",
                400,
            )
        if response_text is not None and (
            not isinstance(response_text, str)
            or not response_text.strip()
            or len(response_text) > 4000
        ):
            raise ControlError(
                "invalid_decision_response",
                "Decision response text must contain 1 to 4000 characters",
                400,
            )
        return self.store.resolve_decision_for_account(
            auth_user_id,
            self._bounded_text(decision_id, "decision_id", 128),
            normalized_outcome,
            response_text,
        )

    def get_decision_for_instance(
        self,
        identity: ActorIdentity,
        decision_id: str,
    ) -> HumanDecision:
        if not isinstance(identity, ActorIdentity):
            raise ControlError(
                "invalid_instance_identity",
                "Decision requester must be an Instance identity",
                401,
            )
        return self.store.get_decision_for_instance(
            identity,
            self._bounded_text(decision_id, "decision_id", 128),
        )

    @staticmethod
    def _token(value: object, scope: str) -> str:
        if not isinstance(value, str) or not value:
            raise ControlError(
                f"invalid_{scope}_token",
                f"{scope.capitalize()} credential is invalid",
                401,
            )
        return value

    @staticmethod
    def _bounded_text(value: object, field_name: str, maximum: int) -> str:
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise ControlError(
                f"invalid_{field_name}",
                f"{field_name} must be a non-empty string of at most {maximum} characters",
                400,
            )
        return value

    @classmethod
    def _optional_bounded_text(
        cls,
        value: object,
        field_name: str,
        maximum: int,
    ) -> str | None:
        if value is None:
            return None
        return cls._bounded_text(value, field_name, maximum)

    @classmethod
    def _capabilities(cls, value: object) -> tuple[str, ...]:
        if not isinstance(value, (list, tuple)) or len(value) > 64:
            raise ControlError(
                "invalid_capabilities",
                "capabilities must be a list of at most 64 strings",
                400,
            )
        normalized: list[str] = []
        for item in value:
            capability = cls._bounded_text(item, "capability", 100)
            if capability in normalized:
                raise ControlError(
                    "invalid_capabilities",
                    "capabilities must be unique",
                    400,
                )
            normalized.append(capability)
        return tuple(normalized)

    @staticmethod
    def _lease_seconds(value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 3600:
            raise ControlError(
                "invalid_lease_seconds",
                "lease_seconds must be between 1 and 3600",
                400,
            )
        return value

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
