"""Additive SQLite persistence for SharedNet V1 control-plane state.

The service layer depends on this focused store instead of issuing SQL itself. That
keeps the public identity and protocol contracts portable to a future Postgres/
Neon adapter while SQLite remains the V1 local/demo persistence implementation.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import sqlite3

from ..identity import is_typed_id, new_agent_id, new_instance_id, new_principal_id, new_runtime_id
from ..room.models import RuntimeIdentity
from ..room.store import RoomStore
from .models import (
    ActorIdentity,
    AgentBinding,
    AgentInstance,
    ConnectorSession,
    ControlError,
    DecisionMode,
    DecisionStatus,
    HumanDecision,
    InstanceSession,
    InstanceStatus,
    PairingChallenge,
    PairingStatus,
    RuntimeBinding,
    RuntimeSession,
)


_GENERATED_ID_ATTEMPTS = 8

_DEMO_OWNER_AGENTS = (
    (
        "planner",
        "Planner",
        "Planning Agent",
        "Turns outcomes into task graphs and decides when the network helps.",
        ("task planning", "candidate selection", "coordination"),
        0,
    ),
    (
        "codex",
        "Codex",
        "Implementation Agent",
        "Owns the repository and integrates specialist contributions.",
        ("coding", "integration", "tests"),
        1,
    ),
    (
        "research",
        "Research",
        "Research Agent",
        "Collects product context and primary implementation evidence.",
        ("web research", "API research", "synthesis"),
        1,
    ),
    (
        "reviewer",
        "Reviewer",
        "Independent Verifier",
        "Checks evidence without inheriting the builder’s assumptions.",
        ("code review", "acceptance tests", "risk checks"),
        0,
    ),
)

_DEMO_AICOO_AGENTS = (
    (
        "web-builder",
        "Web Builder",
        "Website Specialist",
        "Builds production-oriented web products from a concise outcome.",
        ("Next.js", "product implementation", "responsive UI"),
    ),
    (
        "design-engineer",
        "Design Engineer",
        "Interface Specialist",
        "Shapes clear interaction systems and production-ready interface code.",
        ("interaction design", "design systems", "accessibility"),
    ),
    (
        "neon",
        "Neon",
        "Database Specialist",
        "Designs Neon schemas, migrations, and least-privilege integration plans.",
        ("Postgres", "Neon API", "schema design"),
    ),
    (
        "vercel",
        "Vercel",
        "Deployment Specialist",
        "Prepares Vercel projects, environment bindings, and deployment checks.",
        ("Vercel API", "deployments", "environment variables"),
    ),
    (
        "quality",
        "Quality",
        "Launch Verifier",
        "Independently verifies behavior, accessibility, and launch readiness.",
        ("browser QA", "accessibility", "release evidence"),
    ),
)

def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id(prefix: str) -> str:
    return f"{prefix}{secrets.token_urlsafe(18).lower().replace('-', '_')}"


def _hash_secret(raw_secret: str) -> str:
    return hashlib.sha256(raw_secret.encode("utf-8")).hexdigest()


def _timestamp(value: datetime) -> str:
    return value.isoformat()


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _error(code: str, message: str, status_code: int) -> ControlError:
    return ControlError(code, message, status_code)


def _require_demo_seed_id(value: object, prefix: str, identity_name: str) -> str:
    if not is_typed_id(value, prefix):
        raise _error(
            "demo_seed_conflict",
            f"demo seed {identity_name} identity is not an opaque SharedNet ID",
            409,
        )
    return str(value)


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
                    credential_status TEXT NOT NULL DEFAULT 'active'
                        CHECK (credential_status IN ('active', 'revoked')),
                    provider_session_id TEXT,
                    runtime_type TEXT NOT NULL,
                    workspace_label TEXT,
                    capabilities_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('online', 'ended')),
                    started_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    ended_at TEXT,
                    revoked_at TEXT,
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
            self._add_column_if_missing(
                connection,
                "runtime_registrations",
                "runtime_kind",
                "TEXT",
            )
            self._add_column_if_missing(
                connection,
                "runtime_registrations",
                "workspace_label",
                "TEXT",
            )
            self._add_column_if_missing(
                connection,
                "runtime_registrations",
                "credential_status",
                "TEXT NOT NULL DEFAULT 'active'",
            )
            self._add_column_if_missing(
                connection,
                "runtime_registrations",
                "revoked_at",
                "TEXT",
            )
            self._add_column_if_missing(
                connection,
                "agent_instances",
                "credential_status",
                "TEXT NOT NULL DEFAULT 'active'",
            )
            self._add_column_if_missing(
                connection,
                "agent_instances",
                "revoked_at",
                "TEXT",
            )

    @staticmethod
    def _add_column_if_missing(
        connection: sqlite3.Connection,
        table_name: str,
        column_name: str,
        declaration: str,
    ) -> None:
        columns = {
            row["name"]
            for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall()
        }
        if column_name not in columns:
            connection.execute(
                f"ALTER TABLE {table_name} ADD COLUMN {column_name} {declaration}"
            )

    @staticmethod
    def _validate_auth_user_id(auth_user_id: object) -> str:
        if (
            not isinstance(auth_user_id, str)
            or not auth_user_id.strip()
            or len(auth_user_id) > 255
        ):
            raise _error(
                "invalid_auth_user_id",
                "auth_user_id must be a non-empty string of at most 255 characters",
                400,
            )
        return auth_user_id

    def _provision_principal_in_connection(
        self,
        connection: sqlite3.Connection,
        auth_user_id: str,
        created_at: datetime,
    ) -> str:
        existing = connection.execute(
            "SELECT principal_id FROM account_principals WHERE auth_user_id = ?",
            (auth_user_id,),
        ).fetchone()
        if existing is not None:
            return existing["principal_id"]

        for _ in range(_GENERATED_ID_ATTEMPTS):
            principal_id = new_principal_id()
            collision = connection.execute(
                "SELECT 1 FROM principals WHERE principal_id = ?",
                (principal_id,),
            ).fetchone()
            if collision is not None:
                continue
            serialized = _timestamp(created_at)
            connection.execute(
                "INSERT INTO principals(principal_id, created_at) VALUES (?, ?)",
                (principal_id, serialized),
            )
            connection.execute(
                """
                INSERT INTO account_principals(auth_user_id, principal_id, created_at)
                VALUES (?, ?, ?)
                """,
                (auth_user_id, principal_id, serialized),
            )
            return principal_id

        raise _error(
            "principal_id_conflict",
            "could not allocate a unique Principal ID",
            409,
        )

    def provision_principal(self, auth_user_id: str) -> str:
        """Idempotently map one Better Auth user ID to one opaque Principal."""

        validated_user_id = self._validate_auth_user_id(auth_user_id)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            return self._provision_principal_in_connection(
                connection,
                validated_user_id,
                self.clock(),
            )

    @staticmethod
    def _seed_principal_profile_in_connection(
        connection: sqlite3.Connection,
        principal_id: str,
        seed_key: str,
        diagnostic_label: str,
        kind: str,
        summary: str,
        created_at: str,
    ) -> None:
        _require_demo_seed_id(principal_id, "p", "Principal")
        seed_owner = connection.execute(
            "SELECT principal_id FROM principal_profiles WHERE seed_key = ?",
            (seed_key,),
        ).fetchone()
        if seed_owner is not None and seed_owner["principal_id"] != principal_id:
            raise _error(
                "demo_seed_conflict",
                "demo Principal seed key belongs to another Principal",
                409,
            )
        try:
            connection.execute(
                """
                INSERT INTO principal_profiles(
                    principal_id, seed_key, diagnostic_label, kind, summary, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(principal_id) DO UPDATE SET
                    seed_key = excluded.seed_key,
                    diagnostic_label = excluded.diagnostic_label,
                    kind = excluded.kind,
                    summary = excluded.summary
                """,
                (
                    principal_id,
                    seed_key,
                    diagnostic_label,
                    kind,
                    summary,
                    created_at,
                ),
            )
        except sqlite3.IntegrityError:
            raise _error(
                "demo_seed_conflict",
                "demo Principal profile conflicts with existing data",
                409,
            ) from None

    @staticmethod
    def _seed_agent_in_connection(
        connection: sqlite3.Connection,
        principal_id: str,
        seed_key: str,
        diagnostic_label: str,
        role: str,
        summary: str,
        runtime_kind: str,
        capabilities: tuple[str, ...],
        discoverability: int,
        official: int,
        created_at: str,
    ) -> str:
        _require_demo_seed_id(principal_id, "p", "Principal")
        existing = connection.execute(
            """
            SELECT agent.agent_id, agent.principal_id
            FROM agent_profiles AS profile
            JOIN agents AS agent ON agent.agent_id = profile.agent_id
            WHERE profile.seed_key = ?
            """,
            (seed_key,),
        ).fetchone()
        serialized_capabilities = json.dumps(capabilities, separators=(",", ":"))
        if existing is not None:
            existing_agent_id = _require_demo_seed_id(
                existing["agent_id"],
                "a",
                "Agent",
            )
            existing_principal_id = _require_demo_seed_id(
                existing["principal_id"],
                "p",
                "Principal",
            )
            if existing_principal_id != principal_id:
                raise _error(
                    "demo_seed_conflict",
                    "demo Agent seed key belongs to another Principal",
                    409,
                )
            connection.execute(
                """
                UPDATE agent_profiles
                SET diagnostic_label = ?, role = ?, summary = ?, runtime_kind = ?,
                    capabilities_json = ?, discoverability = ?, official = ?
                WHERE agent_id = ?
                """,
                (
                    diagnostic_label,
                    role,
                    summary,
                    runtime_kind,
                    serialized_capabilities,
                    discoverability,
                    official,
                    existing_agent_id,
                ),
            )
            return existing_agent_id

        for _ in range(_GENERATED_ID_ATTEMPTS):
            agent_id = _require_demo_seed_id(new_agent_id(), "a", "Agent")
            if connection.execute(
                "SELECT 1 FROM agents WHERE agent_id = ?",
                (agent_id,),
            ).fetchone() is not None:
                continue
            connection.execute(
                "INSERT INTO agents(agent_id, principal_id, created_at) VALUES (?, ?, ?)",
                (agent_id, principal_id, created_at),
            )
            connection.execute(
                """
                INSERT INTO agent_profiles(
                    agent_id, seed_key, diagnostic_label, role, summary,
                    runtime_kind, capabilities_json, discoverability,
                    official, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    agent_id,
                    seed_key,
                    diagnostic_label,
                    role,
                    summary,
                    runtime_kind,
                    serialized_capabilities,
                    discoverability,
                    official,
                    created_at,
                ),
            )
            return agent_id

        raise _error("agent_id_conflict", "could not allocate a unique Agent ID", 409)

    @staticmethod
    def _seed_principal_connection_in_connection(
        connection: sqlite3.Connection,
        principal_id: str,
        connected_principal_id: str,
        created_at: str,
    ) -> int:
        left_principal_id, right_principal_id = sorted(
            (
                _require_demo_seed_id(principal_id, "p", "Principal"),
                _require_demo_seed_id(
                    connected_principal_id,
                    "p",
                    "Principal",
                ),
            )
        )
        if left_principal_id == right_principal_id:
            raise _error(
                "demo_seed_conflict",
                "demo Principal connection cannot connect a Principal to itself",
                409,
            )

        existing = connection.execute(
            """
            SELECT connection_id, left_principal_id, right_principal_id
            FROM principal_connections
            WHERE (left_principal_id = ? AND right_principal_id = ?)
               OR (left_principal_id = ? AND right_principal_id = ?)
            ORDER BY connection_id
            """,
            (
                left_principal_id,
                right_principal_id,
                right_principal_id,
                left_principal_id,
            ),
        ).fetchall()
        if len(existing) > 1:
            raise _error(
                "demo_seed_conflict",
                "demo Principal connection exists in both orientations",
                409,
            )
        if existing:
            row = existing[0]
            if row["left_principal_id"] != left_principal_id:
                try:
                    connection.execute(
                        """
                        UPDATE principal_connections
                        SET left_principal_id = ?, right_principal_id = ?
                        WHERE connection_id = ?
                        """,
                        (
                            left_principal_id,
                            right_principal_id,
                            row["connection_id"],
                        ),
                    )
                except sqlite3.IntegrityError:
                    raise _error(
                        "demo_seed_conflict",
                        "demo Principal connection conflicts with existing data",
                        409,
                    ) from None
            return 1

        connection.execute(
            """
            INSERT INTO principal_connections(
                connection_id, left_principal_id, right_principal_id, created_at
            ) VALUES (?, ?, ?, ?)
            """,
            (
                _new_id("connection_"),
                left_principal_id,
                right_principal_id,
                created_at,
            ),
        )
        return 1

    def seed_demo_account(self, auth_user_id: str) -> dict[str, object]:
        """Seed truthful account-scoped profiles in one idempotent transaction."""

        validated_user_id = self._validate_auth_user_id(auth_user_id)
        created_at = self.clock()
        serialized_created_at = _timestamp(created_at)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            aicoo = connection.execute(
                """
                SELECT principal_id
                FROM principal_profiles
                WHERE seed_key = 'demo.aicoo.principal'
                """
            ).fetchone()
            connected_principal_id: str | None = None
            if aicoo is not None:
                connected_principal_id = _require_demo_seed_id(
                    aicoo["principal_id"],
                    "p",
                    "Aicoo Principal",
                )
                account_owner = connection.execute(
                    "SELECT 1 FROM account_principals WHERE principal_id = ?",
                    (connected_principal_id,),
                ).fetchone()
                if account_owner is not None:
                    raise _error(
                        "demo_seed_conflict",
                        "Aicoo demo Principal is mapped to an account",
                        409,
                    )

            principal_id = _require_demo_seed_id(
                self._provision_principal_in_connection(
                    connection,
                    validated_user_id,
                    created_at,
                ),
                "p",
                "owner Principal",
            )
            self._seed_principal_profile_in_connection(
                connection,
                principal_id,
                f"demo.owner.{principal_id}.principal",
                "Your account",
                "self",
                "Your identity, policies, and persistent Agents.",
                serialized_created_at,
            )

            if connected_principal_id is None:
                for _ in range(_GENERATED_ID_ATTEMPTS):
                    candidate = _require_demo_seed_id(
                        new_principal_id(),
                        "p",
                        "Aicoo Principal",
                    )
                    if connection.execute(
                        "SELECT 1 FROM principals WHERE principal_id = ?",
                        (candidate,),
                    ).fetchone() is not None:
                        continue
                    connected_principal_id = candidate
                    connection.execute(
                        "INSERT INTO principals(principal_id, created_at) VALUES (?, ?)",
                        (connected_principal_id, serialized_created_at),
                    )
                    break
                if connected_principal_id is None:
                    raise _error(
                        "principal_id_conflict",
                        "could not allocate a unique Principal ID",
                        409,
                    )
            self._seed_principal_profile_in_connection(
                connection,
                connected_principal_id,
                "demo.aicoo.principal",
                "Aicoo",
                "connected",
                "A connected company Principal with discoverable specialist Agents.",
                serialized_created_at,
            )

            owner_agent_ids = []
            for slug, label, role, summary, capabilities, discoverability in (
                _DEMO_OWNER_AGENTS
            ):
                owner_agent_ids.append(
                    self._seed_agent_in_connection(
                        connection,
                        principal_id,
                        f"demo.owner.{principal_id}.{slug}",
                        label,
                        role,
                        summary,
                        "offline",
                        capabilities,
                        discoverability,
                        0,
                        serialized_created_at,
                    )
                )

            connected_agent_ids = []
            for slug, label, role, summary, capabilities in _DEMO_AICOO_AGENTS:
                connected_agent_ids.append(
                    self._seed_agent_in_connection(
                        connection,
                        connected_principal_id,
                        f"demo.aicoo.{slug}",
                        label,
                        role,
                        summary,
                        "template",
                        capabilities,
                        1,
                        1,
                        serialized_created_at,
                    )
                )

            connection_count = self._seed_principal_connection_in_connection(
                connection,
                principal_id,
                connected_principal_id,
                serialized_created_at,
            )
            return {
                "principal_id": principal_id,
                "connected_principal_id": connected_principal_id,
                "owner_agent_ids": owner_agent_ids,
                "connected_agent_ids": connected_agent_ids,
                "counts": {
                    "owner_agents": len(owner_agent_ids),
                    "connected_agents": len(connected_agent_ids),
                    "principal_connections": connection_count,
                },
            }

    @staticmethod
    def _matching_token_row(
        rows: list[sqlite3.Row],
        raw_token: str,
    ) -> sqlite3.Row | None:
        candidate_hash = _hash_secret(raw_token)
        match = None
        for row in rows:
            if hmac.compare_digest(row["token_hash"], candidate_hash):
                match = row
        return match

    def _authenticate_connector_in_connection(
        self,
        connection: sqlite3.Connection,
        connector_token: str,
    ) -> sqlite3.Row:
        rows = connection.execute(
            """
            SELECT * FROM principal_connector_credentials
            WHERE status = 'active'
            """
        ).fetchall()
        match = self._matching_token_row(rows, connector_token)
        if match is None:
            raise _error(
                "invalid_connector_token",
                "connector credential is invalid or revoked",
                401,
            )
        return match

    def authenticate_connector(self, connector_token: str) -> str:
        if not isinstance(connector_token, str) or not connector_token:
            raise _error("invalid_connector_token", "connector credential is invalid", 401)
        with self._connect() as connection:
            return self._authenticate_connector_in_connection(
                connection,
                connector_token,
            )["principal_id"]

    def create_agent(
        self,
        connector_token: str,
        diagnostic_label: str,
        capabilities: tuple[str, ...],
    ) -> AgentBinding:
        created_at = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            credential = self._authenticate_connector_in_connection(
                connection,
                connector_token,
            )
            principal_id = credential["principal_id"]
            for _ in range(_GENERATED_ID_ATTEMPTS):
                agent_id = new_agent_id()
                if connection.execute(
                    "SELECT 1 FROM agents WHERE agent_id = ?",
                    (agent_id,),
                ).fetchone() is not None:
                    continue
                serialized = _timestamp(created_at)
                connection.execute(
                    "INSERT INTO agents(agent_id, principal_id, created_at) VALUES (?, ?, ?)",
                    (agent_id, principal_id, serialized),
                )
                connection.execute(
                    """
                    INSERT INTO agent_profiles(
                        agent_id, seed_key, diagnostic_label, role, summary,
                        runtime_kind, capabilities_json, discoverability,
                        official, created_at
                    ) VALUES (?, NULL, ?, 'Local agent', '', 'unregistered', ?, 0, 0, ?)
                    """,
                    (
                        agent_id,
                        diagnostic_label,
                        json.dumps(capabilities, separators=(",", ":")),
                        serialized,
                    ),
                )
                return AgentBinding(
                    principal_id,
                    agent_id,
                    diagnostic_label,
                    capabilities,
                    created_at,
                )
        raise _error("agent_id_conflict", "could not allocate a unique Agent ID", 409)

    def register_runtime(
        self,
        connector_token: str,
        agent_id: str,
        runtime_kind: str,
        workspace_label: str | None,
    ) -> RuntimeSession:
        created_at = self.clock()
        runtime_token = secrets.token_urlsafe(32)
        token_hash = _hash_secret(runtime_token)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            credential = self._authenticate_connector_in_connection(
                connection,
                connector_token,
            )
            principal_id = credential["principal_id"]
            agent = connection.execute(
                "SELECT 1 FROM agents WHERE agent_id = ? AND principal_id = ?",
                (agent_id, principal_id),
            ).fetchone()
            if agent is None:
                raise _error("agent_not_found", "Agent was not found", 404)

            for _ in range(_GENERATED_ID_ATTEMPTS):
                runtime_id = new_runtime_id()
                if connection.execute(
                    "SELECT 1 FROM runtime_registrations WHERE runtime_id = ?",
                    (runtime_id,),
                ).fetchone() is not None:
                    continue
                connection.execute(
                    """
                    INSERT INTO runtime_registrations(
                        runtime_id, principal_id, agent_id, token_hash, created_at,
                        runtime_kind, workspace_label, credential_status, revoked_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL)
                    """,
                    (
                        runtime_id,
                        principal_id,
                        agent_id,
                        token_hash,
                        _timestamp(created_at),
                        runtime_kind,
                        workspace_label,
                    ),
                )
                return RuntimeSession(
                    principal_id=principal_id,
                    agent_id=agent_id,
                    runtime_id=runtime_id,
                    runtime_kind=runtime_kind,
                    workspace_label=workspace_label,
                    created_at=created_at,
                    runtime_token=runtime_token,
                )
        raise _error("runtime_id_conflict", "could not allocate a unique Runtime ID", 409)

    def _authenticate_runtime_in_connection(
        self,
        connection: sqlite3.Connection,
        runtime_token: str,
    ) -> sqlite3.Row:
        rows = connection.execute(
            """
            SELECT * FROM runtime_registrations
            WHERE credential_status = 'active'
            """
        ).fetchall()
        match = self._matching_token_row(rows, runtime_token)
        if match is None:
            raise _error(
                "invalid_runtime_token",
                "Runtime credential is invalid or revoked",
                401,
            )
        return match

    def authenticate_runtime(self, runtime_token: str) -> RuntimeBinding:
        if not isinstance(runtime_token, str) or not runtime_token:
            raise _error("invalid_runtime_token", "Runtime credential is invalid", 401)
        with self._connect() as connection:
            row = self._authenticate_runtime_in_connection(connection, runtime_token)
            return self._runtime_binding(row)

    def authenticate_legacy_instance(
        self,
        runtime_token: str,
        *,
        lease_seconds: int = 90,
    ) -> RuntimeIdentity:
        """Upgrade one pre-V1 Runtime bearer to a reusable compatibility Instance."""

        if not isinstance(runtime_token, str) or not runtime_token:
            raise _error("invalid_runtime_token", "runtime token is invalid", 401)
        now = self.clock()
        expires_at = now + timedelta(seconds=lease_seconds)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            runtime = self._authenticate_runtime_in_connection(connection, runtime_token)
            if all(
                is_typed_id(runtime[field], prefix)
                for field, prefix in (
                    ("principal_id", "p"),
                    ("agent_id", "a"),
                    ("runtime_id", "r"),
                )
            ):
                raise _error(
                    "invalid_instance_token",
                    "modern Runtime credentials cannot be used as Instance credentials",
                    401,
                )

            existing = connection.execute(
                """
                SELECT * FROM agent_instances
                WHERE runtime_id = ? AND runtime_type = 'legacy-compatibility'
                ORDER BY started_at ASC
                LIMIT 1
                """,
                (runtime["runtime_id"],),
            ).fetchone()
            if existing is not None:
                if existing["credential_status"] != "active":
                    raise _error(
                        "invalid_instance_token",
                        "compatibility Instance credential is revoked",
                        401,
                    )
                if existing["status"] == InstanceStatus.ENDED.value:
                    raise _error("instance_ended", "compatibility Instance has ended", 409)
                connection.execute(
                    """
                    UPDATE agent_instances
                    SET last_seen_at = ?, expires_at = ?
                    WHERE instance_id = ?
                    """,
                    (_timestamp(now), _timestamp(expires_at), existing["instance_id"]),
                )
                return RuntimeIdentity(
                    runtime["principal_id"],
                    runtime["agent_id"],
                    runtime["runtime_id"],
                    existing["instance_id"],
                )

            for _ in range(_GENERATED_ID_ATTEMPTS):
                instance_id = new_instance_id()
                if connection.execute(
                    "SELECT 1 FROM agent_instances WHERE instance_id = ?",
                    (instance_id,),
                ).fetchone() is not None:
                    continue
                connection.execute(
                    """
                    INSERT INTO agent_instances(
                        instance_id, principal_id, agent_id, runtime_id, token_hash,
                        credential_status, provider_session_id, runtime_type,
                        workspace_label, capabilities_json, status, started_at,
                        last_seen_at, expires_at, ended_at, revoked_at
                    ) VALUES (?, ?, ?, ?, ?, 'active', NULL, 'legacy-compatibility',
                              ?, '[]', 'online', ?, ?, ?, NULL, NULL)
                    """,
                    (
                        instance_id,
                        runtime["principal_id"],
                        runtime["agent_id"],
                        runtime["runtime_id"],
                        _hash_secret(runtime_token),
                        runtime["workspace_label"],
                        _timestamp(now),
                        _timestamp(now),
                        _timestamp(expires_at),
                    ),
                )
                return RuntimeIdentity(
                    runtime["principal_id"],
                    runtime["agent_id"],
                    runtime["runtime_id"],
                    instance_id,
                )
        raise _error(
            "instance_id_conflict",
            "could not allocate a compatibility Instance ID",
            409,
        )

    def start_instance(
        self,
        runtime_token: str,
        provider_session_id: str | None,
        lease_seconds: int,
    ) -> InstanceSession:
        started_at = self.clock()
        expires_at = started_at + timedelta(seconds=lease_seconds)
        instance_token = secrets.token_urlsafe(32)
        token_hash = _hash_secret(instance_token)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            runtime = self._authenticate_runtime_in_connection(connection, runtime_token)
            profile = connection.execute(
                "SELECT capabilities_json FROM agent_profiles WHERE agent_id = ?",
                (runtime["agent_id"],),
            ).fetchone()
            capabilities = tuple(json.loads(profile["capabilities_json"])) if profile else ()
            for _ in range(_GENERATED_ID_ATTEMPTS):
                instance_id = new_instance_id()
                if connection.execute(
                    "SELECT 1 FROM agent_instances WHERE instance_id = ?",
                    (instance_id,),
                ).fetchone() is not None:
                    continue
                connection.execute(
                    """
                    INSERT INTO agent_instances(
                        instance_id, principal_id, agent_id, runtime_id, token_hash,
                        credential_status, provider_session_id, runtime_type,
                        workspace_label, capabilities_json, status, started_at,
                        last_seen_at, expires_at, ended_at, revoked_at
                    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 'online', ?, ?, ?, NULL, NULL)
                    """,
                    (
                        instance_id,
                        runtime["principal_id"],
                        runtime["agent_id"],
                        runtime["runtime_id"],
                        token_hash,
                        provider_session_id,
                        runtime["runtime_kind"] or "legacy",
                        runtime["workspace_label"],
                        json.dumps(capabilities, separators=(",", ":")),
                        _timestamp(started_at),
                        _timestamp(started_at),
                        _timestamp(expires_at),
                    ),
                )
                return InstanceSession(
                    ActorIdentity(
                        runtime["principal_id"],
                        runtime["agent_id"],
                        runtime["runtime_id"],
                        instance_id,
                    ),
                    instance_token,
                    started_at,
                    expires_at,
                )
        raise _error("instance_id_conflict", "could not allocate a unique Instance ID", 409)

    def _instance_row_for_token(
        self,
        connection: sqlite3.Connection,
        instance_token: str,
        *,
        require_active_credential: bool = True,
    ) -> sqlite3.Row:
        query = "SELECT * FROM agent_instances"
        if require_active_credential:
            query += " WHERE credential_status = 'active'"
        rows = connection.execute(query).fetchall()
        match = self._matching_token_row(rows, instance_token)
        if match is None:
            raise _error(
                "invalid_instance_token",
                "Instance credential is invalid or revoked",
                401,
            )
        return match

    def authenticate_instance(self, instance_token: str) -> ActorIdentity:
        if not isinstance(instance_token, str) or not instance_token:
            raise _error("invalid_instance_token", "Instance credential is invalid", 401)
        now = self.clock()
        with self._connect() as connection:
            row = self._instance_row_for_token(connection, instance_token)
            if row["status"] == InstanceStatus.ENDED.value:
                raise _error("instance_ended", "Instance has ended", 409)
            if _parse_timestamp(row["expires_at"]) <= now:
                raise _error("instance_expired", "Instance lease has expired", 401)
            return ActorIdentity(
                row["principal_id"],
                row["agent_id"],
                row["runtime_id"],
                row["instance_id"],
            )

    def heartbeat_instance(
        self,
        instance_token: str,
        lease_seconds: int,
    ) -> AgentInstance:
        now = self.clock()
        expires_at = now + timedelta(seconds=lease_seconds)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._instance_row_for_token(connection, instance_token)
            if row["status"] == InstanceStatus.ENDED.value:
                raise _error("instance_ended", "Instance has ended", 409)
            if _parse_timestamp(row["expires_at"]) <= now:
                raise _error("instance_expired", "Instance lease has expired", 401)
            connection.execute(
                """
                UPDATE agent_instances
                SET last_seen_at = ?, expires_at = ?
                WHERE instance_id = ?
                """,
                (_timestamp(now), _timestamp(expires_at), row["instance_id"]),
            )
            return self._instance_by_id(connection, row["instance_id"])

    def end_instance(self, instance_token: str) -> AgentInstance:
        now = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._instance_row_for_token(connection, instance_token)
            if row["status"] != InstanceStatus.ENDED.value:
                connection.execute(
                    """
                    UPDATE agent_instances
                    SET status = 'ended', ended_at = ?
                    WHERE instance_id = ?
                    """,
                    (_timestamp(now), row["instance_id"]),
                )
            return self._instance_by_id(connection, row["instance_id"])

    def get_instance(self, instance_id: str) -> AgentInstance:
        with self._connect() as connection:
            return self._instance_by_id(connection, instance_id)

    def _require_actor_identity_in_connection(
        self,
        connection: sqlite3.Connection,
        identity: ActorIdentity,
    ) -> sqlite3.Row:
        row = connection.execute(
            """
            SELECT * FROM agent_instances
            WHERE instance_id = ? AND runtime_id = ? AND agent_id = ? AND principal_id = ?
              AND credential_status = 'active'
            """,
            (
                identity.instance_id,
                identity.runtime_id,
                identity.agent_id,
                identity.principal_id,
            ),
        ).fetchone()
        if row is None:
            raise _error("invalid_instance_identity", "Instance identity is invalid", 401)
        if row["status"] == InstanceStatus.ENDED.value:
            raise _error("instance_ended", "Instance has ended", 409)
        if _parse_timestamp(row["expires_at"]) <= self.clock():
            raise _error("instance_expired", "Instance lease has expired", 401)
        return row

    def request_decision(
        self,
        identity: ActorIdentity,
        mode: DecisionMode,
        title: str,
        description: str,
        consequence: str | None,
        room_id: str | None,
    ) -> HumanDecision:
        created_at = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._require_actor_identity_in_connection(connection, identity)
            if room_id is not None:
                membership = connection.execute(
                    """
                    SELECT 1
                    FROM rooms
                    JOIN room_memberships
                      ON room_memberships.room_id = rooms.room_id
                    WHERE rooms.room_id = ?
                      AND room_memberships.principal_id = ?
                      AND room_memberships.agent_id = ?
                      AND room_memberships.status = 'active'
                    """,
                    (room_id, identity.principal_id, identity.agent_id),
                ).fetchone()
                if membership is None:
                    raise _error(
                        "room_membership_required",
                        "active Room membership is required for a linked Decision",
                        403,
                    )

            for _ in range(_GENERATED_ID_ATTEMPTS):
                decision_id = _new_id("decision_")
                if connection.execute(
                    "SELECT 1 FROM human_decisions WHERE decision_id = ?",
                    (decision_id,),
                ).fetchone() is not None:
                    continue
                connection.execute(
                    """
                    INSERT INTO human_decisions(
                        decision_id, pairing_id, room_id, target_principal_id,
                        requester_principal_id, requester_agent_id, requester_runtime_id,
                        requester_instance_id, response_mode, title, description,
                        consequence, status, response_text, created_at, resolved_at
                    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                              'pending', NULL, ?, NULL)
                    """,
                    (
                        decision_id,
                        room_id,
                        identity.principal_id,
                        identity.principal_id,
                        identity.agent_id,
                        identity.runtime_id,
                        identity.instance_id,
                        mode.value,
                        title,
                        description,
                        consequence,
                        _timestamp(created_at),
                    ),
                )
                return self._decision_by_id(connection, decision_id)
        raise _error("decision_id_conflict", "could not allocate a unique Decision ID", 409)

    def list_decisions_for_account(
        self,
        auth_user_id: str,
        status: DecisionStatus | None,
    ) -> tuple[HumanDecision, ...]:
        validated_user_id = self._validate_auth_user_id(auth_user_id)
        parameters: list[str] = [validated_user_id]
        status_clause = ""
        if status is not None:
            status_clause = " AND decision.status = ?"
            parameters.append(status.value)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT decision.*
                FROM human_decisions AS decision
                JOIN account_principals AS account
                  ON account.principal_id = decision.target_principal_id
                WHERE account.auth_user_id = ?{status_clause}
                ORDER BY decision.created_at DESC, decision.decision_id ASC
                """,
                parameters,
            ).fetchall()
        return tuple(self._decision(row) for row in rows)

    def resolve_decision_for_account(
        self,
        auth_user_id: str,
        decision_id: str,
        outcome: DecisionStatus,
        response_text: str | None,
    ) -> HumanDecision:
        validated_user_id = self._validate_auth_user_id(auth_user_id)
        now = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT decision.*
                FROM human_decisions AS decision
                JOIN account_principals AS account
                  ON account.principal_id = decision.target_principal_id
                WHERE decision.decision_id = ? AND account.auth_user_id = ?
                """,
                (decision_id, validated_user_id),
            ).fetchone()
            if row is None:
                raise _error("decision_not_found", "Decision was not found", 404)

            mode = DecisionMode(row["response_mode"])
            if mode is DecisionMode.APPROVAL:
                if outcome not in {DecisionStatus.APPROVED, DecisionStatus.DENIED}:
                    raise _error(
                        "invalid_decision_response",
                        "approval Decisions require approved or denied",
                        400,
                    )
            elif outcome is not DecisionStatus.ANSWERED or response_text is None:
                raise _error(
                    "invalid_decision_response",
                    "text Decisions require a non-empty answer",
                    400,
                )

            if row["status"] != DecisionStatus.PENDING.value:
                if row["status"] == outcome.value and row["response_text"] == response_text:
                    return self._decision(row)
                raise _error(
                    "decision_already_resolved",
                    "Decision was already resolved with another response",
                    409,
                )

            resolved_at = _timestamp(now)
            connection.execute(
                """
                UPDATE human_decisions
                SET status = ?, response_text = ?, resolved_at = ?
                WHERE decision_id = ?
                """,
                (outcome.value, response_text, resolved_at, decision_id),
            )
            if row["pairing_id"] is not None:
                connection.execute(
                    """
                    UPDATE pairing_challenges
                    SET status = ?, resolved_at = ?
                    WHERE pairing_id = ? AND status = 'claimed'
                    """,
                    (outcome.value, resolved_at, row["pairing_id"]),
                )
            return self._decision_by_id(connection, decision_id)

    def get_decision_for_instance(
        self,
        identity: ActorIdentity,
        decision_id: str,
    ) -> HumanDecision:
        with self._connect() as connection:
            self._require_actor_identity_in_connection(connection, identity)
            row = connection.execute(
                """
                SELECT * FROM human_decisions
                WHERE decision_id = ?
                  AND requester_principal_id = ?
                  AND requester_agent_id = ?
                  AND requester_runtime_id = ?
                  AND requester_instance_id = ?
                """,
                (
                    decision_id,
                    identity.principal_id,
                    identity.agent_id,
                    identity.runtime_id,
                    identity.instance_id,
                ),
            ).fetchone()
        if row is None:
            raise _error("decision_not_found", "Decision was not found", 404)
        return self._decision(row)

    def revoke_connector(self, connector_token: str) -> None:
        now = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._authenticate_connector_in_connection(connection, connector_token)
            connection.execute(
                """
                UPDATE principal_connector_credentials
                SET status = 'revoked', revoked_at = ?
                WHERE credential_id = ?
                """,
                (_timestamp(now), row["credential_id"]),
            )

    def revoke_runtime(self, runtime_token: str) -> None:
        now = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._authenticate_runtime_in_connection(connection, runtime_token)
            connection.execute(
                """
                UPDATE runtime_registrations
                SET credential_status = 'revoked', revoked_at = ?
                WHERE runtime_id = ?
                """,
                (_timestamp(now), row["runtime_id"]),
            )

    def revoke_instance(self, instance_token: str) -> None:
        now = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._instance_row_for_token(connection, instance_token)
            connection.execute(
                """
                UPDATE agent_instances
                SET credential_status = 'revoked', revoked_at = ?
                WHERE instance_id = ?
                """,
                (_timestamp(now), row["instance_id"]),
            )

    @staticmethod
    def _runtime_binding(row: sqlite3.Row) -> RuntimeBinding:
        return RuntimeBinding(
            principal_id=row["principal_id"],
            agent_id=row["agent_id"],
            runtime_id=row["runtime_id"],
            runtime_kind=row["runtime_kind"] or "legacy",
            workspace_label=row["workspace_label"],
            created_at=_parse_timestamp(row["created_at"]),
        )

    def _instance_by_id(
        self,
        connection: sqlite3.Connection,
        instance_id: str,
    ) -> AgentInstance:
        row = connection.execute(
            "SELECT * FROM agent_instances WHERE instance_id = ?",
            (instance_id,),
        ).fetchone()
        if row is None:
            raise _error("instance_not_found", "Instance was not found", 404)
        expires_at = _parse_timestamp(row["expires_at"])
        presence = (
            "online"
            if row["status"] == InstanceStatus.ONLINE.value
            and row["credential_status"] == "active"
            and expires_at > self.clock()
            else "offline"
        )
        return AgentInstance(
            identity=ActorIdentity(
                row["principal_id"],
                row["agent_id"],
                row["runtime_id"],
                row["instance_id"],
            ),
            provider_session_id=row["provider_session_id"],
            runtime_type=row["runtime_type"],
            workspace_label=row["workspace_label"],
            capabilities=tuple(json.loads(row["capabilities_json"])),
            status=InstanceStatus(row["status"]),
            presence=presence,
            started_at=_parse_timestamp(row["started_at"]),
            last_seen_at=_parse_timestamp(row["last_seen_at"]),
            expires_at=expires_at,
            ended_at=(
                _parse_timestamp(row["ended_at"])
                if row["ended_at"] is not None
                else None
            ),
        )

    def create_pairing_challenge(
        self,
        expires_at: datetime,
    ) -> tuple[PairingChallenge, str]:
        created_at = self.clock()
        for _ in range(_GENERATED_ID_ATTEMPTS):
            pairing_id = _new_id("pairing_")
            pairing_secret = secrets.token_urlsafe(32)
            challenge_hash = _hash_secret(pairing_secret)
            try:
                with self._connect() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    connection.execute(
                        """
                        INSERT INTO pairing_challenges(
                            pairing_id, challenge_hash, status, claimed_principal_id,
                            expires_at, created_at, resolved_at
                        ) VALUES (?, ?, 'pending', NULL, ?, ?, NULL)
                        """,
                        (
                            pairing_id,
                            challenge_hash,
                            _timestamp(expires_at),
                            _timestamp(created_at),
                        ),
                    )
            except sqlite3.IntegrityError:
                continue
            return (
                PairingChallenge(
                    pairing_id,
                    PairingStatus.PENDING,
                    None,
                    expires_at,
                    created_at,
                    None,
                ),
                pairing_secret,
            )
        raise _error(
            "pairing_id_conflict",
            "could not allocate a unique pairing challenge",
            409,
        )

    def claim_pairing(
        self,
        pairing_id: str,
        auth_user_id: str,
    ) -> HumanDecision:
        validated_user_id = self._validate_auth_user_id(auth_user_id)
        now = self.clock()
        expired = False
        decision: HumanDecision | None = None

        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            pairing = connection.execute(
                "SELECT * FROM pairing_challenges WHERE pairing_id = ?",
                (pairing_id,),
            ).fetchone()
            if pairing is None:
                raise _error("pairing_not_found", "pairing challenge was not found", 404)

            if _parse_timestamp(pairing["expires_at"]) <= now:
                if pairing["status"] not in {
                    PairingStatus.EXCHANGED.value,
                    PairingStatus.DENIED.value,
                }:
                    connection.execute(
                        "UPDATE pairing_challenges SET status = 'expired', resolved_at = ? WHERE pairing_id = ?",
                        (_timestamp(now), pairing_id),
                    )
                expired = True
            elif pairing["status"] == PairingStatus.PENDING.value:
                principal_id = self._provision_principal_in_connection(
                    connection,
                    validated_user_id,
                    now,
                )
                decision_id = _new_id("decision_")
                connection.execute(
                    """
                    UPDATE pairing_challenges
                    SET status = 'claimed', claimed_principal_id = ?
                    WHERE pairing_id = ?
                    """,
                    (principal_id, pairing_id),
                )
                connection.execute(
                    """
                    INSERT INTO human_decisions(
                        decision_id, pairing_id, room_id, target_principal_id,
                        requester_principal_id, requester_agent_id, requester_runtime_id,
                        requester_instance_id, response_mode, title, description,
                        consequence, status, response_text, created_at, resolved_at
                    ) VALUES (?, ?, NULL, ?, NULL, NULL, NULL, NULL,
                              'approval', ?, ?, NULL, 'pending', NULL, ?, NULL)
                    """,
                    (
                        decision_id,
                        pairing_id,
                        principal_id,
                        "Authorize SharedNet Local",
                        "Allow this local connector to join your SharedNet Principal.",
                        _timestamp(now),
                    ),
                )
                decision = self._decision_by_id(connection, decision_id)
            elif pairing["status"] == PairingStatus.CLAIMED.value:
                principal = connection.execute(
                    "SELECT principal_id FROM account_principals WHERE auth_user_id = ?",
                    (validated_user_id,),
                ).fetchone()
                if principal is None or principal["principal_id"] != pairing["claimed_principal_id"]:
                    raise _error(
                        "pairing_already_claimed",
                        "pairing challenge belongs to another Principal",
                        409,
                    )
                row = connection.execute(
                    "SELECT * FROM human_decisions WHERE pairing_id = ?",
                    (pairing_id,),
                ).fetchone()
                decision = self._decision(row)
            elif pairing["status"] == PairingStatus.EXPIRED.value:
                expired = True
            else:
                raise _error(
                    "pairing_already_resolved",
                    "pairing challenge is already resolved",
                    409,
                )

        if expired:
            raise _error("pairing_expired", "pairing challenge has expired", 410)
        if decision is None:
            raise RuntimeError("pairing claim did not produce a Decision")
        return decision

    def resolve_pairing(
        self,
        decision_id: str,
        auth_user_id: str,
        outcome: str,
    ) -> HumanDecision:
        validated_user_id = self._validate_auth_user_id(auth_user_id)
        if outcome not in {DecisionStatus.APPROVED.value, DecisionStatus.DENIED.value}:
            raise _error(
                "invalid_pairing_outcome",
                "pairing outcome must be approved or denied",
                400,
            )
        now = self.clock()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT decision.*
                FROM human_decisions AS decision
                JOIN account_principals AS account
                  ON account.principal_id = decision.target_principal_id
                WHERE decision.decision_id = ?
                  AND decision.pairing_id IS NOT NULL
                  AND account.auth_user_id = ?
                """,
                (decision_id, validated_user_id),
            ).fetchone()
            if row is None:
                raise _error("decision_not_found", "Decision was not found", 404)

            if row["status"] != DecisionStatus.PENDING.value:
                if row["status"] == outcome:
                    return self._decision(row)
                raise _error(
                    "decision_already_resolved",
                    "Decision was already resolved with another outcome",
                    409,
                )

            pairing = connection.execute(
                "SELECT * FROM pairing_challenges WHERE pairing_id = ?",
                (row["pairing_id"],),
            ).fetchone()
            if pairing is None:
                raise _error("pairing_not_found", "pairing challenge was not found", 404)
            if _parse_timestamp(pairing["expires_at"]) <= now:
                raise _error("pairing_expired", "pairing challenge has expired", 410)
            if pairing["status"] != PairingStatus.CLAIMED.value:
                raise _error(
                    "pairing_state_conflict",
                    "pairing challenge is not awaiting a Decision",
                    409,
                )

            resolved_at = _timestamp(now)
            connection.execute(
                """
                UPDATE human_decisions
                SET status = ?, resolved_at = ?
                WHERE decision_id = ?
                """,
                (outcome, resolved_at, decision_id),
            )
            connection.execute(
                """
                UPDATE pairing_challenges
                SET status = ?, resolved_at = ?
                WHERE pairing_id = ?
                """,
                (outcome, resolved_at, row["pairing_id"]),
            )
            return self._decision_by_id(connection, decision_id)

    def exchange_pairing(
        self,
        pairing_id: str,
        pairing_secret: str,
    ) -> ConnectorSession:
        if not isinstance(pairing_secret, str) or not pairing_secret:
            raise _error("invalid_pairing_secret", "pairing secret is invalid", 401)
        now = self.clock()
        expired = False
        result: ConnectorSession | None = None

        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            pairing = connection.execute(
                "SELECT * FROM pairing_challenges WHERE pairing_id = ?",
                (pairing_id,),
            ).fetchone()
            if pairing is None or not hmac.compare_digest(
                pairing["challenge_hash"],
                _hash_secret(pairing_secret),
            ):
                raise _error("invalid_pairing_secret", "pairing secret is invalid", 401)

            status = PairingStatus(pairing["status"])
            if _parse_timestamp(pairing["expires_at"]) <= now or status is PairingStatus.EXPIRED:
                if status not in {PairingStatus.EXCHANGED, PairingStatus.DENIED}:
                    connection.execute(
                        "UPDATE pairing_challenges SET status = 'expired', resolved_at = ? WHERE pairing_id = ?",
                        (_timestamp(now), pairing_id),
                    )
                expired = True
            elif status is PairingStatus.DENIED:
                raise _error("pairing_denied", "pairing challenge was denied", 403)
            elif status is PairingStatus.EXCHANGED:
                raise _error(
                    "pairing_already_exchanged",
                    "pairing credential was already exchanged",
                    409,
                )
            elif status is not PairingStatus.APPROVED:
                raise _error(
                    "pairing_not_approved",
                    "pairing challenge has not been approved",
                    409,
                )
            else:
                principal_id = pairing["claimed_principal_id"]
                if principal_id is None:
                    raise _error(
                        "pairing_state_conflict",
                        "approved pairing has no Principal",
                        409,
                    )
                credential_id = _new_id("credential_")
                connector_token = secrets.token_urlsafe(32)
                connection.execute(
                    """
                    INSERT INTO principal_connector_credentials(
                        credential_id, principal_id, token_hash, status, created_at, revoked_at
                    ) VALUES (?, ?, ?, 'active', ?, NULL)
                    """,
                    (
                        credential_id,
                        principal_id,
                        _hash_secret(connector_token),
                        _timestamp(now),
                    ),
                )
                connection.execute(
                    "UPDATE pairing_challenges SET status = 'exchanged' WHERE pairing_id = ?",
                    (pairing_id,),
                )
                result = ConnectorSession(
                    principal_id,
                    credential_id,
                    connector_token,
                    now,
                )

        if expired:
            raise _error("pairing_expired", "pairing challenge has expired", 410)
        if result is None:
            raise RuntimeError("pairing exchange did not produce a Connector session")
        return result

    def _decision_by_id(
        self,
        connection: sqlite3.Connection,
        decision_id: str,
    ) -> HumanDecision:
        row = connection.execute(
            "SELECT * FROM human_decisions WHERE decision_id = ?",
            (decision_id,),
        ).fetchone()
        if row is None:
            raise _error("decision_not_found", "Decision was not found", 404)
        return self._decision(row)

    @staticmethod
    def _decision(row: sqlite3.Row) -> HumanDecision:
        requester = None
        if row["requester_instance_id"] is not None:
            requester = ActorIdentity(
                row["requester_principal_id"],
                row["requester_agent_id"],
                row["requester_runtime_id"],
                row["requester_instance_id"],
            )
        return HumanDecision(
            decision_id=row["decision_id"],
            room_id=row["room_id"],
            target_principal_id=row["target_principal_id"],
            requester=requester,
            response_mode=DecisionMode(row["response_mode"]),
            title=row["title"],
            description=row["description"],
            consequence=row["consequence"],
            status=DecisionStatus(row["status"]),
            response_text=row["response_text"],
            created_at=_parse_timestamp(row["created_at"]),
            resolved_at=(
                _parse_timestamp(row["resolved_at"])
                if row["resolved_at"] is not None
                else None
            ),
        )
