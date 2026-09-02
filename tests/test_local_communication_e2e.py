"""Opt-in live acceptance test for SharedNet V1 local Agent communication."""

from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import time
from unittest import TestCase, skipUnless

from sharednet.control.client import ControlClient
from sharednet.room.api import create_room_app
from sharednet.room.client import RoomClient
from sharednet.room.errors import RoomError
from tests.room.test_client import LiveServer


RUN_LIVE = os.environ.get("SHAREDNET_RUN_LIVE_E2E") == "1"


@skipUnless(RUN_LIVE, "set SHAREDNET_RUN_LIVE_E2E=1 to run the local communication harness")
class LocalCommunicationE2E(TestCase):
    def test_complete_local_agent_communication_survives_restart(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sharednet-local-e2e-") as directory:
            root = Path(directory)
            database = root / "sharednet.db"
            blobs = root / "blobs"
            console_token = "e2e-console-only"

            app = create_room_app(database, blobs, console_token=console_token)
            with LiveServer(app) as server:
                control = ControlClient(server.url)
                console = RoomClient(server.url)
                headers = {"X-SharedNet-Console-Token": console_token}

                pairing = control.create_pairing("http://127.0.0.1:3001")
                claim = console._json(
                    "POST",
                    f"/v1/console/accounts/demo-user/pairings/{pairing['pairing_id']}/claim",
                    protected=False,
                    headers=headers,
                )
                console._json(
                    "POST",
                    f"/v1/console/accounts/demo-user/decisions/{claim['decision_id']}/resolve",
                    payload={"outcome": "approved"},
                    protected=False,
                    headers=headers,
                )
                connector = control.exchange_pairing(
                    pairing["pairing_id"], pairing["pairing_secret"]
                )
                principal_id = connector["principal_id"]

                first = self._start_agent(
                    control,
                    connector["connector_token"],
                    "Codex A",
                    "codex",
                    "/workspace/a",
                )
                second = self._start_agent(
                    control,
                    connector["connector_token"],
                    "Claude B",
                    "claude-code",
                    "/workspace/b",
                )
                first_rooms = RoomClient(
                    server.url,
                    first["instance_token"],
                    auth_scheme="Instance",
                )
                second_rooms = RoomClient(
                    server.url,
                    second["instance_token"],
                    auth_scheme="Instance",
                )
                room = first_rooms.build_room("Local Agent Communication E2E")
                second_rooms.join_room(room["room_id"])
                message_a = first_rooms.post_message(room["room_id"], "A asks B to review")
                page_b = second_rooms.retrieve_messages(room["room_id"])
                self.assertEqual(page_b["messages"][0]["message_id"], message_a["message_id"])
                message_b = second_rooms.post_message(
                    room["room_id"],
                    "B reviewed it",
                    reply_to=message_a["message_id"],
                )
                page_a = first_rooms.retrieve_messages(
                    room["room_id"],
                    after_cursor=page_b["next_cursor"],
                )
                self.assertEqual(page_a["messages"][0]["message_id"], message_b["message_id"])

                approval = control.request_decision(
                    first["instance_token"],
                    "approval",
                    "Publish review?",
                    "Allow the reviewed output to be published.",
                    None,
                    room["room_id"],
                )
                text = control.request_decision(
                    second["instance_token"],
                    "text",
                    "Release note",
                    "Provide a short release note.",
                    None,
                    room["room_id"],
                )
                console._json(
                    "POST",
                    f"/v1/console/accounts/demo-user/decisions/{approval['decision_id']}/resolve",
                    payload={"outcome": "approved"},
                    protected=False,
                    headers=headers,
                )
                console._json(
                    "POST",
                    f"/v1/console/accounts/demo-user/decisions/{text['decision_id']}/resolve",
                    payload={"outcome": "answered", "response_text": "Ship the local Room demo."},
                    protected=False,
                    headers=headers,
                )

                other = console._json(
                    "POST",
                    "/v1/console/accounts/other-user/provision",
                    protected=False,
                    headers=headers,
                )
                self.assertNotEqual(other["principal_id"], principal_id)
                with self.assertRaises(RoomError) as hidden:
                    console._json(
                        "GET",
                        f"/v1/console/accounts/other-user/rooms/{room['room_id']}",
                        protected=False,
                        headers=headers,
                    )
                self.assertEqual(hidden.exception.status_code, 404)

                control.heartbeat_instance(first["instance_token"], 1)
                control.heartbeat_instance(second["instance_token"], 1)
                receipt = {
                    "principal_id": principal_id,
                    "agent_ids": [
                        first["identity"]["agent_id"],
                        second["identity"]["agent_id"],
                    ],
                    "runtime_ids": [
                        first["identity"]["runtime_id"],
                        second["identity"]["runtime_id"],
                    ],
                    "instance_ids": [
                        first["identity"]["instance_id"],
                        second["identity"]["instance_id"],
                    ],
                    "room_id": room["room_id"],
                    "message_ids": [message_a["message_id"], message_b["message_id"]],
                    "latest_cursor": page_a["next_cursor"],
                    "decision_ids": [approval["decision_id"], text["decision_id"]],
                }

            time.sleep(1.05)
            restarted = create_room_app(database, blobs, console_token=console_token)
            with LiveServer(restarted) as server:
                console = RoomClient(server.url)
                headers = {"X-SharedNet-Console-Token": console_token}
                detail = console._json(
                    "GET",
                    f"/v1/console/accounts/demo-user/rooms/{receipt['room_id']}",
                    protected=False,
                    headers=headers,
                )
                network = console._json(
                    "GET",
                    "/v1/console/accounts/demo-user/network",
                    protected=False,
                    headers=headers,
                )
                decisions = console._json(
                    "GET",
                    "/v1/console/accounts/demo-user/decisions",
                    protected=False,
                    headers=headers,
                )

            self.assertEqual(len(detail["messages"]), 2)
            self.assertEqual({item["presence"] for item in network["instances"]}, {"offline"})
            self.assertEqual(
                {item["status"] for item in decisions["decisions"]},
                {"approved", "answered"},
            )
            serialized_receipt = json.dumps(receipt, sort_keys=True)
            for forbidden in ("token", "secret", "credential"):
                self.assertNotIn(forbidden, serialized_receipt.lower())
            print(serialized_receipt)

    def _start_agent(
        self,
        control: ControlClient,
        connector_token: str,
        label: str,
        runtime_kind: str,
        workspace: str,
    ) -> dict[str, object]:
        agent = control.create_agent(connector_token, label, ["rooms", "decisions"])
        runtime = control.register_runtime(
            connector_token,
            agent["agent_id"],
            runtime_kind,
            workspace,
        )
        return control.start_instance(runtime["runtime_token"], None, 90)


if __name__ == "__main__":
    import unittest

    unittest.main()
