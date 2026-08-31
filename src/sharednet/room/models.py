"""Frozen, JSON-ready contracts for SharedNet Rooms."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import re
from typing import Any, Literal

from .errors import RoomError


_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")
_CURSOR = re.compile(r"^cursor_([0-9]+)$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_TAG_KIND = Literal["human_review", "verification", "delegation"]


class RoomStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"


class MembershipStatus(str, Enum):
    ACTIVE = "active"
    LEFT = "left"


class ResolutionState(str, Enum):
    NOT_REQUIRED = "not_required"
    PENDING = "pending"
    RESOLVED = "resolved"
    REJECTED = "rejected"


def _error(code: str, message: str) -> RoomError:
    return RoomError(code, message, 400)


def _identifier(value: object, name: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise _error("invalid_identifier", f"{name} must be a valid identifier")
    return value


def _timestamp(value: object, name: str) -> datetime:
    if not isinstance(value, datetime):
        raise _error("invalid_timestamp", f"{name} must be a datetime")
    return value


def _enum(value: object, enum_type: type[Enum], name: str) -> Enum:
    if isinstance(value, enum_type):
        return value
    try:
        return enum_type(value)
    except (TypeError, ValueError) as error:
        raise _error("invalid_value", f"{name} is invalid") from error


def _as_isoformat(value: datetime) -> str:
    return value.isoformat()


def _to_dict(value: object) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return _as_isoformat(value)
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if isinstance(value, tuple):
        return [_to_dict(item) for item in value]
    return value


@dataclass(frozen=True)
class CoordinationTag:
    raw: str
    kind: Literal["human_review", "verification", "delegation"]
    target_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.raw, str):
            raise _error("invalid_tag", "tag must be a string")
        if self.kind not in ("human_review", "verification", "delegation"):
            raise _error("invalid_tag", "tag kind is invalid")
        if self.kind == "delegation":
            object.__setattr__(self, "target_id", _identifier(self.target_id, "tag target"))
        elif self.target_id is not None:
            raise _error("invalid_tag", "only delegation tags may have a target")

    def to_dict(self) -> dict[str, str | None]:
        return {"raw": self.raw, "kind": self.kind, "target_id": self.target_id}


def normalize_tags(tags: object) -> tuple[CoordinationTag, ...]:
    if tags is None:
        return ()
    if not isinstance(tags, (list, tuple)):
        raise _error("invalid_tag", "tags must be a list")
    result: list[CoordinationTag] = []
    seen: set[str] = set()
    for raw in tags:
        if not isinstance(raw, str):
            raise _error("invalid_tag", "tags must contain strings")
        if raw in seen:
            raise _error("duplicate_tag", "tags must be unique")
        seen.add(raw)
        if raw == "human-review-required":
            result.append(CoordinationTag(raw, "human_review"))
        elif raw == "verification-required":
            result.append(CoordinationTag(raw, "verification"))
        elif raw.startswith("delegate-to:"):
            target_id = raw.removeprefix("delegate-to:")
            try:
                result.append(CoordinationTag(raw, "delegation", target_id))
            except RoomError as error:
                raise _error("invalid_tag", "delegation target is invalid") from error
        else:
            raise _error("invalid_tag", "tag is not supported")
    return tuple(result)


def parse_cursor(value: str | None) -> int:
    if value is None:
        return 0
    if not isinstance(value, str):
        raise _error("invalid_cursor", "cursor must be a cursor string")
    match = _CURSOR.fullmatch(value)
    if match is None:
        raise _error("invalid_cursor", "cursor must be formatted cursor_<integer>")
    return int(match.group(1))


def format_cursor(sequence: int) -> str:
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
        raise _error("invalid_cursor", "sequence must be a nonnegative integer")
    return f"cursor_{sequence}"


@dataclass(frozen=True)
class RuntimeIdentity:
    principal_id: str
    agent_id: str
    runtime_id: str

    def __post_init__(self) -> None:
        for name in ("principal_id", "agent_id", "runtime_id"):
            object.__setattr__(self, name, _identifier(getattr(self, name), name))

    def to_dict(self) -> dict[str, str]:
        return {"principal_id": self.principal_id, "agent_id": self.agent_id, "runtime_id": self.runtime_id}


@dataclass(frozen=True)
class RuntimeRegistration:
    identity: RuntimeIdentity
    created_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.identity, RuntimeIdentity):
            raise _error("invalid_identity", "identity must be a runtime identity")
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))

    def to_dict(self) -> dict[str, Any]:
        return {"identity": self.identity.to_dict(), "created_at": _as_isoformat(self.created_at)}


@dataclass(frozen=True)
class Room:
    room_id: str
    name: str
    description: str | None
    creator: RuntimeIdentity
    access_policy: str
    status: RoomStatus
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "room_id", _identifier(self.room_id, "room_id"))
        if not isinstance(self.name, str) or not 1 <= len(self.name.strip()) <= 200:
            raise _error("invalid_name", "room name must be 1 to 200 trimmed characters")
        object.__setattr__(self, "name", self.name.strip())
        if self.description is not None and (not isinstance(self.description, str) or len(self.description) > 4000):
            raise _error("invalid_description", "description must be at most 4000 characters")
        if not isinstance(self.creator, RuntimeIdentity):
            raise _error("invalid_identity", "creator must be a runtime identity")
        if self.access_policy not in ("anyone_with_id", "principal_only"):
            raise _error("invalid_access_policy", "access policy is invalid")
        object.__setattr__(self, "status", _enum(self.status, RoomStatus, "status"))
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))
        object.__setattr__(self, "updated_at", _timestamp(self.updated_at, "updated_at"))

    def to_dict(self) -> dict[str, Any]:
        return {name: _to_dict(getattr(self, name)) for name in self.__dataclass_fields__}


@dataclass(frozen=True)
class Membership:
    room_id: str
    principal_id: str
    agent_id: str
    status: MembershipStatus
    joined_at: datetime
    left_at: datetime | None
    last_read_sequence: int

    def __post_init__(self) -> None:
        for name in ("room_id", "principal_id", "agent_id"):
            object.__setattr__(self, name, _identifier(getattr(self, name), name))
        object.__setattr__(self, "status", _enum(self.status, MembershipStatus, "status"))
        object.__setattr__(self, "joined_at", _timestamp(self.joined_at, "joined_at"))
        if self.left_at is not None:
            object.__setattr__(self, "left_at", _timestamp(self.left_at, "left_at"))
        if isinstance(self.last_read_sequence, bool) or not isinstance(self.last_read_sequence, int) or self.last_read_sequence < 0:
            raise _error("invalid_cursor", "last_read_sequence must be nonnegative")

    def to_dict(self) -> dict[str, Any]:
        return {name: _to_dict(getattr(self, name)) for name in self.__dataclass_fields__}


@dataclass(frozen=True)
class Message:
    message_id: str
    room_id: str
    sequence: int
    sender: RuntimeIdentity
    content: str
    reply_to: str | None
    tags: tuple[CoordinationTag, ...]
    attachment_ids: tuple[str, ...]
    created_at: datetime
    resolution_state: ResolutionState

    def __post_init__(self) -> None:
        for name in ("message_id", "room_id"):
            object.__setattr__(self, name, _identifier(getattr(self, name), name))
        if isinstance(self.sequence, bool) or not isinstance(self.sequence, int) or self.sequence < 1:
            raise _error("invalid_sequence", "sequence must be a positive integer")
        if not isinstance(self.sender, RuntimeIdentity):
            raise _error("invalid_identity", "sender must be a runtime identity")
        if not isinstance(self.content, str) or not 1 <= len(self.content.strip()) <= 100000:
            raise _error("invalid_content", "content must be 1 to 100000 trimmed characters")
        object.__setattr__(self, "content", self.content.strip())
        if self.reply_to is not None:
            object.__setattr__(self, "reply_to", _identifier(self.reply_to, "reply_to"))
        if not isinstance(self.tags, tuple) or not all(isinstance(tag, CoordinationTag) for tag in self.tags):
            raise _error("invalid_tag", "tags must be normalized coordination tags")
        if not isinstance(self.attachment_ids, tuple):
            raise _error("invalid_attachment", "attachment_ids must be a tuple")
        object.__setattr__(self, "attachment_ids", tuple(_identifier(value, "artifact_id") for value in self.attachment_ids))
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))
        object.__setattr__(self, "resolution_state", _enum(self.resolution_state, ResolutionState, "resolution_state"))

    def to_dict(self) -> dict[str, Any]:
        return {name: _to_dict(getattr(self, name)) for name in self.__dataclass_fields__}


@dataclass(frozen=True)
class Obligation:
    obligation_id: str
    message_id: str
    tag: CoordinationTag
    created_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "obligation_id", _identifier(self.obligation_id, "obligation_id"))
        object.__setattr__(self, "message_id", _identifier(self.message_id, "message_id"))
        if not isinstance(self.tag, CoordinationTag):
            raise _error("invalid_tag", "obligation tag must be a coordination tag")
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))

    def to_dict(self) -> dict[str, Any]:
        return {name: _to_dict(getattr(self, name)) for name in self.__dataclass_fields__}


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    room_id: str
    filename: str
    media_type: str
    size_bytes: int
    sha256: str
    created_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "artifact_id", _identifier(self.artifact_id, "artifact_id"))
        object.__setattr__(self, "room_id", _identifier(self.room_id, "room_id"))
        if not isinstance(self.filename, str) or not 1 <= len(self.filename) <= 255 or self.filename in (".", "..") or "/" in self.filename or "\\" in self.filename:
            raise _error("invalid_filename", "filename must be a basename of 1 to 255 characters")
        if not isinstance(self.media_type, str) or not self.media_type.strip():
            raise _error("invalid_media_type", "media_type must be nonempty")
        if isinstance(self.size_bytes, bool) or not isinstance(self.size_bytes, int) or self.size_bytes < 0:
            raise _error("invalid_size", "size_bytes must be nonnegative")
        if not isinstance(self.sha256, str) or not _SHA256.fullmatch(self.sha256):
            raise _error("invalid_sha256", "sha256 must be lowercase hexadecimal")
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))

    def to_dict(self) -> dict[str, Any]:
        return {name: _to_dict(getattr(self, name)) for name in self.__dataclass_fields__}


@dataclass(frozen=True)
class MessagePage:
    messages: tuple[Message, ...]
    next_cursor: str
    limit: int = 50

    def __post_init__(self) -> None:
        if not isinstance(self.messages, tuple) or not all(isinstance(message, Message) for message in self.messages):
            raise _error("invalid_message", "messages must be a tuple of messages")
        parse_cursor(self.next_cursor)
        if isinstance(self.limit, bool) or not isinstance(self.limit, int) or not 1 <= self.limit <= 100:
            raise _error("invalid_limit", "limit must be between 1 and 100")

    def to_dict(self) -> dict[str, Any]:
        return {"messages": [_to_dict(message) for message in self.messages], "next_cursor": self.next_cursor}
