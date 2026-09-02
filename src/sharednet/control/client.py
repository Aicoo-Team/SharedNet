"""Dependency-light HTTP client for SharedNet local identity lifecycles."""

from __future__ import annotations

from collections.abc import Sequence

from ..room.client import RoomClient, normalize_base_url


class ControlClient:
    def __init__(self, base_url: str, timeout: float = 30.0) -> None:
        self.base_url = normalize_base_url(base_url)
        self.timeout = timeout

    def _client(self, token: str | None = None, scheme: str = "Bearer") -> RoomClient:
        return RoomClient(
            self.base_url,
            token,
            self.timeout,
            auth_scheme=scheme,
        )

    def create_pairing(self, web_base_url: str) -> dict[str, object]:
        return self._client()._json(
            "POST",
            "/v1/pairings",
            payload={"web_base_url": web_base_url},
            protected=False,
        )

    def exchange_pairing(self, pairing_id: str, pairing_secret: str) -> dict[str, object]:
        segment = RoomClient._segment(pairing_id)
        return self._client()._json(
            "POST",
            f"/v1/pairings/{segment}/exchange",
            payload={"pairing_secret": pairing_secret},
            protected=False,
        )

    def create_agent(
        self,
        connector_token: str,
        diagnostic_label: str,
        capabilities: Sequence[str],
    ) -> dict[str, object]:
        return self._client(connector_token, "Connector")._json(
            "POST",
            "/v1/local/agents",
            payload={
                "diagnostic_label": diagnostic_label,
                "capabilities": list(capabilities),
            },
        )

    def register_runtime(
        self,
        connector_token: str,
        agent_id: str,
        runtime_kind: str,
        workspace_label: str | None,
    ) -> dict[str, object]:
        return self._client(connector_token, "Connector")._json(
            "POST",
            "/v1/local/runtimes",
            payload={
                "agent_id": agent_id,
                "runtime_kind": runtime_kind,
                "workspace_label": workspace_label,
            },
        )

    def start_instance(
        self,
        runtime_token: str,
        provider_session_id: str | None,
        lease_seconds: int,
    ) -> dict[str, object]:
        return self._client(runtime_token, "Runtime")._json(
            "POST",
            "/v1/local/instances",
            payload={
                "provider_session_id": provider_session_id,
                "lease_seconds": lease_seconds,
            },
        )

    def heartbeat_instance(self, instance_token: str, lease_seconds: int) -> dict[str, object]:
        return self._client(instance_token, "Instance")._json(
            "POST",
            "/v1/local/instances/current/heartbeat",
            payload={"lease_seconds": lease_seconds},
        )

    def end_instance(self, instance_token: str) -> dict[str, object]:
        return self._client(instance_token, "Instance")._json(
            "POST",
            "/v1/local/instances/current/end",
        )

    def request_decision(
        self,
        instance_token: str,
        mode: str,
        title: str,
        description: str,
        consequence: str | None,
        room_id: str | None,
    ) -> dict[str, object]:
        return self._client(instance_token, "Instance")._json(
            "POST",
            "/v1/decisions",
            payload={
                "mode": mode,
                "title": title,
                "description": description,
                "consequence": consequence,
                "room_id": room_id,
            },
        )

    def get_decision(self, instance_token: str, decision_id: str) -> dict[str, object]:
        segment = RoomClient._segment(decision_id)
        return self._client(instance_token, "Instance")._json(
            "GET",
            f"/v1/decisions/{segment}",
        )


__all__ = ["ControlClient"]
