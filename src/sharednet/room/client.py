"""Dependency-light, fail-closed HTTP client for SharedNet Rooms."""

from __future__ import annotations

from dataclasses import dataclass
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
from typing import BinaryIO, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, OpenerDirector, ProxyHandler, Request, build_opener

from .errors import RoomError
from .models import RuntimeIdentity


_DEFAULT_TIMEOUT = 30.0
_JSON_RESPONSE_LIMIT = 2 * 1024 * 1024
_SESSION_LIMIT = 64 * 1024
_TRANSFER_CHUNK_BYTES = 64 * 1024
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def normalize_base_url(value: str) -> str:
    """Validate and canonicalize a daemon origin without a path."""
    if not isinstance(value, str) or not value or any(ord(character) < 33 for character in value):
        raise RoomError("invalid_base_url", "base URL must be an HTTP(S) origin", 400)
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise RoomError("invalid_base_url", "base URL must be an HTTP(S) origin", 400) from error
    if (
        parsed.scheme.lower() not in ("http", "https")
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise RoomError("invalid_base_url", "base URL must be an HTTP(S) origin", 400)
    hostname = parsed.hostname.lower()
    if ":" in hostname:
        hostname = f"[{hostname}]"
    netloc = hostname if port is None else f"{hostname}:{port}"
    return urlunsplit((parsed.scheme.lower(), netloc, "", "", ""))


def _validate_token(value: object) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 4096
        or not value.isascii()
        or any(character.isspace() or ord(character) < 33 or ord(character) == 127 for character in value)
    ):
        raise RoomError("invalid_runtime_token", "runtime token is invalid", 401)
    return value


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _BoundedReader:
    """Expose exactly the file size measured before an upload starts."""

    def __init__(self, stream: BinaryIO, size_bytes: int) -> None:
        self.stream = stream
        self.remaining = size_bytes

    def read(self, size: int = -1) -> bytes:
        if self.remaining == 0:
            return b""
        if size is None or size < 0:
            size = min(_TRANSFER_CHUNK_BYTES, self.remaining)
        else:
            size = min(size, self.remaining)
        chunk = self.stream.read(size)
        if not chunk:
            raise OSError("upload file ended before its declared Content-Length")
        if len(chunk) > self.remaining:
            raise OSError("upload reader exceeded its declared Content-Length")
        self.remaining -= len(chunk)
        return chunk


