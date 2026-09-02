# SharedNet Local Identity and Room API V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authenticated SharedNet API and installable local companion needed for two local Agent Instances to pair with one account, exchange persistent Room messages, report presence, and request durable human Decisions.

**Architecture:** Extend the existing Python Room daemon rather than creating a second network state machine. New control-plane modules own opaque IDs, account pairing, Agent/Runtime/Instance registration, presence, and Decisions; existing Room storage remains authoritative for Room lifecycle and ordered messages. Agent-originated operations authenticate with connector, Runtime, or Instance credentials, while a separately authenticated Web service client receives account-scoped projections.

**Tech Stack:** Python 3.11+, FastAPI, SQLite, standard-library `secrets`/`hashlib`/`hmac`, existing dependency-light Room client, pytest-compatible `unittest`, PyInstaller for the macOS arm64 local bundle.

**Spec:** `docs/superpowers/specs/2026-09-03-local-agent-communication-v1-design.md`

## Global Constraints

- Canonical IDs use server-generated typed codes: `p_`, `a_`, `r_`, or `i_` plus a case-sensitive ten-character Base62 body.
- IDs are generated from cryptographically secure randomness, checked by database uniqueness constraints, and never derived from semantic or hardware data.
- Better Auth `user.id`, not email, maps an account to a Principal.
- Raw pairing, connector, Runtime, and Instance credentials are returned once, stored owner-only by SharedNet Local, hashed at rest, and never logged.
- New Room messages carry Principal, Agent, Runtime, and Instance provenance derived from the Instance credential.
- Room membership remains Agent-scoped; presence is Instance-scoped.
- V1 Room content is plain text. Existing obligation-tag storage may remain compatible but is not documented or used by the V1 acceptance flow.
- The website cannot create Rooms or post Agent messages.
- SharedNet Local makes outbound authenticated requests and exposes no unauthenticated inbound execution endpoint.
- Legacy caller-asserted loopback registration is disabled unless `SHAREDNET_ENABLE_LEGACY_REGISTRATION=1`.
- Existing legacy database rows and Room credentials remain usable; first authenticated use of a legacy Runtime token creates one server-generated compatibility Instance so every new write still receives Instance provenance. No migration deletes or rewrites user data.

---

### Task 1: Typed opaque ID generation

**Files:**
- Create: `src/sharednet/identity.py`
- Create: `tests/test_identity.py`
- Modify: `src/sharednet/room/store.py`
- Modify: `tests/room/test_store_rooms.py`

**Interfaces:**
- Produces: `new_principal_id() -> str`, `new_agent_id() -> str`, `new_runtime_id() -> str`, `new_instance_id() -> str`, and `is_typed_id(value: object, prefix: str) -> bool`.
- Consumes: standard-library `secrets.choice` and SQLite uniqueness errors handled by the caller's transaction retry.

- [ ] **Step 1: Write failing format and collision-retry tests**

```python
from unittest import TestCase, mock

from sharednet.identity import is_typed_id, new_agent_id, new_principal_id


class TypedIdentityTests(TestCase):
    def test_generated_ids_have_typed_ten_character_base62_bodies(self) -> None:
        self.assertRegex(new_principal_id(), r"^p_[0-9A-Za-z]{10}$")
        self.assertRegex(new_agent_id(), r"^a_[0-9A-Za-z]{10}$")
        self.assertTrue(is_typed_id("i_8pQ2Km7XaN", "i"))
        self.assertFalse(is_typed_id("principal_xisen", "p"))

    @mock.patch("sharednet.identity.secrets.choice", side_effect=list("15COsXY9aK"))
    def test_generator_uses_the_configured_secure_alphabet(self, _choice) -> None:
        self.assertEqual(new_principal_id(), "p_15COsXY9aK")
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `python -m unittest tests.test_identity -v`

Expected: FAIL because `sharednet.identity` does not exist.

- [ ] **Step 3: Implement the ID module**

```python
from __future__ import annotations

import re
import secrets


BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
BODY_LENGTH = 10
_TYPED_ID = re.compile(r"^(?P<prefix>[pari])_[0-9A-Za-z]{10}$")


def _new_typed_id(prefix: str) -> str:
    if prefix not in {"p", "a", "r", "i"}:
        raise ValueError("unsupported SharedNet identity prefix")
    return f"{prefix}_{''.join(secrets.choice(BASE62) for _ in range(BODY_LENGTH))}"


def new_principal_id() -> str:
    return _new_typed_id("p")


def new_agent_id() -> str:
    return _new_typed_id("a")


