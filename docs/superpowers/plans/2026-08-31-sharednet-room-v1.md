# SharedNet Room V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent local Room API through which independently running AI chats register distinct identities, join human-shared Rooms, exchange ordered messages and attachments, and honor message-level obligations.

**Architecture:** Add a focused `sharednet.room` package with frozen contracts, a transactional SQLite repository, a content-addressed local blob store, a domain service, a FastAPI transport, and a thin HTTP client/CLI. A project-local Codex skill calls the CLI. Normal CI proves all behavior with three deterministic clients; an opt-in test launches three separate Codex processes for the live proof.

**Tech Stack:** Python 3.11+, stdlib `sqlite3`, `hashlib`, and `urllib`; FastAPI and Uvicorn for HTTP; HTTPX-backed FastAPI `TestClient` for tests; stdlib `unittest` to match the repository.

**Spec:** `docs/superpowers/specs/2026-08-31-sharednet-room-v1-design.md`

## Global Constraints

- The daemon binds to `127.0.0.1` by default and initial registration is a local trust boundary, not hosted authentication.
- Authenticated sender identity always comes from the runtime token; request bodies never select sender provenance.
- Room membership is keyed by `(room_id, agent_id)` and joins are idempotent.
- Message ordering uses one Room-local monotonic sequence allocated in the insertion transaction.
- Messages, tags, provenance, and completed artifact metadata are immutable.
- Only `human-review-required`, `verification-required`, and `delegate-to:<agent-or-principal-id>` are valid tags.
- Tags can create obligations and block resolution state; they never create identity, membership, tokens, or authority.
- Uploads stream to disk, default to a 256 MiB ceiling, and use SHA-256 content paths.
- No automatic recruitment, task decomposition, team formation, WebSockets, semantic search, trust scoring, hosted runtime, TLS, or executable custom tags.
- Normal tests never invoke a model. Live Codex execution requires `RUN_CODEX_ROOM_E2E=1`.

---

### Task 1: Room contracts, validation, and package dependencies

**Files:**
- Create: `src/sharednet/room/__init__.py`
- Create: `src/sharednet/room/errors.py`
- Create: `src/sharednet/room/models.py`
- Modify: `pyproject.toml`
- Test: `tests/room/__init__.py`
- Test: `tests/room/test_models.py`

**Interfaces:**
- Produces: `RoomError(code: str, message: str, status_code: int)`.
- Produces: `RuntimeIdentity`, `RuntimeRegistration`, `Room`, `Membership`, `Message`, `Obligation`, `Artifact`, and `MessagePage` frozen dataclasses with `to_dict()`.
- Produces: `parse_cursor(value: str | None) -> int`, `format_cursor(sequence: int) -> str`, and `normalize_tags(tags: object) -> tuple[CoordinationTag, ...]`.

- [ ] **Step 1: Write failing model tests**

```python
class RoomModelTests(unittest.TestCase):
    def test_cursor_round_trip_and_validation(self) -> None:
        self.assertEqual(parse_cursor(None), 0)
        self.assertEqual(parse_cursor("cursor_41"), 41)
        self.assertEqual(format_cursor(41), "cursor_41")
        with self.assertRaisesRegex(RoomError, "invalid_cursor"):
            parse_cursor("41")

    def test_tags_are_typed_unique_and_fail_closed(self) -> None:
        tags = normalize_tags(["verification-required", "delegate-to:agent_reviewer"])
        self.assertEqual([tag.kind for tag in tags], ["verification", "delegation"])
        with self.assertRaisesRegex(RoomError, "duplicate_tag"):
            normalize_tags(["verification-required", "verification-required"])
        with self.assertRaisesRegex(RoomError, "invalid_tag"):
            normalize_tags(["custom-code:run"])
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_models`

Expected: import failure because `sharednet.room.models` does not exist.

- [ ] **Step 3: Implement contracts and validation**

Implement exact enums and helpers:

```python
class RoomStatus(str, Enum): OPEN = "open"; CLOSED = "closed"
class MembershipStatus(str, Enum): ACTIVE = "active"; LEFT = "left"
class ResolutionState(str, Enum): NOT_REQUIRED = "not_required"; PENDING = "pending"; RESOLVED = "resolved"; REJECTED = "rejected"

@dataclass(frozen=True)
class CoordinationTag:
    raw: str
    kind: Literal["human_review", "verification", "delegation"]
    target_id: str | None = None
```

Validate identifiers with `^[A-Za-z][A-Za-z0-9_.:-]{0,127}$`, Room names as trimmed 1–200 characters, descriptions at most 4,000 characters, content as trimmed 1–100,000 characters, filenames as basename-only 1–255 characters, and limits from 1 through 100.

Add runtime dependencies `fastapi>=0.115,<1` and `uvicorn>=0.30,<1`; keep `httpx>=0.27,<1` in the `test` extra with `setuptools>=77.0.0`.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_models`

Expected: all model tests pass.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml src/sharednet/room tests/room
git commit -m "feat: add Room V1 contracts"
```

### Task 2: Transactional identity, Room, and membership repository

**Files:**
- Create: `src/sharednet/room/store.py`
- Test: `tests/room/test_store_rooms.py`

**Interfaces:**
- Consumes: model dataclasses and `RoomError` from Task 1.
- Produces: `RoomStore(database_path: Path, clock: Callable[[], datetime] = utc_now)`.
- Produces methods:

```python
initialize() -> None
register_runtime(principal_id: str, agent_id: str, requested_runtime_id: str | None) -> tuple[RuntimeRegistration, str]
authenticate_runtime(raw_token: str) -> RuntimeIdentity
create_room(identity: RuntimeIdentity, name: str, description: str | None, access_policy: str) -> Room
join_room(identity: RuntimeIdentity, room_id: str) -> Membership
list_rooms(identity: RuntimeIdentity) -> tuple[RoomSummary, ...]
get_room(identity: RuntimeIdentity, room_id: str) -> tuple[Room, tuple[Membership, ...]]
leave_room(identity: RuntimeIdentity, room_id: str) -> Membership
close_room(identity: RuntimeIdentity, room_id: str) -> Room
```

- [ ] **Step 1: Write failing identity and Room tests**

Cover first-use Principal/Agent creation, hashed tokens, token-derived identity, Agent-to-Principal remapping rejection, Runtime ID collision, creator auto-membership, `principal_only`, idempotent join, leave/rejoin of one row, list membership state, owner-only close, closed history readability, and closed join/post preparation rejection.

```python
registration, token = store.register_runtime("principal_alice", "agent_alpha", "runtime_alpha")
self.assertEqual(store.authenticate_runtime(token).runtime_id, "runtime_alpha")
self.assertNotIn(token, database_path.read_bytes().decode("utf-8", errors="ignore"))
self.assertEqual(store.join_room(identity, room.room_id), store.join_room(identity, room.room_id))
```

- [ ] **Step 2: Run the repository tests and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_store_rooms`

Expected: import failure because `RoomStore` does not exist.

- [ ] **Step 3: Implement schema and repository operations**

Create `principals`, `agents`, `runtime_registrations`, `rooms`, and `room_memberships` tables. Enable `PRAGMA foreign_keys=ON`, use WAL mode, open one connection per operation, and use `BEGIN IMMEDIATE` for upserts and lifecycle transitions. Persist token hashes as `sha256(raw_token).hexdigest()` and compare with `hmac.compare_digest`.

Generate IDs as lowercase URL-safe tokens with prefixes `runtime_`, `room_`, and `membership_`. Preserve a requested Runtime ID only after identifier validation and uniqueness checks.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_store_rooms`

