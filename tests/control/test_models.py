from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

from sharednet.control.models import (
    ActorIdentity,
    ControlError,
    DecisionMode,
    DecisionStatus,
    HumanDecision,
    InstanceStatus,
    PairingStatus,
)


class ControlModelTests(TestCase):
    def test_actor_identity_contains_the_complete_provenance_tuple(self) -> None:
        identity = ActorIdentity(
            "p_15COsXY9aK",
            "a_7Qm2Zx8WpL",
            "r_4Nk8Vm2QaT",
            "i_8pQ2Km7XaN",
        )

        self.assertEqual(
            identity.to_dict(),
            {
                "principal_id": "p_15COsXY9aK",
                "agent_id": "a_7Qm2Zx8WpL",
                "runtime_id": "r_4Nk8Vm2QaT",
                "instance_id": "i_8pQ2Km7XaN",
            },
        )

    def test_actor_identity_rejects_legacy_or_mistyped_codes(self) -> None:
        invalid_values = (
            ("principal_xisen", "a_7Qm2Zx8WpL", "r_4Nk8Vm2QaT", "i_8pQ2Km7XaN", "principal_id"),
            ("p_15COsXY9aK", "p_7Qm2Zx8WpL", "r_4Nk8Vm2QaT", "i_8pQ2Km7XaN", "agent_id"),
            ("p_15COsXY9aK", "a_7Qm2Zx8WpL", "R_4Nk8Vm2QaT", "i_8pQ2Km7XaN", "runtime_id"),
            ("p_15COsXY9aK", "a_7Qm2Zx8WpL", "r_4Nk8Vm2QaT", "i_short", "instance_id"),
        )
        for principal_id, agent_id, runtime_id, instance_id, field_name in invalid_values:
            with self.subTest(field_name=field_name):
                with self.assertRaisesRegex(ControlError, field_name):
                    ActorIdentity(principal_id, agent_id, runtime_id, instance_id)

    def test_wire_enums_have_the_frozen_values(self) -> None:
        self.assertEqual(
            [status.value for status in PairingStatus],
            ["pending", "claimed", "approved", "denied", "exchanged", "expired"],
        )
        self.assertEqual([status.value for status in InstanceStatus], ["online", "ended"])
        self.assertEqual([mode.value for mode in DecisionMode], ["approval", "text"])
        self.assertEqual(
            [status.value for status in DecisionStatus],
            ["pending", "approved", "denied", "answered"],
        )

    def test_contract_timestamps_and_enums_are_json_ready(self) -> None:
        now = datetime(2026, 9, 3, 1, 30, tzinfo=timezone.utc)
        identity = ActorIdentity(
            "p_15COsXY9aK",
            "a_7Qm2Zx8WpL",
            "r_4Nk8Vm2QaT",
            "i_8pQ2Km7XaN",
        )
        decision = HumanDecision(
            decision_id="decision_demo",
            room_id=None,
            target_principal_id=identity.principal_id,
            requester=identity,
            response_mode=DecisionMode.APPROVAL,
            title="Deploy?",
            description="Ship the build",
            consequence=None,
            status=DecisionStatus.PENDING,
            response_text=None,
            created_at=now,
            resolved_at=None,
        )

        serialized = decision.to_dict()

        self.assertEqual(serialized["created_at"], now.isoformat())
        self.assertEqual(serialized["response_mode"], "approval")
        self.assertEqual(serialized["status"], "pending")
        self.assertEqual(serialized["requester"]["instance_id"], identity.instance_id)


if __name__ == "__main__":
    import unittest

    unittest.main()