def new_runtime_id() -> str:
    return _new_typed_id("r")


def new_instance_id() -> str:
    return _new_typed_id("i")


def is_typed_id(value: object, prefix: str) -> bool:
    match = _TYPED_ID.fullmatch(value) if isinstance(value, str) else None
    return match is not None and match.group("prefix") == prefix
```

Replace `_new_id("runtime_")` in new registration paths with `new_runtime_id()`. Do not rewrite the existing `room_`, `message_`, membership, resolution, or artifact ID formats in this release.

- [ ] **Step 4: Run ID and existing Room store tests**

Run: `python -m unittest tests.test_identity tests.room.test_store_rooms -v`

Expected: PASS, including existing legacy Room tests.

- [ ] **Step 5: Commit the focused change**

```bash
git add src/sharednet/identity.py src/sharednet/room/store.py tests/test_identity.py tests/room/test_store_rooms.py
git commit -m "feat: generate opaque SharedNet identity codes"
```

---

### Task 2: Control-plane contracts and schema

**Files:**
- Create: `src/sharednet/control/__init__.py`
- Create: `src/sharednet/control/models.py`
- Create: `src/sharednet/control/store.py`
- Create: `tests/control/__init__.py`
- Create: `tests/control/test_models.py`
- Create: `tests/control/test_store_schema.py`
- Modify: `src/sharednet/room/store.py`

**Interfaces:**
- Produces: `ControlError`, `PairingStatus`, `CredentialStatus`, `InstanceStatus`, `DecisionMode`, `DecisionStatus`, `ActorIdentity`, `PairingChallenge`, `PairingStart`, `ConnectorSession`, `AgentBinding`, `RuntimeBinding`, `RuntimeSession`, `AgentInstance`, `InstanceSession`, `HumanDecision`, and `ControlStore`.
- Produces tables: `account_principals`, `principal_connector_credentials`, `pairing_challenges`, `principal_profiles`, `agent_profiles`, `principal_connections`, `agent_instances`, and `human_decisions`.
- Consumes existing tables: `principals`, `agents`, `runtime_registrations`, `rooms`, and `room_memberships`.

- [ ] **Step 1: Write failing model tests**

```python
from unittest import TestCase

from sharednet.control.models import ActorIdentity, ControlError


class ControlModelTests(TestCase):
    def test_actor_identity_contains_the_complete_provenance_tuple(self) -> None:
        identity = ActorIdentity(
            "p_15COsXY9aK",
            "a_7Qm2Zx8WpL",
            "r_4Nk8Vm2QaT",
            "i_8pQ2Km7XaN",
        )
        self.assertEqual(identity.to_dict()["instance_id"], "i_8pQ2Km7XaN")

    def test_actor_identity_rejects_legacy_or_mistyped_codes(self) -> None:
        with self.assertRaisesRegex(ControlError, "principal_id"):
            ActorIdentity(
                "principal_xisen",
                "a_7Qm2Zx8WpL",
                "r_4Nk8Vm2QaT",
                "i_8pQ2Km7XaN",
            )
```

- [ ] **Step 2: Run the model test and verify it fails**

Run: `python -m unittest tests.control.test_models -v`

Expected: FAIL because the control package does not exist.

- [ ] **Step 3: Define immutable JSON-ready contracts**

Implement enums with exact wire values:

```python
class PairingStatus(str, Enum):
    PENDING = "pending"
    CLAIMED = "claimed"
    APPROVED = "approved"
    DENIED = "denied"
    EXCHANGED = "exchanged"
    EXPIRED = "expired"


class InstanceStatus(str, Enum):
    ONLINE = "online"
    ENDED = "ended"


class DecisionMode(str, Enum):
    APPROVAL = "approval"
    TEXT = "text"


class DecisionStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    ANSWERED = "answered"
```

`ActorIdentity.to_dict()` must return exactly `principal_id`, `agent_id`, `runtime_id`, and `instance_id`. Every timestamp serializes with `datetime.isoformat()`.

- [ ] **Step 4: Write failing schema and non-destructive initialization tests**

```python
import sqlite3


def test_initialize_adds_control_tables_without_deleting_legacy_rooms(self) -> None:
    room_store = RoomStore(self.database_path)
    room_store.initialize()
    legacy_registration, _ = room_store.register_runtime(
        "principal_legacy", "agent_legacy", "runtime_legacy"
    )

    ControlStore(self.database_path).initialize()

    with sqlite3.connect(self.database_path) as connection:
        row = connection.execute(
            "SELECT agent_id FROM runtime_registrations WHERE runtime_id = ?",
            (legacy_registration.identity.runtime_id,),
        ).fetchone()
    self.assertEqual(row, ("agent_legacy",))
    self.assertIn("agent_instances", self.table_names())
    self.assertIn("human_decisions", self.table_names())
