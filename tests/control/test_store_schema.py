from __future__ import annotations

from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
from unittest import TestCase

from sharednet.control.store import ControlStore
from sharednet.room.store import RoomStore


class ControlStoreSchemaTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="sharednet-control-schema-")
        self.database_path = Path(self.temporary_directory.name) / "sharednet.db"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def table_names(self) -> set[str]:
        with closing(sqlite3.connect(self.database_path)) as connection:
            return {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }

    def columns(self, table: str) -> set[str]:
        with closing(sqlite3.connect(self.database_path)) as connection:
            return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}

    def test_initialize_adds_control_tables_without_deleting_legacy_rooms(self) -> None:
        room_store = RoomStore(self.database_path)
        room_store.initialize()
        legacy_registration, legacy_token = room_store.register_runtime(
            "principal_legacy", "agent_legacy", "runtime_legacy"
        )
        legacy_room = room_store.create_room(
            legacy_registration.identity,
            "Legacy room",
            None,
            "principal_only",
        )

        ControlStore(self.database_path).initialize()

        with closing(sqlite3.connect(self.database_path)) as connection:
            registration = connection.execute(
                "SELECT agent_id, token_hash FROM runtime_registrations WHERE runtime_id = ?",
                (legacy_registration.identity.runtime_id,),
            ).fetchone()
            room = connection.execute(
                "SELECT name FROM rooms WHERE room_id = ?",
                (legacy_room.room_id,),
            ).fetchone()
        self.assertEqual(registration[0], "agent_legacy")
        self.assertNotEqual(registration[1], legacy_token)
        self.assertEqual(room, ("Legacy room",))
        self.assertTrue(
            {
                "account_principals",
                "principal_connector_credentials",
                "pairing_challenges",
                "principal_profiles",
                "agent_profiles",
                "principal_connections",
                "agent_instances",
                "human_decisions",
            }.issubset(self.table_names())
        )

    def test_initialize_is_idempotent_and_migrates_nullable_instance_provenance(self) -> None:
        store = ControlStore(self.database_path)
        store.initialize()
        store.initialize()

        self.assertIn("creator_instance_id", self.columns("rooms"))
        self.assertIn("sender_instance_id", self.columns("messages"))

        with closing(sqlite3.connect(self.database_path)) as connection:
            rooms_column = next(
                row
                for row in connection.execute("PRAGMA table_info(rooms)")
                if row[1] == "creator_instance_id"
            )
            messages_column = next(
                row
                for row in connection.execute("PRAGMA table_info(messages)")
                if row[1] == "sender_instance_id"
            )
            foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()

        self.assertEqual(rooms_column[3], 0)
        self.assertEqual(messages_column[3], 0)
        self.assertEqual(foreign_key_errors, [])

    def test_secret_bearing_tables_store_hashes_not_raw_secrets(self) -> None:
        ControlStore(self.database_path).initialize()

        connector_columns = self.columns("principal_connector_credentials")
        pairing_columns = self.columns("pairing_challenges")
        instance_columns = self.columns("agent_instances")

        self.assertIn("token_hash", connector_columns)
        self.assertIn("challenge_hash", pairing_columns)
        self.assertIn("token_hash", instance_columns)
        for columns in (connector_columns, pairing_columns, instance_columns):
            self.assertNotIn("token", columns)
            self.assertNotIn("secret", columns)


if __name__ == "__main__":
    import unittest

    unittest.main()
