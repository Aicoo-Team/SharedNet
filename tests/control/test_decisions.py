from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
from unittest import TestCase

from sharednet.control.models import ControlError, DecisionStatus
from sharednet.control.service import ControlService
from sharednet.control.store import ControlStore
from sharednet.room.store import RoomStore


class FakeClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 9, 3, 4, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.current

    def advance(self, *, seconds: int) -> None:
        self.current += timedelta(seconds=seconds)


class HumanDecisionTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="sharednet-decisions-")
        self.database_path = Path(self.temporary_directory.name) / "sharednet.db"
        self.clock = FakeClock()
        self.store = ControlStore(self.database_path, self.clock)
        self.store.initialize()
        self.service = ControlService(self.store, self.clock)
        self.auth_user_id = "better-auth-user-1"
        self.identity, self.instance_token = self.started_identity(self.auth_user_id, "Requester")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def approved_connector(self, auth_user_id: str):
        pairing = self.service.create_pairing("http://127.0.0.1:3001")
        decision = self.service.claim_pairing(pairing.pairing_id, auth_user_id)
        self.service.resolve_pairing(decision.decision_id, auth_user_id, "approved")
        return self.service.exchange_pairing(pairing.pairing_id, pairing.pairing_secret)

    def started_identity(self, auth_user_id: str, label: str):
        connector = self.approved_connector(auth_user_id)
        agent = self.service.create_agent(connector.token, label, ["decisions", "rooms"])
        runtime = self.service.register_runtime(connector.token, agent.agent_id, "codex", None)
        instance = self.service.start_instance(runtime.runtime_token)
        return instance.identity, instance.instance_token

    def test_approval_and_text_decisions_have_distinct_terminal_states(self) -> None:
        approval = self.service.request_decision(
            self.identity,
            "approval",
            "Deploy?",
            "Ship build",
        )
        answer = self.service.request_decision(
            self.identity,
            "text",
            "Region?",
            "Choose a region",
        )

        approved = self.service.resolve_decision_for_account(
            self.auth_user_id,
            approval.decision_id,
            "approved",
            "Reviewed locally",
        )
        answered = self.service.resolve_decision_for_account(
            self.auth_user_id,
            answer.decision_id,
            "answered",
            "Singapore",
        )

        self.assertEqual(approved.status, DecisionStatus.APPROVED)
        self.assertEqual(approved.response_text, "Reviewed locally")
        self.assertEqual(answered.status, DecisionStatus.ANSWERED)
        self.assertEqual(answered.response_text, "Singapore")

    def test_other_account_cannot_discover_or_resolve_decision(self) -> None:
        decision = self.service.request_decision(
            self.identity,
            "approval",
            "Deploy?",
            "Ship build",
        )
        self.store.provision_principal("better-auth-user-2")

        self.assertEqual(
            self.service.list_decisions_for_account("better-auth-user-2"),
            (),
        )
        with self.assertRaisesRegex(ControlError, "decision_not_found"):
            self.service.resolve_decision_for_account(
                "better-auth-user-2",
                decision.decision_id,
                "denied",
            )

    def test_resolution_is_idempotent_only_for_the_same_complete_response(self) -> None:
        decision = self.service.request_decision(
            self.identity,
            "text",
            "What next?",
            "Give one instruction",
        )
        first = self.service.resolve_decision_for_account(
            self.auth_user_id,
            decision.decision_id,
            "answered",
            "Run tests",
        )
        second = self.service.resolve_decision_for_account(
            self.auth_user_id,
            decision.decision_id,
            "answered",
            "Run tests",
        )
        self.assertEqual(first, second)

        with self.assertRaisesRegex(ControlError, "decision_already_resolved"):
            self.service.resolve_decision_for_account(
                self.auth_user_id,
                decision.decision_id,
                "answered",
                "Deploy now",
            )
        with self.assertRaisesRegex(ControlError, "invalid_decision_response"):
            pending = self.service.request_decision(
                self.identity,
                "text",
                "Region?",
                "Choose",
            )
            self.service.resolve_decision_for_account(
                self.auth_user_id,
                pending.decision_id,
                "answered",
                "   ",
            )

    def test_room_reference_requires_active_membership_for_requesting_agent(self) -> None:
        room_store = RoomStore(self.database_path, self.clock)
        room = room_store.create_room(self.identity, "Decision room", None, "anyone_with_id")
        linked = self.service.request_decision(
            self.identity,
            "approval",
            "Continue?",
            "Continue in this Room",
            room_id=room.room_id,
        )
        self.assertEqual(linked.room_id, room.room_id)

        outsider, _ = self.started_identity(self.auth_user_id, "Sibling")
        with self.assertRaisesRegex(ControlError, "room_membership_required"):
            self.service.request_decision(
                outsider,
                "approval",
                "Continue?",
                "No membership",
                room_id=room.room_id,
            )

    def test_requester_can_retrieve_result_and_account_lists_are_filterable(self) -> None:
        approval = self.service.request_decision(
            self.identity,
            "approval",
            "Approve?",
            "First",
        )
        text = self.service.request_decision(
            self.identity,
            "text",
            "Answer?",
            "Second",
        )
        self.service.resolve_decision_for_account(
            self.auth_user_id,
            approval.decision_id,
            "denied",
        )

        pending = self.service.list_decisions_for_account(
            self.auth_user_id,
            status="pending",
        )
        self.assertEqual([item.decision_id for item in pending], [text.decision_id])
        retrieved = self.service.get_decision_for_instance(
            self.identity,
            approval.decision_id,
        )
        self.assertEqual(retrieved.status, DecisionStatus.DENIED)

        sibling, _ = self.started_identity(self.auth_user_id, "Sibling")
        with self.assertRaisesRegex(ControlError, "decision_not_found"):
            self.service.get_decision_for_instance(sibling, approval.decision_id)


if __name__ == "__main__":
    import unittest

    unittest.main()