```

- [ ] **Step 5: Implement the additive schema**

Use `CREATE TABLE IF NOT EXISTS` and `PRAGMA foreign_keys = ON`. Store only hashes in credential/challenge tables. Add nullable `sender_instance_id` to `messages` through a guarded `PRAGMA table_info(messages)` migration so legacy rows remain readable. Add nullable `creator_instance_id` to `rooms` for the same reason.

`principal_profiles` stores `principal_id`, an optional unique internal `seed_key`, `diagnostic_label`, `kind`, `summary`, and `created_at`. `agent_profiles` stores `agent_id`, an optional unique internal `seed_key`, `diagnostic_label`, `role`, `summary`, `runtime_kind`, `capabilities_json`, `discoverability`, `official`, and `created_at`. Neither table contains a user-editable alias; `seed_key` is an idempotent development fixture key and is never exposed as network identity.

`principal_connections` stores a stable connection row between two Principal IDs for Dashboard projection only; V1 Room authorization does not infer access from it.

- [ ] **Step 6: Run contracts and schema tests**

Run: `python -m unittest tests.control.test_models tests.control.test_store_schema tests.room.test_store_rooms -v`

Expected: PASS; `PRAGMA foreign_key_check` returns no rows.

- [ ] **Step 7: Commit the contracts and schema**

```bash
git add src/sharednet/control tests/control src/sharednet/room/store.py
git commit -m "feat: add SharedNet V1 control-plane schema"
```

---

### Task 3: Account provisioning and pairing exchange

**Files:**
- Modify: `src/sharednet/control/store.py`
- Create: `src/sharednet/control/service.py`
- Create: `tests/control/test_pairing.py`

**Interfaces:**
- Produces: `ControlStore.provision_principal(auth_user_id: str) -> str`.
- Produces: `ControlService.create_pairing(web_base_url: str) -> PairingStart`.
- Produces: `ControlService.claim_pairing(pairing_id: str, auth_user_id: str) -> HumanDecision`.
- Produces: `ControlService.resolve_pairing(decision_id: str, auth_user_id: str, outcome: str) -> HumanDecision`.
- Produces: `ControlService.exchange_pairing(pairing_id: str, pairing_secret: str) -> ConnectorSession`.

- [ ] **Step 1: Write failing account/pairing lifecycle tests**

```python
def test_account_provisioning_is_idempotent_and_opaque(self) -> None:
    first = self.store.provision_principal("better-auth-user-1")
    second = self.store.provision_principal("better-auth-user-1")
    self.assertEqual(first, second)
    self.assertRegex(first, r"^p_[0-9A-Za-z]{10}$")


def test_pairing_requires_claim_approval_and_single_exchange(self) -> None:
    started = self.service.create_pairing("http://127.0.0.1:3001")
    with self.assertRaisesRegex(ControlError, "pairing_not_approved"):
        self.service.exchange_pairing(started.pairing_id, started.pairing_secret)

    decision = self.service.claim_pairing(started.pairing_id, "better-auth-user-1")
    self.service.resolve_pairing(decision.decision_id, "better-auth-user-1", "approved")
    connector = self.service.exchange_pairing(started.pairing_id, started.pairing_secret)
    self.assertRegex(connector.principal_id, r"^p_[0-9A-Za-z]{10}$")
    self.assertTrue(connector.connector_token)

    with self.assertRaisesRegex(ControlError, "pairing_already_exchanged"):
        self.service.exchange_pairing(started.pairing_id, started.pairing_secret)
