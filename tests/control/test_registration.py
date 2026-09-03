from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import tempfile
from unittest import TestCase

from sharednet.control.models import ControlError
from sharednet.control.service import ControlService
from sharednet.control.store import ControlStore


class FakeClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 9, 3, 3, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.current

    def advance(self, *, seconds: int) -> None:
        self.current += timedelta(seconds=seconds)


class LocalRegistrationTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="sharednet-registration-")
        self.database_path = Path(self.temporary_directory.name) / "sharednet.db"
        self.clock = FakeClock()
        self.store = ControlStore(self.database_path, self.clock)
        self.store.initialize()
        self.service = ControlService(self.store, self.clock)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def approved_connector(self, auth_user_id: str = "better-auth-user-1"):
        pairing = self.service.create_pairing("http://127.0.0.1:3001")
        decision = self.service.claim_pairing(pairing.pairing_id, auth_user_id)
        self.service.resolve_pairing(decision.decision_id, auth_user_id, "approved")
        return self.service.exchange_pairing(pairing.pairing_id, pairing.pairing_secret)

    def test_server_generates_agent_runtime_and_instance_codes(self) -> None:
        connector = self.approved_connector()
        agent = self.service.create_agent(
            connector.token,
            "Codex",
            ["room-messaging", "decisions"],
        )
        runtime = self.service.register_runtime(
            connector.token,
            agent.agent_id,
            "codex",
            "/workspace/sharednet",
        )
        instance = self.service.start_instance(
            runtime.runtime_token,
            "codex-thread-123",
        )

        self.assertRegex(agent.agent_id, r"^a_[0-9A-Za-z]{10}$")
        self.assertRegex(runtime.runtime_id, r"^r_[0-9A-Za-z]{10}$")
        self.assertRegex(instance.identity.instance_id, r"^i_[0-9A-Za-z]{10}$")
        self.assertEqual(instance.identity.principal_id, connector.principal_id)
        self.assertEqual(instance.identity.agent_id, agent.agent_id)
        self.assertEqual(instance.identity.runtime_id, runtime.runtime_id)
        self.assertNotEqual(instance.identity.instance_id, "codex-thread-123")
        self.assertEqual(
            self.service.authenticate_instance(instance.instance_token),
            instance.identity,
        )

    def test_one_agent_supports_multiple_runtimes_and_instances(self) -> None:
        connector = self.approved_connector()
        agent = self.service.create_agent(connector.token, "Coding agent", ["rooms"])
        first_runtime = self.service.register_runtime(
            connector.token, agent.agent_id, "codex", "/workspace/one"
        )
        second_runtime = self.service.register_runtime(
            connector.token, agent.agent_id, "claude-code", "/workspace/two"
        )
        first_instance = self.service.start_instance(first_runtime.runtime_token, "thread-a")
        second_instance = self.service.start_instance(first_runtime.runtime_token, "thread-b")

        self.assertNotEqual(first_runtime.runtime_id, second_runtime.runtime_id)
        self.assertNotEqual(first_instance.identity.instance_id, second_instance.identity.instance_id)
        self.assertEqual(first_instance.identity.runtime_id, second_instance.identity.runtime_id)

    def test_expired_instance_is_offline_without_deleting_it(self) -> None:
        connector = self.approved_connector()
        agent = self.service.create_agent(connector.token, "Codex", ["rooms"])
        runtime = self.service.register_runtime(
            connector.token, agent.agent_id, "codex", None
        )
        session = self.service.start_instance(runtime.runtime_token, lease_seconds=30)

        self.clock.advance(seconds=31)
        projected = self.store.get_instance(session.identity.instance_id)

        self.assertEqual(projected.presence, "offline")
        self.assertIsNone(projected.ended_at)
        with self.assertRaisesRegex(ControlError, "instance_expired"):
            self.service.authenticate_instance(session.instance_token)
        with closing(sqlite3.connect(self.database_path)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM agent_instances WHERE instance_id = ?",
                    (session.identity.instance_id,),
                ).fetchone()[0],
                1,
            )

    def test_heartbeat_extends_lease_and_end_is_durable(self) -> None:
        connector = self.approved_connector()
        agent = self.service.create_agent(connector.token, "Codex", ["rooms"])
        runtime = self.service.register_runtime(connector.token, agent.agent_id, "codex", None)
        session = self.service.start_instance(runtime.runtime_token, lease_seconds=30)

        self.clock.advance(seconds=20)
        heartbeat = self.service.heartbeat_instance(session.instance_token, lease_seconds=60)
        self.assertEqual(heartbeat.presence, "online")
        self.assertEqual(heartbeat.last_seen_at, self.clock())
        self.assertEqual(heartbeat.expires_at, self.clock() + timedelta(seconds=60))

        ended = self.service.end_instance(session.instance_token)
        self.assertEqual(ended.status.value, "ended")
        self.assertEqual(ended.presence, "offline")
        self.assertEqual(self.service.end_instance(session.instance_token), ended)
        with self.assertRaisesRegex(ControlError, "instance_ended"):
            self.service.authenticate_instance(session.instance_token)

    def test_credentials_are_scope_bound_and_revocation_fails_closed(self) -> None:
        first_connector = self.approved_connector("better-auth-user-1")
        first_agent = self.service.create_agent(first_connector.token, "First", ["rooms"])
        first_runtime = self.service.register_runtime(
            first_connector.token, first_agent.agent_id, "codex", None
        )
        first_instance = self.service.start_instance(first_runtime.runtime_token)
        other_connector = self.approved_connector("better-auth-user-2")

        with self.assertRaisesRegex(ControlError, "invalid_runtime_token"):
            self.service.start_instance(first_connector.token)
        with self.assertRaisesRegex(ControlError, "invalid_connector_token"):
            self.service.create_agent(first_runtime.runtime_token, "Wrong scope", [])
        with self.assertRaisesRegex(ControlError, "agent_not_found"):
            self.service.register_runtime(
                other_connector.token, first_agent.agent_id, "codex", None
            )

        self.store.revoke_instance(first_instance.instance_token)
        with self.assertRaisesRegex(ControlError, "invalid_instance_token"):
            self.service.authenticate_instance(first_instance.instance_token)
        self.store.revoke_runtime(first_runtime.runtime_token)
        with self.assertRaisesRegex(ControlError, "invalid_runtime_token"):
            self.service.start_instance(first_runtime.runtime_token)
        self.store.revoke_connector(first_connector.token)
        with self.assertRaisesRegex(ControlError, "invalid_connector_token"):
            self.service.register_runtime(
                first_connector.token, first_agent.agent_id, "codex", None
            )

    def test_connector_revocation_is_limited_to_its_issued_descendants(self) -> None:
        first_connector = self.approved_connector("better-auth-user-1")
        second_connector = self.approved_connector("better-auth-user-1")
        agent = self.service.create_agent(first_connector.token, "Codex", ["rooms"])
        first_runtime = self.service.register_runtime(
            first_connector.token,
            agent.agent_id,
            "codex",
            None,
        )
        second_runtime = self.service.register_runtime(
            second_connector.token,
            agent.agent_id,
            "codex",
            None,
        )
        first_instance = self.service.start_instance(first_runtime.runtime_token)
        second_instance = self.service.start_instance(second_runtime.runtime_token)

        self.store.revoke_connector(first_connector.token)

        with self.assertRaisesRegex(ControlError, "invalid_instance_token"):
            self.service.authenticate_instance(first_instance.instance_token)
        self.assertEqual(
            self.service.authenticate_instance(second_instance.instance_token),
            second_instance.identity,
        )

    def test_pre_lineage_modern_runtime_credentials_fail_closed(self) -> None:
        connector = self.approved_connector()
        agent = self.service.create_agent(connector.token, "Codex", ["rooms"])
        runtime = self.service.register_runtime(
            connector.token,
            agent.agent_id,
            "codex",
            None,
        )
        instance = self.service.start_instance(runtime.runtime_token)

        with closing(sqlite3.connect(self.database_path)) as connection:
            connection.execute(
                "UPDATE runtime_registrations SET connector_credential_id = NULL "
                "WHERE runtime_id = ?",
                (runtime.runtime_id,),
            )
            connection.commit()

        with self.assertRaisesRegex(ControlError, "invalid_runtime_token"):
            self.service.start_instance(runtime.runtime_token)
        with self.assertRaisesRegex(ControlError, "invalid_instance_token"):
            self.service.authenticate_instance(instance.instance_token)

    def test_raw_runtime_and_instance_credentials_are_never_persisted(self) -> None:
        connector = self.approved_connector()
        agent = self.service.create_agent(connector.token, "Codex", ["rooms"])
        runtime = self.service.register_runtime(connector.token, agent.agent_id, "codex", None)
        instance = self.service.start_instance(runtime.runtime_token)

        with closing(sqlite3.connect(self.database_path)) as connection:
            runtime_hash = connection.execute(
                "SELECT token_hash FROM runtime_registrations WHERE runtime_id = ?",
                (runtime.runtime_id,),
            ).fetchone()[0]
            instance_hash = connection.execute(
                "SELECT token_hash FROM agent_instances WHERE instance_id = ?",
                (instance.identity.instance_id,),
            ).fetchone()[0]
        self.assertNotEqual(runtime_hash, runtime.runtime_token)
        self.assertNotEqual(instance_hash, instance.instance_token)


if __name__ == "__main__":
    import unittest

    unittest.main()
