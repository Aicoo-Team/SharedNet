from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
from unittest import TestCase

from sharednet.control.models import ControlError
from sharednet.control.projections import DashboardProjectionService
from sharednet.control.service import ControlService
from sharednet.control.store import ControlStore
from sharednet.room.store import RoomStore


class FakeClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 9, 3, 5, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.current

    def advance(self, seconds: int) -> None:
        self.current += timedelta(seconds=seconds)


class DashboardProjectionTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="sharednet-projections-")
        self.database_path = Path(self.temporary_directory.name) / "sharednet.db"
        self.clock = FakeClock()
        self.store = ControlStore(self.database_path, self.clock)
        self.store.initialize()
        self.control = ControlService(self.store, self.clock)
        self.rooms = RoomStore(self.database_path, self.clock)
        self.projections = DashboardProjectionService(
            self.database_path,
            self.store,
            self.clock,
        )

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def started_instance(self, auth_user_id: str, label: str, workspace: str):
        pairing = self.control.create_pairing("http://127.0.0.1:3001")
        decision = self.control.claim_pairing(pairing.pairing_id, auth_user_id)
        self.control.resolve_pairing(decision.decision_id, auth_user_id, "approved")
        connector = self.control.exchange_pairing(pairing.pairing_id, pairing.pairing_secret)
        agent = self.control.create_agent(connector.token, label, ["rooms"])
        runtime = self.control.register_runtime(
            connector.token,
            agent.agent_id,
            "codex",
            workspace,
        )
        instance = self.control.start_instance(runtime.runtime_token, lease_seconds=90)
        return connector, agent, runtime, instance

    def test_network_and_room_projections_are_scoped_and_secret_free(self) -> None:
        owner = self.started_instance("auth-owner", "Owner", "/private/owner")
        peer = self.started_instance("auth-peer", "Peer", "/private/peer")
        room = self.rooms.create_room(owner[3].identity, "Shared room", None, "anyone_with_id")
        self.rooms.join_room(peer[3].identity, room.room_id)
        self.rooms.post_message(owner[3].identity, room.room_id, "hello", None, (), ())

        network = self.projections.get_network("auth-owner")
        detail = self.projections.get_room("auth-owner", room.room_id)
        serialized = json.dumps({"network": network, "detail": detail})

        self.assertEqual(network["principal"]["principal_id"], owner[0].principal_id)
        self.assertEqual(
            [item["principal_id"] for item in network["connected_principals"]],
            [peer[0].principal_id],
        )
        peer_runtime = next(
            item for item in network["runtimes"] if item["runtime_id"] == peer[2].runtime_id
        )
        self.assertIsNone(peer_runtime["workspace_label"])
        self.assertTrue(
            any(edge["kind"] == "room_co_membership" for edge in network["edges"])
        )
        self.assertEqual(detail["messages"][0]["content"], "hello")
        for secret in (
            owner[0].connector_token,
            owner[2].runtime_token,
            owner[3].instance_token,
            peer[0].connector_token,
        ):
            self.assertNotIn(secret, serialized)

        stranger_principal = self.store.provision_principal("auth-stranger")
        self.assertRegex(stranger_principal, r"^p_[0-9A-Za-z]{10}$")
        with self.assertRaisesRegex(ControlError, "room_not_found"):
            self.projections.get_room("auth-stranger", room.room_id)

    def test_instance_presence_is_derived_at_projection_time(self) -> None:
        instance = self.started_instance("auth-owner", "Owner", "/workspace")[3]
        before = self.projections.get_network("auth-owner")
        self.assertEqual(before["instances"][0]["presence"], "online")

        self.clock.advance(91)
        after = self.projections.get_network("auth-owner")
        self.assertEqual(after["instances"][0]["presence"], "offline")


if __name__ == "__main__":
    import unittest

    unittest.main()