class RoomClient:
    """Call the frozen Room HTTP API using only Python's standard library."""

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        timeout: float = _DEFAULT_TIMEOUT,
        *,
        auth_scheme: str = "Bearer",
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise RoomError("invalid_timeout", "timeout must be a positive number", 400)
        self.timeout = float(timeout)
        self.token = None if token is None else _validate_token(token)
        if auth_scheme not in {"Bearer", "Connector", "Runtime", "Instance"}:
            raise RoomError("invalid_auth_scheme", "authorization scheme is invalid", 400)
        self.auth_scheme = auth_scheme
        self._opener: OpenerDirector = build_opener(ProxyHandler({}), _RejectRedirects())

    @staticmethod
    def _segment(value: str) -> str:
        if not isinstance(value, str) or not value:
            raise RoomError("invalid_path_segment", "path identifier must be non-empty", 400)
        return quote(value, safe="")

    def _request(
        self,
        method: str,
        path: str,
        *,
        payload: Mapping[str, object] | None = None,
        query: Sequence[tuple[str, object]] = (),
        protected: bool = True,
        data: object | None = None,
        headers: Mapping[str, str] | None = None,
    ):
        if query:
            path = f"{path}?{urlencode(query)}"
        request_headers = dict(headers or {})
        if protected and self.token is not None:
            request_headers["Authorization"] = f"{self.auth_scheme} {self.token}"
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            return self._opener.open(request, timeout=self.timeout)
        except HTTPError as error:
            if 300 <= error.code < 400:
                error.close()
                raise RoomError("redirect_refused", "HTTP redirects are not permitted", error.code) from error
            parsed_error = self._parse_http_error(error)
            error.close()
            raise parsed_error from error
        except (URLError, TimeoutError, OSError) as error:
            raise RoomError("transport_error", "Room server request failed", 0) from error

    @staticmethod
    def _read_limited(stream, limit: int = _JSON_RESPONSE_LIMIT) -> bytes:
        body = stream.read(limit + 1)
        if len(body) > limit:
            raise RoomError("invalid_response", "Room server response is too large", 502)
        return body

    @classmethod
    def _parse_http_error(cls, error: HTTPError) -> RoomError:
        try:
            body = cls._read_limited(error)
            payload = json.loads(body.decode("utf-8"))
            item = payload["error"]
            code = item["code"]
            message = item["message"]
            if not isinstance(code, str) or not isinstance(message, str):
                raise TypeError("invalid Room error payload")
            return RoomError(code, message, error.code)
        except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError, RoomError):
            return RoomError("http_error", f"Room server returned HTTP {error.code}", error.code)

    def _json(
        self,
        method: str,
        path: str,
        *,
        payload: Mapping[str, object] | None = None,
        query: Sequence[tuple[str, object]] = (),
        protected: bool = True,
        data: object | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> dict[str, object]:
        response = self._request(
            method,
            path,
            payload=payload,
            query=query,
            protected=protected,
            data=data,
            headers=headers,
        )
        with response:
            try:
                body = self._read_limited(response)
                result = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise RoomError("invalid_response", "Room server returned invalid JSON", 502) from error
        if not isinstance(result, dict):
            raise RoomError("invalid_response", "Room server returned invalid JSON", 502)
        return result

    def register_runtime(
        self,
        principal_id: str,
        agent_id: str,
        requested_runtime_id: str | None = None,
    ) -> dict[str, object]:
        return self._json(
            "POST",
            "/v1/runtimes/register",
            payload={
                "principal_id": principal_id,
                "agent_id": agent_id,
                "requested_runtime_id": requested_runtime_id,
            },
            protected=False,
        )

    def health(self) -> dict[str, object]:
        return self._json("GET", "/healthz", protected=False)

    def build_room(
        self,
        name: str,
        description: str | None = None,
        access_policy: str = "anyone_with_id",
    ) -> dict[str, object]:
        return self._json(
            "POST",
            "/v1/rooms",
            payload={
                "name": name,
                "description": description,
                "access_policy": access_policy,
            },
        )

    def join_room(self, room_id: str) -> dict[str, object]:
        return self._json("POST", f"/v1/rooms/{self._segment(room_id)}/memberships")

    def list_rooms(self) -> dict[str, object]:
        return self._json("GET", "/v1/rooms")

    def get_room(self, room_id: str) -> dict[str, object]:
        return self._json("GET", f"/v1/rooms/{self._segment(room_id)}")

    def post_message(
        self,
        room_id: str,
        content: str,
        reply_to: str | None = None,
        tags: Sequence[str] = (),
        attachment_ids: Sequence[str] = (),
    ) -> dict[str, object]:
        return self._json(
            "POST",
            f"/v1/rooms/{self._segment(room_id)}/messages",
            payload={
                "content": content,
                "reply_to": reply_to,
                "tags": list(tags),
                "attachment_ids": list(attachment_ids),
            },
        )

    def retrieve_messages(
        self,
        room_id: str,
        after_cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, object]:
        query: list[tuple[str, object]] = []
        if after_cursor is not None:
            query.append(("after_cursor", after_cursor))
        query.append(("limit", limit))
        return self._json(
            "GET",
            f"/v1/rooms/{self._segment(room_id)}/messages",
            query=query,
        )

    def resolve_message(
        self,
        room_id: str,
        message_id: str,
        outcome: str,
        evidence: str | None = None,
    ) -> dict[str, object]:
        return self._json(
            "POST",
            (
                f"/v1/rooms/{self._segment(room_id)}/messages/"
                f"{self._segment(message_id)}/resolve"
            ),
            payload={"outcome": outcome, "evidence": evidence},
        )

    def upload_artifact(
        self,
        room_id: str,
        path: str | os.PathLike[str],
        filename: str | None = None,
        media_type: str | None = None,
    ) -> dict[str, object]:
        source = Path(path)
        try:
            stream = source.open("rb")
        except OSError as error:
            raise RoomError("invalid_upload_file", "upload source could not be opened", 400) from error
        with stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise RoomError("invalid_upload_file", "upload source must be a regular file", 400)
            upload_filename = source.name if filename is None else filename
            bounded = _BoundedReader(stream, metadata.st_size)
            result = self._json(
                "POST",
                f"/v1/rooms/{self._segment(room_id)}/artifacts",
                query=(("filename", upload_filename),),
                data=bounded,
                headers={
                    "Content-Type": media_type or "application/octet-stream",
                    "Content-Length": str(metadata.st_size),
                },
            )
            if bounded.remaining:
                raise RoomError("upload_changed", "upload file changed during transfer", 400)
            return result

    def download_artifact(
        self,
        room_id: str,
        artifact_id: str,
        destination: str | os.PathLike[str],
        *,
        force: bool = False,
    ) -> dict[str, object]:
        target = Path(destination)
        if not target.name or not target.parent.is_dir():
            raise RoomError("invalid_destination", "download destination directory does not exist", 400)
        if not force and os.path.lexists(target):
            raise RoomError("destination_exists", "download destination already exists", 409)

        response = self._request(
            "GET",
            (
                f"/v1/rooms/{self._segment(room_id)}/artifacts/"
                f"{self._segment(artifact_id)}"
            ),
        )
        expected_length_raw = response.headers.get("Content-Length")
        expected_sha256 = response.headers.get("X-Content-SHA256", "")
        try:
            if expected_length_raw is None or not expected_length_raw.isascii() or not expected_length_raw.isdigit():
                raise RoomError("invalid_download_metadata", "download Content-Length is invalid", 502)
            expected_length = int(expected_length_raw)
            if not _SHA256.fullmatch(expected_sha256):
                raise RoomError("invalid_download_metadata", "download SHA-256 metadata is invalid", 502)

            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{target.name}.",
                suffix=".tmp",
                dir=target.parent,
            )
            temporary_path = Path(temporary_name)
            try:
                digest = hashlib.sha256()
                count = 0
                with os.fdopen(descriptor, "wb") as output, response:
                    os.fchmod(output.fileno(), 0o600)
                    while chunk := response.read(_TRANSFER_CHUNK_BYTES):
                        count += len(chunk)
                        if count > expected_length:
                            raise RoomError(
                                "download_integrity_error",
                                "download length does not match metadata",
                                502,
                            )
                        digest.update(chunk)
                        output.write(chunk)
                    if count != expected_length:
                        raise RoomError(
                            "download_transfer_error",
                            "download ended before its declared Content-Length",
                            502,
                        )
                    if digest.hexdigest() != expected_sha256:
                        raise RoomError(
                            "download_integrity_error",
                            "download integrity verification failed",
                            502,
                        )
                    output.flush()
                    os.fsync(output.fileno())

                if force:
                    os.replace(temporary_path, target)
                else:
                    try:
                        os.link(temporary_path, target)
                    except FileExistsError as error:
                        raise RoomError(
                            "destination_exists",
                            "download destination already exists",
                            409,
                        ) from error
                    temporary_path.unlink()
                temporary_path = None
                _fsync_directory(target.parent)
                return {
                    "path": str(target),
                    "size_bytes": count,
                    "sha256": expected_sha256,
                    "media_type": response.headers.get("Content-Type", "application/octet-stream"),
                }
            finally:
                if temporary_path is not None:
                    try:
                        temporary_path.unlink()
                    except FileNotFoundError:
                        pass
        finally:
            response.close()

    def leave_room(self, room_id: str) -> dict[str, object]:
        return self._json("DELETE", f"/v1/rooms/{self._segment(room_id)}/membership")

    def close_room(self, room_id: str) -> dict[str, object]:
        return self._json("POST", f"/v1/rooms/{self._segment(room_id)}/close")


