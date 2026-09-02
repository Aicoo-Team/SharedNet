"""Account-scoped, credential-free Dashboard projections."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path
import sqlite3

from ..room.models import format_cursor
from ..room.store import RoomStore
from .models import ControlError, DecisionStatus
from .store import ControlStore, _parse_timestamp, utc_now


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


class DashboardProjectionService:
    """Read-only projections whose scope always starts from Better Auth user ID."""

    def __init__(
        self,
        database_path: Path,
        control_store: ControlStore,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.database_path = Path(database_path)
        self.control_store = control_store
        self.clock = clock

    def _connect(self) -> _ConnectionContext:
        return _ConnectionContext(self.database_path)

    @staticmethod
    def _principal_for_account(
        connection: sqlite3.Connection,
        auth_user_id: str,
    ) -> str:
        row = connection.execute(
            "SELECT principal_id FROM account_principals WHERE auth_user_id = ?",
            (auth_user_id,),
        ).fetchone()
        if row is None:
            raise ControlError(
                "account_not_provisioned",
                "SharedNet Principal has not been provisioned for this account",
                404,
            )
        return row["principal_id"]

    def list_rooms(self, auth_user_id: str) -> dict[str, object]:
        with self._connect() as connection:
            principal_id = self._principal_for_account(connection, auth_user_id)
            rows = connection.execute(
                """
                SELECT DISTINCT room.*
                FROM rooms AS room
                JOIN room_memberships AS membership ON membership.room_id = room.room_id
                JOIN agents AS agent ON agent.agent_id = membership.agent_id
                WHERE agent.principal_id = ?
                ORDER BY room.updated_at DESC, room.room_id ASC
                """,
                (principal_id,),
            ).fetchall()
            rooms = [self._room_summary(connection, row, principal_id) for row in rows]
        return {"rooms": rooms}

    def get_room(self, auth_user_id: str, room_id: str) -> dict[str, object]:
        with self._connect() as connection:
            principal_id = self._principal_for_account(connection, auth_user_id)
            row = connection.execute(
                """
                SELECT DISTINCT room.*
                FROM rooms AS room
                JOIN room_memberships AS membership ON membership.room_id = room.room_id
                JOIN agents AS agent ON agent.agent_id = membership.agent_id
                WHERE room.room_id = ? AND agent.principal_id = ?
                """,
                (room_id, principal_id),
            ).fetchone()
            if row is None:
                raise ControlError("room_not_found", "Room was not found", 404)
            memberships = connection.execute(
                """
                SELECT * FROM room_memberships
                WHERE room_id = ?
                ORDER BY joined_at ASC, agent_id ASC
                """,
                (room_id,),
            ).fetchall()
            messages = connection.execute(
                """
                SELECT * FROM messages
                WHERE room_id = ?
                ORDER BY sequence ASC
                """,
                (room_id,),
            ).fetchall()
            room = RoomStore._room(row).to_dict()
            serialized_memberships = [RoomStore._membership(item).to_dict() for item in memberships]
            serialized_messages = [RoomStore._message(item).to_dict() for item in messages]
        return {
            "room": room,
            "memberships": serialized_memberships,
            "messages": serialized_messages,
            "next_cursor": format_cursor(row["latest_sequence"]),
        }

    def get_network(self, auth_user_id: str) -> dict[str, object]:
        with self._connect() as connection:
            principal_id = self._principal_for_account(connection, auth_user_id)
            connected_ids = self._connected_principal_ids(connection, principal_id)
            visible_principal_ids = (principal_id, *connected_ids)
            placeholders = ",".join("?" for _ in visible_principal_ids)

            principal = self._principal_projection(connection, principal_id)
            connected_principals = [
                self._principal_projection(connection, connected_id)
                for connected_id in connected_ids
            ]
            agents = connection.execute(
                f"""
                SELECT agent.agent_id, agent.principal_id, agent.created_at,
                       profile.diagnostic_label, profile.role, profile.summary,
                       profile.runtime_kind, profile.capabilities_json,
                       profile.discoverability, profile.official
                FROM agents AS agent
                LEFT JOIN agent_profiles AS profile ON profile.agent_id = agent.agent_id
                WHERE agent.principal_id IN ({placeholders})
                ORDER BY agent.principal_id, agent.created_at, agent.agent_id
                """,
                visible_principal_ids,
            ).fetchall()
            agent_ids = tuple(row["agent_id"] for row in agents)
            runtimes: list[sqlite3.Row] = []
            instances: list[sqlite3.Row] = []
            if agent_ids:
                agent_placeholders = ",".join("?" for _ in agent_ids)
                runtimes = connection.execute(
                    f"""
                    SELECT runtime_id, principal_id, agent_id, runtime_kind,
                           workspace_label, created_at, credential_status
                    FROM runtime_registrations
                    WHERE agent_id IN ({agent_placeholders})
                    ORDER BY created_at, runtime_id
                    """,
                    agent_ids,
                ).fetchall()
                instances = connection.execute(
                    f"""
                    SELECT instance_id, principal_id, agent_id, runtime_id,
                           runtime_type, workspace_label, status, credential_status,
                           started_at, last_seen_at, expires_at, ended_at
                    FROM agent_instances
                    WHERE agent_id IN ({agent_placeholders})
                    ORDER BY started_at, instance_id
                    """,
                    agent_ids,
                ).fetchall()

            edges = self._network_edges(connection, principal_id, connected_ids)

        return {
            "principal": principal,
            "connected_principals": connected_principals,
            "agents": [self._agent_projection(row) for row in agents],
            "runtimes": [self._runtime_projection(row, principal_id) for row in runtimes],
            "instances": [self._instance_projection(row, principal_id) for row in instances],
            "edges": edges,
        }

    def list_decisions(
        self,
        auth_user_id: str,
        status: str | None = None,
    ) -> dict[str, object]:
        try:
            normalized_status = DecisionStatus(status) if status is not None else None
        except (TypeError, ValueError) as error:
            raise ControlError(
                "invalid_decision_status",
                "Decision status is invalid",
                400,
            ) from error
        decisions = self.control_store.list_decisions_for_account(
            auth_user_id,
            normalized_status,
        )
        return {"decisions": [decision.to_dict() for decision in decisions]}

    @staticmethod
    def _room_summary(
        connection: sqlite3.Connection,
        row: sqlite3.Row,
        principal_id: str,
    ) -> dict[str, object]:
        membership_count = connection.execute(
            "SELECT COUNT(*) FROM room_memberships WHERE room_id = ? AND status = 'active'",
            (row["room_id"],),
        ).fetchone()[0]
        owner_agents = connection.execute(
            """
            SELECT membership.agent_id
            FROM room_memberships AS membership
            JOIN agents AS agent ON agent.agent_id = membership.agent_id
            WHERE membership.room_id = ? AND agent.principal_id = ?
            ORDER BY membership.agent_id
            """,
            (row["room_id"], principal_id),
        ).fetchall()
        return {
            "room_id": row["room_id"],
            "name": row["name"],
            "description": row["description"],
            "status": row["status"],
            "updated_at": row["updated_at"],
            "latest_sequence": row["latest_sequence"],
            "latest_cursor": format_cursor(row["latest_sequence"]),
            "member_count": membership_count,
            "owner_agent_ids": [item["agent_id"] for item in owner_agents],
        }

    @staticmethod
    def _principal_projection(
        connection: sqlite3.Connection,
        principal_id: str,
    ) -> dict[str, object]:
        row = connection.execute(
            """
            SELECT principal.principal_id, principal.created_at,
                   profile.diagnostic_label, profile.kind, profile.summary
            FROM principals AS principal
            LEFT JOIN principal_profiles AS profile
              ON profile.principal_id = principal.principal_id
            WHERE principal.principal_id = ?
            """,
            (principal_id,),
        ).fetchone()
        if row is None:
            raise ControlError("principal_not_found", "Principal was not found", 404)
        return {
            "principal_id": row["principal_id"],
            "diagnostic_label": row["diagnostic_label"] or "SharedNet Principal",
            "kind": row["kind"] or "account",
            "summary": row["summary"] or "",
            "created_at": row["created_at"],
        }

    @staticmethod
    def _connected_principal_ids(
        connection: sqlite3.Connection,
        principal_id: str,
    ) -> tuple[str, ...]:
        rows = connection.execute(
            """
            SELECT DISTINCT connected_principal_id
            FROM (
                SELECT CASE
                         WHEN left_principal_id = ? THEN right_principal_id
                         ELSE left_principal_id
                       END AS connected_principal_id
                FROM principal_connections
                WHERE left_principal_id = ? OR right_principal_id = ?

                UNION ALL

                SELECT peer_agent.principal_id AS connected_principal_id
                FROM room_memberships AS owner_membership
                JOIN agents AS owner_agent
                  ON owner_agent.agent_id = owner_membership.agent_id
                JOIN room_memberships AS peer_membership
                  ON peer_membership.room_id = owner_membership.room_id
                 AND peer_membership.status = 'active'
                JOIN agents AS peer_agent
                  ON peer_agent.agent_id = peer_membership.agent_id
                WHERE owner_agent.principal_id = ?
                  AND owner_membership.status = 'active'
                  AND peer_agent.principal_id <> ?
            )
            ORDER BY connected_principal_id
            """,
            (principal_id, principal_id, principal_id, principal_id, principal_id),
        ).fetchall()
        return tuple(row["connected_principal_id"] for row in rows)

    @staticmethod
    def _agent_projection(row: sqlite3.Row) -> dict[str, object]:
        import json

        return {
            "agent_id": row["agent_id"],
            "principal_id": row["principal_id"],
            "diagnostic_label": row["diagnostic_label"] or "Local Agent",
            "role": row["role"] or "Agent",
            "summary": row["summary"] or "",
            "runtime_kind": row["runtime_kind"] or "unknown",
            "capabilities": (
                json.loads(row["capabilities_json"])
                if row["capabilities_json"] is not None
                else []
            ),
            "discoverability": bool(row["discoverability"] or 0),
            "official": bool(row["official"] or 0),
            "created_at": row["created_at"],
        }

    @staticmethod
    def _runtime_projection(row: sqlite3.Row, owner_principal_id: str) -> dict[str, object]:
        return {
            "runtime_id": row["runtime_id"],
            "principal_id": row["principal_id"],
            "agent_id": row["agent_id"],
            "runtime_kind": row["runtime_kind"] or "legacy",
            "workspace_label": (
                row["workspace_label"]
                if row["principal_id"] == owner_principal_id
                else None
            ),
            "status": row["credential_status"],
            "created_at": row["created_at"],
        }

    def _instance_projection(
        self,
        row: sqlite3.Row,
        owner_principal_id: str,
    ) -> dict[str, object]:
        expires_at = _parse_timestamp(row["expires_at"])
        presence = (
            "online"
            if row["status"] == "online"
            and row["credential_status"] == "active"
            and expires_at > self.clock()
            else "offline"
        )
        return {
            "instance_id": row["instance_id"],
            "principal_id": row["principal_id"],
            "agent_id": row["agent_id"],
            "runtime_id": row["runtime_id"],
            "runtime_type": row["runtime_type"],
            "workspace_label": (
                row["workspace_label"]
                if row["principal_id"] == owner_principal_id
                else None
            ),
            "status": row["status"],
            "presence": presence,
            "started_at": row["started_at"],
            "last_seen_at": row["last_seen_at"],
            "expires_at": row["expires_at"],
            "ended_at": row["ended_at"],
        }

    @staticmethod
    def _network_edges(
        connection: sqlite3.Connection,
        principal_id: str,
        connected_ids: tuple[str, ...],
    ) -> list[dict[str, object]]:
        visible_principal_ids = (principal_id, *connected_ids)
        visible_placeholders = ",".join("?" for _ in visible_principal_ids)
        edges: list[dict[str, object]] = [
            {
                "kind": "principal_connection",
                "source_id": principal_id,
                "target_id": connected_id,
                "weight": 1,
            }
            for connected_id in connected_ids
        ]
        rows = connection.execute(
            f"""
            SELECT left_member.agent_id AS source_id,
                   right_member.agent_id AS target_id,
                   COUNT(DISTINCT left_member.room_id) AS weight
            FROM room_memberships AS left_member
            JOIN agents AS left_agent ON left_agent.agent_id = left_member.agent_id
            JOIN room_memberships AS right_member
              ON right_member.room_id = left_member.room_id
             AND right_member.agent_id > left_member.agent_id
            JOIN agents AS right_agent ON right_agent.agent_id = right_member.agent_id
            WHERE left_member.status = 'active'
              AND right_member.status = 'active'
              AND left_agent.principal_id IN ({visible_placeholders})
              AND right_agent.principal_id IN ({visible_placeholders})
              AND EXISTS (
                  SELECT 1
                  FROM room_memberships AS owner_member
                  JOIN agents AS owner_agent
                    ON owner_agent.agent_id = owner_member.agent_id
                  WHERE owner_member.room_id = left_member.room_id
                    AND owner_member.status = 'active'
                    AND owner_agent.principal_id = ?
              )
            GROUP BY left_member.agent_id, right_member.agent_id
            ORDER BY source_id, target_id
            """,
            (*visible_principal_ids, *visible_principal_ids, principal_id),
        ).fetchall()
        edges.extend(
            {
                "kind": "room_co_membership",
                "source_id": row["source_id"],
                "target_id": row["target_id"],
                "weight": row["weight"],
            }
            for row in rows
        )
        return edges
