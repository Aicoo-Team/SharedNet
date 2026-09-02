"""Additive SQLite persistence for SharedNet V1 control-plane state.

The service layer depends on this focused store instead of issuing SQL itself. That
keeps the public identity and protocol contracts portable to a future Postgres/
Neon adapter while SQLite remains the V1 local/demo persistence implementation.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

from ..room.store import RoomStore


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


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


class ControlStore:
    """SQLite implementation of the V1 control-plane persistence boundary."""

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
        RoomStore(self.database_path, self.clock).initialize()
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS account_principals (
                    auth_user_id TEXT PRIMARY KEY,
                    principal_id TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (principal_id) REFERENCES principals(principal_id)
                );

                CREATE TABLE IF NOT EXISTS principal_connector_credentials (
                    credential_id TEXT PRIMARY KEY,
                    principal_id TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
                    created_at TEXT NOT NULL,
                    revoked_at TEXT,
                    FOREIGN KEY (principal_id) REFERENCES principals(principal_id)
                );

                CREATE INDEX IF NOT EXISTS connector_credentials_principal_idx
                    ON principal_connector_credentials(principal_id, status);

                CREATE TABLE IF NOT EXISTS pairing_challenges (
                    pairing_id TEXT PRIMARY KEY,
                    challenge_hash TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'claimed', 'approved', 'denied', 'exchanged', 'expired')
                    ),
                    claimed_principal_id TEXT,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    FOREIGN KEY (claimed_principal_id) REFERENCES principals(principal_id)
                );

                CREATE INDEX IF NOT EXISTS pairing_challenges_expiry_idx
                    ON pairing_challenges(status, expires_at);

                CREATE TABLE IF NOT EXISTS principal_profiles (
                    principal_id TEXT PRIMARY KEY,
                    seed_key TEXT UNIQUE,
                    diagnostic_label TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (principal_id) REFERENCES principals(principal_id)
                );

                CREATE TABLE IF NOT EXISTS agent_profiles (
                    agent_id TEXT PRIMARY KEY,
                    seed_key TEXT UNIQUE,
                    diagnostic_label TEXT NOT NULL,
                    role TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    runtime_kind TEXT NOT NULL,
                    capabilities_json TEXT NOT NULL,
                    discoverability INTEGER NOT NULL DEFAULT 0 CHECK (discoverability IN (0, 1)),
                    official INTEGER NOT NULL DEFAULT 0 CHECK (official IN (0, 1)),
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
                );

                CREATE TABLE IF NOT EXISTS principal_connections (
                    connection_id TEXT PRIMARY KEY,
                    left_principal_id TEXT NOT NULL,
                    right_principal_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    CHECK (left_principal_id <> right_principal_id),
                    UNIQUE (left_principal_id, right_principal_id),
                    FOREIGN KEY (left_principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (right_principal_id) REFERENCES principals(principal_id)
                );

                CREATE TABLE IF NOT EXISTS agent_instances (
                    instance_id TEXT PRIMARY KEY,
                    principal_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    runtime_id TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    provider_session_id TEXT,
                    runtime_type TEXT NOT NULL,
                    workspace_label TEXT,
                    capabilities_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('online', 'ended')),
                    started_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    ended_at TEXT,
                    FOREIGN KEY (principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (agent_id, principal_id) REFERENCES agents(agent_id, principal_id),
                    FOREIGN KEY (runtime_id) REFERENCES runtime_registrations(runtime_id)
                );

                CREATE INDEX IF NOT EXISTS agent_instances_agent_idx
                    ON agent_instances(agent_id, status, expires_at);
                CREATE INDEX IF NOT EXISTS agent_instances_runtime_idx
                    ON agent_instances(runtime_id, started_at);

                CREATE TABLE IF NOT EXISTS human_decisions (
                    decision_id TEXT PRIMARY KEY,
                    pairing_id TEXT,
                    room_id TEXT,
                    target_principal_id TEXT NOT NULL,
                    requester_principal_id TEXT,
                    requester_agent_id TEXT,
                    requester_runtime_id TEXT,
                    requester_instance_id TEXT,
                    response_mode TEXT NOT NULL CHECK (response_mode IN ('approval', 'text')),
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    consequence TEXT,
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'approved', 'denied', 'answered')
                    ),
                    response_text TEXT,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    FOREIGN KEY (pairing_id) REFERENCES pairing_challenges(pairing_id),
                    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
                    FOREIGN KEY (target_principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (requester_principal_id) REFERENCES principals(principal_id),
                    FOREIGN KEY (requester_agent_id, requester_principal_id)
                        REFERENCES agents(agent_id, principal_id),
                    FOREIGN KEY (requester_runtime_id) REFERENCES runtime_registrations(runtime_id),
                    FOREIGN KEY (requester_instance_id) REFERENCES agent_instances(instance_id)
                );

                CREATE INDEX IF NOT EXISTS human_decisions_target_idx
                    ON human_decisions(target_principal_id, status, created_at);
                """
            )
