"""Behavioral tests for transactional Room identities and membership."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from sharednet.room.errors import RoomError
from sharednet.room.models import MembershipStatus, RoomStatus, RuntimeIdentity
from sharednet.room.store import RoomStore


START = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)


class SteppingClock:
    def __init__(self) -> None:
        self.current = START

    def __call__(self) -> datetime:
        value = self.current
        self.current += timedelta(seconds=1)
        return value


class RoomStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.database_path = Path(self.temporary_directory.name) / "rooms.sqlite3"
        self.clock = SteppingClock()
        self.store = RoomStore(self.database_path, clock=self.clock)
        self.store.initialize()

    def register(
        self,
        principal_id: str,
        agent_id: str,
        runtime_id: str | None,
    ) -> tuple[RuntimeIdentity, str]:
        registration, token = self.store.register_runtime(principal_id, agent_id, runtime_id)
        return registration.identity, token

    def assert_room_error(self, code: str, status_code: int, operation) -> RoomError:
        with self.assertRaises(RoomError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.status_code, status_code)
        return caught.exception

    def test_registration_creates_identity_and_persists_only_a_token_hash(self) -> None:
        registration, token = self.store.register_runtime("principal_alice", "agent_alpha", "runtime_alpha")

        self.assertEqual(registration.identity, RuntimeIdentity("principal_alice", "agent_alpha", "runtime_alpha"))
        self.assertEqual(self.store.authenticate_runtime(token), registration.identity)
        self.assertNotIn(token, self.database_path.read_bytes().decode("utf-8", errors="ignore"))
        with closing(sqlite3.connect(self.database_path)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM principals").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM agents").fetchone()[0], 1)
            row = connection.execute(
                "SELECT principal_id, agent_id, token_hash FROM runtime_registrations"
            ).fetchone()
            self.assertEqual(row, ("principal_alice", "agent_alpha", hashlib.sha256(token.encode()).hexdigest()))
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")

        generated, _ = self.store.register_runtime("principal_alice", "agent_beta", None)
        self.assertRegex(generated.identity.runtime_id, r"^r_[0-9A-Za-z]{10}$")
        self.assert_room_error("invalid_runtime_token", 401, lambda: self.store.authenticate_runtime("not-a-token"))

    def test_registration_rejects_agent_remapping_runtime_collision_and_invalid_requested_id(self) -> None:
        self.store.register_runtime("principal_alice", "agent_alpha", "runtime_alpha")

        self.assert_room_error(
            "agent_principal_conflict",
            409,
            lambda: self.store.register_runtime("principal_bob", "agent_alpha", "runtime_beta"),
        )
        self.assert_room_error(
            "runtime_id_conflict",
            409,
            lambda: self.store.register_runtime("principal_bob", "agent_beta", "runtime_alpha"),
        )
        self.assert_room_error(
            "invalid_identifier",
            400,
            lambda: self.store.register_runtime("principal_bob", "agent_beta", "bad runtime"),
        )

    @mock.patch(
        "sharednet.room.store.new_runtime_id",
        side_effect=["r_0000000000", "r_1111111111"],
    )
    def test_generated_runtime_id_retries_collision_without_overwriting_existing_row(
        self,
        generate_runtime_id,
    ) -> None:
        self.store.register_runtime("principal_existing", "agent_existing", "r_0000000000")

        collision_error_code = None
        try:
            registration, _ = self.store.register_runtime("principal_new", "agent_new", None)
        except RoomError as error:
            collision_error_code = error.code

        self.assertIsNone(
            collision_error_code,
            f"generated Runtime ID collision was not retried: {collision_error_code}",
        )
        self.assertEqual(registration.identity.runtime_id, "r_1111111111")
        self.assertEqual(generate_runtime_id.call_count, 2)
        with closing(sqlite3.connect(self.database_path)) as connection:
            rows = connection.execute(
                """
                SELECT runtime_id, principal_id, agent_id
                FROM runtime_registrations
                ORDER BY runtime_id
                """
            ).fetchall()
        self.assertEqual(
            rows,
            [
                ("r_0000000000", "principal_existing", "agent_existing"),
                ("r_1111111111", "principal_new", "agent_new"),
            ],
        )

    @mock.patch(
        "sharednet.room.store.new_runtime_id",
        side_effect=["r_0000000000"] * 100,
    )
    def test_generated_runtime_id_collision_retries_are_bounded(self, generate_runtime_id) -> None:
        self.store.register_runtime("principal_existing", "agent_existing", "r_0000000000")

        self.assert_room_error(
            "runtime_id_conflict",
            409,
            lambda: self.store.register_runtime("principal_new", "agent_new", None),
        )

        self.assertGreater(generate_runtime_id.call_count, 1)
        self.assertLess(generate_runtime_id.call_count, 100)

    def test_room_creation_is_atomic_with_creator_membership_and_persists(self) -> None:
        owner, token = self.register("principal_alice", "agent_owner", "runtime_owner")

        room = self.store.create_room(owner, "  Planning  ", "A shared plan", "anyone_with_id")
        stored_room, memberships = self.store.get_room(owner, room.room_id)

        self.assertEqual(stored_room, room)
        self.assertEqual(room.name, "Planning")
        self.assertRegex(room.room_id, r"^room_[a-z0-9_]+$")
        self.assertEqual(len(memberships), 1)
        self.assertEqual(memberships[0].agent_id, "agent_owner")
        self.assertEqual(memberships[0].status, MembershipStatus.ACTIVE)
        self.assertEqual(memberships[0].last_read_sequence, 0)
        restarted = RoomStore(self.database_path, clock=self.clock)
        restarted.initialize()
        self.assertEqual(restarted.authenticate_runtime(token), owner)
        self.assertEqual(restarted.get_room(owner, room.room_id), (room, memberships))

    def test_principal_only_room_accepts_sibling_agent_and_rejects_other_principal(self) -> None:
        owner, _ = self.register("principal_alice", "agent_owner", "runtime_owner")
        sibling, _ = self.register("principal_alice", "agent_sibling", "runtime_sibling")
        outsider, _ = self.register("principal_bob", "agent_outsider", "runtime_outsider")
        room = self.store.create_room(owner, "Private", None, "principal_only")

        membership = self.store.join_room(sibling, room.room_id)

        self.assertEqual(membership.agent_id, "agent_sibling")
        self.assert_room_error("room_access_denied", 403, lambda: self.store.join_room(outsider, room.room_id))

    def test_join_is_idempotent_and_leave_rejoin_reuses_one_membership_row(self) -> None:
        owner, _ = self.register("principal_alice", "agent_owner", "runtime_owner")
        peer, _ = self.register("principal_bob", "agent_peer", "runtime_peer")
        room = self.store.create_room(owner, "Planning", None, "anyone_with_id")

        first_join = self.store.join_room(peer, room.room_id)
        self.assertEqual(self.store.join_room(peer, room.room_id), first_join)
        with closing(sqlite3.connect(self.database_path)) as connection:
            membership_id_before_leave = connection.execute(
                "SELECT membership_id FROM room_memberships WHERE room_id = ? AND agent_id = ?",
                (room.room_id, peer.agent_id),
            ).fetchone()[0]
        left = self.store.leave_room(peer, room.room_id)
        self.assertEqual(left.status, MembershipStatus.LEFT)
        self.assertIsNotNone(left.left_at)
        self.assertEqual(self.store.list_rooms(peer)[0].membership_status, MembershipStatus.LEFT)
        self.assert_room_error("not_a_room_member", 403, lambda: self.store.get_room(peer, room.room_id))

        rejoined = self.store.join_room(peer, room.room_id)

        self.assertEqual(rejoined.status, MembershipStatus.ACTIVE)
        self.assertIsNone(rejoined.left_at)
        self.assertGreater(rejoined.joined_at, first_join.joined_at)
        with closing(sqlite3.connect(self.database_path)) as connection:
            rows = connection.execute(
                "SELECT membership_id FROM room_memberships WHERE room_id = ? AND agent_id = ?",
                (room.room_id, peer.agent_id),
            ).fetchall()
        self.assertEqual(rows, [(membership_id_before_leave,)])

    def test_list_rooms_includes_active_and_left_membership_state(self) -> None:
        identity, _ = self.register("principal_alice", "agent_owner", "runtime_owner")
        active_room = self.store.create_room(identity, "Active", None, "anyone_with_id")
        left_room = self.store.create_room(identity, "Left behind", None, "anyone_with_id")
        self.store.leave_room(identity, left_room.room_id)

        summaries = {summary.room_id: summary for summary in self.store.list_rooms(identity)}

        self.assertEqual(set(summaries), {active_room.room_id, left_room.room_id})
        self.assertEqual(summaries[active_room.room_id].membership_status, MembershipStatus.ACTIVE)
        self.assertEqual(summaries[left_room.room_id].membership_status, MembershipStatus.LEFT)
        self.assertEqual(summaries[active_room.room_id].latest_cursor, "cursor_0")
        self.assertEqual(summaries[active_room.room_id].last_read_cursor, "cursor_0")
        self.assertEqual(summaries[active_room.room_id].unread_count, 0)
        self.assertEqual(summaries[active_room.room_id].latest_activity_at, active_room.updated_at)

    def test_only_creator_agent_can_close_and_members_can_read_closed_history(self) -> None:
        owner, _ = self.register("principal_alice", "agent_owner", "runtime_owner")
        sibling, _ = self.register("principal_alice", "agent_sibling", "runtime_sibling")
        peer, _ = self.register("principal_bob", "agent_peer", "runtime_peer")
        late_peer, _ = self.register("principal_carol", "agent_late", "runtime_late")
        room = self.store.create_room(owner, "Planning", None, "anyone_with_id")
        self.store.join_room(peer, room.room_id)

        self.assert_room_error("room_owner_required", 403, lambda: self.store.close_room(sibling, room.room_id))
        closed = self.store.close_room(owner, room.room_id)

        self.assertEqual(closed.status, RoomStatus.CLOSED)
        readable_room, readable_memberships = self.store.get_room(peer, room.room_id)
        self.assertEqual(readable_room.status, RoomStatus.CLOSED)
        self.assertEqual({item.agent_id for item in readable_memberships}, {"agent_owner", "agent_peer"})
        self.assert_room_error("room_closed", 409, lambda: self.store.join_room(late_peer, room.room_id))
        self.assert_room_error("room_closed", 409, lambda: self.store.close_room(owner, room.room_id))

    def test_closed_room_rejects_leave_and_preserves_member_history_access(self) -> None:
        owner, _ = self.register("principal_alice", "agent_owner", "runtime_owner")
        peer, _ = self.register("principal_bob", "agent_peer", "runtime_peer")
        room = self.store.create_room(owner, "Planning", None, "anyone_with_id")
        self.store.join_room(peer, room.room_id)
        self.store.close_room(owner, room.room_id)

        self.assert_room_error("room_closed", 409, lambda: self.store.leave_room(peer, room.room_id))

        readable_room, memberships = self.store.get_room(peer, room.room_id)
        peer_membership = next(item for item in memberships if item.agent_id == peer.agent_id)
        self.assertEqual(readable_room.status, RoomStatus.CLOSED)
        self.assertEqual(peer_membership.status, MembershipStatus.ACTIVE)
        self.assertIsNone(peer_membership.left_at)

    def test_missing_rooms_and_unregistered_identity_fail_closed(self) -> None:
        identity, _ = self.register("principal_alice", "agent_owner", "runtime_owner")
        forged = RuntimeIdentity("principal_alice", "agent_owner", "runtime_forged")

        self.assert_room_error("room_not_found", 404, lambda: self.store.join_room(identity, "room_missing"))
        self.assert_room_error(
            "invalid_runtime_identity",
            401,
            lambda: self.store.create_room(forged, "Planning", None, "anyone_with_id"),
        )


if __name__ == "__main__":
    unittest.main()
