"""HTTP contract tests for the local SharedNet Room API."""

from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from urllib.parse import quote

from fastapi.testclient import TestClient

from sharednet.room.api import _ClosingStreamingResponse, create_room_app


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class _TrackedBytesIO(BytesIO):
    def __init__(self, content: bytes) -> None:
        super().__init__(content)
        self.was_closed = False
        self.read_sizes: list[int] = []

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return super().read(size)

    def close(self) -> None:
        self.was_closed = True
        super().close()


class RoomApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self.temporary_directory.name)
        self.database_path = root / "room.sqlite3"
        self.blob_path = root / "blobs"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def app(self, max_upload_bytes: int = 268_435_456):
        return create_room_app(
            self.database_path,
            self.blob_path,
            max_upload_bytes,
            enable_legacy_registration=True,
        )

    def register(
        self,
        client: TestClient,
        principal_id: str,
        agent_id: str,
        runtime_id: str,
    ) -> tuple[dict[str, object], str]:
        response = client.post(
            "/v1/runtimes/register",
            json={
                "principal_id": principal_id,
                "agent_id": agent_id,
                "requested_runtime_id": runtime_id,
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        body = response.json()
        return body["registration"], body["runtime_token"]

    def build_room(
        self,
        client: TestClient,
        token: str,
        *,
        name: str = "Product design",
        description: str | None = None,
        access_policy: str = "anyone_with_id",
    ) -> dict[str, object]:
        response = client.post(
            "/v1/rooms",
            headers=auth(token),
            json={
                "name": name,
                "description": description,
                "access_policy": access_policy,
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def assert_error(
        self,
        response,
        status_code: int,
        code: str,
        message: str,
    ) -> None:
        self.assertEqual(response.status_code, status_code, response.text)
        self.assertEqual(response.json(), {"error": {"code": code, "message": message}})

    def test_app_exposes_exact_frozen_route_and_method_table(self) -> None:
        expected = {
            ("GET", "/healthz"),
            ("POST", "/v1/pairings"),
            ("POST", "/v1/pairings/{pairing_id}/exchange"),
            ("POST", "/v1/local/agents"),
            ("POST", "/v1/local/runtimes"),
            ("POST", "/v1/local/instances"),
            ("POST", "/v1/local/instances/current/heartbeat"),
            ("POST", "/v1/local/instances/current/end"),
            ("POST", "/v1/decisions"),
            ("GET", "/v1/decisions/{decision_id}"),
            ("POST", "/v1/console/accounts/{auth_user_id}/provision"),
            ("POST", "/v1/console/accounts/{auth_user_id}/demo-seed"),
            ("POST", "/v1/console/accounts/{auth_user_id}/pairings/{pairing_id}/claim"),
            ("GET", "/v1/console/accounts/{auth_user_id}/rooms"),
            ("GET", "/v1/console/accounts/{auth_user_id}/rooms/{room_id}"),
            ("GET", "/v1/console/accounts/{auth_user_id}/network"),
            ("GET", "/v1/console/accounts/{auth_user_id}/decisions"),
            ("POST", "/v1/console/accounts/{auth_user_id}/decisions/{decision_id}/resolve"),
            ("POST", "/v1/runtimes/register"),
            ("POST", "/v1/rooms"),
            ("POST", "/v1/rooms/{room_id}/memberships"),
            ("GET", "/v1/rooms"),
            ("GET", "/v1/rooms/{room_id}"),
            ("DELETE", "/v1/rooms/{room_id}/membership"),
            ("POST", "/v1/rooms/{room_id}/close"),
            ("POST", "/v1/rooms/{room_id}/messages"),
            ("GET", "/v1/rooms/{room_id}/messages"),
            ("POST", "/v1/rooms/{room_id}/messages/{message_id}/resolve"),
            ("POST", "/v1/rooms/{room_id}/artifacts"),
            ("GET", "/v1/rooms/{room_id}/artifacts/{artifact_id}"),
        }
        app = self.app()
        with TestClient(app):
            actual = {
                (method, route.path)
                for route in app.routes
                for method in getattr(route, "methods", ())
            }
        self.assertEqual(actual, expected)

    def test_protected_json_routes_authenticate_before_malformed_body(self) -> None:
        with TestClient(self.app()) as client:
            _, valid_token = self.register(
                client, "principal_alice", "agent_alpha", "runtime_alpha"
            )
            protected_routes = (
                "/v1/rooms",
                "/v1/rooms/room_missing/messages",
                "/v1/rooms/room_missing/messages/message_missing/resolve",
            )
            invalid_credentials = (
                {},
                {"Authorization": "Basic malformed"},
                auth("unknown-token"),
            )
            for route in protected_routes:
                for credentials in invalid_credentials:
                    with self.subTest(route=route, credentials=credentials):
                        response = client.post(
                            route,
                            headers={**credentials, "Content-Type": "application/json"},
                            content=b'{"malformed":',
                        )
                        self.assertEqual(response.status_code, 401, response.text)
                        self.assertIn(
                            response.json()["error"]["code"],
                            {"invalid_instance_token", "invalid_runtime_token"},
                        )
                        self.assertEqual(response.headers["www-authenticate"], "Bearer")

            accepted_auth = client.post(
                "/v1/rooms",
                headers={**auth(valid_token), "Content-Type": "application/json"},
                content=b'{"malformed":',
            )
            self.assert_error(
                accepted_auth,
                400,
                "invalid_request",
                "request validation failed",
            )

    def test_invalid_utf8_json_uses_stable_validation_error(self) -> None:
        with TestClient(self.app()) as client:
            invalid_registration = client.post(
                "/v1/runtimes/register",
                headers={"Content-Type": "application/json"},
                content=b'{"principal_id":"principal_\xff","agent_id":"agent_bad"}',
            )
            self.assert_error(
                invalid_registration,
                400,
                "invalid_request",
                "request validation failed",
            )

            _, token = self.register(
                client, "principal_alice", "agent_alpha", "runtime_alpha"
            )
            invalid_protected_body = client.post(
                "/v1/rooms",
                headers={**auth(token), "Content-Type": "application/json"},
                content=b'{"name":"\xff"}',
            )
            self.assert_error(
                invalid_protected_body,
                400,
                "invalid_request",
                "request validation failed",
            )

    def test_health_registration_validation_and_bearer_contract(self) -> None:
        with TestClient(self.app()) as client:
            health = client.get("/healthz")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(health.json(), {"status": "ok"})

            registration, token = self.register(
                client, "principal_alice", "agent_alpha", "runtime_alpha"
            )
            self.assertEqual(
                registration["identity"],
                {
                    "principal_id": "principal_alice",
                    "agent_id": "agent_alpha",
                    "runtime_id": "runtime_alpha",
                },
            )
            self.assertIsInstance(registration["created_at"], str)
            self.assertIsInstance(token, str)
            self.assertNotEqual(token, "")

            conflict = client.post(
                "/v1/runtimes/register",
                json={
                    "principal_id": "principal_alice",
                    "agent_id": "agent_other",
                    "requested_runtime_id": "runtime_alpha",
                },
            )
            self.assert_error(
                conflict,
                409,
                "runtime_id_conflict",
                "runtime_id is already registered",
            )

            invalid_registration = client.post(
                "/v1/runtimes/register",
                json={"principal_id": 4, "agent_id": "agent_x", "sender": "forged"},
            )
            self.assert_error(
                invalid_registration,
                400,
                "invalid_request",
                "request validation failed",
            )

            malformed_json = client.post(
                "/v1/runtimes/register",
                headers={"Content-Type": "application/json"},
                content=b'{"principal_id":',
            )
            self.assert_error(
                malformed_json,
                400,
                "invalid_request",
                "request validation failed",
            )

            wrong_content_type = client.post(
                "/v1/runtimes/register",
                headers={"Content-Type": "text/plain"},
                content=b'{"principal_id":"principal_x","agent_id":"agent_x"}',
            )
            self.assert_error(
                wrong_content_type,
                400,
                "invalid_request",
                "request validation failed",
            )

            for headers in (
                {},
                {"Authorization": "Basic abc"},
                {"Authorization": "Bearer"},
                {"Authorization": "Bearer one two"},
                {"Authorization": "bearer abc"},
                auth("unknown-token"),
            ):
                response = client.get("/v1/rooms", headers=headers)
                self.assertEqual(response.status_code, 401, response.text)
                self.assertIn(
                    response.json()["error"]["code"],
                    {"invalid_instance_token", "invalid_runtime_token"},
                )
                self.assertEqual(response.headers["www-authenticate"], "Bearer")

            accepted = client.get("/v1/rooms", headers=auth(token))
            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(accepted.json(), {"rooms": []})

    def test_room_routes_envelopes_access_and_lifecycle_errors(self) -> None:
        with TestClient(self.app()) as client:
            _, owner_token = self.register(
                client, "principal_alice", "agent_alpha", "runtime_alpha"
            )
            _, peer_token = self.register(
                client, "principal_bob", "agent_beta", "runtime_beta"
            )
            _, outsider_token = self.register(
                client, "principal_carol", "agent_gamma", "runtime_gamma"
            )

            room = self.build_room(client, owner_token, description="Coordinate the launch")
            room_id = room["room_id"]
            self.assertEqual(room["name"], "Product design")
            self.assertEqual(room["status"], "open")

            forged = client.post(
                "/v1/rooms",
                headers=auth(peer_token),
                json={"name": "Forged", "creator": {"agent_id": "agent_alpha"}},
            )
            self.assert_error(
                forged, 400, "invalid_request", "request validation failed"
            )

            denied_get = client.get(f"/v1/rooms/{room_id}", headers=auth(peer_token))
            self.assert_error(
                denied_get,
                403,
                "not_a_room_member",
                "active room membership is required",
            )

            join = client.post(
                f"/v1/rooms/{room_id}/memberships", headers=auth(peer_token)
            )
            self.assertEqual(join.status_code, 200)
            self.assertEqual(join.json()["agent_id"], "agent_beta")
            repeated = client.post(
                f"/v1/rooms/{room_id}/memberships", headers=auth(peer_token)
            )
            self.assertEqual(repeated.status_code, 200)
            self.assertEqual(repeated.json(), join.json())

            listed = client.get("/v1/rooms", headers=auth(peer_token))
            self.assertEqual(listed.status_code, 200)
            self.assertEqual(len(listed.json()["rooms"]), 1)
            self.assertEqual(listed.json()["rooms"][0]["room_id"], room_id)

            detail = client.get(f"/v1/rooms/{room_id}", headers=auth(owner_token))
            self.assertEqual(detail.status_code, 200)
            self.assertEqual(detail.json()["room"], room)
            self.assertEqual(
                {membership["agent_id"] for membership in detail.json()["memberships"]},
                {"agent_alpha", "agent_beta"},
            )

            missing = client.get("/v1/rooms/room_missing", headers=auth(owner_token))
            self.assert_error(
                missing, 404, "room_not_found", "room does not exist"
            )

            private_room = self.build_room(
                client,
                owner_token,
                name="Private",
                access_policy="principal_only",
            )
            denied_join = client.post(
                f"/v1/rooms/{private_room['room_id']}/memberships",
                headers=auth(outsider_token),
            )
            self.assert_error(
                denied_join,
                403,
                "room_access_denied",
                "room is restricted to the creator principal",
            )

            not_owner = client.post(
                f"/v1/rooms/{room_id}/close", headers=auth(peer_token)
            )
            self.assert_error(
                not_owner,
                403,
                "room_owner_required",
                "only the creator agent may close the room",
            )

            left = client.delete(
                f"/v1/rooms/{room_id}/membership", headers=auth(peer_token)
            )
            self.assertEqual(left.status_code, 200)
            self.assertEqual(left.json()["status"], "left")
            active_again = client.post(
                f"/v1/rooms/{room_id}/memberships", headers=auth(peer_token)
            )
            self.assertEqual(active_again.status_code, 200)
            self.assertEqual(active_again.json()["status"], "active")

            closed = client.post(f"/v1/rooms/{room_id}/close", headers=auth(owner_token))
            self.assertEqual(closed.status_code, 200)
            self.assertEqual(closed.json()["status"], "closed")
            repeated_close = client.post(
                f"/v1/rooms/{room_id}/close", headers=auth(owner_token)
            )
            self.assert_error(
                repeated_close, 409, "room_closed", "room is already closed"
            )
            blocked_leave = client.delete(
                f"/v1/rooms/{room_id}/membership", headers=auth(peer_token)
            )
            self.assert_error(blocked_leave, 409, "room_closed", "room is closed")
            closed_detail = client.get(
                f"/v1/rooms/{room_id}", headers=auth(peer_token)
            )
            self.assertEqual(closed_detail.status_code, 200)

    def test_message_reply_cursor_tag_resolution_and_sender_provenance(self) -> None:
        with TestClient(self.app()) as client:
            _, owner_token = self.register(
                client, "principal_alice", "agent_alpha", "runtime_alpha"
            )
            _, peer_token = self.register(
                client, "principal_bob", "agent_beta", "runtime_beta"
            )
            _, outsider_token = self.register(
                client, "principal_carol", "agent_gamma", "runtime_gamma"
            )
            room = self.build_room(client, owner_token)
            room_id = room["room_id"]
            client.post(f"/v1/rooms/{room_id}/memberships", headers=auth(peer_token))

            forged = client.post(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(peer_token),
                json={
                    "content": "I am Alice",
                    "sender": {
                        "principal_id": "principal_alice",
                        "agent_id": "agent_alpha",
                        "runtime_id": "runtime_alpha",
                    },
                },
            )
            self.assert_error(
                forged, 400, "invalid_request", "request validation failed"
            )

            first = client.post(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(owner_token),
                json={"content": "Please verify", "tags": ["verification-required"]},
            )
            self.assertEqual(first.status_code, 201, first.text)
            first_message = first.json()
            self.assertEqual(
                first_message["sender"],
                {
                    "principal_id": "principal_alice",
                    "agent_id": "agent_alpha",
                    "runtime_id": "runtime_alpha",
                    "instance_id": first_message["sender"]["instance_id"],
                },
            )
            self.assertRegex(
                first_message["sender"]["instance_id"],
                r"^i_[0-9A-Za-z]{10}$",
            )
            self.assertEqual(first_message["resolution_state"], "pending")

            second = client.post(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(peer_token),
                json={
                    "content": "Replying",
                    "reply_to": first_message["message_id"],
                    "attachment_ids": [],
                },
            )
            self.assertEqual(second.status_code, 201, second.text)
            self.assertEqual(second.json()["reply_to"], first_message["message_id"])

            page_one = client.get(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(peer_token),
                params={"limit": 1},
            )
            self.assertEqual(page_one.status_code, 200)
            self.assertEqual(
                page_one.json(),
                {"messages": [first_message], "next_cursor": "cursor_1"},
            )
            page_two = client.get(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(peer_token),
                params={"after_cursor": page_one.json()["next_cursor"], "limit": 10},
            )
            self.assertEqual(page_two.status_code, 200)
            self.assertEqual(page_two.json()["messages"], [second.json()])
            self.assertEqual(page_two.json()["next_cursor"], "cursor_2")

            invalid_cursor = client.get(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(owner_token),
                params={"after_cursor": "1"},
            )
            self.assert_error(
                invalid_cursor,
                400,
                "invalid_cursor",
                "cursor must be formatted cursor_<integer>",
            )
            invalid_limit = client.get(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(owner_token),
                params={"limit": 101},
            )
            self.assert_error(
                invalid_limit,
                400,
                "invalid_limit",
                "limit must be between 1 and 100",
            )
            invalid_tag = client.post(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(owner_token),
                json={"content": "Bad tag", "tags": ["unknown"]},
            )
            self.assert_error(
                invalid_tag, 400, "invalid_tag", "tag is not supported"
            )
            invalid_reply = client.post(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(owner_token),
                json={"content": "Bad reply", "reply_to": "message_missing"},
            )
            self.assert_error(
                invalid_reply,
                400,
                "invalid_reply",
                "reply must reference a message in the same room",
            )

            unauthorized_resolution = client.post(
                f"/v1/rooms/{room_id}/messages/{first_message['message_id']}/resolve",
                headers=auth(owner_token),
                json={"outcome": "fulfilled", "evidence": "self-approved"},
            )
            self.assert_error(
                unauthorized_resolution,
                403,
                "resolver_not_authorized",
                "resolver is not authorized for a pending obligation",
            )
            no_membership = client.post(
                f"/v1/rooms/{room_id}/messages/{first_message['message_id']}/resolve",
                headers=auth(outsider_token),
                json={"outcome": "fulfilled"},
            )
            self.assert_error(
                no_membership,
                403,
                "not_a_room_member",
                "active room membership is required",
            )
            resolved = client.post(
                f"/v1/rooms/{room_id}/messages/{first_message['message_id']}/resolve",
                headers=auth(peer_token),
                json={"outcome": "fulfilled", "evidence": "checked"},
            )
            self.assertEqual(resolved.status_code, 200)
            self.assertEqual(resolved.json()["resolution_state"], "resolved")
            resolved_again = client.post(
                f"/v1/rooms/{room_id}/messages/{first_message['message_id']}/resolve",
                headers=auth(peer_token),
                json={"outcome": "fulfilled"},
            )
            self.assert_error(
                resolved_again,
                409,
                "message_already_resolved",
                "message resolution is already terminal",
            )

            client.post(f"/v1/rooms/{room_id}/close", headers=auth(owner_token))
            blocked_post = client.post(
                f"/v1/rooms/{room_id}/messages",
                headers=auth(peer_token),
                json={"content": "Too late"},
            )
            self.assert_error(blocked_post, 409, "room_closed", "room is closed")
            retained = client.get(
                f"/v1/rooms/{room_id}/messages", headers=auth(peer_token)
            )
            self.assertEqual(retained.status_code, 200)
            self.assertEqual(len(retained.json()["messages"]), 2)

    def test_raw_upload_download_headers_limits_and_closed_room_behavior(self) -> None:
        with TestClient(self.app(max_upload_bytes=8)) as client:
            _, owner_token = self.register(
                client, "principal_alice", "agent_alpha", "runtime_alpha"
            )
            _, peer_token = self.register(
                client, "principal_bob", "agent_beta", "runtime_beta"
            )
            room = self.build_room(client, owner_token)
            room_id = room["room_id"]
            client.post(f"/v1/rooms/{room_id}/memberships", headers=auth(peer_token))

            content = b"abc\x00def"
            filename = "r\u00e9sum\u00e9 #1.txt"
            uploaded = client.post(
                f"/v1/rooms/{room_id}/artifacts",
                headers={**auth(owner_token), "Content-Type": "text/plain; charset=utf-8"},
                params={"filename": filename},
                content=content,
            )
            self.assertEqual(uploaded.status_code, 201, uploaded.text)
            artifact = uploaded.json()
            self.assertEqual(artifact["filename"], filename)
            self.assertEqual(artifact["media_type"], "text/plain")
            self.assertEqual(artifact["size_bytes"], len(content))

            downloaded = client.get(
                f"/v1/rooms/{room_id}/artifacts/{artifact['artifact_id']}",
                headers=auth(peer_token),
            )
            self.assertEqual(downloaded.status_code, 200)
            self.assertEqual(downloaded.content, content)
            self.assertEqual(downloaded.headers["content-type"], "text/plain")
            self.assertEqual(downloaded.headers["content-length"], str(len(content)))
            self.assertEqual(downloaded.headers["x-content-sha256"], artifact["sha256"])
            self.assertEqual(
                downloaded.headers["content-disposition"],
                f"attachment; filename*=utf-8''{quote(filename, safe='')}",
            )
            self.assertNotIn(filename, downloaded.headers["content-disposition"])

            default_media = client.post(
                f"/v1/rooms/{room_id}/artifacts",
                headers=auth(owner_token),
                params={"filename": "binary.dat"},
                content=b"\x01\x02",
            )
            self.assertEqual(default_media.status_code, 201)
            self.assertEqual(default_media.json()["media_type"], "application/octet-stream")

            too_large = client.post(
                f"/v1/rooms/{room_id}/artifacts",
                headers={**auth(owner_token), "Content-Type": "application/octet-stream"},
                params={"filename": "large.bin"},
                content=b"123456789",
            )
            self.assert_error(
                too_large,
                413,
                "upload_too_large",
                "upload exceeds the configured size limit",
            )
            invalid_media = client.post(
                f"/v1/rooms/{room_id}/artifacts",
                headers={**auth(owner_token), "Content-Type": "not a media type"},
                params={"filename": "bad.bin"},
                content=b"",
            )
            self.assert_error(
                invalid_media,
                400,
                "invalid_media_type",
                "media_type must be an ASCII type/subtype",
            )
            missing_artifact = client.get(
                f"/v1/rooms/{room_id}/artifacts/artifact_missing",
                headers=auth(owner_token),
            )
            self.assert_error(
                missing_artifact,
                404,
                "artifact_not_found",
                "artifact does not exist in this room",
            )

            client.post(f"/v1/rooms/{room_id}/close", headers=auth(owner_token))
            blocked_upload = client.post(
                f"/v1/rooms/{room_id}/artifacts",
                headers=auth(owner_token),
                params={"filename": "late.bin"},
                content=b"late",
            )
            self.assert_error(blocked_upload, 409, "room_closed", "room is closed")
            retained_download = client.get(
                f"/v1/rooms/{room_id}/artifacts/{artifact['artifact_id']}",
                headers=auth(peer_token),
            )
            self.assertEqual(retained_download.status_code, 200)
            self.assertEqual(retained_download.content, content)

    def test_download_closes_stream_after_completion(self) -> None:
        app = self.app()
        with TestClient(app) as client:
            _, token = self.register(
                client, "principal_alice", "agent_alpha", "runtime_alpha"
            )
            room_id = self.build_room(client, token)["room_id"]
            upload = client.post(
                f"/v1/rooms/{room_id}/artifacts",
                headers=auth(token),
                params={"filename": "tracked.bin"},
                content=b"tracked",
            )
            artifact_id = upload.json()["artifact_id"]
            original_open_blob = app.state.blob_store.open_blob
            tracked: list[_TrackedBytesIO] = []

            def tracked_open_blob(sha256: str) -> _TrackedBytesIO:
                real_stream = original_open_blob(sha256)
                try:
                    stream = _TrackedBytesIO(real_stream.read())
                finally:
                    real_stream.close()
                tracked.append(stream)
                return stream

            app.state.blob_store.open_blob = tracked_open_blob
            response = client.get(
                f"/v1/rooms/{room_id}/artifacts/{artifact_id}", headers=auth(token)
            )
            self.assertEqual(response.content, b"tracked")
            self.assertEqual(len(tracked), 1)
            self.assertTrue(tracked[0].was_closed)
            self.assertEqual(tracked[0].read_sizes, [65_536, 65_536])

    def test_streaming_response_closes_binary_io_on_disconnect(self) -> None:
        stream = _TrackedBytesIO(b"x" * 70_000)
        response = _ClosingStreamingResponse(stream, media_type="application/octet-stream")
        sent: list[dict[str, object]] = []
        receive_count = 0

        async def receive() -> dict[str, object]:
            nonlocal receive_count
            receive_count += 1
            if receive_count == 1:
                return {"type": "http.request", "body": b"", "more_body": False}
            return {"type": "http.disconnect"}

        async def send(message: dict[str, object]) -> None:
            sent.append(message)

        asyncio.run(
            response(
                {
                    "type": "http",
                    "asgi": {"version": "3.0", "spec_version": "2.3"},
                    "http_version": "1.1",
                    "method": "GET",
                    "scheme": "http",
                    "path": "/artifact",
                    "raw_path": b"/artifact",
                    "query_string": b"",
                    "headers": [],
                    "client": ("127.0.0.1", 1),
                    "server": ("127.0.0.1", 2),
                    "root_path": "",
                },
                receive,
                send,
            )
        )
        self.assertTrue(stream.was_closed)


if __name__ == "__main__":
    unittest.main()
