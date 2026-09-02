"""End-to-end acceptance coverage for three independent Room clients."""

from __future__ import annotations

from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest

import uvicorn

from sharednet.room.api import create_room_app
from sharednet.room.client import RoomClient
from sharednet.room.errors import RoomError


IDENTITY_A = {
    "principal_id": "principal_e2e_alice",
    "agent_id": "agent_e2e_architect",
    "runtime_id": "runtime_e2e_codex_a",
}
IDENTITY_B = {
    "principal_id": "principal_e2e_bob",
    "agent_id": "agent_e2e_reviewer",
    "runtime_id": "runtime_e2e_codex_b",
}
IDENTITY_C = {
    "principal_id": "principal_e2e_carol",
    "agent_id": "agent_e2e_writer",
    "runtime_id": "runtime_e2e_codex_c",
}


class _LiveRoomServer:
    """Run a real Room daemon on an OS-assigned loopback socket."""

    def __init__(self, database_path: Path, blob_path: Path) -> None:
        app = create_room_app(database_path, blob_path)
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen(128)
        self.url = f"http://127.0.0.1:{self.socket.getsockname()[1]}"
        self.server = uvicorn.Server(
            uvicorn.Config(
                app,
                log_level="critical",
                lifespan="on",
                access_log=False,
            )
        )
        self.thread = threading.Thread(
            target=self.server.run,
            kwargs={"sockets": [self.socket]},
            name=f"room-e2e-uvicorn-{self.socket.getsockname()[1]}",
            daemon=False,
        )

    def start(self) -> "_LiveRoomServer":
        self.thread.start()
        deadline = time.monotonic() + 5.0
        while self.thread.is_alive():
            if self.server.started:
                try:
                    if RoomClient(self.url, timeout=0.25).health() == {"status": "ok"}:
                        return self
                except RoomError:
                    pass
            if time.monotonic() >= deadline:
                self.stop()
                raise AssertionError("Room daemon did not become ready within five seconds")
            time.sleep(0.01)
        raise AssertionError("Room daemon exited before becoming ready")

    def stop(self) -> None:
        self.server.should_exit = True
        if self.thread.ident is not None:
            self.thread.join(timeout=5.0)
            if self.thread.is_alive():
                raise AssertionError("Room daemon did not stop within five seconds")
        try:
            self.socket.close()
        except OSError:
            pass

    def __enter__(self) -> "_LiveRoomServer":
        return self.start()

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.stop()


def _register(base_url: str, identity: dict[str, str]) -> tuple[RoomClient, str]:
    response = RoomClient(base_url).register_runtime(
        identity["principal_id"],
        identity["agent_id"],
        identity["runtime_id"],
    )
    if response["registration"]["identity"] != identity:
        raise AssertionError("runtime registration changed the requested identity")
    token = response["runtime_token"]
    if not isinstance(token, str) or not token:
        raise AssertionError("runtime registration did not return a token")
    return RoomClient(base_url, token), token


def _only_room_summary(client: RoomClient) -> dict[str, object]:
    rooms = client.list_rooms()["rooms"]
    if len(rooms) != 1:
        raise AssertionError(f"expected exactly one Room membership, got {len(rooms)}")
    return rooms[0]


