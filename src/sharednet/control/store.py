"""Additive SQLite persistence for SharedNet V1 control-plane state.

The service layer depends on this focused store instead of issuing SQL itself. That
keeps the public identity and protocol contracts portable to a future Postgres/
Neon adapter while SQLite remains the V1 local/demo persistence implementation.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
import hashlib
import hmac
from pathlib import Path
import secrets
import sqlite3

from ..identity import new_principal_id
from ..room.store import RoomStore
from .models import (
    ActorIdentity,
    ConnectorSession,
    ControlError,
    DecisionMode,
    DecisionStatus,
    HumanDecision,
    PairingChallenge,
    PairingStatus,
)


_GENERATED_ID_ATTEMPTS = 8


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