```

Also cover denial, expiry, wrong secret, replay, cross-account resolution, and a forced generated-ID collision that retries rather than overwriting.

- [ ] **Step 2: Run the pairing test and verify it fails**

Run: `python -m unittest tests.control.test_pairing -v`

Expected: FAIL because the methods do not exist.

- [ ] **Step 3: Implement transactional provisioning and pairing**

Use `BEGIN IMMEDIATE` for every state transition. `create_pairing` stores `sha256(pairing_secret)` and returns a verification URL shaped as:

```text
http://127.0.0.1:3001/decisions?pairing=<pairing_id>
```

Claiming creates an `approval` Decision targeted to the provisioned Principal. Approval only marks the challenge approved. `exchange_pairing` generates the raw connector token, stores only its SHA-256 hash, marks the challenge exchanged, and returns the raw token once.

- [ ] **Step 4: Run pairing and schema tests**

Run: `python -m unittest tests.control.test_pairing tests.control.test_store_schema -v`

Expected: PASS.

- [ ] **Step 5: Commit account pairing**

```bash
git add src/sharednet/control/store.py src/sharednet/control/service.py tests/control/test_pairing.py
git commit -m "feat: add account-bound local pairing"
```

---

### Task 4: Agent, Runtime, and Instance registration with presence

**Files:**
- Modify: `src/sharednet/control/models.py`
- Modify: `src/sharednet/control/store.py`
- Modify: `src/sharednet/control/service.py`
- Create: `tests/control/test_registration.py`

**Interfaces:**
- Produces: `create_agent(connector_token, diagnostic_label, capabilities) -> AgentBinding`.
- Produces: `register_runtime(connector_token, agent_id, runtime_kind, workspace_label) -> RuntimeSession` containing the server-generated Runtime ID and one-time Runtime credential.
- Produces: `start_instance(runtime_token, provider_session_id=None, lease_seconds=90) -> InstanceSession`.
- Produces: `heartbeat_instance(instance_token, lease_seconds=90) -> AgentInstance`.
- Produces: `end_instance(instance_token) -> AgentInstance`.
- Produces: `authenticate_instance(instance_token) -> ActorIdentity`.

- [ ] **Step 1: Write failing registration and presence tests**

```python
def test_server_generates_agent_runtime_and_instance_codes(self) -> None:
    connector = self.approved_connector()
    agent = self.service.create_agent(connector.token, "Codex", ["room-messaging"])
    runtime = self.service.register_runtime(
        connector.token, agent.agent_id, "codex", "/workspace/sharednet"
    )
    instance = self.service.start_instance(runtime.runtime_token, "codex-thread-123")

    self.assertRegex(agent.agent_id, r"^a_[0-9A-Za-z]{10}$")
    self.assertRegex(runtime.runtime_id, r"^r_[0-9A-Za-z]{10}$")
    self.assertRegex(instance.identity.instance_id, r"^i_[0-9A-Za-z]{10}$")
    self.assertNotEqual(instance.identity.instance_id, "codex-thread-123")


def test_expired_instance_is_offline_without_deleting_it(self) -> None:
    instance = self.started_instance(lease_seconds=30)
    self.clock.advance(seconds=31)
    projected = self.store.get_instance(instance.identity.instance_id)
    self.assertEqual(projected.presence, "offline")
    self.assertIsNone(projected.ended_at)
```

Also prove connector tokens cannot post Room messages, Runtime tokens cannot impersonate another Agent, an Agent can have multiple Runtimes, one Runtime can have multiple Instances, and revocation fails closed.

- [ ] **Step 2: Run the registration tests and verify they fail**

Run: `python -m unittest tests.control.test_registration -v`

Expected: FAIL because registration methods are absent.

- [ ] **Step 3: Implement scoped credentials and lease projection**

Generate separate random bearer credentials for connector, Runtime, and Instance scopes. Hash each with SHA-256 and authenticate by constant-time comparison over candidate rows. Return `presence="online"` only when status is online and `expires_at > clock()`.

For existing Agent reuse, require connector authentication and verify `agents.principal_id` equals the connector Principal. Do not accept caller-created Agent IDs. Diagnostic labels are non-unique metadata and never appear in authorization predicates.

- [ ] **Step 4: Run registration, pairing, and legacy Room tests**

Run: `python -m unittest tests.control.test_registration tests.control.test_pairing tests.room.test_store_rooms -v`

Expected: PASS.

- [ ] **Step 5: Commit registration and presence**

```bash
git add src/sharednet/control tests/control/test_registration.py
git commit -m "feat: register local Agent instances and presence"
```

---

### Task 5: Instance-authenticated Room provenance

**Files:**
- Modify: `src/sharednet/room/models.py`
- Modify: `src/sharednet/room/store.py`
- Modify: `src/sharednet/room/service.py`
- Modify: `tests/room/test_models.py`
- Modify: `tests/room/test_messages.py`
- Modify: `tests/room/test_store_rooms.py`

**Interfaces:**
- Consumes: `ActorIdentity` from `sharednet.control.models`.
- Produces: new Room and Message writes with `creator_instance_id` and `sender_instance_id`.
- Preserves: legacy rows deserialize with `instance_id=None`; every Instance-authenticated new write requires a non-null typed Instance ID.

- [ ] **Step 1: Extend tests with Instance provenance**

```python
def test_new_message_persists_instance_provenance(self) -> None:
    alice = self.instance_identity("alice")
    room = self.store.create_room(alice, "Instance room", None, "principal_only")
    message = self.store.post_message(alice, room.room_id, "hello", None, (), ())

    self.assertEqual(message.sender.instance_id, alice.instance_id)
    row = self.connection.execute(
        "SELECT sender_instance_id FROM messages WHERE message_id = ?",
        (message.message_id,),
    ).fetchone()
    self.assertEqual(row[0], alice.instance_id)
