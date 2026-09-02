from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import tempfile
from unittest import TestCase, mock

from sharednet.control.models import ControlError, DecisionStatus, PairingStatus
from sharednet.control.service import ControlService
from sharednet.control.store import ControlStore


class FakeClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 9, 3, 2, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.current

    def advance(self, *, seconds: int) -> None:
        self.current += timedelta(seconds=seconds)


class PairingLifecycleTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="sharednet-pairing-")
        self.database_path = Path(self.temporary_directory.name) / "sharednet.db"
        self.clock = FakeClock()
        self.store = ControlStore(self.database_path, self.clock)
        self.store.initialize()
        self.service = ControlService(self.store, self.clock)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_account_provisioning_is_idempotent_and_opaque(self) -> None:
        first = self.store.provision_principal("better-auth-user-1")
        second = self.store.provision_principal("better-auth-user-1")

        self.assertEqual(first, second)
        self.assertRegex(first, r"^p_[0-9A-Za-z]{10}$")

        with closing(sqlite3.connect(self.database_path)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM account_principals WHERE auth_user_id = ?",
                    ("better-auth-user-1",),
                ).fetchone()[0],
                1,
            )

    @mock.patch(
        "sharednet.control.store.new_principal_id",
        side_effect=["p_0000000000", "p_0000000000", "p_1111111111"],
    )
    def test_principal_generation_retries_collision_without_overwriting(self, generator) -> None:
        first = self.store.provision_principal("better-auth-user-1")
        second = self.store.provision_principal("better-auth-user-2")

        self.assertEqual(first, "p_0000000000")
        self.assertEqual(second, "p_1111111111")
        self.assertEqual(generator.call_count, 3)

    def test_pairing_requires_claim_approval_and_single_exchange(self) -> None:
        started = self.service.create_pairing("http://127.0.0.1:3001")
        self.assertEqual(
            started.verification_url,
            f"http://127.0.0.1:3001/decisions?pairing={started.pairing_id}",
        )

        with self.assertRaisesRegex(ControlError, "pairing_not_approved"):
            self.service.exchange_pairing(started.pairing_id, started.pairing_secret)

        decision = self.service.claim_pairing(started.pairing_id, "better-auth-user-1")
        self.assertEqual(decision.status, DecisionStatus.PENDING)
        resolved = self.service.resolve_pairing(
            decision.decision_id,
            "better-auth-user-1",
            "approved",
        )
        self.assertEqual(resolved.status, DecisionStatus.APPROVED)

        connector = self.service.exchange_pairing(started.pairing_id, started.pairing_secret)
        self.assertRegex(connector.principal_id, r"^p_[0-9A-Za-z]{10}$")
        self.assertTrue(connector.connector_token)

        with self.assertRaisesRegex(ControlError, "pairing_already_exchanged"):
            self.service.exchange_pairing(started.pairing_id, started.pairing_secret)

        with closing(sqlite3.connect(self.database_path)) as connection:
            stored_pairing = connection.execute(
                "SELECT challenge_hash, status FROM pairing_challenges WHERE pairing_id = ?",
                (started.pairing_id,),
            ).fetchone()
            stored_credential = connection.execute(
                "SELECT token_hash FROM principal_connector_credentials"
            ).fetchone()[0]
        self.assertNotEqual(stored_pairing[0], started.pairing_secret)
        self.assertEqual(stored_pairing[1], PairingStatus.EXCHANGED.value)
        self.assertNotEqual(stored_credential, connector.connector_token)

    def test_denial_makes_pairing_unusable_and_same_resolution_is_idempotent(self) -> None:
        started = self.service.create_pairing("https://sharednet.example")
        decision = self.service.claim_pairing(started.pairing_id, "better-auth-user-1")

        first = self.service.resolve_pairing(
            decision.decision_id,
            "better-auth-user-1",
            "denied",
        )
        second = self.service.resolve_pairing(
            decision.decision_id,
            "better-auth-user-1",
            "denied",
        )

        self.assertEqual(first, second)
        with self.assertRaisesRegex(ControlError, "pairing_denied"):
            self.service.exchange_pairing(started.pairing_id, started.pairing_secret)
        with self.assertRaisesRegex(ControlError, "decision_already_resolved"):
            self.service.resolve_pairing(
                decision.decision_id,
                "better-auth-user-1",
                "approved",
            )

    def test_expired_wrong_secret_and_cross_account_attempts_fail_closed(self) -> None:
        started = self.service.create_pairing("http://127.0.0.1:3001", ttl_seconds=30)
        decision = self.service.claim_pairing(started.pairing_id, "better-auth-user-1")

        with self.assertRaisesRegex(ControlError, "decision_not_found"):
            self.service.resolve_pairing(
                decision.decision_id,
                "better-auth-user-2",
                "approved",
            )
        with self.assertRaisesRegex(ControlError, "invalid_pairing_secret"):
            self.service.exchange_pairing(started.pairing_id, "wrong-secret")

        self.clock.advance(seconds=31)
        with self.assertRaisesRegex(ControlError, "pairing_expired"):
            self.service.exchange_pairing(started.pairing_id, started.pairing_secret)
        with self.assertRaisesRegex(ControlError, "pairing_expired"):
            self.service.claim_pairing(started.pairing_id, "better-auth-user-1")

    def test_pairing_rejects_unsafe_web_origin_and_invalid_ttl(self) -> None:
        for web_base_url in (
            "javascript:alert(1)",
            "http://127.0.0.1:3001/path",
            "http://127.0.0.1:3001?query=yes",
        ):
            with self.subTest(web_base_url=web_base_url):
                with self.assertRaisesRegex(ControlError, "invalid_web_base_url"):
                    self.service.create_pairing(web_base_url)

        with self.assertRaisesRegex(ControlError, "invalid_pairing_ttl"):
            self.service.create_pairing("http://127.0.0.1:3001", ttl_seconds=0)


if __name__ == "__main__":
    import unittest

    unittest.main()
