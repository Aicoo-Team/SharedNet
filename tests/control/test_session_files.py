from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import tempfile
from unittest import TestCase

from sharednet.control.models import ControlError
from sharednet.control.session import AccountSessionFile, AgentStateFile, InstanceSessionFile
from sharednet.room.client import RoomSessionFile


class ControlSessionFileTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="sharednet-sessions-")
        self.root = Path(self.temporary_directory.name) / ".sharednet"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_owner_only_files_round_trip_explicit_contracts(self) -> None:
        account_path = self.root / "account.json"
        agent_path = self.root / "agent.json"
        instance_path = self.root / "instance.json"

        AccountSessionFile(account_path).save(
            "http://127.0.0.1:8765",
            "p_15COsXY9aK",
            "connector-secret",
        )
        AgentStateFile(agent_path).save(
            "http://127.0.0.1:8765",
            "p_15COsXY9aK",
            "a_7Qm2Zx8WpL",
            "r_4Nk8Vm2QaT",
            "runtime-secret",
        )
        InstanceSessionFile(instance_path).save(
            "http://127.0.0.1:8765",
            "p_15COsXY9aK",
            "a_7Qm2Zx8WpL",
            "r_4Nk8Vm2QaT",
            "i_8pQ2Km7XaN",
            "instance-secret",
        )

        self.assertEqual(AccountSessionFile(account_path).load().principal_id, "p_15COsXY9aK")
        self.assertEqual(AgentStateFile(agent_path).load().runtime_id, "r_4Nk8Vm2QaT")
        instance = InstanceSessionFile(instance_path).load()
        self.assertEqual(instance.instance_id, "i_8pQ2Km7XaN")
        self.assertEqual(instance.instance_token, "instance-secret")
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        for path in (account_path, agent_path, instance_path):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 1)

    def test_save_refuses_to_overwrite_an_existing_credential(self) -> None:
        path = self.root / "account.json"
        file = AccountSessionFile(path)
        file.save("http://127.0.0.1:8765", "p_15COsXY9aK", "first-secret")

        with self.assertRaises(ControlError) as caught:
            file.save("http://127.0.0.1:8765", "p_15COsXY9aK", "second-secret")

        self.assertEqual(caught.exception.code, "session_exists")
        self.assertEqual(file.load().connector_token, "first-secret")

    def test_load_rejects_malformed_or_public_session_files(self) -> None:
        self.root.mkdir(mode=0o700)
        malformed = self.root / "malformed.json"
        malformed.write_text("{}", encoding="utf-8")
        malformed.chmod(0o600)
        with self.assertRaises(ControlError) as malformed_error:
            AccountSessionFile(malformed).load()
        self.assertEqual(malformed_error.exception.code, "invalid_session")

        public = self.root / "public.json"
        public.write_text("{}", encoding="utf-8")
        public.chmod(0o644)
        with self.assertRaises(ControlError) as public_error:
            AccountSessionFile(public).load()
        self.assertEqual(public_error.exception.code, "insecure_session_permissions")

    def test_instance_session_is_accepted_by_existing_room_commands(self) -> None:
        path = self.root / "instance.json"
        InstanceSessionFile(path).save(
            "http://127.0.0.1:8765",
            "p_15COsXY9aK",
            "a_7Qm2Zx8WpL",
            "r_4Nk8Vm2QaT",
            "i_8pQ2Km7XaN",
            "instance-secret",
        )

        room_session = RoomSessionFile(path).load()

        self.assertEqual(room_session.auth_scheme, "Instance")
        self.assertEqual(room_session.runtime_token, "instance-secret")
        self.assertEqual(room_session.identity["instance_id"], "i_8pQ2Km7XaN")


if __name__ == "__main__":
    import unittest

    unittest.main()