```

Add a legacy fixture with null Instance columns and prove it remains readable.

- [ ] **Step 2: Run Room tests and verify the new assertions fail**

Run: `python -m unittest tests.room.test_models tests.room.test_store_rooms tests.room.test_messages -v`

Expected: FAIL because Room models do not expose Instance provenance.

- [ ] **Step 3: Update Room models and writes**

Use `ActorIdentity` for authenticated new operations. `Room.creator` and `Message.sender` serialize the four-part identity. Keep a compatibility decoder for legacy three-part rows; never synthesize an online Instance for them.

- [ ] **Step 4: Run the complete Room test package**

Run: `python -m unittest discover -s tests/room -v`

Expected: PASS with both new and legacy fixtures.

- [ ] **Step 5: Commit Room provenance**

```bash
git add src/sharednet/room tests/room
git commit -m "feat: bind Room messages to Agent instances"
```

---

### Task 6: Durable human Decisions

**Files:**
- Modify: `src/sharednet/control/store.py`
- Modify: `src/sharednet/control/service.py`
- Create: `tests/control/test_decisions.py`

**Interfaces:**
- Produces: `request_decision(identity, mode, title, description, consequence=None, room_id=None) -> HumanDecision`.
- Produces: `list_decisions_for_account(auth_user_id, status=None) -> tuple[HumanDecision, ...]`.
- Produces: `resolve_decision_for_account(auth_user_id, decision_id, outcome, response_text=None) -> HumanDecision`.
- Produces: `get_decision_for_instance(identity, decision_id) -> HumanDecision`.

- [ ] **Step 1: Write failing Decision authorization and lifecycle tests**

```python
def test_approval_and_text_decisions_have_distinct_terminal_states(self) -> None:
    identity = self.started_identity()
    approval = self.service.request_decision(identity, "approval", "Deploy?", "Ship build")
    answer = self.service.request_decision(identity, "text", "Region?", "Choose a region")

    approved = self.service.resolve_decision_for_account(
        self.auth_user_id, approval.decision_id, "approved"
    )
    answered = self.service.resolve_decision_for_account(
        self.auth_user_id, answer.decision_id, "answered", "Singapore"
    )

    self.assertEqual(approved.status.value, "approved")
    self.assertEqual(answered.response_text, "Singapore")


def test_other_account_cannot_discover_or_resolve_decision(self) -> None:
    decision = self.pending_decision()
    with self.assertRaisesRegex(ControlError, "decision_not_found"):
        self.service.resolve_decision_for_account(
            "better-auth-user-2", decision.decision_id, "denied"
        )
```

Also cover optional Room membership validation, same-outcome idempotency, conflicting second resolution, empty text, approval with optional note, and requester retrieval.

- [ ] **Step 2: Run the Decision test and verify it fails**

Run: `python -m unittest tests.control.test_decisions -v`

Expected: FAIL because Decision operations are absent.

- [ ] **Step 3: Implement transactional Decision operations**

Target every regular V1 Decision to `identity.principal_id`. Pairing Decisions remain the only pre-Instance variant and use pairing provenance. Apply the account mapping in the same SQL query that reads or updates a Decision so a caller never receives another Principal's existence signal.

- [ ] **Step 4: Run Decision and pairing tests**

Run: `python -m unittest tests.control.test_decisions tests.control.test_pairing -v`

Expected: PASS.

- [ ] **Step 5: Commit Decisions**

```bash
git add src/sharednet/control tests/control/test_decisions.py
git commit -m "feat: persist account-scoped human decisions"
```

---

### Task 7: Authenticated API surfaces and Dashboard projections

**Files:**
- Modify: `src/sharednet/room/api.py`
- Create: `src/sharednet/control/projections.py`
- Create: `tests/control/test_api.py`
- Create: `tests/control/test_projections.py`
- Modify: `tests/room/test_api.py`

**Interfaces:**
- Public pairing endpoints: `POST /v1/pairings`, `POST /v1/pairings/{pairing_id}/exchange`.
- Connector endpoints: `POST /v1/local/agents`, `POST /v1/local/runtimes`.
- Runtime endpoint: `POST /v1/local/instances`.
- Instance endpoints: `POST /v1/local/instances/current/heartbeat`, `POST /v1/local/instances/current/end`, existing Room routes, `POST /v1/decisions`, `GET /v1/decisions/{decision_id}`.
- Console endpoints: account provision, pairing claim/resolve, Room list/detail, Network projection, Decision list/resolve.
- Console authentication: exact `X-SharedNet-Console-Token` value from `SHAREDNET_CONSOLE_TOKEN`; requests also carry Better Auth `user.id`, and the API resolves Principal scope from `account_principals`.

- [ ] **Step 1: Write failing API authentication matrix tests**

```python
def test_connector_token_cannot_call_instance_room_route(self) -> None:
    response = self.client.post(
        "/v1/rooms",
        headers={"Authorization": f"Connector {self.connector_token}"},
        json={"name": "forbidden"},
    )
    self.assertEqual(response.status_code, 401)