Expected: all identity, Room, and membership tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sharednet/room/store.py tests/room/test_store_rooms.py
git commit -m "feat: persist Room identities and membership"
```

### Task 3: Ordered messaging, cursors, replies, unread state, and obligations

**Files:**
- Modify: `src/sharednet/room/store.py`
- Create: `src/sharednet/room/service.py`
- Test: `tests/room/test_messages.py`

**Interfaces:**
- Consumes: `RoomStore`, authenticated identity, cursor and tag helpers.
- Produces `RoomService(store: RoomStore, blob_store: BlobStore | None = None)`.
- Produces methods:

```python
post_message(identity, room_id, content, reply_to=None, tags=(), attachment_ids=()) -> Message
retrieve_messages(identity, room_id, after_cursor=None, limit=50) -> MessagePage
resolve_message(identity, room_id, message_id, outcome, evidence=None) -> Message
```

- [ ] **Step 1: Write failing messaging tests**

Cover active-membership enforcement, stable ascending sequence, two-thread concurrent inserts without duplicate sequences, same-Room replies, foreign reply rejection, pagination and empty-page cursor preservation, membership read-cursor updates, unread counts, immutable sender provenance, valid tag obligation rows, unknown/duplicate tag rejection, each resolver rule, fulfilled/rejected aggregate state, and tags never changing membership.

```python
first = service.post_message(alpha, room_id, "proposal")
second = service.post_message(beta, room_id, "review", reply_to=first.message_id)
page = service.retrieve_messages(gamma, room_id, after_cursor="cursor_1", limit=10)
self.assertEqual([message.message_id for message in page.messages], [second.message_id])
self.assertEqual(page.next_cursor, "cursor_2")
self.assertEqual(second.sender_runtime_id, beta.runtime_id)
```

- [ ] **Step 2: Run the messaging tests and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_messages`

Expected: missing service/store message methods.

- [ ] **Step 3: Implement transactional messaging and resolution**

Add `messages`, `message_obligations`, and `message_resolutions` tables. Allocate `MAX(sequence)+1` inside the same `BEGIN IMMEDIATE` transaction as insertion. Store normalized tags as canonical JSON. Derive all sender/resolver columns from `RuntimeIdentity`. Update Room activity on post and Membership `last_read_sequence` only to the greatest sequence returned.

Implement resolver predicates exactly as specified in the design document. Re-read all obligation rows within the resolution transaction and derive aggregate `pending`, `resolved`, or `rejected` state.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_messages`

Expected: all messaging and obligation tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sharednet/room/store.py src/sharednet/room/service.py tests/room/test_messages.py
git commit -m "feat: add ordered Room messaging"
```

### Task 4: Streaming content-addressed Room artifacts

**Files:**
- Create: `src/sharednet/room/blobs.py`
- Modify: `src/sharednet/room/store.py`
- Modify: `src/sharednet/room/service.py`
- Test: `tests/room/test_artifacts.py`

**Interfaces:**
- Produces `LocalBlobStore(root: Path, max_upload_bytes: int = 268_435_456)`.
- Produces `store_stream(chunks: Iterable[bytes]) -> StoredBlob` and `open_blob(sha256: str) -> BinaryIO`.
- Produces service methods:

```python
upload_artifact(identity, room_id, filename, media_type, chunks) -> Artifact
open_artifact(identity, room_id, artifact_id) -> tuple[Artifact, BinaryIO]
```

- [ ] **Step 1: Write failing artifact tests**

Cover multi-chunk streaming, 256 MiB configurable ceiling via a small test limit, temporary-file cleanup on failure, SHA-256 correctness, physical deduplication, basename validation, Room membership, closed-Room rejection, cross-Room attachment rejection, download integrity, and metadata/blob survival after new store/service instances are constructed.

```python
artifact = service.upload_artifact(alpha, room_id, "brief.bin", "application/octet-stream", [b"abc", b"def"])
self.assertEqual(artifact.sha256, hashlib.sha256(b"abcdef").hexdigest())
metadata, stream = service.open_artifact(beta, room_id, artifact.artifact_id)
with stream:
    self.assertEqual(stream.read(), b"abcdef")
```

