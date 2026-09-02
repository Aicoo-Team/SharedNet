from __future__ import annotations

from pathlib import Path
import tempfile
from unittest import TestCase

from sharednet.control.session import InstanceSessionFile
from sharednet.local.service import InstanceTarget, LocalConfig, LocalConnector
from sharednet.room.errors import RoomError


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeClient:
    def __init__(self) -> None:
        self.heartbeat_tokens: list[str] = []
        self.fail = False

    def heartbeat_instance(self, token: str, lease_seconds: int):
        self.heartbeat_tokens.append(token)
        if self.fail:
            raise RoomError("transport_error", "offline", 0)
        return {"presence": "online", "lease_seconds": lease_seconds}


class LocalConnectorTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="sharednet-local-")
        self.root = Path(self.temporary_directory.name) / ".sharednet"
        self.active = self.root / "active.json"
        self.inactive = self.root / "inactive.json"
        for path, instance_id, token in (
            (self.active, "i_8pQ2Km7XaN", "active-secret"),
            (self.inactive, "i_9pQ2Km7XaN", "inactive-secret"),
        ):
            InstanceSessionFile(path).save(
                "http://127.0.0.1:8765",
                "p_15COsXY9aK",
                "a_7Qm2Zx8WpL",
                "r_4Nk8Vm2QaT",
                instance_id,
                token,
            )

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_connector_heartbeats_only_declared_active_instances(self) -> None:
        client = FakeClient()
        config = LocalConfig(
            lease_seconds=90,
            instances=(
                InstanceTarget(self.active, active=True),
                InstanceTarget(self.inactive, active=False),
            ),
        )
        connector = LocalConnector(client, config, clock=FakeClock())

        receipts = connector.tick()

        self.assertEqual(client.heartbeat_tokens, ["active-secret"])
        self.assertEqual(receipts[0]["instance_id"], "i_8pQ2Km7XaN")
        self.assertNotIn("active-secret", repr(receipts))
        self.assertNotIn("inactive-secret", repr(receipts))

    def test_success_interval_and_failure_retry_are_bounded(self) -> None:
        client = FakeClient()
        clock = FakeClock()
        config = LocalConfig(
            lease_seconds=90,
            instances=(InstanceTarget(self.active),),
        )
        connector = LocalConnector(client, config, clock=clock)

        connector.tick()
        clock.advance(29)
        connector.tick()
        self.assertEqual(len(client.heartbeat_tokens), 1)
        clock.advance(1)
        client.fail = True
        connector.tick()
        self.assertEqual(len(client.heartbeat_tokens), 2)
        clock.advance(0.5)
        connector.tick()
        self.assertEqual(len(client.heartbeat_tokens), 2)
        clock.advance(0.5)
        connector.tick()
        self.assertEqual(len(client.heartbeat_tokens), 3)

    def test_running_connector_reloads_new_instance_targets_from_disk(self) -> None:
        client = FakeClient()
        config_path = self.root / "local.json"
        empty = LocalConfig(instances=())
        empty.save(config_path)
        connector = LocalConnector(client, empty, clock=FakeClock(), config_path=config_path)

        self.assertEqual(connector.tick(), [])
        empty.with_instance(self.active).save(config_path)
        connector.tick()

        self.assertEqual(client.heartbeat_tokens, ["active-secret"])


if __name__ == "__main__":
    import unittest

    unittest.main()