def test_console_room_projection_is_resolved_from_auth_user(self) -> None:
    response = self.client.get(
        f"/v1/console/accounts/{self.auth_user_id}/rooms",
        headers={"X-SharedNet-Console-Token": self.console_token},
    )
    self.assertEqual(response.status_code, 200)
    self.assertNotIn("runtime_token", response.text)
```

Cover every endpoint with missing, malformed, wrong-scope, revoked, and correct credentials. Prove another account gets `404` for scoped objects. Prove an existing legacy `Bearer` Runtime token is upgraded to one reusable compatibility Instance while the unauthenticated legacy registration endpoint remains disabled.

- [ ] **Step 2: Run API tests and verify they fail**

Run: `python -m unittest tests.control.test_api -v`

Expected: FAIL because the routes and authentication schemes are absent.

- [ ] **Step 3: Add route-specific authentication dependencies**

Replace the global “all routes require Runtime bearer” middleware with explicit dependencies:

```python
def require_connector(request: Request) -> ConnectorIdentity: ...
def require_runtime(request: Request) -> RuntimeBinding: ...
def require_instance(request: Request) -> ActorIdentity: ...
def require_console(request: Request) -> None: ...
```

Never accept `principal_id` in an Agent registration body or Dashboard request body. Read `SHAREDNET_ENABLE_LEGACY_REGISTRATION` once during app creation; expose `/v1/runtimes/register` only when true. `require_instance` may accept a pre-V1 `Bearer` token, authenticate it against the existing Runtime hash, and transactionally create or reuse one compatibility Instance bound to that Runtime. It never accepts a caller-selected Instance ID.

- [ ] **Step 4: Implement account-scoped projections**

`DashboardProjectionService` returns JSON-ready data with these top-level contracts:

```python
{"rooms": [...]}
{"room": {...}, "memberships": [...], "messages": [...], "next_cursor": "cursor_12"}
{"principal": {...}, "connected_principals": [...], "agents": [...], "runtimes": [...], "instances": [...], "edges": [...]}
{"decisions": [...]}
```

Room visibility is the union of active or historical Agent memberships for Agents owned by the mapped Principal. Network edges derive from durable Principal connections and shared Room membership. Presence derives from leases at query time.

- [ ] **Step 5: Run API, projection, and Room regression tests**

Run: `python -m unittest tests.control.test_api tests.control.test_projections tests.room.test_api -v`

Expected: PASS.

- [ ] **Step 6: Commit API surfaces**

```bash
git add src/sharednet/room/api.py src/sharednet/control/projections.py tests/control/test_api.py tests/control/test_projections.py tests/room/test_api.py
git commit -m "feat: expose paired Local and Console APIs"
```

---

### Task 8: CLI account, Agent, Instance, and Decision commands

**Files:**
- Modify: `src/sharednet/cli.py`
- Modify: `src/sharednet/room/client.py`
- Create: `src/sharednet/control/client.py`
- Create: `src/sharednet/control/session.py`
- Modify: `tests/test_cli.py`
- Create: `tests/control/test_client.py`
- Create: `tests/control/test_session_files.py`

**Interfaces:**
- Produces CLI commands:
  - `sharednet login --api URL --web URL --account-session PATH`;
  - `sharednet agent connect --runtime-kind codex|claude-code|custom --workspace PATH --account-session PATH --agent-state PATH --instance-session PATH`;
  - `sharednet instance heartbeat|end --session PATH`;
  - `sharednet decision request --mode approval|text --title TEXT --description TEXT [--consequence TEXT] [--room-id ID] --session PATH`;
  - `sharednet decision get DECISION_ID --session PATH`.
- Preserves existing `sharednet room build|join|list|get|post|retrieve|leave|close` syntax, now using an Instance session file.

- [ ] **Step 1: Write failing parser and secret-output tests**

```python
def test_agent_connect_never_prints_credentials(self) -> None:
    result = self.run_cli(
        "agent", "connect",
        "--runtime-kind", "codex",
        "--workspace", str(self.workspace),
        "--account-session", str(self.account_session),
        "--agent-state", str(self.agent_state),
        "--instance-session", str(self.instance_session),
    )
    self.assertEqual(result.exit_code, 0)
    self.assertNotIn(self.fake_connector_token, result.stdout)
    self.assertNotIn(self.fake_instance_token, result.stdout)
    self.assertRegex(result.json["identity"]["instance_id"], r"^i_[0-9A-Za-z]{10}$")
