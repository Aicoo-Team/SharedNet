"""Transactional SQLite persistence for Room identities and membership."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import sqlite3
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..control.models import ActorIdentity

from ..identity import new_runtime_id
from .errors import RoomError
from .models import (
    Artifact,
    CoordinationTag,
    Membership,
    MembershipStatus,
    Message,
    MessagePage,
    ResolutionState,
    Room,
    RoomStatus,
    RoomSummary,
    RuntimeIdentity,
    RuntimeRegistration,
    format_cursor,
)


_GENERATED_RUNTIME_ID_ATTEMPTS = 8


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _error(code: str, message: str, status_code: int) -> RoomError:
    return RoomError(code, message, status_code)


def _new_id(prefix: str) -> str:
    token = secrets.token_urlsafe(18).lower().replace("-", "_")
    return f"{prefix}{token}"


def _timestamp(value: datetime) -> str:
    return value.isoformat()


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


class _ConnectionContext:
    def __init__(self, database_path: Path) -> None:
        self.connection = sqlite3.connect(database_path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys=ON")

    def __enter__(self) -> sqlite3.Connection:
        self.connection.__enter__()
        return self.connection

    def __exit__(self, exception_type, exception, traceback) -> bool:
        try:
            return bool(self.connection.__exit__(exception_type, exception, traceback))
        finally:
            self.connection.close()


class RoomStore:
    def __init__(
        self,
        database_path: Path,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.database_path = Path(database_path)
        self.clock = clock

    def _connect(self) -> _ConnectionContext:
        return _ConnectionContext(self.database_path)

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS principals (
                    principal_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS agents (
                    agent_id TEXT PRIMARY KEY,
                    principal_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE (agent_id, principal_id),
                    FOREIGN KEY (principal_id) REFERENCES principals(principal_id)
                );

                CREATE TABLE IF NOT EXISTS runtime_registrations (
                    runtime_id TEXT PRIMARY KEY,
                    principal_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (agent_id, principal_id) REFERENCES agents(agent_id, principal_id)
                );

                CREATE TABLE IF NOT EXISTS rooms (
                    room_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    creator_principal_id TEXT NOT NULL,
                    creator_agent_id TEXT NOT NULL,
                    creator_runtime_id TEXT NOT NULL,
                    access_policy TEXT NOT NULL CHECK (access_policy IN ('anyone_with_id', 'principal_only')),
                    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
                    FOREIGN KEY (creator_principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (creator_agent_id, creator_principal_id)
                        REFERENCES agents(agent_id, principal_id),
                    FOREIGN KEY (creator_runtime_id) REFERENCES runtime_registrations(runtime_id)
                );

                CREATE TABLE IF NOT EXISTS room_memberships (
                    membership_id TEXT PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    principal_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('active', 'left')),
                    joined_at TEXT NOT NULL,
                    left_at TEXT,
                    last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
                    UNIQUE (room_id, agent_id),
                    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
                    FOREIGN KEY (principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (agent_id, principal_id) REFERENCES agents(agent_id, principal_id)
                );

                CREATE INDEX IF NOT EXISTS room_memberships_agent_idx
                    ON room_memberships(agent_id, room_id);

                CREATE TABLE IF NOT EXISTS messages (
                    message_id TEXT PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL CHECK (sequence >= 1),
                    sender_principal_id TEXT NOT NULL,
                    sender_agent_id TEXT NOT NULL,
                    sender_runtime_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    reply_to TEXT,
                    tags_json TEXT NOT NULL,
                    attachment_ids_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolution_state TEXT NOT NULL
                        CHECK (resolution_state IN ('not_required', 'pending', 'resolved', 'rejected')),
                    UNIQUE (room_id, sequence),
                    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
                    FOREIGN KEY (sender_principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (sender_agent_id, sender_principal_id)
                        REFERENCES agents(agent_id, principal_id),
                    FOREIGN KEY (sender_runtime_id) REFERENCES runtime_registrations(runtime_id),
                    FOREIGN KEY (reply_to) REFERENCES messages(message_id)
                );

                CREATE INDEX IF NOT EXISTS messages_room_sequence_idx
                    ON messages(room_id, sequence);

                CREATE TABLE IF NOT EXISTS artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    uploader_principal_id TEXT NOT NULL,
                    uploader_agent_id TEXT NOT NULL,
                    uploader_runtime_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
                    sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
                    FOREIGN KEY (uploader_principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (uploader_agent_id, uploader_principal_id)
                        REFERENCES agents(agent_id, principal_id),
                    FOREIGN KEY (uploader_runtime_id) REFERENCES runtime_registrations(runtime_id)
                );

                CREATE INDEX IF NOT EXISTS artifacts_room_idx
                    ON artifacts(room_id, created_at, artifact_id);

                CREATE TABLE IF NOT EXISTS message_artifacts (
                    message_id TEXT NOT NULL,
                    artifact_id TEXT NOT NULL,
                    position INTEGER NOT NULL CHECK (position >= 0),
                    PRIMARY KEY (message_id, artifact_id),
                    UNIQUE (message_id, position),
                    FOREIGN KEY (message_id) REFERENCES messages(message_id),
                    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
                );

                CREATE INDEX IF NOT EXISTS message_artifacts_artifact_idx
                    ON message_artifacts(artifact_id, message_id);

                CREATE TABLE IF NOT EXISTS message_obligations (
                    obligation_id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    tag_raw TEXT NOT NULL,
                    tag_kind TEXT NOT NULL
                        CHECK (tag_kind IN ('human_review', 'verification', 'delegation')),
                    target_id TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE (message_id, tag_raw),
                    FOREIGN KEY (message_id) REFERENCES messages(message_id)
                );

                CREATE INDEX IF NOT EXISTS message_obligations_message_idx
                    ON message_obligations(message_id);

                CREATE TABLE IF NOT EXISTS message_resolutions (
                    resolution_id TEXT PRIMARY KEY,
                    obligation_id TEXT NOT NULL UNIQUE,
                    message_id TEXT NOT NULL,
                    resolver_principal_id TEXT NOT NULL,
                    resolver_agent_id TEXT NOT NULL,
                    resolver_runtime_id TEXT NOT NULL,
                    outcome TEXT NOT NULL CHECK (outcome IN ('fulfilled', 'rejected')),
                    evidence TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (obligation_id) REFERENCES message_obligations(obligation_id),
                    FOREIGN KEY (message_id) REFERENCES messages(message_id),
                    FOREIGN KEY (resolver_principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (resolver_agent_id, resolver_principal_id)
                        REFERENCES agents(agent_id, principal_id),
                    FOREIGN KEY (resolver_runtime_id) REFERENCES runtime_registrations(runtime_id)
                );

                CREATE INDEX IF NOT EXISTS message_resolutions_message_idx
                    ON message_resolutions(message_id);
                """
            )
            self._add_nullable_column(
                connection,
                "rooms",
                "creator_instance_id",
                "TEXT",
            )
            self._add_nullable_column(
                connection,
                "messages",
                "sender_instance_id",
                "TEXT",
            )

    @staticmethod
    def _add_nullable_column(
        connection: sqlite3.Connection,
        table_name: str,
        column_name: str,
        column_type: str,
    ) -> None:
        columns = {
            row["name"]
            for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall()
        }
        if column_name not in columns:
            connection.execute(
                f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"
            )

    def register_runtime(
        self,
        principal_id: str,
        agent_id: str,
        requested_runtime_id: str | None,
    ) -> tuple[RuntimeRegistration, str]:
        created_at = self.clock()
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        generated_runtime_id = requested_runtime_id is None
        attempts = _GENERATED_RUNTIME_ID_ATTEMPTS if generated_runtime_id else 1

        for _ in range(attempts):
            runtime_id = new_runtime_id() if generated_runtime_id else requested_runtime_id
            identity = RuntimeIdentity(principal_id, agent_id, runtime_id)

            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                agent = connection.execute(
                    "SELECT principal_id FROM agents WHERE agent_id = ?",
                    (agent_id,),
                ).fetchone()
                if agent is not None and agent["principal_id"] != principal_id:
                    raise _error(
                        "agent_principal_conflict",
                        "agent is already owned by another principal",
                        409,
                    )
                if connection.execute(
                    "SELECT 1 FROM runtime_registrations WHERE runtime_id = ?",
                    (runtime_id,),
                ).fetchone() is not None:
                    if generated_runtime_id:
                        continue
                    raise _error("runtime_id_conflict", "runtime_id is already registered", 409)

                serialized_created_at = _timestamp(created_at)
                connection.execute(
                    "INSERT OR IGNORE INTO principals(principal_id, created_at) VALUES (?, ?)",
                    (principal_id, serialized_created_at),
                )
                connection.execute(
                    "INSERT OR IGNORE INTO agents(agent_id, principal_id, created_at) VALUES (?, ?, ?)",
                    (agent_id, principal_id, serialized_created_at),
                )
                connection.execute(
                    """
                    INSERT INTO runtime_registrations(
                        runtime_id, principal_id, agent_id, token_hash, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (runtime_id, principal_id, agent_id, token_hash, serialized_created_at),
                )

            return RuntimeRegistration(identity, created_at), raw_token

        raise _error("runtime_id_conflict", "runtime_id is already registered", 409)

    def authenticate_runtime(self, raw_token: str) -> RuntimeIdentity:
        if not isinstance(raw_token, str):
            raise _error("invalid_runtime_token", "runtime token is invalid", 401)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT principal_id, agent_id, runtime_id, token_hash FROM runtime_registrations"
            ).fetchall()
        for row in rows:
            if hmac.compare_digest(row["token_hash"], token_hash):
                return RuntimeIdentity(row["principal_id"], row["agent_id"], row["runtime_id"])
        raise _error("invalid_runtime_token", "runtime token is invalid", 401)

    def _require_identity(
        self,
        connection: sqlite3.Connection,
        identity: RuntimeIdentity | ActorIdentity,
    ) -> None:
        row = connection.execute(
            """
            SELECT 1
            FROM runtime_registrations
            WHERE runtime_id = ? AND principal_id = ? AND agent_id = ?
            """,
            (identity.runtime_id, identity.principal_id, identity.agent_id),
        ).fetchone()
        if row is None:
            raise _error("invalid_runtime_identity", "runtime identity is not registered", 401)
        instance_id = getattr(identity, "instance_id", None)
        if instance_id is None:
            return
        instance = connection.execute(
            """
            SELECT status, credential_status, expires_at
            FROM agent_instances
            WHERE instance_id = ? AND runtime_id = ? AND agent_id = ? AND principal_id = ?
            """,
            (
                instance_id,
                identity.runtime_id,
                identity.agent_id,
                identity.principal_id,
            ),
        ).fetchone()
        if (
            instance is None
            or instance["status"] != "online"
            or instance["credential_status"] != "active"
            or _parse_timestamp(instance["expires_at"]) <= self.clock()
        ):
            raise _error("invalid_instance_identity", "Instance identity is not active", 401)

    def create_room(
        self,
        identity: RuntimeIdentity | ActorIdentity,
        name: str,
        description: str | None,
        access_policy: str,
    ) -> Room:
        room_id = _new_id("room_")
        created_at = self.clock()
        room = Room(
            room_id,
            name,
            description,
            identity,
            access_policy,
            RoomStatus.OPEN,
            created_at,
            created_at,
        )
        membership_id = _new_id("membership_")

        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_identity(connection, identity)
            serialized_created_at = _timestamp(created_at)
            connection.execute(
                """
                INSERT INTO rooms(
                    room_id, name, description,
                    creator_principal_id, creator_agent_id, creator_runtime_id,
                    creator_instance_id,
                    access_policy, status, created_at, updated_at, latest_sequence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    room.room_id,
                    room.name,
                    room.description,
                    identity.principal_id,
                    identity.agent_id,
                    identity.runtime_id,
                    getattr(identity, "instance_id", None),
                    room.access_policy,
                    room.status.value,
                    serialized_created_at,
                    serialized_created_at,
                ),
            )
            connection.execute(
                """
                INSERT INTO room_memberships(
                    membership_id, room_id, principal_id, agent_id,
                    status, joined_at, left_at, last_read_sequence
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
                """,
                (
                    membership_id,
                    room.room_id,
                    identity.principal_id,
                    identity.agent_id,
                    MembershipStatus.ACTIVE.value,
                    serialized_created_at,
                ),
            )
        return room

    def join_room(self, identity: RuntimeIdentity, room_id: str) -> Membership:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_identity(connection, identity)
            room_row = self._room_row(connection, room_id)
            if RoomStatus(room_row["status"]) is RoomStatus.CLOSED:
                raise _error("room_closed", "room is closed", 409)
            if room_row["access_policy"] == "principal_only" and (
                identity.principal_id != room_row["creator_principal_id"]
            ):
                raise _error("room_access_denied", "room is restricted to the creator principal", 403)

            membership_row = connection.execute(
                "SELECT * FROM room_memberships WHERE room_id = ? AND agent_id = ?",
                (room_id, identity.agent_id),
            ).fetchone()
            if membership_row is not None and membership_row["status"] == MembershipStatus.ACTIVE.value:
                return self._membership(membership_row)

            joined_at = self.clock()
            serialized_joined_at = _timestamp(joined_at)
            if membership_row is None:
                connection.execute(
                    """
                    INSERT INTO room_memberships(
                        membership_id, room_id, principal_id, agent_id,
                        status, joined_at, left_at, last_read_sequence
                    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
                    """,
                    (
                        _new_id("membership_"),
                        room_id,
                        identity.principal_id,
                        identity.agent_id,
                        MembershipStatus.ACTIVE.value,
                        serialized_joined_at,
                    ),
                )
            else:
                connection.execute(
                    """
                    UPDATE room_memberships
                    SET principal_id = ?, status = ?, joined_at = ?, left_at = NULL
                    WHERE room_id = ? AND agent_id = ?
                    """,
                    (
                        identity.principal_id,
                        MembershipStatus.ACTIVE.value,
                        serialized_joined_at,
                        room_id,
                        identity.agent_id,
                    ),
                )
            row = connection.execute(
                "SELECT * FROM room_memberships WHERE room_id = ? AND agent_id = ?",
                (room_id, identity.agent_id),
            ).fetchone()
            return self._membership(row)

    def list_rooms(self, identity: RuntimeIdentity) -> tuple[RoomSummary, ...]:
        with self._connect() as connection:
            self._require_identity(connection, identity)
            rows = connection.execute(
                """
                SELECT
                    r.room_id, r.name, r.status, r.updated_at, r.latest_sequence,
                    m.status AS membership_status, m.last_read_sequence
                FROM room_memberships AS m
                JOIN rooms AS r ON r.room_id = m.room_id
                WHERE m.agent_id = ? AND m.principal_id = ?
                ORDER BY r.updated_at DESC, r.room_id ASC
                """,
                (identity.agent_id, identity.principal_id),
            ).fetchall()
        return tuple(
            RoomSummary(
                room_id=row["room_id"],
                name=row["name"],
                status=RoomStatus(row["status"]),
                membership_status=MembershipStatus(row["membership_status"]),
                latest_activity_at=_parse_timestamp(row["updated_at"]),
                unread_count=max(0, row["latest_sequence"] - row["last_read_sequence"]),
                latest_cursor=format_cursor(row["latest_sequence"]),
                last_read_cursor=format_cursor(row["last_read_sequence"]),
            )
            for row in rows
        )

    def get_room(
        self,
        identity: RuntimeIdentity,
        room_id: str,
    ) -> tuple[Room, tuple[Membership, ...]]:
        with self._connect() as connection:
            self._require_identity(connection, identity)
            room_row = self._room_row(connection, room_id)
            membership_row = connection.execute(
                """
                SELECT 1 FROM room_memberships
                WHERE room_id = ? AND agent_id = ? AND principal_id = ? AND status = ?
                """,
                (room_id, identity.agent_id, identity.principal_id, MembershipStatus.ACTIVE.value),
            ).fetchone()
            if membership_row is None:
                raise _error("not_a_room_member", "active room membership is required", 403)
            membership_rows = connection.execute(
                """
                SELECT * FROM room_memberships
                WHERE room_id = ?
                ORDER BY joined_at ASC, agent_id ASC
                """,
                (room_id,),
            ).fetchall()
        return self._room(room_row), tuple(self._membership(row) for row in membership_rows)

    def leave_room(self, identity: RuntimeIdentity, room_id: str) -> Membership:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_identity(connection, identity)
            room_row = self._room_row(connection, room_id)
            if room_row["status"] == RoomStatus.CLOSED.value:
                raise _error("room_closed", "room is closed", 409)
            membership_row = connection.execute(
                "SELECT * FROM room_memberships WHERE room_id = ? AND agent_id = ? AND principal_id = ?",
                (room_id, identity.agent_id, identity.principal_id),
            ).fetchone()
            if membership_row is None or membership_row["status"] != MembershipStatus.ACTIVE.value:
                raise _error("not_a_room_member", "active room membership is required", 403)
            left_at = self.clock()
            connection.execute(
                """
                UPDATE room_memberships
                SET status = ?, left_at = ?
                WHERE room_id = ? AND agent_id = ?
                """,
                (MembershipStatus.LEFT.value, _timestamp(left_at), room_id, identity.agent_id),
            )
            row = connection.execute(
                "SELECT * FROM room_memberships WHERE room_id = ? AND agent_id = ?",
                (room_id, identity.agent_id),
            ).fetchone()
            return self._membership(row)

    def close_room(self, identity: RuntimeIdentity, room_id: str) -> Room:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_identity(connection, identity)
            room_row = self._room_row(connection, room_id)
            if room_row["creator_agent_id"] != identity.agent_id:
                raise _error("room_owner_required", "only the creator agent may close the room", 403)
            if room_row["status"] == RoomStatus.CLOSED.value:
                raise _error("room_closed", "room is already closed", 409)
            updated_at = self.clock()
            connection.execute(
                "UPDATE rooms SET status = ?, updated_at = ? WHERE room_id = ?",
                (RoomStatus.CLOSED.value, _timestamp(updated_at), room_id),
            )
            updated_row = connection.execute(
                "SELECT * FROM rooms WHERE room_id = ?",
                (room_id,),
            ).fetchone()
            return self._room(updated_row)

    def post_message(
        self,
        identity: RuntimeIdentity | ActorIdentity,
        room_id: str,
        content: str,
        reply_to: str | None,
        tags: tuple[CoordinationTag, ...],
        attachment_ids: tuple[str, ...],
    ) -> Message:
        message_id = _new_id("message_")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_identity(connection, identity)
            room_row = self._room_row(connection, room_id)
            self._require_active_membership(connection, identity, room_id)
            if room_row["status"] == RoomStatus.CLOSED.value:
                raise _error("room_closed", "room is closed", 409)
            if reply_to is not None:
                reply_row = connection.execute(
                    "SELECT room_id FROM messages WHERE message_id = ?",
                    (reply_to,),
                ).fetchone()
                if reply_row is None or reply_row["room_id"] != room_id:
                    raise _error("invalid_reply", "reply must reference a message in the same room", 400)
            seen_attachment_ids: set[str] = set()
            for attachment_id in attachment_ids:
                if not isinstance(attachment_id, str) or attachment_id in seen_attachment_ids:
                    raise _error(
                        "invalid_attachment",
                        "attachments must be unique artifacts in the same room",
                        400,
                    )
                seen_attachment_ids.add(attachment_id)
                artifact_row = connection.execute(
                    "SELECT room_id FROM artifacts WHERE artifact_id = ?",
                    (attachment_id,),
                ).fetchone()
                if artifact_row is None or artifact_row["room_id"] != room_id:
                    raise _error(
                        "invalid_attachment",
                        "attachment must reference an artifact in the same room",
                        400,
                    )

            sequence = connection.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 FROM messages WHERE room_id = ?",
                (room_id,),
            ).fetchone()[0]
            created_at = self.clock()
            state = ResolutionState.PENDING if tags else ResolutionState.NOT_REQUIRED
            message = Message(
                message_id=message_id,
                room_id=room_id,
                sequence=sequence,
                sender=identity,
                content=content,
                reply_to=reply_to,
                tags=tags,
                attachment_ids=attachment_ids,
                created_at=created_at,
                resolution_state=state,
            )
            tags_json = json.dumps(
                [tag.to_dict() for tag in message.tags],
                sort_keys=True,
                separators=(",", ":"),
            )
            attachments_json = json.dumps(list(message.attachment_ids), separators=(",", ":"))
            serialized_created_at = _timestamp(created_at)
            connection.execute(
                """
                INSERT INTO messages(
                    message_id, room_id, sequence,
                    sender_principal_id, sender_agent_id, sender_runtime_id,
                    sender_instance_id,
                    content, reply_to, tags_json, attachment_ids_json,
                    created_at, resolution_state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message.message_id,
                    message.room_id,
                    message.sequence,
                    identity.principal_id,
                    identity.agent_id,
                    identity.runtime_id,
                    getattr(identity, "instance_id", None),
                    message.content,
                    message.reply_to,
                    tags_json,
                    attachments_json,
                    serialized_created_at,
                    state.value,
                ),
            )
            for position, attachment_id in enumerate(message.attachment_ids):
                connection.execute(
                    """
                    INSERT INTO message_artifacts(message_id, artifact_id, position)
                    VALUES (?, ?, ?)
                    """,
                    (message.message_id, attachment_id, position),
                )
            for tag in message.tags:
                connection.execute(
                    """
                    INSERT INTO message_obligations(
                        obligation_id, message_id, tag_raw, tag_kind, target_id, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _new_id("obligation_"),
                        message.message_id,
                        tag.raw,
                        tag.kind,
                        tag.target_id,
                        serialized_created_at,
                    ),
                )
            connection.execute(
                "UPDATE rooms SET latest_sequence = ?, updated_at = ? WHERE room_id = ?",
                (message.sequence, serialized_created_at, room_id),
            )
        return message

    def require_artifact_upload_access(
        self,
        identity: RuntimeIdentity,
        room_id: str,
    ) -> None:
        with self._connect() as connection:
            self._require_identity(connection, identity)
            room_row = self._room_row(connection, room_id)
            self._require_active_membership(connection, identity, room_id)
            if room_row["status"] == RoomStatus.CLOSED.value:
                raise _error("room_closed", "room is closed", 409)

    def create_artifact(
        self,
        identity: RuntimeIdentity,
        room_id: str,
        filename: str,
        media_type: str,
        size_bytes: int,
        sha256: str,
    ) -> Artifact:
        artifact_id = _new_id("artifact_")
        created_at = self.clock()
        artifact = Artifact(
            artifact_id=artifact_id,
            room_id=room_id,
            filename=filename,
            media_type=media_type,
            size_bytes=size_bytes,
            sha256=sha256,
            created_at=created_at,
        )
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_identity(connection, identity)
            room_row = self._room_row(connection, room_id)
            self._require_active_membership(connection, identity, room_id)
            if room_row["status"] == RoomStatus.CLOSED.value:
                raise _error("room_closed", "room is closed", 409)
            connection.execute(
                """
                INSERT INTO artifacts(
                    artifact_id, room_id,
                    uploader_principal_id, uploader_agent_id, uploader_runtime_id,
                    filename, media_type, size_bytes, sha256, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact.artifact_id,
                    artifact.room_id,
                    identity.principal_id,
                    identity.agent_id,
                    identity.runtime_id,
                    artifact.filename,
                    artifact.media_type,
                    artifact.size_bytes,
                    artifact.sha256,
                    _timestamp(artifact.created_at),
                ),
            )
        return artifact

    def get_artifact(
        self,
        identity: RuntimeIdentity,
        room_id: str,
        artifact_id: str,
    ) -> Artifact:
        with self._connect() as connection:
            self._require_identity(connection, identity)
            self._room_row(connection, room_id)
            self._require_active_membership(connection, identity, room_id)
            row = connection.execute(
                "SELECT * FROM artifacts WHERE artifact_id = ? AND room_id = ?",
                (artifact_id, room_id),
            ).fetchone()
            if row is None:
                raise _error(
                    "artifact_not_found",
                    "artifact does not exist in this room",
                    404,
                )
        return self._artifact(row)

    def retrieve_messages(
        self,
        identity: RuntimeIdentity,
        room_id: str,
        after_sequence: int,
        limit: int,
    ) -> MessagePage:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_identity(connection, identity)
            self._room_row(connection, room_id)
            self._require_active_membership(connection, identity, room_id)
            rows = connection.execute(
                """
                SELECT * FROM messages
                WHERE room_id = ? AND sequence > ?
                ORDER BY sequence ASC
                LIMIT ?
                """,
                (room_id, after_sequence, limit),
            ).fetchall()
            messages = tuple(self._message(row) for row in rows)
            if messages:
                greatest_sequence = messages[-1].sequence
                connection.execute(
                    """
                    UPDATE room_memberships
                    SET last_read_sequence = MAX(last_read_sequence, ?)
                    WHERE room_id = ? AND agent_id = ? AND principal_id = ?
                    """,
                    (greatest_sequence, room_id, identity.agent_id, identity.principal_id),
                )
                next_sequence = greatest_sequence
            else:
                next_sequence = after_sequence
        return MessagePage(messages, format_cursor(next_sequence), limit)

    def resolve_message(
        self,
        identity: RuntimeIdentity,
        room_id: str,
        message_id: str,
        outcome: str,
        evidence: str | None,
    ) -> Message:
        if outcome not in ("fulfilled", "rejected"):
            raise _error("invalid_outcome", "outcome must be fulfilled or rejected", 400)
        if evidence is not None and (not isinstance(evidence, str) or len(evidence) > 100000):
            raise _error("invalid_evidence", "evidence must be text of at most 100000 characters", 400)

        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_identity(connection, identity)
            room_row = self._room_row(connection, room_id)
            self._require_active_membership(connection, identity, room_id)
            message_row = connection.execute(
                "SELECT * FROM messages WHERE message_id = ? AND room_id = ?",
                (message_id, room_id),
            ).fetchone()
            if message_row is None:
                raise _error("message_not_found", "message does not exist in this room", 404)
            if message_row["resolution_state"] != ResolutionState.PENDING.value:
                raise _error("message_already_resolved", "message resolution is already terminal", 409)

            pending_rows = connection.execute(
                """
                SELECT o.*
                FROM message_obligations AS o
                LEFT JOIN message_resolutions AS r ON r.obligation_id = o.obligation_id
                WHERE o.message_id = ? AND r.resolution_id IS NULL
                ORDER BY o.rowid
                """,
                (message_id,),
            ).fetchall()
            eligible = [
                row
                for row in pending_rows
                if self._can_resolve_obligation(identity, room_row, message_row, row)
            ]
            if not eligible:
                raise _error(
                    "resolver_not_authorized",
                    "resolver is not authorized for a pending obligation",
                    403,
                )

            resolved_at = self.clock()
            serialized_resolved_at = _timestamp(resolved_at)
            for obligation_row in eligible:
                connection.execute(
                    """
                    INSERT INTO message_resolutions(
                        resolution_id, obligation_id, message_id,
                        resolver_principal_id, resolver_agent_id, resolver_runtime_id,
                        outcome, evidence, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _new_id("resolution_"),
                        obligation_row["obligation_id"],
                        message_id,
                        identity.principal_id,
                        identity.agent_id,
                        identity.runtime_id,
                        outcome,
                        evidence,
                        serialized_resolved_at,
                    ),
                )

            aggregate_rows = connection.execute(
                """
                SELECT r.outcome
                FROM message_obligations AS o
                LEFT JOIN message_resolutions AS r ON r.obligation_id = o.obligation_id
                WHERE o.message_id = ?
                """,
                (message_id,),
            ).fetchall()
            outcomes = [row["outcome"] for row in aggregate_rows]
            if "rejected" in outcomes:
                state = ResolutionState.REJECTED
            elif outcomes and all(value == "fulfilled" for value in outcomes):
                state = ResolutionState.RESOLVED
            else:
                state = ResolutionState.PENDING
            connection.execute(
                "UPDATE messages SET resolution_state = ? WHERE message_id = ?",
                (state.value, message_id),
            )
            updated_row = connection.execute(
                "SELECT * FROM messages WHERE message_id = ?",
                (message_id,),
            ).fetchone()
            return self._message(updated_row)

    @staticmethod
    def _can_resolve_obligation(
        identity: RuntimeIdentity,
        room_row: sqlite3.Row,
        message_row: sqlite3.Row,
        obligation_row: sqlite3.Row,
    ) -> bool:
        if obligation_row["tag_kind"] == "human_review":
            return (
                identity.principal_id == room_row["creator_principal_id"]
                and identity.agent_id != message_row["sender_agent_id"]
            )
        if obligation_row["tag_kind"] == "verification":
            return identity.agent_id != message_row["sender_agent_id"]
        return (
            identity.agent_id == obligation_row["target_id"]
            or identity.principal_id == obligation_row["target_id"]
        )

    def _require_active_membership(
        self,
        connection: sqlite3.Connection,
        identity: RuntimeIdentity,
        room_id: str,
    ) -> sqlite3.Row:
        row = connection.execute(
            """
            SELECT * FROM room_memberships
            WHERE room_id = ? AND agent_id = ? AND principal_id = ? AND status = ?
            """,
            (room_id, identity.agent_id, identity.principal_id, MembershipStatus.ACTIVE.value),
        ).fetchone()
        if row is None:
            raise _error("not_a_room_member", "active room membership is required", 403)
        return row

    @staticmethod
    def _message(row: sqlite3.Row) -> Message:
        tags = tuple(CoordinationTag(**item) for item in json.loads(row["tags_json"]))
        if row["sender_instance_id"] is None:
            identity: RuntimeIdentity | ActorIdentity = RuntimeIdentity(
                row["sender_principal_id"],
                row["sender_agent_id"],
                row["sender_runtime_id"],
            )
        else:
            from ..control.models import ActorIdentity

            identity = ActorIdentity(
                row["sender_principal_id"],
                row["sender_agent_id"],
                row["sender_runtime_id"],
                row["sender_instance_id"],
            )
        return Message(
            message_id=row["message_id"],
            room_id=row["room_id"],
            sequence=row["sequence"],
            sender=identity,
            content=row["content"],
            reply_to=row["reply_to"],
            tags=tags,
            attachment_ids=tuple(json.loads(row["attachment_ids_json"])),
            created_at=_parse_timestamp(row["created_at"]),
            resolution_state=ResolutionState(row["resolution_state"]),
        )

    @staticmethod
    def _artifact(row: sqlite3.Row) -> Artifact:
        return Artifact(
            artifact_id=row["artifact_id"],
            room_id=row["room_id"],
            filename=row["filename"],
            media_type=row["media_type"],
            size_bytes=row["size_bytes"],
            sha256=row["sha256"],
            created_at=_parse_timestamp(row["created_at"]),
        )

    def _room_row(self, connection: sqlite3.Connection, room_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM rooms WHERE room_id = ?", (room_id,)).fetchone()
        if row is None:
            raise _error("room_not_found", "room does not exist", 404)
        return row

    @staticmethod
    def _room(row: sqlite3.Row) -> Room:
        if row["creator_instance_id"] is None:
            identity: RuntimeIdentity | ActorIdentity = RuntimeIdentity(
                row["creator_principal_id"],
                row["creator_agent_id"],
                row["creator_runtime_id"],
            )
        else:
            from ..control.models import ActorIdentity

            identity = ActorIdentity(
                row["creator_principal_id"],
                row["creator_agent_id"],
                row["creator_runtime_id"],
                row["creator_instance_id"],
            )
        return Room(
            room_id=row["room_id"],
            name=row["name"],
            description=row["description"],
            creator=identity,
            access_policy=row["access_policy"],
            status=RoomStatus(row["status"]),
            created_at=_parse_timestamp(row["created_at"]),
            updated_at=_parse_timestamp(row["updated_at"]),
        )

    @staticmethod
    def _membership(row: sqlite3.Row) -> Membership:
        return Membership(
            room_id=row["room_id"],
            principal_id=row["principal_id"],
            agent_id=row["agent_id"],
            status=MembershipStatus(row["status"]),
            joined_at=_parse_timestamp(row["joined_at"]),
            left_at=_parse_timestamp(row["left_at"]) if row["left_at"] is not None else None,
            last_read_sequence=row["last_read_sequence"],
        )
