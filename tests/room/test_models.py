"""Behavioral tests for Room V1 model contracts."""

from __future__ import annotations

from datetime import datetime, timezone
import unittest

from sharednet.room.errors import RoomError
from sharednet.room.models import (
    Artifact,
    Membership,
    MembershipStatus,
    Message,
    MessagePage,
    ResolutionState,
    Room,
    RoomStatus,
    RuntimeIdentity,
    RuntimeRegistration,
    format_cursor,
    normalize_tags,
    parse_cursor,
)


NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)


class RoomModelTests(unittest.TestCase):
    def test_cursor_round_trip_and_validation(self) -> None:
        self.assertEqual(parse_cursor(None), 0)
        self.assertEqual(parse_cursor("cursor_41"), 41)
        self.assertEqual(format_cursor(41), "cursor_41")
        with self.assertRaisesRegex(RoomError, "invalid_cursor"):
            parse_cursor("41")

    def test_tags_are_typed_unique_and_fail_closed(self) -> None:
        tags = normalize_tags(["verification-required", "delegate-to:agent_reviewer"])
        self.assertEqual([tag.kind for tag in tags], ["verification", "delegation"])
        self.assertEqual(tags[1].target_id, "agent_reviewer")
        with self.assertRaisesRegex(RoomError, "duplicate_tag"):
            normalize_tags(["verification-required", "verification-required"])
        with self.assertRaisesRegex(RoomError, "invalid_tag"):
            normalize_tags(["custom-code:run"])

    def test_records_serialize_to_json_ready_mappings(self) -> None:
        identity = RuntimeIdentity("principal_alpha", "agent_writer", "runtime_1")
        registration = RuntimeRegistration(identity=identity, created_at=NOW)
        room = Room(
            room_id="room_1",
            name="Planning",
            description=None,
            creator=identity,
            access_policy="anyone_with_id",
            status=RoomStatus.OPEN,
            created_at=NOW,
            updated_at=NOW,
        )
        membership = Membership("room_1", "principal_alpha", "agent_writer", MembershipStatus.ACTIVE, NOW, None, 0)
        message = Message(
            message_id="message_1",
            room_id="room_1",
            sequence=1,
            sender=identity,
            content="Ready",
            reply_to=None,
            tags=normalize_tags(["human-review-required"]),
            attachment_ids=("artifact_1",),
            created_at=NOW,
            resolution_state=ResolutionState.PENDING,
        )
        artifact = Artifact("artifact_1", "room_1", "brief.pdf", "application/pdf", 3, "a" * 64, NOW)
        page = MessagePage(messages=(message,), next_cursor="cursor_1")

        self.assertEqual(identity.to_dict(), {"principal_id": "principal_alpha", "agent_id": "agent_writer", "runtime_id": "runtime_1"})
        self.assertEqual(registration.to_dict()["identity"], identity.to_dict())
        self.assertEqual(room.to_dict()["status"], "open")
        self.assertEqual(membership.to_dict()["last_read_sequence"], 0)
        self.assertEqual(message.to_dict()["tags"][0]["kind"], "human_review")
        self.assertEqual(artifact.to_dict()["filename"], "brief.pdf")
        self.assertEqual(page.to_dict()["next_cursor"], "cursor_1")

    def test_models_reject_invalid_identifiers_and_content_shapes(self) -> None:
        with self.assertRaisesRegex(RoomError, "invalid_identifier"):
            RuntimeIdentity("principal_alpha", "1agent", "runtime_1")
        with self.assertRaisesRegex(RoomError, "invalid_name"):
            Room("room_1", "  ", None, RuntimeIdentity("principal_alpha", "agent_1", "runtime_1"), "anyone_with_id", RoomStatus.OPEN, NOW, NOW)
        with self.assertRaisesRegex(RoomError, "invalid_content"):
            Message("message_1", "room_1", 1, RuntimeIdentity("principal_alpha", "agent_1", "runtime_1"), " ", None, (), (), NOW, ResolutionState.NOT_REQUIRED)
        with self.assertRaisesRegex(RoomError, "invalid_filename"):
            Artifact("artifact_1", "room_1", "../brief.pdf", "application/pdf", 1, "a" * 64, NOW)

    def test_limit_and_cursor_nonnegative_constraints_fail_closed(self) -> None:
        with self.assertRaisesRegex(RoomError, "invalid_limit"):
            MessagePage(messages=(), next_cursor="cursor_0", limit=101)
        with self.assertRaisesRegex(RoomError, "invalid_cursor"):
            format_cursor(-1)


if __name__ == "__main__":
    unittest.main()