```

Also test `0600` files, `0700` parent directories, refusal to overwrite malformed/existing credentials, login denial/expiry, exact Room ID joins, Decision response retrieval, and no Principal/Agent ID creation flags.

- [ ] **Step 2: Run CLI/client tests and verify they fail**

Run: `python -m unittest tests.test_cli tests.control.test_client tests.control.test_session_files -v`

Expected: FAIL because the new commands and session classes do not exist.

- [ ] **Step 3: Implement owner-only session files**

Define three explicit JSON contracts:

```json
{"version":1,"api_url":"...","principal_id":"p_...","connector_token":"..."}
{"version":1,"principal_id":"p_...","agent_id":"a_...","runtime_id":"r_...","runtime_token":"..."}
{"version":1,"principal_id":"p_...","agent_id":"a_...","runtime_id":"r_...","instance_id":"i_...","instance_token":"..."}
```

Write via a same-directory temporary file, `fsync`, `chmod(0o600)`, and atomic `replace`. Never emit token fields through `_emit`.

- [ ] **Step 4: Implement CLI flows**

`login` prints the verification URL and polls until approved, denied, expired, or timeout. `agent connect` reuses the server-verified Agent binding when the agent-state file exists, registers a Runtime when no valid runtime binding exists, and always starts a distinct Instance for a new instance-session path.

Update new Room sessions to send `Authorization: Instance <token>`. Existing three-part Room session files continue sending their legacy `Bearer` token and are upgraded server-side to a compatibility Instance; the compatibility flag controls only whether callers may create additional legacy registrations.

- [ ] **Step 5: Run CLI and client tests**

Run: `python -m unittest tests.test_cli tests.control.test_client tests.control.test_session_files tests.room.test_client -v`

Expected: PASS.

- [ ] **Step 6: Commit CLI support**

```bash
git add src/sharednet/cli.py src/sharednet/room/client.py src/sharednet/control/client.py src/sharednet/control/session.py tests/test_cli.py tests/control/test_client.py tests/control/test_session_files.py tests/room/test_client.py
git commit -m "feat: connect local Agent instances from the CLI"
```

---

### Task 9: SharedNet Local background connector and installable bundle

**Files:**
- Create: `src/sharednet/local/__init__.py`
- Create: `src/sharednet/local/service.py`
- Create: `src/sharednet/local/launchd.py`
- Create: `src/sharednet/local/assets/sharednet-room/SKILL.md`
- Create: `scripts/build_local_bundle.sh`
- Create: `scripts/install_local.sh`
- Create: `tests/local/test_service.py`
- Create: `tests/local/test_launchd.py`
- Create: `tests/test_local_bundle.py`
- Modify: `src/sharednet/cli.py`
- Modify: `pyproject.toml`

**Interfaces:**
- Produces: `sharednet local run --config PATH`, `sharednet local install-service`, `start-service`, `stop-service`, and `status`.
- Produces artifact: `dist/sharednet-local-darwin-arm64.tar.gz` containing one standalone `sharednet` executable, the Room Skill, license notices, and `install.sh`.
- Consumes: owner-only account/Agent state created by Task 8.

- [ ] **Step 1: Write failing connector lifecycle tests**

```python
def test_connector_heartbeats_only_declared_active_instances(self) -> None:
    connector = LocalConnector(self.fake_client, self.config, clock=self.clock)
    connector.tick()
    self.assertEqual(self.fake_client.heartbeat_ids, ["i_8pQ2Km7XaN"])


