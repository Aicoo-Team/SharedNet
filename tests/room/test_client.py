"""Security and integration contracts for the stdlib Room client."""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import socket
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse, Response, StreamingResponse
import uvicorn

from sharednet.room.api import create_room_app
from sharednet.room.client import RoomClient, RoomSessionFile
from sharednet.room.errors import RoomError


class LiveServer:
    """Run one real Uvicorn server on an OS-assigned loopback socket."""

    def __init__(self, app: FastAPI) -> None:
        self.app = app
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen(128)
        self.port = self.socket.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        config = uvicorn.Config(
            app,
            log_level="critical",
            lifespan="on",
            access_log=False,
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(
            target=self.server.run,
            kwargs={"sockets": [self.socket]},
            name=f"test-uvicorn-{self.port}",
            daemon=False,
        )

    def start(self) -> "LiveServer":
        self.thread.start()
        deadline = time.monotonic() + 5
        while not self.server.started and self.thread.is_alive():
            if time.monotonic() >= deadline:
                self.stop()
                raise AssertionError("Uvicorn did not become ready within five seconds")
            time.sleep(0.01)
        if not self.thread.is_alive():
            raise AssertionError("Uvicorn exited before becoming ready")
        return self

    def stop(self) -> None:
        self.server.should_exit = True
        if self.thread.ident is not None:
            self.thread.join(timeout=5)
            if self.thread.is_alive():
                raise AssertionError("Uvicorn did not stop within five seconds")
        try:
            self.socket.close()
        except OSError:
            pass

    def __enter__(self) -> "LiveServer":
        return self.start()

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.stop()


def room_server(root: Path, *, max_upload_bytes: int = 268_435_456) -> LiveServer:
    return LiveServer(
        create_room_app(
            root / "room.sqlite3",
            root / "blobs",
            max_upload_bytes,
        )
    )


class _TrackedFile:
    def __init__(self, stream) -> None:
        self.stream = stream
        self.read_sizes: list[int] = []

    def read(self, size: int = -1):
        self.read_sizes.append(size)
        if size < 0:
            raise AssertionError("upload attempted an unbounded read")
        return self.stream.read(size)

    def __enter__(self):
        self.stream.__enter__()
        return self

    def __exit__(self, exc_type, exc, traceback):
        return self.stream.__exit__(exc_type, exc, traceback)

    def __getattr__(self, name: str):
        return getattr(self.stream, name)


class RoomClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def register(
        self,
        base_url: str,
        principal_id: str = "principal_alice",
        agent_id: str = "agent_alpha",
        runtime_id: str = "runtime_alpha",
    ) -> tuple[RoomClient, dict[str, object]]:
        anonymous = RoomClient(base_url)
        result = anonymous.register_runtime(principal_id, agent_id, runtime_id)
        return RoomClient(base_url, result["runtime_token"]), result

    def test_real_server_client_covers_all_room_routes_and_stable_errors(self) -> None:
        with room_server(self.root) as server:
            self.assertEqual(RoomClient(server.url).health(), {"status": "ok"})
            owner, registration = self.register(server.url)
            peer, _ = self.register(
                server.url,
                "principal_bob",
                "agent_beta",
                "runtime_beta",
            )
            self.assertEqual(
                registration["registration"]["identity"]["runtime_id"],
                "runtime_alpha",
            )

            room = owner.build_room("Client integration", "All routes")
            room_id = room["room_id"]
            first_join = peer.join_room(room_id)
            self.assertEqual(peer.join_room(room_id), first_join)
            self.assertEqual(peer.list_rooms()["rooms"][0]["room_id"], room_id)
            self.assertEqual(peer.get_room(room_id)["room"]["room_id"], room_id)

            source = self.root / "artifact.bin"
            source.write_bytes(b"streamed artifact")
            artifact = owner.upload_artifact(room_id, source)
            message = owner.post_message(
                room_id,
                "Please verify",
                tags=["delegate-to:agent_beta"],
                attachment_ids=[artifact["artifact_id"]],
            )
            reply = peer.post_message(
                room_id,
                "Verified",
                reply_to=message["message_id"],
            )
            page = peer.retrieve_messages(room_id, after_cursor="cursor_1", limit=7)
            self.assertEqual([item["message_id"] for item in page["messages"]], [reply["message_id"]])
            self.assertEqual(page["next_cursor"], "cursor_2")
            resolved = peer.resolve_message(
                room_id,
                message["message_id"],
                "fulfilled",
                "checked bytes",
            )
            self.assertEqual(resolved["resolution_state"], "resolved")

            destination = self.root / "downloaded.bin"
            receipt = peer.download_artifact(
                room_id,
                artifact["artifact_id"],
                destination,
            )
            self.assertEqual(destination.read_bytes(), b"streamed artifact")
            self.assertEqual(receipt["sha256"], hashlib.sha256(b"streamed artifact").hexdigest())
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(peer.leave_room(room_id)["status"], "left")
            self.assertEqual(owner.close_room(room_id)["status"], "closed")

            with self.assertRaises(RoomError) as caught:
                peer.get_room("room_missing")
            self.assertEqual(
                (caught.exception.code, caught.exception.status_code),
                ("room_not_found", 404),
            )

    def test_base_url_and_timeout_validation_fail_closed(self) -> None:
        invalid_urls = (
            "ftp://127.0.0.1",
            "http://user:secret@127.0.0.1",
            "http://127.0.0.1/path",
            "http://127.0.0.1?query=yes",
            "http://127.0.0.1#fragment",
            "http://",
        )
        for value in invalid_urls:
            with self.subTest(value=value), self.assertRaises(RoomError) as caught:
                RoomClient(value)
            self.assertEqual(caught.exception.code, "invalid_base_url")
        with self.assertRaises(RoomError) as caught:
            RoomClient("http://127.0.0.1", timeout=0)
        self.assertEqual(caught.exception.code, "invalid_timeout")
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(timeout=value):
                with self.assertRaises(RoomError) as caught:
                    RoomClient("http://127.0.0.1", timeout=value)
                self.assertEqual(caught.exception.code, "invalid_timeout")
        with self.assertRaises(RoomError) as caught:
            RoomClient("http://127.0.0.1", token="tökén")
        self.assertEqual(caught.exception.code, "invalid_runtime_token")

    def test_path_segments_and_cursor_query_are_percent_encoded(self) -> None:
        observed: list[tuple[bytes, bytes]] = []
        app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

        @app.middleware("http")
        async def record_request(request: Request, call_next):
            observed.append((request.scope["raw_path"], request.scope["query_string"]))
            return await call_next(request)

        @app.get("/{rest:path}")
        async def any_get(rest: str):
            if rest.endswith("messages"):
                return {"messages": [], "next_cursor": "cursor_0"}
            return {"room": {}, "memberships": []}

        with LiveServer(app) as server:
            client = RoomClient(server.url, "test-token")
            client.get_room("room/with ?#")
            client.retrieve_messages(
                "room/with ?#",
                after_cursor="cursor_1 +?",
                limit=9,
            )

        self.assertEqual(observed[0][0], b"/v1/rooms/room%2Fwith%20%3F%23")
        self.assertEqual(observed[1][0], b"/v1/rooms/room%2Fwith%20%3F%23/messages")
        self.assertEqual(observed[1][1], b"after_cursor=cursor_1+%2B%3F&limit=9")

    def test_redirect_is_refused_without_disclosing_bearer_to_target(self) -> None:
        target_requests: list[str | None] = []
        target_app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

        @target_app.get("/capture")
        def capture(request: Request):
            target_requests.append(request.headers.get("authorization"))
            return {"rooms": []}

        with LiveServer(target_app) as target:
            redirect_app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

            @redirect_app.get("/v1/rooms")
            def redirect():
                return RedirectResponse(f"{target.url}/capture", status_code=307)

            with LiveServer(redirect_app) as origin:
                with self.assertRaises(RoomError) as caught:
                    RoomClient(origin.url, "top-secret").list_rooms()

        self.assertEqual(caught.exception.code, "redirect_refused")
        self.assertEqual(target_requests, [])

    def test_registration_never_attaches_an_existing_bearer_token(self) -> None:
        observed_authorization: list[str | None] = []
        app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

        @app.post("/v1/runtimes/register", status_code=201)
        def register(request: Request):
            observed_authorization.append(request.headers.get("authorization"))
            return {
                "registration": {
                    "identity": {
                        "principal_id": "principal_a",
                        "agent_id": "agent_a",
                        "runtime_id": "runtime_a",
                    },
                    "created_at": "2026-09-01T00:00:00+00:00",
                },
                "runtime_token": "new-token",
            }

        with LiveServer(app) as server:
            result = RoomClient(server.url, "old-token").register_runtime(
                "principal_a", "agent_a", "runtime_a"
            )

        self.assertEqual(result["runtime_token"], "new-token")
        self.assertEqual(observed_authorization, [None])

    def test_environment_proxy_is_never_used(self) -> None:
        proxy_requests: list[str] = []
        proxy_app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

        @proxy_app.api_route("/{rest:path}", methods=["GET", "POST", "DELETE"])
        def proxy(rest: str):
            proxy_requests.append(rest)
            return Response(status_code=502)

        with room_server(self.root) as origin, LiveServer(proxy_app) as proxy:
            with patch.dict(
                os.environ,
                {
                    "HTTP_PROXY": proxy.url,
                    "http_proxy": proxy.url,
                    "NO_PROXY": "",
                    "no_proxy": "",
                },
                clear=False,
            ):
                client, _ = self.register(origin.url)
                self.assertEqual(client.list_rooms(), {"rooms": []})

        self.assertEqual(proxy_requests, [])

    def test_upload_uses_fixed_length_and_only_bounded_reads(self) -> None:
        observed_lengths: list[str | None] = []
        app = create_room_app(self.root / "room.sqlite3", self.root / "blobs")

        @app.middleware("http")
        async def observe_length(request: Request, call_next):
            if request.url.path.endswith("/artifacts"):
                observed_lengths.append(request.headers.get("content-length"))
            return await call_next(request)

        source = self.root / "large.bin"
        content = os.urandom(300_000)
        source.write_bytes(content)
        original_open = Path.open
        tracked: list[_TrackedFile] = []

        def tracking_open(path: Path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            if path == source and (not args or "r" in args[0]):
                wrapped = _TrackedFile(stream)
                tracked.append(wrapped)
                return wrapped
            return stream

        with LiveServer(app) as server:
            client, _ = self.register(server.url)
            room = client.build_room("Streaming")
            with patch.object(Path, "open", tracking_open):
                artifact = client.upload_artifact(room["room_id"], source)

        self.assertEqual(artifact["size_bytes"], len(content))
        self.assertEqual(observed_lengths, [str(len(content))])
        self.assertTrue(tracked)
        self.assertTrue(tracked[0].read_sizes)
        self.assertNotIn(-1, tracked[0].read_sizes)

    def test_download_corruption_never_replaces_or_leaves_temporary_file(self) -> None:
        content = b"corrupt in transit"
        app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

        @app.get("/v1/rooms/{room_id}/artifacts/{artifact_id}")
        def bad_download(room_id: str, artifact_id: str):
            return Response(
                content,
                media_type="application/octet-stream",
                headers={
                    "Content-Length": str(len(content)),
                    "X-Content-SHA256": "0" * 64,
                },
            )

        destination = self.root / "keep.bin"
        destination.write_bytes(b"existing")
        with LiveServer(app) as server:
            client = RoomClient(server.url, "token")
            with self.assertRaises(RoomError) as caught:
                client.download_artifact("room_a", "artifact_a", destination, force=True)

        self.assertEqual(caught.exception.code, "download_integrity_error")
        self.assertEqual(destination.read_bytes(), b"existing")
        self.assertEqual(list(self.root.glob(".keep.bin.*.tmp")), [])

    def test_interrupted_download_is_a_stable_error_and_cleans_temporary_file(self) -> None:
        app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
        expected = b"first chunksecond chunk"

        def interrupted():
            yield b"first chunk"
            raise RuntimeError("simulated broken response")

        @app.get("/v1/rooms/{room_id}/artifacts/{artifact_id}")
        def broken_download(room_id: str, artifact_id: str):
            return StreamingResponse(
                interrupted(),
                headers={
                    "Content-Length": str(len(expected)),
                    "X-Content-SHA256": hashlib.sha256(expected).hexdigest(),
                },
            )

        destination = self.root / "interrupted.bin"
        with LiveServer(app) as server:
            with self.assertRaises(RoomError) as caught:
                RoomClient(server.url, "token").download_artifact(
                    "room_a", "artifact_a", destination
                )

        self.assertEqual(caught.exception.code, "download_transfer_error")
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".interrupted.bin.*.tmp")), [])

    def test_download_refuses_overwrite_without_issuing_request(self) -> None:
        requests: list[str] = []
        app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

        @app.get("/v1/rooms/{room_id}/artifacts/{artifact_id}")
        def download(room_id: str, artifact_id: str):
            requests.append(artifact_id)
            content = b"new"
            return Response(
                content,
                headers={
                    "Content-Length": str(len(content)),
                    "X-Content-SHA256": hashlib.sha256(content).hexdigest(),
                },
            )

        destination = self.root / "existing.bin"
        destination.write_bytes(b"old")
        with LiveServer(app) as server:
            with self.assertRaises(RoomError) as caught:
                RoomClient(server.url, "token").download_artifact(
                    "room_a", "artifact_a", destination
                )

        self.assertEqual(caught.exception.code, "destination_exists")
        self.assertEqual(requests, [])
        self.assertEqual(destination.read_bytes(), b"old")


class RoomSessionFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.path = self.root / ".sharednet" / "room-session.json"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_session_round_trip_is_atomic_owner_only_and_exact(self) -> None:
        session_file = RoomSessionFile(self.path)
        identity = {
            "principal_id": "principal_alice",
            "agent_id": "agent_alpha",
            "runtime_id": "runtime_alpha",
        }
        session_file.save("http://127.0.0.1:8765", "secret-token", identity)

        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(
            json.loads(self.path.read_text(encoding="utf-8")),
            {
                "base_url": "http://127.0.0.1:8765",
                "runtime_token": "secret-token",
                "identity": identity,
            },
        )
        loaded = session_file.load()
        self.assertEqual(loaded.base_url, "http://127.0.0.1:8765")
        self.assertEqual(loaded.runtime_token, "secret-token")
        self.assertEqual(loaded.identity, identity)
        self.assertEqual(list(self.path.parent.glob(".room-session.json.*.tmp")), [])

    def test_session_rejects_symlink_nonregular_permissive_and_malformed_files(self) -> None:
        self.path.parent.mkdir(parents=True)
        valid = json.dumps(
            {
                "base_url": "http://127.0.0.1:8765",
                "runtime_token": "secret-token",
                "identity": {
                    "principal_id": "principal_alice",
                    "agent_id": "agent_alpha",
                    "runtime_id": "runtime_alpha",
                },
            }
        )
        cases: list[tuple[str, callable]] = []

        def permissive() -> None:
            self.path.write_text(valid, encoding="utf-8")
            self.path.chmod(0o644)

        cases.append(("insecure_session_permissions", permissive))

        def malformed() -> None:
            self.path.write_text("{}", encoding="utf-8")
            self.path.chmod(0o600)

        cases.append(("invalid_session", malformed))

        def directory() -> None:
            self.path.mkdir()

        cases.append(("invalid_session_file", directory))

        def symlink() -> None:
            target = self.root / "target.json"
            target.write_text(valid, encoding="utf-8")
            target.chmod(0o600)
            self.path.symlink_to(target)

        cases.append(("invalid_session_file", symlink))

        if hasattr(os, "mkfifo"):
            def fifo() -> None:
                os.mkfifo(self.path, mode=0o600)

            cases.append(("invalid_session_file", fifo))

        for expected_code, setup in cases:
            with self.subTest(expected_code=expected_code):
                if os.path.lexists(self.path) and not self.path.is_dir():
                    self.path.unlink()
                elif self.path.exists():
                    self.path.rmdir()
                setup()
                with self.assertRaises(RoomError) as caught:
                    RoomSessionFile(self.path).load()
                self.assertEqual(caught.exception.code, expected_code)


if __name__ == "__main__":
    unittest.main()
