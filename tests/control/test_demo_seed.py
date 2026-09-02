from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from sharednet.control.models import ControlError
from sharednet.control.store import ControlStore
from sharednet.room.api import create_room_app


PUBLIC_PRINCIPAL_ID = r"^p_[0-9A-Za-z]{10}$"
PUBLIC_AGENT_ID = r"^a_[0-9A-Za-z]{10}$"


OWNER_PROFILES = {
    "Planner": (
        "Planning Agent",
        "Turns outcomes into task graphs and decides when the network helps.",
        ["task planning", "candidate selection", "coordination"],
        0,
    ),
    "Codex": (
        "Implementation Agent",
        "Owns the repository and integrates specialist contributions.",
        ["coding", "integration", "tests"],
        1,
    ),
    "Research": (
        "Research Agent",
        "Collects product context and primary implementation evidence.",
        ["web research", "API research", "synthesis"],
        1,
    ),
    "Reviewer": (
        "Independent Verifier",
        "Checks evidence without inheriting the builder’s assumptions.",
        ["code review", "acceptance tests", "risk checks"],
        0,
    ),
}

AICOO_PROFILES = {
    "Web Builder": (
        "Website Specialist",
        "Builds production-oriented web products from a concise outcome.",
        ["Next.js", "product implementation", "responsive UI"],
    ),
    "Design Engineer": (
        "Interface Specialist",
        "Shapes clear interaction systems and production-ready interface code.",
        ["interaction design", "design systems", "accessibility"],
    ),
    "Neon": (
        "Database Specialist",
        "Designs Neon schemas, migrations, and least-privilege integration plans.",
        ["Postgres", "Neon API", "schema design"],
    ),
    "Vercel": (
        "Deployment Specialist",
        "Prepares Vercel projects, environment bindings, and deployment checks.",
        ["Vercel API", "deployments", "environment variables"],
    ),
    "Quality": (
        "Launch Verifier",
        "Independently verifies behavior, accessibility, and launch readiness.",
        ["browser QA", "accessibility", "release evidence"],
    ),
}

TRUTHFUL_EMPTY_TABLES = (
    "principal_connector_credentials",
    "pairing_challenges",
    "runtime_registrations",
    "agent_instances",
    "rooms",
    "room_memberships",
    "messages",
    "artifacts",
    "message_artifacts",
    "message_obligations",
    "message_resolutions",
    "human_decisions",
)


class DemoSeedStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "sharednet.db"
        self.store = ControlStore(self.database_path)
        self.store.initialize()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def rows(self, query: str, parameters: tuple[object, ...] = ()) -> list[sqlite3.Row]:
        with sqlite3.connect(self.database_path) as connection:
            connection.row_factory = sqlite3.Row
            return connection.execute(query, parameters).fetchall()

    def count(self, table_name: str) -> int:
        with sqlite3.connect(self.database_path) as connection:
            return int(connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0])

    def test_seed_is_idempotent_and_returns_only_opaque_public_ids(self) -> None:
        first = self.store.seed_demo_account("auth-user-1")
        second = self.store.seed_demo_account("auth-user-1")

        self.assertEqual(first, second)
        self.assertEqual(
            set(first),
            {
                "principal_id",
                "connected_principal_id",
                "owner_agent_ids",
                "connected_agent_ids",
                "counts",
            },
        )
        self.assertRegex(first["principal_id"], PUBLIC_PRINCIPAL_ID)
        self.assertRegex(first["connected_principal_id"], PUBLIC_PRINCIPAL_ID)
        self.assertNotEqual(first["principal_id"], first["connected_principal_id"])
        self.assertEqual(len(first["owner_agent_ids"]), 4)
        self.assertEqual(len(first["connected_agent_ids"]), 5)
        for agent_id in first["owner_agent_ids"] + first["connected_agent_ids"]:
            self.assertRegex(agent_id, PUBLIC_AGENT_ID)
        self.assertEqual(
            first["counts"],
            {
                "owner_agents": 4,
                "connected_agents": 5,
                "principal_connections": 1,
            },
        )
        self.assertNotIn("seed_key", json.dumps(first))

    def test_seed_persists_profiles_and_no_runtime_or_activity_rows(self) -> None:
        seeded = self.store.seed_demo_account("auth-user-1")

        principal_profiles = self.rows(
            """
            SELECT principal_id, seed_key, diagnostic_label, kind, summary
            FROM principal_profiles
            ORDER BY principal_id
            """
        )
        self.assertEqual(len(principal_profiles), 2)
        owner_principal = next(
            row for row in principal_profiles if row["principal_id"] == seeded["principal_id"]
        )
        aicoo_principal = next(
            row
            for row in principal_profiles
            if row["principal_id"] == seeded["connected_principal_id"]
        )
        self.assertIn(seeded["principal_id"], owner_principal["seed_key"])
        self.assertEqual(owner_principal["kind"], "self")
        self.assertEqual(
            owner_principal["summary"],
            "Your identity, policies, and persistent Agents.",
        )
        self.assertEqual(aicoo_principal["seed_key"], "demo.aicoo.principal")
        self.assertEqual(aicoo_principal["diagnostic_label"], "Aicoo")
        self.assertEqual(aicoo_principal["kind"], "connected")
        self.assertEqual(
            aicoo_principal["summary"],
            "A connected company Principal with discoverable specialist Agents.",
        )

        owner_rows = self.rows(
            """
            SELECT profile.*, agent.principal_id
            FROM agent_profiles AS profile
            JOIN agents AS agent ON agent.agent_id = profile.agent_id
            WHERE agent.principal_id = ?
            """,
            (seeded["principal_id"],),
        )
        self.assertEqual({row["diagnostic_label"] for row in owner_rows}, set(OWNER_PROFILES))
        for row in owner_rows:
            role, summary, capabilities, discoverability = OWNER_PROFILES[
                row["diagnostic_label"]
            ]
            self.assertIn(seeded["principal_id"], row["seed_key"])
            self.assertEqual(row["role"], role)
            self.assertEqual(row["summary"], summary)
            self.assertEqual(json.loads(row["capabilities_json"]), capabilities)
            self.assertEqual(row["runtime_kind"], "offline")
            self.assertEqual(row["discoverability"], discoverability)
            self.assertEqual(row["official"], 0)

        connected_rows = self.rows(
            """
            SELECT profile.*, agent.principal_id
            FROM agent_profiles AS profile
            JOIN agents AS agent ON agent.agent_id = profile.agent_id
            WHERE agent.principal_id = ?
            """,
            (seeded["connected_principal_id"],),
        )
        self.assertEqual(
            {row["diagnostic_label"] for row in connected_rows}, set(AICOO_PROFILES)
        )
        for row in connected_rows:
            role, summary, capabilities = AICOO_PROFILES[row["diagnostic_label"]]
            self.assertTrue(row["seed_key"].startswith("demo.aicoo."))
            self.assertEqual(row["role"], role)
            self.assertEqual(row["summary"], summary)
            self.assertEqual(json.loads(row["capabilities_json"]), capabilities)
            self.assertEqual(row["runtime_kind"], "template")
            self.assertEqual(row["discoverability"], 1)
            self.assertEqual(row["official"], 1)

        for table_name in TRUTHFUL_EMPTY_TABLES:
            self.assertEqual(self.count(table_name), 0, table_name)

    def test_seed_refreshes_the_global_aicoo_principal_profile(self) -> None:
        seeded = self.store.seed_demo_account("auth-user-1")
        with sqlite3.connect(self.database_path) as connection:
            connection.execute(
                """
                UPDATE principal_profiles
                SET diagnostic_label = 'stale', kind = 'stale', summary = 'stale'
                WHERE principal_id = ?
                """,
                (seeded["connected_principal_id"],),
            )

        repeated = self.store.seed_demo_account("auth-user-1")
        refreshed = self.rows(
            """
            SELECT seed_key, diagnostic_label, kind, summary
            FROM principal_profiles
            WHERE principal_id = ?
            """,
            (seeded["connected_principal_id"],),
        )[0]

        self.assertEqual(repeated, seeded)
        self.assertEqual(refreshed["seed_key"], "demo.aicoo.principal")
        self.assertEqual(refreshed["diagnostic_label"], "Aicoo")
        self.assertEqual(refreshed["kind"], "connected")
        self.assertEqual(
            refreshed["summary"],
            "A connected company Principal with discoverable specialist Agents.",
        )

    def test_two_accounts_have_disjoint_owner_agents_and_shared_aicoo_agents(self) -> None:
        first = self.store.seed_demo_account("auth-user-1")
        second = self.store.seed_demo_account("auth-user-2")
        first_after_second_account = self.store.seed_demo_account("auth-user-1")

        self.assertNotEqual(first["principal_id"], second["principal_id"])
        self.assertEqual(first_after_second_account, first)
        self.assertTrue(set(first["owner_agent_ids"]).isdisjoint(second["owner_agent_ids"]))
        self.assertEqual(first["connected_principal_id"], second["connected_principal_id"])
        self.assertEqual(first["connected_agent_ids"], second["connected_agent_ids"])
        self.assertEqual(self.count("principals"), 3)
        self.assertEqual(self.count("agents"), 13)

        owner_seed_rows = self.rows(
            """
            SELECT agent.principal_id, profile.seed_key
            FROM agent_profiles AS profile
            JOIN agents AS agent ON agent.agent_id = profile.agent_id
            WHERE agent.principal_id != ?
            """,
            (first["connected_principal_id"],),
        )
        self.assertEqual(len(owner_seed_rows), 8)
        for row in owner_seed_rows:
            self.assertIn(row["principal_id"], row["seed_key"])

        connections = self.rows(
            """
            SELECT left_principal_id, right_principal_id
            FROM principal_connections
            ORDER BY left_principal_id, right_principal_id
            """
        )
        self.assertEqual(len(connections), 2)
        self.assertEqual(
            {
                frozenset((row["left_principal_id"], row["right_principal_id"]))
                for row in connections
            },
            {
                frozenset((first["principal_id"], first["connected_principal_id"])),
                frozenset((second["principal_id"], second["connected_principal_id"])),
            },
        )
        for row in connections:
            self.assertLess(row["left_principal_id"], row["right_principal_id"])

    def test_seed_rolls_back_every_row_when_agent_id_allocation_fails(self) -> None:
        with patch(
            "sharednet.control.store.new_agent_id",
            return_value="a_AAAAAAAAAA",
        ):
            with self.assertRaises(ControlError) as raised:
                self.store.seed_demo_account("auth-user-1")

        self.assertEqual(raised.exception.code, "agent_id_conflict")
        for table_name in (
            "account_principals",
            "principals",
            "principal_profiles",
            "agents",
            "agent_profiles",
            "principal_connections",
        ):
            self.assertEqual(self.count(table_name), 0, table_name)


class DemoSeedApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self.temporary_directory.name)
        self.app = create_room_app(
            root / "sharednet.db",
            root / "blobs",
            console_token="console-secret",
        )

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_demo_seed_endpoint_requires_console_token_and_is_idempotent(self) -> None:
        with TestClient(self.app) as client:
            missing = client.post("/v1/console/accounts/auth-user-1/demo-seed")
            wrong = client.post(
                "/v1/console/accounts/auth-user-1/demo-seed",
                headers={"x-sharednet-console-token": "wrong"},
            )
            first = client.post(
                "/v1/console/accounts/auth-user-1/demo-seed",
                headers={"x-sharednet-console-token": "console-secret"},
            )
            second = client.post(
                "/v1/console/accounts/auth-user-1/demo-seed",
                headers={"x-sharednet-console-token": "console-secret"},
            )

        self.assertEqual(missing.status_code, 401, missing.text)
        self.assertEqual(wrong.status_code, 401, wrong.text)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), second.json())
        self.assertRegex(first.json()["principal_id"], PUBLIC_PRINCIPAL_ID)


if __name__ == "__main__":
    unittest.main()