class ThreeRuntimeRoomE2ETests(unittest.TestCase):
    """Exercise the frozen V1 journey entirely through the public HTTP client."""

    def assert_summary(
        self,
        client: RoomClient,
        room_id: str,
        *,
        status: str,
        latest_cursor: str,
        last_read_cursor: str,
        unread_count: int,
    ) -> None:
        summary = _only_room_summary(client)
        self.assertEqual(summary["room_id"], room_id)
        self.assertEqual(summary["membership_status"], "active")
        self.assertEqual(summary["status"], status)
        self.assertEqual(summary["latest_cursor"], latest_cursor)
        self.assertEqual(summary["last_read_cursor"], last_read_cursor)
        self.assertEqual(summary["unread_count"], unread_count)

    def test_three_clients_exchange_persistent_room_messages(self) -> None:
        artifact_body = b"SharedNet V1 artifact from runtime A.\n"
        expected_artifact_sha256 = (
            "d7b11f2a9be93a36fa39a6fe3785d09e3833b9e608466cd859fb0c8bead21254"
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            database_path = root / "sharednet.sqlite3"
            blob_path = root / "blobs"
            source_path = root / "design-brief.txt"
            source_path.write_bytes(artifact_body)

            with _LiveRoomServer(database_path, blob_path) as first_server:
                client_a, token_a = _register(first_server.url, IDENTITY_A)
                client_b, token_b = _register(first_server.url, IDENTITY_B)
                client_c, token_c = _register(first_server.url, IDENTITY_C)

                room = client_a.build_room(
                    "SharedNet V1 design",
                    "Three independently identified Codex runtimes collaborate here.",
                )
                room_id = room["room_id"]
                self.assertEqual(room["creator"], IDENTITY_A)
                self.assertEqual(room["status"], "open")
                self.assertEqual(client_b.list_rooms(), {"rooms": []})
                self.assertEqual(client_c.list_rooms(), {"rooms": []})

                artifact = client_a.upload_artifact(
                    room_id,
                    source_path,
                    media_type="text/plain",
                )
                self.assertEqual(artifact["filename"], "design-brief.txt")
                self.assertEqual(artifact["media_type"], "text/plain")
                self.assertEqual(artifact["size_bytes"], 38)
                self.assertEqual(artifact["sha256"], expected_artifact_sha256)

                first = client_a.post_message(
                    room_id,
                    "Runtime A posted the design brief for review.",
                    attachment_ids=[artifact["artifact_id"]],
                )
                self.assertEqual(first["sequence"], 1)
                self.assertEqual(first["sender"], IDENTITY_A)
                self.assertEqual(first["reply_to"], None)
                self.assertEqual(first["attachment_ids"], [artifact["artifact_id"]])

                membership_b = client_b.join_room(room_id)
                self.assertEqual(client_b.join_room(room_id), membership_b)
                membership_c = client_c.join_room(room_id)
                self.assertEqual(client_c.join_room(room_id), membership_c)
                self.assertEqual(membership_b["agent_id"], IDENTITY_B["agent_id"])
                self.assertEqual(membership_c["agent_id"], IDENTITY_C["agent_id"])

                room_view = client_a.get_room(room_id)
                memberships = room_view["memberships"]
                self.assertEqual(len(memberships), 3)
                self.assertEqual(
                    {
                        (item["principal_id"], item["agent_id"], item["status"])
                        for item in memberships
                    },
                    {
                        (
                            IDENTITY_A["principal_id"],
                            IDENTITY_A["agent_id"],
                            "active",
                        ),
                        (
                            IDENTITY_B["principal_id"],
                            IDENTITY_B["agent_id"],
                            "active",
                        ),
                        (
                            IDENTITY_C["principal_id"],
                            IDENTITY_C["agent_id"],
                            "active",
                        ),
                    },
                )

                self.assert_summary(
                    client_b,
                    room_id,
                    status="open",
                    latest_cursor="cursor_1",
                    last_read_cursor="cursor_0",
                    unread_count=1,
                )
                self.assert_summary(
                    client_c,
                    room_id,
                    status="open",
                    latest_cursor="cursor_1",
                    last_read_cursor="cursor_0",
                    unread_count=1,
                )

                history_b = client_b.retrieve_messages(room_id)
                history_c = client_c.retrieve_messages(room_id)
                self.assertEqual(history_b["messages"], [first])
                self.assertEqual(history_b["next_cursor"], "cursor_1")
                self.assertEqual(history_c["messages"], [first])
                self.assertEqual(history_c["next_cursor"], "cursor_1")
                self.assert_summary(
                    client_c,
                    room_id,
                    status="open",
                    latest_cursor="cursor_1",
                    last_read_cursor="cursor_1",
                    unread_count=0,
                )

                second = client_b.post_message(
                    room_id,
                    "Runtime B reviewed the brief and approves the direction.",
                    reply_to=first["message_id"],
                )
                self.assertEqual(second["sequence"], 2)
                self.assertEqual(second["sender"], IDENTITY_B)
                self.assertEqual(second["reply_to"], first["message_id"])
                self.assert_summary(
                    client_c,
                    room_id,
                    status="open",
                    latest_cursor="cursor_2",
                    last_read_cursor="cursor_1",
                    unread_count=1,
                )

                new_for_c = client_c.retrieve_messages(
                    room_id,
                    after_cursor="cursor_1",
                )
                self.assertEqual(new_for_c["messages"], [second])
                self.assertEqual(new_for_c["next_cursor"], "cursor_2")
                self.assert_summary(
                    client_c,
                    room_id,
                    status="open",
                    latest_cursor="cursor_2",
                    last_read_cursor="cursor_2",
                    unread_count=0,
                )

                third = client_c.post_message(
                    room_id,
                    "Runtime C incorporated Runtime B's review.",
                    reply_to=second["message_id"],
                )
                self.assertEqual(third["sequence"], 3)
                self.assertEqual(third["sender"], IDENTITY_C)
                self.assertEqual(third["reply_to"], second["message_id"])

                history_a = client_a.retrieve_messages(room_id)
                self.assertEqual(
                    [message["message_id"] for message in history_a["messages"]],
                    [first["message_id"], second["message_id"], third["message_id"]],
                )
                self.assertEqual(
                    [message["sequence"] for message in history_a["messages"]],
                    [1, 2, 3],
                )
                self.assertEqual(
                    [message["sender"] for message in history_a["messages"]],
                    [IDENTITY_A, IDENTITY_B, IDENTITY_C],
                )
                self.assertEqual(
                    [message["reply_to"] for message in history_a["messages"]],
                    [None, first["message_id"], second["message_id"]],
                )
                self.assertEqual(history_a["next_cursor"], "cursor_3")
                self.assert_summary(
                    client_a,
                    room_id,
                    status="open",
                    latest_cursor="cursor_3",
                    last_read_cursor="cursor_3",
                    unread_count=0,
                )
                self.assert_summary(
                    client_b,
                    room_id,
                    status="open",
                    latest_cursor="cursor_3",
                    last_read_cursor="cursor_1",
                    unread_count=2,
                )
                self.assert_summary(
                    client_c,
                    room_id,
                    status="open",
                    latest_cursor="cursor_3",
                    last_read_cursor="cursor_2",
                    unread_count=1,
                )

                closed_room = client_a.close_room(room_id)
                self.assertEqual(closed_room["status"], "closed")
                with self.assertRaises(RoomError) as caught:
                    client_b.post_message(room_id, "This must remain blocked.")
                self.assertEqual(caught.exception.code, "room_closed")
                self.assertEqual(caught.exception.status_code, 409)

            with _LiveRoomServer(database_path, blob_path) as restarted_server:
                restarted_a = RoomClient(restarted_server.url, token_a)
                restarted_b = RoomClient(restarted_server.url, token_b)
                restarted_c = RoomClient(restarted_server.url, token_c)

                for client in (restarted_a, restarted_b, restarted_c):
                    self.assertEqual(client.get_room(room_id)["room"]["status"], "closed")

                self.assert_summary(
                    restarted_a,
                    room_id,
                    status="closed",
                    latest_cursor="cursor_3",
                    last_read_cursor="cursor_3",
                    unread_count=0,
                )
                self.assert_summary(
                    restarted_b,
                    room_id,
                    status="closed",
                    latest_cursor="cursor_3",
                    last_read_cursor="cursor_1",
                    unread_count=2,
                )
                self.assert_summary(
                    restarted_c,
                    room_id,
                    status="closed",
                    latest_cursor="cursor_3",
                    last_read_cursor="cursor_2",
                    unread_count=1,
                )

                expected_messages = [first, second, third]
                for client in (restarted_a, restarted_b, restarted_c):
                    page = client.retrieve_messages(
                        room_id,
                        after_cursor="cursor_0",
                    )
                    self.assertEqual(page["messages"], expected_messages)
                    self.assertEqual(page["next_cursor"], "cursor_3")

                for label, client in (
                    ("a", restarted_a),
                    ("b", restarted_b),
                    ("c", restarted_c),
                ):
                    destination = root / f"downloaded-by-{label}.txt"
                    receipt = client.download_artifact(
                        room_id,
                        artifact["artifact_id"],
                        destination,
                    )
                    self.assertEqual(destination.read_bytes(), artifact_body)
                    self.assertEqual(receipt["size_bytes"], 38)
                    self.assertEqual(receipt["sha256"], expected_artifact_sha256)
                    self.assertEqual(receipt["media_type"], "text/plain")


if __name__ == "__main__":
    unittest.main()
