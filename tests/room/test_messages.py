"""Behavioral tests for ordered persistent Room messaging."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from sharednet.room.errors import RoomError
from sharednet.room.models import ResolutionState, RuntimeIdentity
from sharednet.room.service import RoomService
from sharednet.room.store import RoomStore


START = datetime(2026, 8, 31, 14, 0, tzinfo=timezone.utc)


class ThreadSafeSteppingClock:
    def __init__(self) -> None:
        self.current = START
        self.lock = threading.Lock()

    def __call__(self) -> datetime:
        with self.lock:
            value = self.current
            self.current += timedelta(seconds=1)
            return value


class RoomMessageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.database_path = Path(self.temporary_directory.name) / "rooms.sqlite3"
        self.clock = ThreadSafeSteppingClock()
        self.store = RoomStore(self.database_path, clock=self.clock)
        self.store.initialize()
        self.service = RoomService(self.store)

    def register(self, principal_id: str, agent_id: str, runtime_id: str) -> RuntimeIdentity:
        registration, _ = self.store.register_runtime(principal_id, agent_id, runtime_id)
        return registration.identity

    def create_room(self, owner: RuntimeIdentity):
        return self.store.create_room(owner, "Coordination", None, "anyone_with_id")

    def assert_room_error(self, code: str, status_code: int, operation) -> RoomError:
        with self.assertRaises(RoomError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.status_code, status_code)
        return caught.exception

    def test_active_membership_guards_reads_and_posts_but_closed_history_remains_readable(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        departed = self.register("principal_peer", "agent_departed", "runtime_departed")
        outsider = self.register("principal_other", "agent_outsider", "runtime_outsider")
        room = self.create_room(owner)
        self.store.join_room(departed, room.room_id)
        self.store.leave_room(departed, room.room_id)
        posted = self.service.post_message(owner, room.room_id, "history")

        for identity in (departed, outsider):
            self.assert_room_error(
                "not_a_room_member",
                403,
                lambda identity=identity: self.service.retrieve_messages(identity, room.room_id),
            )
            self.assert_room_error(
                "not_a_room_member",
                403,
                lambda identity=identity: self.service.post_message(identity, room.room_id, "blocked"),
            )

        self.store.close_room(owner, room.room_id)

        self.assertEqual(self.service.retrieve_messages(owner, room.room_id).messages, (posted,))
        self.assert_room_error(
            "room_closed",
            409,
            lambda: self.service.post_message(owner, room.room_id, "too late"),
        )

    def test_ordered_replies_pagination_empty_cursor_and_unread_state(self) -> None:
        alpha = self.register("principal_alpha", "agent_alpha", "runtime_alpha")
        beta = self.register("principal_beta", "agent_beta", "runtime_beta")
        gamma = self.register("principal_gamma", "agent_gamma", "runtime_gamma")
        room = self.create_room(alpha)
        self.store.join_room(beta, room.room_id)
        self.store.join_room(gamma, room.room_id)

        first = self.service.post_message(alpha, room.room_id, "proposal")
        second = self.service.post_message(beta, room.room_id, "review", reply_to=first.message_id)

        self.assertEqual((first.sequence, second.sequence), (1, 2))
        self.assertEqual(second.reply_to, first.message_id)
        self.assertEqual(second.sender.runtime_id, beta.runtime_id)
        self.assertEqual(self.store.list_rooms(gamma)[0].unread_count, 2)

        first_page = self.service.retrieve_messages(gamma, room.room_id, limit=1)
        self.assertEqual(first_page.messages, (first,))
        self.assertEqual(first_page.next_cursor, "cursor_1")
        self.assertEqual(self.store.list_rooms(gamma)[0].unread_count, 1)

        empty_page = self.service.retrieve_messages(gamma, room.room_id, after_cursor="cursor_9", limit=10)
        self.assertEqual(empty_page.messages, ())
        self.assertEqual(empty_page.next_cursor, "cursor_9")
        self.assertEqual(self.store.list_rooms(gamma)[0].last_read_cursor, "cursor_1")

        second_page = self.service.retrieve_messages(gamma, room.room_id, after_cursor="cursor_1", limit=10)
        self.assertEqual(second_page.messages, (second,))
        self.assertEqual(second_page.next_cursor, "cursor_2")
        summary = self.store.list_rooms(gamma)[0]
        self.assertEqual(summary.last_read_cursor, "cursor_2")
        self.assertEqual(summary.latest_cursor, "cursor_2")
        self.assertEqual(summary.unread_count, 0)

    def test_concurrent_posts_get_unique_room_local_sequences_and_survive_restart(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        peer = self.register("principal_peer", "agent_peer", "runtime_peer")
        room = self.create_room(owner)
        self.store.join_room(peer, room.room_id)
        barrier = threading.Barrier(2)

        def post(identity: RuntimeIdentity, content: str):
            barrier.wait()
            return self.service.post_message(identity, room.room_id, content)

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(post, owner, "alpha"), executor.submit(post, peer, "beta")]
            posted = [future.result() for future in futures]

        self.assertEqual(sorted(message.sequence for message in posted), [1, 2])
        restarted = RoomStore(self.database_path, clock=self.clock)
        restarted.initialize()
        page = RoomService(restarted).retrieve_messages(owner, room.room_id)
        self.assertEqual([message.sequence for message in page.messages], [1, 2])
        self.assertEqual({message.content for message in page.messages}, {"alpha", "beta"})

    def test_reply_must_reference_a_message_in_the_same_room(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        first_room = self.create_room(owner)
        second_room = self.create_room(owner)
        foreign = self.service.post_message(owner, first_room.room_id, "foreign")

        self.assert_room_error(
            "invalid_reply",
            400,
            lambda: self.service.post_message(owner, second_room.room_id, "reply", reply_to=foreign.message_id),
        )
        self.assert_room_error(
            "invalid_reply",
            400,
            lambda: self.service.post_message(owner, second_room.room_id, "reply", reply_to="message_missing"),
        )

    def test_sender_provenance_and_message_payload_are_persisted_immutably(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        room = self.create_room(owner)

        message = self.service.post_message(
            owner,
            room.room_id,
            "  immutable body  ",
            attachment_ids=("artifact_one", "artifact_two"),
        )

        self.assertEqual(message.sender, owner)
        self.assertEqual(message.content, "immutable body")
        with closing(sqlite3.connect(self.database_path)) as connection:
            row = connection.execute(
                """
                SELECT sender_principal_id, sender_agent_id, sender_runtime_id,
                       content, attachment_ids_json
                FROM messages WHERE message_id = ?
                """,
                (message.message_id,),
            ).fetchone()
        self.assertEqual(
            row,
            ("principal_owner", "agent_owner", "runtime_owner", "immutable body", '["artifact_one","artifact_two"]'),
        )

    def test_valid_tags_create_canonical_obligations_without_changing_membership(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        target = self.register("principal_target", "agent_target", "runtime_target")
        room = self.create_room(owner)

        message = self.service.post_message(
            owner,
            room.room_id,
            "coordinate",
            tags=("human-review-required", "verification-required", "delegate-to:agent_target"),
        )

        self.assertEqual(message.resolution_state, ResolutionState.PENDING)
        with closing(sqlite3.connect(self.database_path)) as connection:
            connection.row_factory = sqlite3.Row
            stored = connection.execute(
                "SELECT tags_json FROM messages WHERE message_id = ?", (message.message_id,)
            ).fetchone()["tags_json"]
            obligations = connection.execute(
                """
                SELECT tag_raw, tag_kind, target_id FROM message_obligations
                WHERE message_id = ? ORDER BY rowid
                """,
                (message.message_id,),
            ).fetchall()
            memberships = connection.execute(
                "SELECT agent_id FROM room_memberships WHERE room_id = ? ORDER BY agent_id", (room.room_id,)
            ).fetchall()
        self.assertEqual(
            stored,
            '[{"kind":"human_review","raw":"human-review-required","target_id":null},'
            '{"kind":"verification","raw":"verification-required","target_id":null},'
            '{"kind":"delegation","raw":"delegate-to:agent_target","target_id":"agent_target"}]',
        )
        self.assertEqual(
            [tuple(row) for row in obligations],
            [
                ("human-review-required", "human_review", None),
                ("verification-required", "verification", None),
                ("delegate-to:agent_target", "delegation", "agent_target"),
            ],
        )
        self.assertEqual([tuple(row) for row in memberships], [("agent_owner",)])
        self.assert_room_error(
            "not_a_room_member",
            403,
            lambda: self.service.retrieve_messages(target, room.room_id),
        )

    def test_unknown_and_duplicate_tags_are_rejected_without_message_activity(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        room = self.create_room(owner)

        self.assert_room_error(
            "invalid_tag",
            400,
            lambda: self.service.post_message(owner, room.room_id, "bad", tags=("run-custom-code",)),
        )
        self.assert_room_error(
            "duplicate_tag",
            400,
            lambda: self.service.post_message(
                owner,
                room.room_id,
                "bad",
                tags=("verification-required", "verification-required"),
            ),
        )
        with closing(sqlite3.connect(self.database_path)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)
            self.assertEqual(
                connection.execute("SELECT latest_sequence FROM rooms WHERE room_id = ?", (room.room_id,)).fetchone()[0],
                0,
            )

    def test_human_review_requires_a_different_agent_under_the_creator_principal(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        owner_other_runtime = self.register("principal_owner", "agent_owner", "runtime_owner_two")
        sibling = self.register("principal_owner", "agent_sibling", "runtime_sibling")
        outsider = self.register("principal_other", "agent_outsider", "runtime_outsider")
        room = self.create_room(owner)
        self.store.join_room(sibling, room.room_id)
        self.store.join_room(outsider, room.room_id)
        message = self.service.post_message(owner, room.room_id, "review", tags=("human-review-required",))

        for identity in (owner_other_runtime, outsider):
            self.assert_room_error(
                "resolver_not_authorized",
                403,
                lambda identity=identity: self.service.resolve_message(
                    identity, room.room_id, message.message_id, "fulfilled"
                ),
            )

        resolved = self.service.resolve_message(
            sibling, room.room_id, message.message_id, "fulfilled", evidence="reviewed"
        )
        self.assertEqual(resolved.resolution_state, ResolutionState.RESOLVED)
        self.assert_room_error(
            "message_already_resolved",
            409,
            lambda: self.service.resolve_message(sibling, room.room_id, message.message_id, "fulfilled"),
        )

    def test_verification_requires_a_different_agent_than_the_sender(self) -> None:
        sender = self.register("principal_owner", "agent_sender", "runtime_sender")
        sender_other_runtime = self.register("principal_owner", "agent_sender", "runtime_sender_two")
        verifier = self.register("principal_owner", "agent_verifier", "runtime_verifier")
        room = self.create_room(sender)
        self.store.join_room(verifier, room.room_id)
        message = self.service.post_message(sender, room.room_id, "verify", tags=("verification-required",))

        self.assert_room_error(
            "resolver_not_authorized",
            403,
            lambda: self.service.resolve_message(
                sender_other_runtime, room.room_id, message.message_id, "fulfilled"
            ),
        )
        resolved = self.service.resolve_message(verifier, room.room_id, message.message_id, "fulfilled")
        self.assertEqual(resolved.resolution_state, ResolutionState.RESOLVED)

    def test_delegation_accepts_exact_agent_or_an_agent_under_the_target_principal(self) -> None:
        sender = self.register("principal_sender", "agent_sender", "runtime_sender")
        exact_target = self.register("principal_exact", "agent_exact", "runtime_exact")
        principal_target = self.register("principal_target", "agent_principal_child", "runtime_principal_child")
        wrong = self.register("principal_wrong", "agent_wrong", "runtime_wrong")
        room = self.create_room(sender)
        for identity in (exact_target, principal_target, wrong):
            self.store.join_room(identity, room.room_id)

        agent_message = self.service.post_message(
            sender, room.room_id, "agent task", tags=("delegate-to:agent_exact",)
        )
        principal_message = self.service.post_message(
            sender, room.room_id, "principal task", tags=("delegate-to:principal_target",)
        )

        self.assert_room_error(
            "resolver_not_authorized",
            403,
            lambda: self.service.resolve_message(wrong, room.room_id, agent_message.message_id, "fulfilled"),
        )
        self.assertEqual(
            self.service.resolve_message(exact_target, room.room_id, agent_message.message_id, "fulfilled").resolution_state,
            ResolutionState.RESOLVED,
        )
        self.assertEqual(
            self.service.resolve_message(
                principal_target, room.room_id, principal_message.message_id, "fulfilled"
            ).resolution_state,
            ResolutionState.RESOLVED,
        )

    def test_multi_tag_resolution_applies_to_all_eligible_pending_obligations(self) -> None:
        sender = self.register("principal_owner", "agent_sender", "runtime_sender")
        target = self.register("principal_target", "agent_target", "runtime_target")
        room = self.create_room(sender)
        self.store.join_room(target, room.room_id)
        message = self.service.post_message(
            sender,
            room.room_id,
            "two obligations",
            tags=("verification-required", "delegate-to:principal_target"),
        )

        resolved = self.service.resolve_message(target, room.room_id, message.message_id, "fulfilled")

        self.assertEqual(resolved.resolution_state, ResolutionState.RESOLVED)
        with closing(sqlite3.connect(self.database_path)) as connection:
            rows = connection.execute(
                """
                SELECT outcome, resolver_principal_id, resolver_agent_id, resolver_runtime_id
                FROM message_resolutions WHERE message_id = ? ORDER BY resolution_id
                """,
                (message.message_id,),
            ).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual({row[0] for row in rows}, {"fulfilled"})
        self.assertEqual({row[1:] for row in rows}, {("principal_target", "agent_target", "runtime_target")})

    def test_partial_multi_tag_resolution_stays_pending_and_any_rejection_is_terminal(self) -> None:
        sender = self.register("principal_owner", "agent_sender", "runtime_sender")
        sibling = self.register("principal_owner", "agent_sibling", "runtime_sibling")
        target = self.register("principal_target", "agent_target", "runtime_target")
        room = self.create_room(sender)
        self.store.join_room(sibling, room.room_id)
        self.store.join_room(target, room.room_id)
        pending_message = self.service.post_message(
            sender,
            room.room_id,
            "split work",
            tags=("human-review-required", "delegate-to:principal_target"),
        )

        pending = self.service.resolve_message(sibling, room.room_id, pending_message.message_id, "fulfilled")
        self.assertEqual(pending.resolution_state, ResolutionState.PENDING)
        resolved = self.service.resolve_message(target, room.room_id, pending_message.message_id, "fulfilled")
        self.assertEqual(resolved.resolution_state, ResolutionState.RESOLVED)

        rejected_message = self.service.post_message(
            sender,
            room.room_id,
            "rejected split",
            tags=("human-review-required", "delegate-to:principal_target"),
        )
        rejected = self.service.resolve_message(sibling, room.room_id, rejected_message.message_id, "rejected")
        self.assertEqual(rejected.resolution_state, ResolutionState.REJECTED)
        with closing(sqlite3.connect(self.database_path)) as connection:
            resolution_count = connection.execute(
                "SELECT COUNT(*) FROM message_resolutions WHERE message_id = ?", (rejected_message.message_id,)
            ).fetchone()[0]
        self.assertEqual(resolution_count, 1)
        self.assert_room_error(
            "message_already_resolved",
            409,
            lambda: self.service.resolve_message(target, room.room_id, rejected_message.message_id, "fulfilled"),
        )


if __name__ == "__main__":
    unittest.main()
