"""Transactional SQLite persistence for Room identities and membership."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
import hashlib
import hmac
from pathlib import Path
import secrets
import sqlite3

from .errors import RoomError
from .models import (
    Membership,
    MembershipStatus,
    Room,
    RoomStatus,
    RoomSummary,
    RuntimeIdentity,
    RuntimeRegistration,
    format_cursor,
)


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
                """
            )

    def register_runtime(
        self,
        principal_id: str,
        agent_id: str,
        requested_runtime_id: str | None,
    ) -> tuple[RuntimeRegistration, str]:
        runtime_id = requested_runtime_id if requested_runtime_id is not None else _new_id("runtime_")
        identity = RuntimeIdentity(principal_id, agent_id, runtime_id)
        created_at = self.clock()
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()

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
        identity: RuntimeIdentity,
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

    def create_room(
        self,
        identity: RuntimeIdentity,
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
                    access_policy, status, created_at, updated_at, latest_sequence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    room.room_id,
                    room.name,
                    room.description,
                    identity.principal_id,
                    identity.agent_id,
                    identity.runtime_id,
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
            self._room_row(connection, room_id)
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

    def _room_row(self, connection: sqlite3.Connection, room_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM rooms WHERE room_id = ?", (room_id,)).fetchone()
        if row is None:
            raise _error("room_not_found", "room does not exist", 404)
        return row

    @staticmethod
    def _room(row: sqlite3.Row) -> Room:
        identity = RuntimeIdentity(
            row["creator_principal_id"],
            row["creator_agent_id"],
            row["creator_runtime_id"],
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
