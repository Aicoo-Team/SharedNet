from __future__ import annotations

from pathlib import Path
import tempfile
from unittest import TestCase

from fastapi.testclient import TestClient

from sharednet.room.api import create_room_app


def authorization(scheme: str, token: str) -> dict[str, str]:
    return {"Authorization": f"{scheme} {token}"}


class ControlApiTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="sharednet-control-api-")
        root = Path(self.temporary_directory.name)
        self.database_path = root / "sharednet.db"
        self.blob_path = root / "blobs"
        self.console_token = "console-test-only"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def app(self, *, legacy: bool = False):
        return create_room_app(
            self.database_path,
            self.blob_path,
            console_token=self.console_token,
            web_base_url="http://127.0.0.1:3001",
            enable_legacy_registration=legacy,
        )

    def console(self) -> dict[str, str]:
        return {"X-SharedNet-Console-Token": self.console_token}

    def paired_connector(self, client: TestClient, auth_user_id: str) -> dict[str, object]:
        started = client.post("/v1/pairings", json={})
        self.assertEqual(started.status_code, 201, started.text)
        pairing = started.json()
        claimed = client.post(
            f"/v1/console/accounts/{auth_user_id}/pairings/{pairing['pairing_id']}/claim",
            headers=self.console(),
        )
        self.assertEqual(claimed.status_code, 200, claimed.text)
        decision = claimed.json()
        resolved = client.post(
            f"/v1/console/accounts/{auth_user_id}/decisions/{decision['decision_id']}/resolve",
            headers=self.console(),
            json={"outcome": "approved"},
        )
        self.assertEqual(resolved.status_code, 200, resolved.text)
        exchanged = client.post(
            f"/v1/pairings/{pairing['pairing_id']}/exchange",
            json={"pairing_secret": pairing["pairing_secret"]},
        )
        self.assertEqual(exchanged.status_code, 200, exchanged.text)
        return exchanged.json()

    def started_instance(self, client: TestClient, auth_user_id: str = "auth-user-1"):
        connector = self.paired_connector(client, auth_user_id)
        agent_response = client.post(
            "/v1/local/agents",
            headers=authorization("Connector", connector["connector_token"]),
            json={"diagnostic_label": "Codex", "capabilities": ["rooms", "decisions"]},
        )
        self.assertEqual(agent_response.status_code, 201, agent_response.text)
        agent = agent_response.json()
        runtime_response = client.post(
            "/v1/local/runtimes",
            headers=authorization("Connector", connector["connector_token"]),
            json={
                "agent_id": agent["agent_id"],
                "runtime_kind": "codex",
                "workspace_label": "/workspace/sharednet",
            },
        )
        self.assertEqual(runtime_response.status_code, 201, runtime_response.text)
        runtime = runtime_response.json()
        instance_response = client.post(
            "/v1/local/instances",
            headers=authorization("Runtime", runtime["runtime_token"]),
            json={"provider_session_id": "codex-thread", "lease_seconds": 90},
        )
        self.assertEqual(instance_response.status_code, 201, instance_response.text)
        return connector, agent, runtime, instance_response.json()

    def test_pairing_instance_room_decision_and_console_projection_end_to_end(self) -> None:
        with TestClient(self.app()) as client:
            connector, agent, runtime, instance = self.started_instance(client)
            instance_headers = authorization("Instance", instance["instance_token"])
            room_response = client.post(
                "/v1/rooms",
                headers=instance_headers,
                json={"name": "Launch room", "access_policy": "principal_only"},
            )
            self.assertEqual(room_response.status_code, 201, room_response.text)
            room = room_response.json()
            self.assertEqual(
                room["creator"]["instance_id"],
                instance["identity"]["instance_id"],
            )
            message_response = client.post(
                f"/v1/rooms/{room['room_id']}/messages",
                headers=instance_headers,
                json={"content": "hello from local"},
            )
            self.assertEqual(message_response.status_code, 201, message_response.text)
            self.assertEqual(
                message_response.json()["sender"]["instance_id"],
                instance["identity"]["instance_id"],
            )

            decision_response = client.post(
                "/v1/decisions",
                headers=instance_headers,
                json={
                    "mode": "text",
                    "title": "Deployment region",
                    "description": "Choose one region",
                    "room_id": room["room_id"],
                },
            )
            self.assertEqual(decision_response.status_code, 201, decision_response.text)
            decision = decision_response.json()

            rooms = client.get(
                "/v1/console/accounts/auth-user-1/rooms",
                headers=self.console(),
            )
            detail = client.get(
                f"/v1/console/accounts/auth-user-1/rooms/{room['room_id']}",
                headers=self.console(),
            )
            network = client.get(
                "/v1/console/accounts/auth-user-1/network",
                headers=self.console(),
            )
            decisions = client.get(
                "/v1/console/accounts/auth-user-1/decisions",
                headers=self.console(),
            )
            for response in (rooms, detail, network, decisions):
                self.assertEqual(response.status_code, 200, response.text)
                self.assertNotIn(connector["connector_token"], response.text)
                self.assertNotIn(runtime["runtime_token"], response.text)
                self.assertNotIn(instance["instance_token"], response.text)

            self.assertEqual(rooms.json()["rooms"][0]["room_id"], room["room_id"])
            self.assertEqual(detail.json()["messages"][0]["content"], "hello from local")
            self.assertEqual(network.json()["principal"]["principal_id"], connector["principal_id"])
            self.assertEqual(network.json()["agents"][0]["agent_id"], agent["agent_id"])
            self.assertEqual(decisions.json()["decisions"][0]["decision_id"], decision["decision_id"])

            invalid_filter = client.get(
                "/v1/console/accounts/auth-user-1/decisions?decision_status=unknown",
                headers=self.console(),
            )
            self.assertEqual(invalid_filter.status_code, 400, invalid_filter.text)
            self.assertEqual(
                invalid_filter.json()["error"]["code"],
                "invalid_decision_status",
            )

            resolved = client.post(
                f"/v1/console/accounts/auth-user-1/decisions/{decision['decision_id']}/resolve",
                headers=self.console(),
                json={"outcome": "answered", "response_text": "Singapore"},
            )
            self.assertEqual(resolved.status_code, 200, resolved.text)
            retrieved = client.get(
                f"/v1/decisions/{decision['decision_id']}",
                headers=instance_headers,
            )
            self.assertEqual(retrieved.status_code, 200, retrieved.text)
            self.assertEqual(retrieved.json()["response_text"], "Singapore")

    def test_credential_scopes_and_account_visibility_fail_closed(self) -> None:
        with TestClient(self.app()) as client:
            connector, _, runtime, instance = self.started_instance(client)
            for headers in (
                authorization("Connector", connector["connector_token"]),
                authorization("Runtime", runtime["runtime_token"]),
            ):
                response = client.post(
                    "/v1/rooms",
                    headers=headers,
                    json={"name": "forbidden"},
                )
                self.assertEqual(response.status_code, 401, response.text)

            room = client.post(
                "/v1/rooms",
                headers=authorization("Instance", instance["instance_token"]),
                json={"name": "private"},
            ).json()
            self.paired_connector(client, "auth-user-2")
            hidden = client.get(
                f"/v1/console/accounts/auth-user-2/rooms/{room['room_id']}",
                headers=self.console(),
            )
            self.assertEqual(hidden.status_code, 404, hidden.text)
            unauthorized = client.get(
                "/v1/console/accounts/auth-user-1/network",
                headers={"X-SharedNet-Console-Token": "wrong"},
            )
            self.assertEqual(unauthorized.status_code, 401, unauthorized.text)

    def assert_existing_instance_rejected(
        self,
        client: TestClient,
        instance_token: str,
    ) -> None:
        headers = authorization("Instance", instance_token)
        responses = {
            "heartbeat": client.post(
                "/v1/local/instances/current/heartbeat",
                headers=headers,
                json={"lease_seconds": 90},
            ),
            "Room": client.get("/v1/rooms", headers=headers),
            "Decision": client.post(
                "/v1/decisions",
                headers=headers,
                json={
                    "mode": "approval",
                    "title": "Release",
                    "description": "Approve the release",
                },
            ),
        }
        for operation, response in responses.items():
            with self.subTest(operation=operation):
                self.assertEqual(response.status_code, 401, response.text)
                self.assertEqual(
                    response.json()["error"]["code"],
                    "invalid_instance_token",
                )

    def test_connector_revocation_invalidates_existing_instance_access(self) -> None:
        app = self.app()
        with TestClient(app) as client:
            connector, _, _, instance = self.started_instance(client)

            app.state.control_store.revoke_connector(connector["connector_token"])

            self.assert_existing_instance_rejected(
                client,
                instance["instance_token"],
            )

    def test_runtime_revocation_invalidates_existing_instance_access(self) -> None:
        app = self.app()
        with TestClient(app) as client:
            _, _, runtime, instance = self.started_instance(client)

            app.state.control_store.revoke_runtime(runtime["runtime_token"])

            self.assert_existing_instance_rejected(
                client,
                instance["instance_token"],
            )

    def test_legacy_registration_is_opt_in_and_bearer_use_gets_compatibility_instance(self) -> None:
        with TestClient(self.app(legacy=False)) as client:
            self.assertEqual(
                client.post(
                    "/v1/runtimes/register",
                    json={"principal_id": "principal_old", "agent_id": "agent_old"},
                ).status_code,
                404,
            )

        legacy_database = self.database_path.with_name("legacy.db")
        legacy_blobs = self.blob_path.with_name("legacy-blobs")
        app = create_room_app(
            legacy_database,
            legacy_blobs,
            console_token=self.console_token,
            enable_legacy_registration=True,
        )
        with TestClient(app) as client:
            registration = client.post(
                "/v1/runtimes/register",
                json={
                    "principal_id": "principal_old",
                    "agent_id": "agent_old",
                    "requested_runtime_id": "runtime_old",
                },
            )
            self.assertEqual(registration.status_code, 201, registration.text)
            room = client.post(
                "/v1/rooms",
                headers=authorization("Bearer", registration.json()["runtime_token"]),
                json={"name": "Compatibility room"},
            )
            self.assertEqual(room.status_code, 201, room.text)
            self.assertRegex(room.json()["creator"]["instance_id"], r"^i_[0-9A-Za-z]{10}$")
            ended = client.post(
                "/v1/local/instances/current/end",
                headers=authorization("Bearer", registration.json()["runtime_token"]),
            )
            self.assertEqual(ended.status_code, 409, ended.text)
            self.assertEqual(
                ended.json()["error"]["code"],
                "legacy_instance_end_not_supported",
            )


if __name__ == "__main__":
    import unittest

    unittest.main()