- [ ] **Step 2: Run artifact tests and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_artifacts`

Expected: `LocalBlobStore` and artifact methods are missing.

- [ ] **Step 3: Implement blob and metadata persistence**

Write uploads under `<root>/.tmp/<random>`, hash and count each chunk before writing, fail as soon as the configured ceiling is crossed, `fsync`, then atomically replace into `<root>/sha256/<first-two>/<digest>`. Add `artifacts` and `message_artifacts` tables. Insert artifact metadata only after the completed blob exists; remove unreferenced temporary files in `finally`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_artifacts`

Expected: all artifact tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sharednet/room/blobs.py src/sharednet/room/store.py src/sharednet/room/service.py tests/room/test_artifacts.py
git commit -m "feat: add Room artifact storage"
```

### Task 5: FastAPI transport and stable error contract

**Files:**
- Create: `src/sharednet/room/api.py`
- Test: `tests/room/test_api.py`

**Interfaces:**
- Produces `create_room_app(database_path: Path, blob_path: Path, max_upload_bytes: int = 268_435_456) -> FastAPI`.
- Maps every endpoint and status specified in the design document.
- Maps `RoomError` to `{"error": {"code": code, "message": message}}`.

- [ ] **Step 1: Write failing HTTP contract tests**

Use `with TestClient(create_room_app(...)) as client:`. Cover health, registration, missing/malformed Bearer token, every Room operation, message/reply/cursor flow, resolution, raw streamed upload/download, closed Room behavior, and exact error bodies. Assert 400 for validation/cursor/tag errors, 401 for missing/invalid tokens, 403 for membership/access/resolver errors, 404 for missing resources, 409 for lifecycle/identity collisions, and 413 for upload limits.

```python
response = client.post("/v1/rooms", headers=auth(token), json={"name": "Product design"})
self.assertEqual(response.status_code, 201)
room_id = response.json()["room_id"]
self.assertEqual(client.post(f"/v1/rooms/{room_id}/memberships", headers=auth(peer_token)).status_code, 200)
```

- [ ] **Step 2: Run API tests and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_api`

Expected: `sharednet.room.api` is missing.

- [ ] **Step 3: Implement the app factory and routes**

Use synchronous FastAPI route functions around the synchronous domain service. Read upload bodies with `async for chunk in request.stream()` and pass chunks through a bounded bridge that does not concatenate the body. Return `StreamingResponse` for downloads. Initialize schema in the app lifespan and use `TestClient` as a context manager.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_api`

Expected: all endpoint and error-contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sharednet/room/api.py tests/room/test_api.py
git commit -m "feat: expose the Room HTTP API"
```

### Task 6: HTTP client, persistent runtime session, and `sharednet room` CLI

**Files:**
- Create: `src/sharednet/room/client.py`
- Modify: `src/sharednet/cli.py`
- Test: `tests/room/test_client.py`
- Modify: `tests/test_cli.py`

**Interfaces:**
- Produces `RoomClient(base_url: str, token: str | None = None, timeout: float = 30.0)` using stdlib `urllib.request` so the installed client has no HTTPX runtime dependency.
- Produces `RoomSessionFile(path: Path)` that writes mode `0o600` JSON containing `base_url`, token, and identity.
- Adds CLI commands `serve`, `register`, `build`, `join`, `list`, `get`, `post`, `retrieve`, `resolve`, `upload`, `download`, `leave`, and `close` beneath `sharednet room`.

- [ ] **Step 1: Write failing client and CLI tests**

Run a Uvicorn server on an OS-assigned loopback port in a test thread. Assert registration saves an owner-only session file, later commands load it, JSON outputs match API responses, repeated join is stable, `--tag` and `--attachment` repeat, downloads preserve bytes, server errors preserve code/message on stderr, and no command prints the bearer token except the explicit registration result.

