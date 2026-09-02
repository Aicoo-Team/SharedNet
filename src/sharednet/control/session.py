"""Owner-only local credential files for the SharedNet V1 connector."""

from __future__ import annotations

from dataclasses import dataclass
import errno
import json
import os
from pathlib import Path
import stat
import tempfile
from typing import Mapping

from ..identity import is_typed_id
from ..room.client import normalize_base_url
from ..room.errors import RoomError
from .models import ControlError


_SESSION_LIMIT = 64 * 1024


def _error(code: str, message: str, status_code: int = 400) -> ControlError:
    return ControlError(code, message, status_code)


def _api_url(value: object) -> str:
    try:
        return normalize_base_url(value)  # type: ignore[arg-type]
    except (RoomError, TypeError) as error:
        raise _error("invalid_session", "session API URL is invalid") from error


def _typed_id(value: object, prefix: str, field: str) -> str:
    if not is_typed_id(value, prefix):
        raise _error("invalid_session", f"session {field} is invalid")
    return value


def _token(value: object, field: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 4096
        or not value.isascii()
        or any(character.isspace() or ord(character) < 33 or ord(character) == 127 for character in value)
    ):
        raise _error("invalid_session", f"session {field} is invalid")
    return value


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


def _ensure_private_parent(path: Path) -> None:
    parent = path.parent
    try:
        parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        metadata = parent.lstat()
    except OSError as error:
        raise _error("session_write_error", "session directory could not be created") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise _error("invalid_session_directory", "session parent must be a real directory")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise _error(
            "insecure_session_directory",
            "session directory must not be accessible by group or other users",
        )


def _write_new(path: Path, payload: Mapping[str, object]) -> None:
    _ensure_private_parent(path)
    if os.path.lexists(path):
        raise _error("session_exists", "session file already exists", 409)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary_path, path)
        except FileExistsError as error:
            raise _error("session_exists", "session file already exists", 409) from error
        _fsync_directory(path.parent)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def _read(path: Path) -> dict[str, object]:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError as error:
        raise _error("session_not_found", "session file does not exist", 404) from error
    except OSError as error:
        code = "invalid_session_file" if error.errno in (errno.ELOOP, errno.EISDIR) else "session_read_error"
        raise _error(code, "session file is not a safe regular file") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise _error("invalid_session_file", "session file must be regular")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise _error(
                "insecure_session_permissions",
                "session file must not be accessible by group or other users",
            )
        if metadata.st_size > _SESSION_LIMIT:
            raise _error("invalid_session", "session file is too large")
        with os.fdopen(descriptor, "rb", closefd=False) as input_file:
            raw = input_file.read(_SESSION_LIMIT + 1)
    finally:
        os.close(descriptor)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _error("invalid_session", "session payload is invalid") from error
    if not isinstance(payload, dict):
        raise _error("invalid_session", "session payload is invalid")
    return payload


def _contract(path: Path, keys: set[str]) -> dict[str, object]:
    payload = _read(path)
    if set(payload) != keys or payload.get("version") != 1 or isinstance(payload.get("version"), bool):
        raise _error("invalid_session", "session payload is invalid")
    return payload


@dataclass(frozen=True)
class AccountSession:
    api_url: str
    principal_id: str
    connector_token: str


@dataclass(frozen=True)
class AgentState:
    api_url: str
    principal_id: str
    agent_id: str
    runtime_id: str
    runtime_token: str


@dataclass(frozen=True)
class LocalInstanceSession:
    api_url: str
    principal_id: str
    agent_id: str
    runtime_id: str
    instance_id: str
    instance_token: str

    @property
    def identity(self) -> dict[str, str]:
        return {
            "principal_id": self.principal_id,
            "agent_id": self.agent_id,
            "runtime_id": self.runtime_id,
            "instance_id": self.instance_id,
        }


class AccountSessionFile:
    KEYS = {"version", "api_url", "principal_id", "connector_token"}

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    def save(self, api_url: str, principal_id: str, connector_token: str) -> None:
        session = AccountSession(
            _api_url(api_url),
            _typed_id(principal_id, "p", "principal_id"),
            _token(connector_token, "connector_token"),
        )
        _write_new(
            self.path,
            {
                "version": 1,
                "api_url": session.api_url,
                "principal_id": session.principal_id,
                "connector_token": session.connector_token,
            },
        )

    def load(self) -> AccountSession:
        payload = _contract(self.path, self.KEYS)
        return AccountSession(
            _api_url(payload["api_url"]),
            _typed_id(payload["principal_id"], "p", "principal_id"),
            _token(payload["connector_token"], "connector_token"),
        )


class AgentStateFile:
    KEYS = {"version", "api_url", "principal_id", "agent_id", "runtime_id", "runtime_token"}

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    def save(
        self,
        api_url: str,
        principal_id: str,
        agent_id: str,
        runtime_id: str,
        runtime_token: str,
    ) -> None:
        state = AgentState(
            _api_url(api_url),
            _typed_id(principal_id, "p", "principal_id"),
            _typed_id(agent_id, "a", "agent_id"),
            _typed_id(runtime_id, "r", "runtime_id"),
            _token(runtime_token, "runtime_token"),
        )
        _write_new(
            self.path,
            {
                "version": 1,
                "api_url": state.api_url,
                "principal_id": state.principal_id,
                "agent_id": state.agent_id,
                "runtime_id": state.runtime_id,
                "runtime_token": state.runtime_token,
            },
        )

    def load(self) -> AgentState:
        payload = _contract(self.path, self.KEYS)
        return AgentState(
            _api_url(payload["api_url"]),
            _typed_id(payload["principal_id"], "p", "principal_id"),
            _typed_id(payload["agent_id"], "a", "agent_id"),
            _typed_id(payload["runtime_id"], "r", "runtime_id"),
            _token(payload["runtime_token"], "runtime_token"),
        )


class InstanceSessionFile:
    KEYS = {
        "version",
        "api_url",
        "principal_id",
        "agent_id",
        "runtime_id",
        "instance_id",
        "instance_token",
    }

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    def save(
        self,
        api_url: str,
        principal_id: str,
        agent_id: str,
        runtime_id: str,
        instance_id: str,
        instance_token: str,
    ) -> None:
        session = LocalInstanceSession(
            _api_url(api_url),
            _typed_id(principal_id, "p", "principal_id"),
            _typed_id(agent_id, "a", "agent_id"),
            _typed_id(runtime_id, "r", "runtime_id"),
            _typed_id(instance_id, "i", "instance_id"),
            _token(instance_token, "instance_token"),
        )
        _write_new(
            self.path,
            {
                "version": 1,
                "api_url": session.api_url,
                **session.identity,
                "instance_token": session.instance_token,
            },
        )

    def load(self) -> LocalInstanceSession:
        payload = _contract(self.path, self.KEYS)
        return LocalInstanceSession(
            _api_url(payload["api_url"]),
            _typed_id(payload["principal_id"], "p", "principal_id"),
            _typed_id(payload["agent_id"], "a", "agent_id"),
            _typed_id(payload["runtime_id"], "r", "runtime_id"),
            _typed_id(payload["instance_id"], "i", "instance_id"),
            _token(payload["instance_token"], "instance_token"),
        )


__all__ = [
    "AccountSession",
    "AccountSessionFile",
    "AgentState",
    "AgentStateFile",
    "InstanceSessionFile",
    "LocalInstanceSession",
]