@dataclass(frozen=True)
class RoomSession:
    base_url: str
    runtime_token: str
    identity: dict[str, str]
    auth_scheme: str = "Bearer"


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class RoomSessionFile:
    """Persist one runtime credential without exposing it in command arguments."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    @staticmethod
    def _validate_identity(value: object) -> dict[str, str]:
        if not isinstance(value, dict) or set(value) != {"principal_id", "agent_id", "runtime_id"}:
            raise RoomError("invalid_session", "Room session identity is invalid", 400)
        try:
            identity = RuntimeIdentity(
                value["principal_id"],
                value["agent_id"],
                value["runtime_id"],
            )
        except (KeyError, RoomError) as error:
            raise RoomError("invalid_session", "Room session identity is invalid", 400) from error
        return identity.to_dict()

    def save(
        self,
        base_url: str,
        runtime_token: str,
        identity: Mapping[str, object],
    ) -> None:
        normalized_url = normalize_base_url(base_url)
        token = _validate_token(runtime_token)
        safe_identity = self._validate_identity(dict(identity))
        payload = json.dumps(
            {
                "base_url": normalized_url,
                "runtime_token": token,
                "identity": safe_identity,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            dir=self.path.parent,
        )
        temporary_path = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, self.path)
            temporary_path = None
            _fsync_directory(self.path.parent)
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass

    def load(self) -> RoomSession:
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        if hasattr(os, "O_NONBLOCK"):
            flags |= os.O_NONBLOCK
        try:
            descriptor = os.open(self.path, flags)
        except FileNotFoundError as error:
            raise RoomError("session_not_found", "Room session file does not exist", 404) from error
        except OSError as error:
            code = "invalid_session_file" if error.errno in (errno.ELOOP, errno.EISDIR) else "session_read_error"
            raise RoomError(code, "Room session file is not a safe regular file", 400) from error
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise RoomError("invalid_session_file", "Room session file must be regular", 400)
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise RoomError(
                    "insecure_session_permissions",
                    "Room session file must not be accessible by group or other users",
                    400,
                )
            if metadata.st_size > _SESSION_LIMIT:
                raise RoomError("invalid_session", "Room session file is too large", 400)
            with os.fdopen(descriptor, "rb", closefd=False) as input_file:
                raw = input_file.read(_SESSION_LIMIT + 1)
        finally:
            os.close(descriptor)
        try:
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise RoomError("invalid_session", "Room session payload is invalid", 400)
            if set(payload) == {
                "version",
                "api_url",
                "principal_id",
                "agent_id",
                "runtime_id",
                "instance_id",
                "instance_token",
            }:
                from ..control.models import ActorIdentity, ControlError

                if payload["version"] != 1 or isinstance(payload["version"], bool):
                    raise RoomError("invalid_session", "Room session payload is invalid", 400)
                try:
                    identity = ActorIdentity(
                        payload["principal_id"],
                        payload["agent_id"],
                        payload["runtime_id"],
                        payload["instance_id"],
                    ).to_dict()
                except ControlError as error:
                    raise RoomError("invalid_session", "Room session identity is invalid", 400) from error
                return RoomSession(
                    normalize_base_url(payload["api_url"]),
                    _validate_token(payload["instance_token"]),
                    identity,
                    "Instance",
                )
            if set(payload) != {"base_url", "runtime_token", "identity"}:
                raise RoomError("invalid_session", "Room session payload is invalid", 400)
            return RoomSession(
                normalize_base_url(payload["base_url"]),
                _validate_token(payload["runtime_token"]),
                self._validate_identity(payload["identity"]),
            )
        except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError, RoomError) as error:
            if isinstance(error, RoomError) and error.code == "invalid_session":
                raise
            raise RoomError("invalid_session", "Room session payload is invalid", 400) from error


__all__ = [
    "RoomClient",
    "RoomSession",
    "RoomSessionFile",
    "normalize_base_url",
]