- [ ] **Step 2: Run client/CLI tests and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_client tests.test_cli`

Expected: Room client and parser commands are missing.

- [ ] **Step 3: Implement client and CLI commands**

Default session path to `.sharednet/room-session.json` in the current working directory; permit `SHAREDNET_ROOM_URL`, `SHAREDNET_RUNTIME_TOKEN`, and `SHAREDNET_ROOM_SESSION` overrides. Default server paths to `.sharednet/sharednet.db` and `.sharednet/blobs`. Default serve host to `127.0.0.1` and reject non-loopback hosts unless `--allow-remote-without-tls` is explicitly passed.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_client tests.test_cli`

Expected: all client and CLI tests pass without regressing coordination CLI tests.

- [ ] **Step 5: Commit**

```bash
git add src/sharednet/room/client.py src/sharednet/cli.py tests/room/test_client.py tests/test_cli.py
git commit -m "feat: add Room client commands"
```

### Task 7: Project-local Codex Room skill

**Files:**
- Create: `.agents/skills/sharednet-room/SKILL.md`
- Create: `.agents/skills/sharednet-room/references/command-contract.md`
- Test: `tests/room/test_skill.py`

**Interfaces:**
- Consumes: exact `sharednet room` CLI commands from Task 6.
- Produces: a discoverable skill named `sharednet-room` with agent behavior matching section 7 of the design spec.

- [ ] **Step 1: Write the failing skill contract test**

```python
skill = Path(".agents/skills/sharednet-room/SKILL.md").read_text()
self.assertIn("name: sharednet-room", skill)
for command in ("list", "build", "join", "retrieve", "post", "upload", "leave", "close"):
    self.assertIn(f"sharednet room {command}", skill)
self.assertIn("Never recruit", skill)
```

- [ ] **Step 2: Run the skill test and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_skill`

Expected: skill file is missing.

- [ ] **Step 3: Create the concise skill and command reference**

Keep `SKILL.md` focused on routing and behavioral rules. Put exact flags, JSON outputs, cursor handling, reply/tag examples, artifact workflow, and error recovery in `references/command-contract.md`. Do not duplicate server authorization logic in the skill.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `PYTHONPATH=src python3 -m unittest -v tests.room.test_skill`

Expected: skill contract passes.

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/sharednet-room tests/room/test_skill.py
git commit -m "feat: teach Codex to use SharedNet Rooms"
```

### Task 8: Deterministic three-client end-to-end proof

**Files:**
- Create: `tests/test_room_e2e.py`

**Interfaces:**
- Consumes: public HTTP/CLI interface only.
- Produces: one hermetic acceptance test proving the complete V1 scenario and persistence after restart.

- [ ] **Step 1: Write the failing E2E test**

Start a real loopback Uvicorn server with temporary SQLite/blob paths. Register three distinct tuples, have A build and post with an uploaded artifact, B and C join and retrieve history, B reply to A, C retrieve by cursor and reply to B, repeat B's join, list all memberships, close as A, restart the daemon using the same paths, then retrieve retained history as every active member.

Assert exact distinct Principal/Agent/Runtime provenance, sequences `[1, 2, 3]`, reply IDs, attachment digest, one membership row per Agent, next-cursor behavior, unread transitions, closed post rejection, and retained history.

