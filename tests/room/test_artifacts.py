"""Behavioral tests for streamed, content-addressed Room artifacts."""

from __future__ import annotations

import asyncio
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

from sharednet.room.blobs import LocalBlobStore
from sharednet.room.errors import RoomError
from sharednet.room.models import RuntimeIdentity
from sharednet.room.service import RoomService
from sharednet.room.store import RoomStore


START = datetime(2026, 8, 31, 16, 0, tzinfo=timezone.utc)


class SteppingClock:
    def __init__(self) -> None:
        self.current = START

    def __call__(self) -> datetime:
        value = self.current
        self.current += timedelta(seconds=1)
        return value


async def stream(*chunks: bytes):
    for chunk in chunks:
        yield chunk


class RoomArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.database_path = self.root / "rooms.sqlite3"
        self.blob_path = self.root / "blobs"
        self.clock = SteppingClock()
        self.store = RoomStore(self.database_path, clock=self.clock)
        self.store.initialize()
        self.blob_store = LocalBlobStore(self.blob_path)
        self.service = RoomService(self.store, self.blob_store)

    def register(self, principal_id: str, agent_id: str, runtime_id: str) -> RuntimeIdentity:
        registration, _ = self.store.register_runtime(principal_id, agent_id, runtime_id)
        return registration.identity

    def create_room(self, owner: RuntimeIdentity):
        return self.store.create_room(owner, "Artifacts", None, "anyone_with_id")

    def upload(
        self,
        identity: RuntimeIdentity,
        room_id: str,
        filename: str,
        *chunks: bytes,
        media_type: str = "application/octet-stream",
    ):
        return asyncio.run(
            self.service.upload_artifact(
                identity,
                room_id,
                filename,
                media_type,
                stream(*chunks),
            )
        )

    def assert_room_error(self, code: str, status_code: int, operation) -> RoomError:
        with self.assertRaises(RoomError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.status_code, status_code)
        return caught.exception

    def artifact_count(self) -> int:
        with closing(sqlite3.connect(self.database_path)) as connection:
            return connection.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0]

    def test_multichunk_upload_hashes_stream_and_persists_uploader_provenance(self) -> None:
        alpha = self.register("principal_alpha", "agent_alpha", "runtime_alpha")
        beta = self.register("principal_beta", "agent_beta", "runtime_beta")
        room = self.create_room(alpha)
        self.store.join_room(beta, room.room_id)

        artifact = self.upload(alpha, room.room_id, "brief.bin", b"abc", b"def")

        self.assertEqual(artifact.room_id, room.room_id)
        self.assertEqual(artifact.filename, "brief.bin")
        self.assertEqual(artifact.size_bytes, 6)
        self.assertEqual(artifact.sha256, "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721")
        metadata, body = self.service.open_artifact(beta, room.room_id, artifact.artifact_id)
        with body:
            self.assertEqual(body.read(), b"abcdef")
        self.assertEqual(metadata, artifact)
        with closing(sqlite3.connect(self.database_path)) as connection:
            provenance = connection.execute(
                """
                SELECT uploader_principal_id, uploader_agent_id, uploader_runtime_id
                FROM artifacts WHERE artifact_id = ?
                """,
                (artifact.artifact_id,),
            ).fetchone()
        self.assertEqual(provenance, ("principal_alpha", "agent_alpha", "runtime_alpha"))

    def test_identical_content_is_physically_deduplicated_but_keeps_distinct_metadata(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        room = self.create_room(owner)

        first = self.upload(owner, room.room_id, "first.bin", b"same")
        second = self.upload(owner, room.room_id, "second.bin", b"sa", b"me")

        self.assertNotEqual(first.artifact_id, second.artifact_id)
        self.assertEqual(first.sha256, second.sha256)
        self.assertEqual(self.artifact_count(), 2)
        stored_files = [path for path in (self.blob_path / "sha256").rglob("*") if path.is_file()]
        self.assertEqual(len(stored_files), 1)
        self.assertEqual(stored_files[0].name, hashlib.sha256(b"same").hexdigest())

    def test_size_limit_and_invalid_chunks_fail_early_and_clean_temporary_files(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        room = self.create_room(owner)
        limited_blobs = LocalBlobStore(self.blob_path, max_upload_bytes=5)
        service = RoomService(self.store, limited_blobs)

        self.assert_room_error(
            "upload_too_large",
            413,
            lambda: asyncio.run(
                service.upload_artifact(
                    owner,
                    room.room_id,
                    "large.bin",
                    "application/octet-stream",
                    stream(b"abc", b"def"),
                )
            ),
        )

        async def invalid_chunks():
            yield b"ok"
            yield "not-bytes"

        self.assert_room_error(
            "invalid_upload_chunk",
            400,
            lambda: asyncio.run(
                service.upload_artifact(
                    owner,
                    room.room_id,
                    "invalid.bin",
                    "application/octet-stream",
                    invalid_chunks(),
                )
            ),
        )
        temporary_files = list((self.blob_path / ".tmp").glob("*"))
        completed_files = [path for path in (self.blob_path / "sha256").rglob("*") if path.is_file()]
        self.assertEqual(temporary_files, [])
        self.assertEqual(completed_files, [])
        self.assertEqual(self.artifact_count(), 0)

    def test_invalid_filename_and_untrusted_digest_never_become_blob_paths(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        room = self.create_room(owner)
        consumed = False

        async def observed_stream():
            nonlocal consumed
            consumed = True
            yield b"secret"

        for filename in ("../secret.bin", "nested/file.bin", "nested\\file.bin", "."):
            self.assert_room_error(
                "invalid_filename",
                400,
                lambda filename=filename: asyncio.run(
                    self.service.upload_artifact(
                        owner,
                        room.room_id,
                        filename,
                        "application/octet-stream",
                        observed_stream(),
                    )
                ),
            )
        self.assertFalse(consumed)
        self.assert_room_error(
            "invalid_sha256",
            400,
            lambda: self.blob_store.open_blob("../../rooms.sqlite3"),
        )

    def test_upload_rejects_control_and_whitespace_filenames_before_streaming(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        room = self.create_room(owner)

        for filename in (
            "nul\x00.bin",
            "line\r\nbreak.bin",
            "delete\x7f.bin",
            "zero\u200bwidth.bin",
            "   ",
        ):
            consumed = False

            async def observed_stream():
                nonlocal consumed
                consumed = True
                yield b"must not be stored"

            with self.subTest(filename=repr(filename)):
                self.assert_room_error(
                    "invalid_filename",
                    400,
                    lambda filename=filename: asyncio.run(
                        self.service.upload_artifact(
                            owner,
                            room.room_id,
                            filename,
                            "application/octet-stream",
                            observed_stream(),
                        )
                    ),
                )
                self.assertFalse(consumed)

        self.assertEqual(self.artifact_count(), 0)
        self.assertEqual(list((self.blob_path / ".tmp").glob("*")), [])
        self.assertEqual(
            [path for path in (self.blob_path / "sha256").rglob("*") if path.is_file()],
            [],
        )

    def test_media_type_accepts_ascii_vendor_suffix_and_rejects_unsafe_values_before_streaming(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        room = self.create_room(owner)
        valid = self.upload(
            owner,
            room.room_id,
            "valid.xml",
            b"<room />",
            media_type="application/vnd.sharednet.room+xml",
        )
        self.assertEqual(valid.media_type, "application/vnd.sharednet.room+xml")
        expected_artifact_count = self.artifact_count()
        expected_blob_count = len(
            [path for path in (self.blob_path / "sha256").rglob("*") if path.is_file()]
        )

        for media_type in (
            "applicationjson",
            "text/plain; charset=utf-8",
            "text/plain\r\nX-Injected: yes",
            "text/pläin",
        ):
            consumed = False

            async def observed_stream():
                nonlocal consumed
                consumed = True
                yield b"unsafe"

            self.assert_room_error(
                "invalid_media_type",
                400,
                lambda media_type=media_type: asyncio.run(
                    self.service.upload_artifact(
                        owner,
                        room.room_id,
                        "unsafe.bin",
                        media_type,
                        observed_stream(),
                    )
                ),
            )
            self.assertFalse(consumed)

        self.assertEqual(self.artifact_count(), expected_artifact_count)
        self.assertEqual(
            len([path for path in (self.blob_path / "sha256").rglob("*") if path.is_file()]),
            expected_blob_count,
        )

    def test_upload_checks_access_before_streaming_and_rechecks_membership_transactionally(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        peer = self.register("principal_peer", "agent_peer", "runtime_peer")
        outsider = self.register("principal_other", "agent_outsider", "runtime_outsider")
        room = self.create_room(owner)
        self.store.join_room(peer, room.room_id)
        consumed = False

        async def observed_stream():
            nonlocal consumed
            consumed = True
            yield b"blocked"

        self.assert_room_error(
            "not_a_room_member",
            403,
            lambda: asyncio.run(
                self.service.upload_artifact(
                    outsider,
                    room.room_id,
                    "blocked.bin",
                    "application/octet-stream",
                    observed_stream(),
                )
            ),
        )
        self.assertFalse(consumed)

        async def leave_during_stream():
            yield b"abc"
            self.store.leave_room(peer, room.room_id)
            yield b"def"

        self.assert_room_error(
            "not_a_room_member",
            403,
            lambda: asyncio.run(
                self.service.upload_artifact(
                    peer,
                    room.room_id,
                    "race.bin",
                    "application/octet-stream",
                    leave_during_stream(),
                )
            ),
        )
        self.assertEqual(self.artifact_count(), 0)

    def test_closed_room_rejects_upload_before_and_after_streaming_race(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        closed_room = self.create_room(owner)
        self.store.close_room(owner, closed_room.room_id)
        consumed = False

        async def observed_stream():
            nonlocal consumed
            consumed = True
            yield b"blocked"

        self.assert_room_error(
            "room_closed",
            409,
            lambda: asyncio.run(
                self.service.upload_artifact(
                    owner,
                    closed_room.room_id,
                    "blocked.bin",
                    "application/octet-stream",
                    observed_stream(),
                )
            ),
        )
        self.assertFalse(consumed)

        racing_room = self.create_room(owner)

        async def close_during_stream():
            yield b"abc"
            self.store.close_room(owner, racing_room.room_id)
            yield b"def"

        self.assert_room_error(
            "room_closed",
            409,
            lambda: asyncio.run(
                self.service.upload_artifact(
                    owner,
                    racing_room.room_id,
                    "race.bin",
                    "application/octet-stream",
                    close_during_stream(),
                )
            ),
        )
        self.assertEqual(self.artifact_count(), 0)

    def test_download_requires_active_membership_but_survives_room_closure(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        peer = self.register("principal_peer", "agent_peer", "runtime_peer")
        departed = self.register("principal_peer", "agent_departed", "runtime_departed")
        outsider = self.register("principal_other", "agent_outsider", "runtime_outsider")
        room = self.create_room(owner)
        self.store.join_room(peer, room.room_id)
        self.store.join_room(departed, room.room_id)
        artifact = self.upload(owner, room.room_id, "history.bin", b"history")
        self.store.leave_room(departed, room.room_id)
        self.store.close_room(owner, room.room_id)

        metadata, body = self.service.open_artifact(peer, room.room_id, artifact.artifact_id)
        with body:
            self.assertEqual(body.read(), b"history")
        self.assertEqual(metadata, artifact)
        for identity in (departed, outsider):
            self.assert_room_error(
                "not_a_room_member",
                403,
                lambda identity=identity: self.service.open_artifact(
                    identity, room.room_id, artifact.artifact_id
                ),
            )

    def test_missing_and_cross_room_attachments_are_atomic_and_valid_links_are_recorded(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        first_room = self.create_room(owner)
        second_room = self.create_room(owner)
        first = self.upload(owner, first_room.room_id, "first.bin", b"first")
        second = self.upload(owner, first_room.room_id, "second.bin", b"second")
        foreign = self.upload(owner, second_room.room_id, "foreign.bin", b"foreign")

        for attachment_id in ("artifact_missing", foreign.artifact_id):
            self.assert_room_error(
                "invalid_attachment",
                400,
                lambda attachment_id=attachment_id: self.service.post_message(
                    owner,
                    first_room.room_id,
                    "must be atomic",
                    attachment_ids=(first.artifact_id, attachment_id),
                ),
            )
        with closing(sqlite3.connect(self.database_path)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM message_artifacts").fetchone()[0], 0)
            self.assertEqual(
                connection.execute(
                    "SELECT latest_sequence FROM rooms WHERE room_id = ?", (first_room.room_id,)
                ).fetchone()[0],
                0,
            )

        message = self.service.post_message(
            owner,
            first_room.room_id,
            "linked",
            attachment_ids=(second.artifact_id, first.artifact_id),
        )
        with closing(sqlite3.connect(self.database_path)) as connection:
            links = connection.execute(
                """
                SELECT artifact_id FROM message_artifacts
                WHERE message_id = ? ORDER BY position
                """,
                (message.message_id,),
            ).fetchall()
        self.assertEqual(links, [(second.artifact_id,), (first.artifact_id,)])
        self.assertEqual(message.attachment_ids, (second.artifact_id, first.artifact_id))

    def test_artifact_metadata_and_blob_survive_new_store_and_service_instances(self) -> None:
        owner = self.register("principal_owner", "agent_owner", "runtime_owner")
        room = self.create_room(owner)
        artifact = self.upload(owner, room.room_id, "durable.bin", b"durable", b" data")

        restarted_store = RoomStore(self.database_path, clock=self.clock)
        restarted_store.initialize()
        restarted_service = RoomService(restarted_store, LocalBlobStore(self.blob_path))
        metadata, body = restarted_service.open_artifact(owner, room.room_id, artifact.artifact_id)

        self.assertEqual(metadata, artifact)
        with body:
            self.assertEqual(body.read(), b"durable data")


if __name__ == "__main__":
    unittest.main()