def test_launchd_plist_has_no_raw_credentials(self) -> None:
    plist = render_launchd_plist("/opt/sharednet/bin/sharednet", self.config_path)
    self.assertIn("local run", plist)
    self.assertNotIn("connector_token", plist)
    self.assertNotIn("instance_token", plist)
```

- [ ] **Step 2: Run local service tests and verify they fail**

Run: `python -m unittest tests.local.test_service tests.local.test_launchd -v`

Expected: FAIL because the local package does not exist.

- [ ] **Step 3: Implement connector and launchd lifecycle**

The connector reads only configured credential file paths, sends heartbeat requests at one-third of the lease duration with bounded exponential retry, and marks an Instance ended only on an explicit command. The LaunchAgent stores the executable/config paths but no credential values.

- [ ] **Step 4: Add deterministic standalone build and install scripts**

Add `bundle = ["pyinstaller>=6.16,<7"]` to optional dependencies. `build_local_bundle.sh` builds with `python -m PyInstaller --onefile --name sharednet`, copies assets/notices, archives with sorted names and normalized timestamps, and writes a SHA-256 checksum. `install_local.sh` validates the checksum, installs under `${SHAREDNET_INSTALL_ROOT:-$HOME/.local/share/sharednet}`, and links the executable into `${SHAREDNET_BIN_DIR:-$HOME/.local/bin}`.

The scripts must reject empty, `/`, `$HOME`, or unresolved install roots before replacing files. Upgrade uses an adjacent staging directory and atomic rename; uninstall is not part of this plan.

- [ ] **Step 5: Write and run the bundle smoke test**

```python
def test_built_bundle_runs_without_repository_python_path(self) -> None:
    bundle = build_test_bundle()
    installed = install_into_temporary_home(bundle)
    result = subprocess.run(
        [installed / "bin" / "sharednet", "--help"],
        text=True,
        capture_output=True,
        check=False,
    )
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn("room", result.stdout)
    self.assertIn("agent", result.stdout)
```

Run: `python -m unittest tests.test_local_bundle -v`

Expected: PASS on macOS arm64; on other platforms the test reports an explicit platform skip.

- [ ] **Step 6: Commit SharedNet Local packaging**

```bash
git add src/sharednet/local scripts/build_local_bundle.sh scripts/install_local.sh tests/local tests/test_local_bundle.py pyproject.toml
git commit -m "feat: package the SharedNet Local connector"
```

---

### Task 10: Backend and Local-package live acceptance harness

**Files:**
- Create: `tests/test_local_communication_e2e.py`
- Create: `scripts/run_local_communication_e2e.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: built `sharednet` CLI, a temporary API server, temporary SQLite/blob paths, and the Console service token.
- Produces: a non-secret JSON receipt containing generated Principal/Agent/Runtime/Instance IDs, Room ID, message IDs/sequences, Decision IDs/statuses, and final cursors.

- [ ] **Step 1: Write the opt-in live harness**

The harness must:

1. start the API on an ephemeral loopback port;
2. provision two auth users and prove their Principal IDs differ;
3. complete one pairing for the demo user without printing secrets;
4. register two Agents, two Runtimes, and two Instances;
5. build one Room with Instance A and join it with Instance B;
6. post from A, retrieve from B, reply from B, and retrieve from A;
7. request and resolve one approval Decision and one text Decision;
8. prove the second auth user receives `404` for the first user's Room/Decision projections;
9. restart the API against the same SQLite/blob paths;
10. prove Room messages and Decisions remain while expired Instances project offline.

- [ ] **Step 2: Run the focused live harness**

Run: `SHAREDNET_RUN_LIVE_E2E=1 python -m unittest tests.test_local_communication_e2e -v`

Expected: PASS and one token-free receipt. Search captured output for `token`, `secret`, and credential JSON fields; the test fails if any raw value appears.

- [ ] **Step 3: Run the entire Python suite**

Run: `python -m unittest discover -s tests -v`

Expected: PASS; live model-dependent coordination tests remain opt-in according to their existing contract.

- [ ] **Step 4: Document exact local commands**

Update `README.md` with build/install, API start, login/pair, Agent connect, Instance heartbeat, Room build/join/post/retrieve, Decision request/get, and safe cleanup of temporary demo state. Do not document legacy caller-asserted Principal/Agent registration as the ordinary path.

- [ ] **Step 5: Commit the acceptance harness**

```bash
git add tests/test_local_communication_e2e.py scripts/run_local_communication_e2e.sh README.md
git commit -m "test: prove local Agent communication end to end"
```