- [ ] **Step 2: Run the E2E test and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.test_room_e2e`

Expected: the first missing or incorrect public contract fails.

- [ ] **Step 3: Make only integration corrections required by the public flow**

Do not add new product features. Correct route/client composition, shutdown, persistence, or response serialization until the public scenario passes.

- [ ] **Step 4: Run deterministic E2E and the complete non-live suite**

Run: `PYTHONPATH=src python3 -m unittest -v tests.test_room_e2e`

Run: `PYTHONPATH=src python3 -m unittest discover -s tests`

Expected: deterministic E2E passes; complete suite passes with the live model test skipped.

- [ ] **Step 5: Commit**

```bash
git add tests/test_room_e2e.py
git commit -m "test: prove three-client Room collaboration"
```

### Task 9: Three independent Codex runtime live proof

**Files:**
- Create: `tests/test_room_codex_live_e2e.py`
- Create: `examples/room-three-codex/README.md`
- Create: `examples/room-three-codex/brief.txt`

**Interfaces:**
- Consumes: installed `sharednet` CLI, project skill, `CODEX_BIN` override or resolvable `codex`, and local Room daemon.
- Produces: opt-in live proof guarded by `RUN_CODEX_ROOM_E2E=1`.

- [ ] **Step 1: Write the opt-in live test and verify default skip**

Use `unittest.skipUnless(os.environ.get("RUN_CODEX_ROOM_E2E") == "1", ...)`. Give each Codex process its own temporary working directory, copied `.agents/skills/sharednet-room`, explicit identity prompt, and Room session file. Launch A first; once the store shows A's Room, launch B and C concurrently with the Room ID while A continues polling.

Run: `PYTHONPATH=src python3 -m unittest -v tests.test_room_codex_live_e2e`

Expected: one explicit skip and no model invocation.

- [ ] **Step 2: Implement bounded subprocess orchestration**

Use separate `subprocess.Popen` calls, process-wide 600-second deadline, `-a never`, an isolated writable sandbox, JSONL output, bounded stdout/stderr capture, terminate/kill cleanup, and no native `spawn_agent`. Prompts require API evidence rather than magic final strings.

- [ ] **Step 3: Run the live proof when credentials and executable are available**

Run: `RUN_CODEX_ROOM_E2E=1 PYTHONPATH=src python3 -m unittest -v tests.test_room_codex_live_e2e`

Expected: three distinct OS process IDs and Runtime IDs; A creates/posts/uploads, B and C join/read/reply, A reads peers and acknowledges; persisted API evidence satisfies every live assertion. Missing credentials or binary must state the exact prerequisite and must not be called a pass.

- [ ] **Step 4: Commit**

```bash
git add tests/test_room_codex_live_e2e.py examples/room-three-codex
git commit -m "test: add three-Codex Room live proof"
```

### Task 10: Packaging, documentation, and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/product/PRD.md`
- Modify: `docs/product/PRD/specs/04-tasks-messages-recovery.md`
- Modify: `docs/product/PRD/specs/06-runtime-session-bridges.md`
- Modify: `tests/test_packaging.py`

**Interfaces:**
- Documents the exact server/client commands, local trust boundary, Room sharing flow, skill location, artifact limits, tags, and live-test opt-in.
- Keeps existing coordination backend packaging and CLI behavior intact.

- [ ] **Step 1: Add failing packaging assertions**

Assert wheel metadata lists FastAPI/Uvicorn dependencies, the installed `sharednet coord list` still works without importing the Room web stack, and the installed Room CLI parser exposes `serve`, `register`, `build`, `join`, `retrieve`, and `post` when dependencies are installed.

- [ ] **Step 2: Run packaging tests and confirm RED**

Run: `PYTHONPATH=src python3 -m unittest -v tests.test_packaging`

Expected: new Room packaging assertion fails before copied source/metadata support is updated.

- [ ] **Step 3: Update public and normative documentation**

Make Room V1 the minimal human-assembled collaboration layer. Explicitly remove any implication that Room V1 recruits agents or automatically forms organizations. Preserve RAC as a later layer above Rooms rather than deleting existing coordination work.

- [ ] **Step 4: Run all verification commands fresh**

```bash
PYTHONPATH=src python3 -m unittest discover -s tests
python3 -m build
python3 -m pip check
```

If the live prerequisite is available, also run:

```bash
RUN_CODEX_ROOM_E2E=1 PYTHONPATH=src python3 -m unittest -v tests.test_room_codex_live_e2e
```

Expected: all non-live tests pass, wheel and source distribution build, dependency check succeeds, and the live result is reported separately with exact evidence.

- [ ] **Step 5: Review the complete diff and commit**

```bash
git diff --check
git status --short
git add README.md docs pyproject.toml src tests .agents examples
git commit -m "feat: ship SharedNet Room V1"
```

