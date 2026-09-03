# SharedNet Local Stack and API Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore one coherent localhost SharedNet Web/API stack, reject stale API binaries, add a safe authenticated read-only API Explorer, and prove the complete path with a permanent full-stack acceptance test.

**Architecture:** The FastAPI service exposes a minimal public `GET /v1` compatibility document. The existing authenticated Next BFF remains the only browser-to-account-data bridge, while a fixed endpoint registry drives `/api-explorer`. A single Node supervisor starts the current Python source and Next with one validated environment, and an isolated E2E harness exercises Better Auth, Console projections, local Agent communication, restart persistence, and account isolation.

**Tech Stack:** Python 3.11+ / FastAPI / SQLite, Node.js 22.13+ or even 24/26, pnpm 11.19.0, Next.js 16, React 19, TypeScript 7, Vitest 4, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-03-local-stack-api-explorer-design.md`

## Global Constraints

- Bind local API and Web children to loopback only; Web defaults to `3001`, API defaults to `8765`, and this machine's durable recovery explicitly uses API port `8766`.
- Browser code may receive only account-scoped projection JSON and the non-sensitive capability document.
- Console, Connector, Runtime, Instance, Better Auth, and pairing credentials must never appear in HTML, URLs, logs, screenshots, command arguments, test receipts, or committed files.
- Keep the existing Better Auth BFF as the only browser-to-Console bridge; never accept browser-supplied account IDs, backend paths, methods, headers, or bodies.
- `GET /v1` contains only `api_version` and a fixed capability list; it never returns routes, config state, database paths, package versions, host data, or identities.
- Automated E2E uses fresh temporary state and generated in-memory secrets; it never mutates the user's durable database.
- Preserve existing untracked files and unrelated worktree changes.
- Follow TDD for every production-code change: observe the focused test fail for the intended reason, implement the minimum behavior, then observe it pass.

---

### Task 1: Add the API compatibility handshake

**Files:**
- Create: `src/sharednet/api-capabilities.ts`
- Create: `src/sharednet/api-capabilities.test.ts`
- Create: `app/api/sharednet/status/route.ts`
- Modify: `src/sharednet/room/api.py`
- Modify: `tests/room/test_api.py`
- Modify: `src/sharednet/server-client.ts`
- Modify: `src/sharednet/server-client.test.ts`
- Modify: `src/sharednet/routes.test.ts`

**Interfaces:**
- Produces Python `GET /v1 -> {"api_version":"1","capabilities":[...]}` without authentication.
- Produces TypeScript `API_VERSION`, `API_CAPABILITIES`, `ApiCapabilitiesDocument`, and `isApiCapabilitiesDocument(value)`.
- Produces `SharedNetServerClient.getCapabilities(): Promise<ApiCapabilitiesDocument>`.
- Produces authenticated BFF `GET /api/sharednet/status` for Task 2.

- [ ] **Step 1: Write the failing Python API contract test**

Add an exact public response assertion beside the `/healthz` route test in `tests/room/test_api.py`:

```python
def test_api_capabilities_are_public_and_exact(self) -> None:
    response = self.client.get("/v1")

    self.assertEqual(response.status_code, 200)
    self.assertEqual(
        response.json(),
        {
            "api_version": "1",
            "capabilities": [
                "console.network.read.v1",
                "console.rooms.read.v1",
                "console.decisions.read.v1",
            ],
        },
    )
```

Also update the test that freezes the exact route/method set to include only `("GET", "/v1")` as the new public surface.

- [ ] **Step 2: Run the focused Python test and verify RED**

Run:

```bash
PYTHONPATH=src python3 -m unittest tests.room.test_api -v
```

Expected: failure because `GET /v1` returns `404` and the frozen route set lacks the endpoint.

- [ ] **Step 3: Implement the exact FastAPI capability response**

In `src/sharednet/room/api.py`, define immutable module-level values and add the route beside `/healthz`:

```python
_API_VERSION = "1"
_API_CAPABILITIES = (
    "console.network.read.v1",
    "console.rooms.read.v1",
    "console.decisions.read.v1",
)

@app.get("/v1")
def api_capabilities() -> dict[str, object]:
    return {
        "api_version": _API_VERSION,
        "capabilities": list(_API_CAPABILITIES),
    }
```

Do not add Swagger, route templates, environment inspection, or authentication state.

- [ ] **Step 4: Run the Python API suite and verify GREEN**

Run the command from Step 2. Expected: all `tests.room.test_api` tests pass.

- [ ] **Step 5: Write failing TypeScript validator and server-client tests**

Create `src/sharednet/api-capabilities.test.ts` with exact-shape cases:

```ts
expect(isApiCapabilitiesDocument({
  api_version: "1",
  capabilities: [
    "console.network.read.v1",
    "console.rooms.read.v1",
    "console.decisions.read.v1",
  ],
})).toBe(true);

expect(isApiCapabilitiesDocument({
  api_version: "1",
  capabilities: ["console.network.read.v1"],
})).toBe(false);
expect(isApiCapabilitiesDocument({
  api_version: "1",
  capabilities: API_CAPABILITIES,
  database_path: "/tmp/private.db",
})).toBe(false);
```

Extend `src/sharednet/server-client.test.ts` so `getCapabilities()` must call `http://127.0.0.1:8765/v1` with `GET`, `cache: "no-store"`, `redirect: "error"`, and the existing timeout, and must reject a malformed/missing capability response as `invalid_sharednet_response`.

Extend `src/sharednet/routes.test.ts` with the `status` route. It must return `401` before calling the backend without a Better Auth session, call `getCapabilities()` exactly once when authenticated, and forward only the validated capability document.

- [ ] **Step 6: Run the focused TypeScript tests and verify RED**

Run:

```bash
pnpm test -- src/sharednet/api-capabilities.test.ts src/sharednet/server-client.test.ts src/sharednet/routes.test.ts
```

Expected: failures because the validator, client method, and BFF route do not exist.

- [ ] **Step 7: Implement the TypeScript capability boundary**

Create `src/sharednet/api-capabilities.ts` with exact-key and exact-order validation:

```ts
export const API_VERSION = "1" as const;
export const API_CAPABILITIES = [
  "console.network.read.v1",
  "console.rooms.read.v1",
  "console.decisions.read.v1",
] as const;

export type ApiCapabilitiesDocument = Readonly<{
  api_version: typeof API_VERSION;
  capabilities: typeof API_CAPABILITIES;
}>;

export function isApiCapabilitiesDocument(
  value: unknown,
): value is ApiCapabilitiesDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "api_version,capabilities") return false;
  return record.api_version === API_VERSION &&
    Array.isArray(record.capabilities) &&
    record.capabilities.length === API_CAPABILITIES.length &&
    API_CAPABILITIES.every((item, index) => record.capabilities?.[index] === item);
}
```

Add `getCapabilities()` to `SharedNetServerClient`, using the existing private request path and validator. Add `app/api/sharednet/status/route.ts`:

```ts
export function GET(request: Request): Promise<Response> {
  return sharedNetResponse(async () => {
    await requireAuthUserId(request.headers);
    return getSharedNetServerClient().getCapabilities();
  });
}
```

- [ ] **Step 8: Run focused and adjacent tests**

Run the command from Step 6 and then:

```bash
pnpm test -- src/sharednet/contracts.test.ts src/sharednet/routes.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/sharednet/api-capabilities.ts src/sharednet/api-capabilities.test.ts \
  app/api/sharednet/status/route.ts src/sharednet/room/api.py tests/room/test_api.py \
  src/sharednet/server-client.ts src/sharednet/server-client.test.ts src/sharednet/routes.test.ts
git commit -m "feat: expose SharedNet API compatibility"
```

### Task 2: Build the authenticated read-only API Explorer

**Files:**
- Create: `src/sharednet/read-endpoints.ts`
- Create: `src/sharednet/read-endpoints.test.ts`
- Create: `src/components/api-explorer-view.tsx`
- Create: `src/components/api-explorer-view.test.tsx`
- Create: `app/api-explorer/page.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/app-shell.test.tsx`
- Modify: `src/auth/redirect.ts`
- Modify: `src/auth/redirect.test.ts`
- Modify: `proxy.ts`
- Modify: `src/auth/proxy.test.ts`
- Modify: `app/product-shell.css`

**Interfaces:**
- Consumes `GET /api/sharednet/status` from Task 1 and the existing Network/Rooms/Room detail/Decisions BFF routes.
- Produces `READ_ENDPOINTS`, `ReadEndpointId`, and `buildReadEndpointPath(endpointId, roomId)`.
- Produces authenticated page `/api-explorer` and secondary Setup navigation label `API`.

- [ ] **Step 1: Write failing endpoint-registry tests**

Create `src/sharednet/read-endpoints.test.ts` that asserts the exact allowlist and encoded Room ID behavior:

```ts
expect(READ_ENDPOINTS.map(({ id, method, path }) => ({ id, method, path }))).toEqual([
  { id: "status", method: "GET", path: "/api/sharednet/status" },
  { id: "network", method: "GET", path: "/api/sharednet/network" },
  { id: "rooms", method: "GET", path: "/api/sharednet/rooms" },
  { id: "room", method: "GET", path: "/api/sharednet/rooms/{room_id}" },
  { id: "decisions", method: "GET", path: "/api/sharednet/decisions" },
]);
expect(buildReadEndpointPath("room", "room.launch:1")).toBe(
  "/api/sharednet/rooms/room.launch%3A1",
);
expect(() => buildReadEndpointPath("room", "room/forged")).toThrow(
  "Enter a valid Room ID.",
);
```

The registry exposes no mutation descriptor and no arbitrary path builder.

- [ ] **Step 2: Run the registry test and verify RED**

```bash
pnpm test -- src/sharednet/read-endpoints.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the pure endpoint registry**

Use a discriminated descriptor type with literal `method: "GET"`, the five exact endpoints, and `parseRoomId()` from `src/sharednet/contracts.ts` before `encodeURIComponent`. Export no function that accepts a raw URL or method.

- [ ] **Step 4: Run the registry test and verify GREEN**

Run the command from Step 2. Expected: pass.

- [ ] **Step 5: Write failing API Explorer component tests**

Create `src/components/api-explorer-view.test.tsx` with Testing Library cases that assert:

```ts
expect(screen.getByRole("heading", { name: "Read your account-scoped projections." })).toBeVisible();
expect(screen.getAllByRole("radio")).toHaveLength(5);
expect(screen.queryByLabelText(/url|method|header|body/i)).not.toBeInTheDocument();
```

Then cover:

- selecting Network and `Send GET` calls exactly `fetch("/api/sharednet/network", { method: "GET", signal })`;
- Room detail refuses an invalid/empty ID without calling `fetch`;
- a valid Room ID is encoded through the registry;
- `200` JSON renders pretty-printed without losing empty arrays;
- `401`, `404`, `500`, `502`, and `504` render status plus the safe JSON body;
- non-JSON response renders bounded plain text, not HTML;
- selecting/sending a second request aborts the first and late completion cannot overwrite the second;
- unmount aborts the active request;
- `Copy JSON` writes only the displayed body and reports `Copied` or `Copy failed`;
- no local/session storage call occurs.

- [ ] **Step 6: Run the component test and verify RED**

```bash
pnpm test -- src/components/api-explorer-view.test.tsx
```

Expected: module-not-found failure.

- [ ] **Step 7: Implement the Explorer component and route**

Create `ApiExplorerView` with these explicit state types:

```ts
type RequestResult = Readonly<{
  body: string;
  completedAt: string;
  elapsedMs: number;
  status: number;
}>;

type ExplorerState =
  | { kind: "idle" }
  | { kind: "loading"; endpointId: ReadEndpointId }
  | { kind: "complete"; endpointId: ReadEndpointId; result: RequestResult }
  | { kind: "invalid"; message: string };
```

Keep the active `AbortController` and monotonically increasing request generation in refs. Format valid JSON with `JSON.stringify(parsed, null, 2)` and cap a non-JSON fallback to 4,096 characters. Use semantic radio controls, a labeled Room ID input, an accessible live status, and escaped React text rendering.

Create `app/api-explorer/page.tsx` with metadata title `API Explorer — SharedNet` and render `<ApiExplorerView />`.

- [ ] **Step 8: Add the route to the authenticated shell and redirects test-first**

First extend tests to require:

- primary navigation remains exactly Rooms, Network, Decisions;
- Setup navigation contains Protocol and API;
- API links to `/api-explorer` and receives `aria-current="page"` there;
- unauthenticated `/api-explorer` redirects to `/login?next=%2Fapi-explorer`;
- `safePostAuthPath("/api-explorer?endpoint=network")` is preserved;
- `/api/sharednet/network` remains rejected as a post-auth destination.

Run:

```bash
pnpm test -- src/components/app-shell.test.tsx src/auth/redirect.test.ts src/auth/proxy.test.ts
```

Expected: focused failures for the missing route.

Then add only `/api-explorer` to the trusted route roots and proxy matcher. Add an `API` destination to the secondary Setup nav; do not add `/api` as a trusted root.

- [ ] **Step 9: Add focused responsive styling**

Append `.api-explorer-*` rules to `app/product-shell.css` using existing custom properties. Use a two-column grid with a narrow endpoint rail and response pane, a single-column breakpoint matching the existing shell, minimum 44px controls, visible focus, `overflow: auto` for JSON, and no new animation when `prefers-reduced-motion` is set.

- [ ] **Step 10: Run all Task 2 tests and verify GREEN**

```bash
pnpm test -- src/sharednet/read-endpoints.test.ts src/components/api-explorer-view.test.tsx \
  src/components/app-shell.test.tsx src/auth/redirect.test.ts src/auth/proxy.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 11: Commit Task 2**

```bash
git add src/sharednet/read-endpoints.ts src/sharednet/read-endpoints.test.ts \
  src/components/api-explorer-view.tsx src/components/api-explorer-view.test.tsx \
  app/api-explorer/page.tsx src/components/app-shell.tsx src/components/app-shell.test.tsx \
  src/auth/redirect.ts src/auth/redirect.test.ts proxy.ts src/auth/proxy.test.ts app/product-shell.css
git commit -m "feat: add read-only API explorer"
```

### Task 3: Add one-command local stack startup with compatibility readiness

**Files:**
- Create: `scripts/dev-stack.mjs`
- Create: `src/sharednet/dev-stack.test.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes the exact `GET /healthz` and `GET /v1` responses from Task 1.
- Produces `loadStackConfig(environment, repositoryRoot)`, `isCompatibleApiDocument(value)`, `waitForApiReady(fetcher, apiUrl, options)`, and the executable supervisor.
- Produces `pnpm stack:dev` using Node's `--env-file=.env.local` support.

- [ ] **Step 1: Write failing configuration and readiness tests**

Create `src/sharednet/dev-stack.test.ts` and import the pure exports from `scripts/dev-stack.mjs`. Cover:

```ts
expect(() => loadStackConfig({}, projectRoot)).toThrow(
  "Missing required local stack configuration: BETTER_AUTH_SECRET",
);
expect(() => loadStackConfig(validEnv({ SHAREDNET_API_URL: "http://0.0.0.0:8765" }), projectRoot))
  .toThrow("SharedNet local stack must bind to loopback");
expect(loadStackConfig(validEnv(), projectRoot)).toMatchObject({
  apiOrigin: "http://127.0.0.1:8765",
  webOrigin: "http://127.0.0.1:3001",
});
```

Mock readiness sequences for:

- health unavailable then exact `/v1` success;
- health success plus `/v1` `404`;
- health success plus legacy `401 invalid_runtime_token`;
- malformed capability JSON;
- deadline expiry;
- error strings containing no supplied secret.

Also assert the child argument arrays contain no secret values and use `-m sharednet.cli` with `PYTHONPATH=<checkout>/src` rather than a global `sharednet` executable.

- [ ] **Step 2: Run the stack test and verify RED**

```bash
pnpm test -- src/sharednet/dev-stack.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement validation and compatibility readiness**

In `scripts/dev-stack.mjs`:

- validate the five required variables from the spec;
- parse API/Web origins with `URL` and accept only `127.0.0.1`, `localhost`, or `[::1]`;
- resolve the database, blob, Python, and repository paths absolutely;
- require the API database to equal `BETTER_AUTH_DATABASE_PATH`;
- compare `/v1` with `isApiCapabilitiesDocument` semantics without importing TypeScript at runtime;
- poll with a bounded deadline and condition-based waits, not a fixed startup sleep;
- return safe error codes/messages that name missing keys or incompatible capabilities but never values.

Keep process spawning behind an exported `runStack({ spawn, fetch, environment, repositoryRoot })` function so tests can supply fakes.

- [ ] **Step 4: Implement exact child lifecycle**

The executable path must:

1. verify `.venv/bin/python` or `SHAREDNET_PYTHON` exists and can import `fastapi`, `uvicorn`, and the current `sharednet` source;
2. invoke `scripts/migrate-auth.mjs` with `process.execPath` and the validated environment;
3. spawn the API as `[python, "-m", "sharednet.cli", "room", "serve", ...]` with `PYTHONPATH` prefixed by `<repo>/src`;
4. wait for both `/healthz` and `/v1`;
5. spawn `<repo>/node_modules/next/dist/bin/next dev --webpack -H 127.0.0.1 -p <web-port>`;
6. forward `SIGINT`/`SIGTERM` once, terminate only owned children, and await their exits;
7. propagate a non-zero child exit without dumping its environment.

No broad `pkill`, shell interpolation, token argv, or automatic port takeover is allowed.

- [ ] **Step 5: Add the package command and documentation**

Add:

```json
"stack:dev": "node --env-file=.env.local scripts/dev-stack.mjs"
```

Document the one-command flow, all required keys, `SHAREDNET_BLOB_PATH`, `SHAREDNET_PYTHON`, the `/v1` compatibility check, and the fact that `stack:dev` refuses occupied/incompatible ports. Update `.env.example` with empty/non-secret examples only.

- [ ] **Step 6: Run Task 3 tests and smoke help/config paths**

```bash
pnpm test -- src/sharednet/dev-stack.test.ts src/auth/migrate-auth.test.ts
node --env-file=.env.example scripts/dev-stack.mjs --check
```

Expected: tests pass; `--check` returns a safe missing-secret error without spawning children or printing values.

- [ ] **Step 7: Commit Task 3**

```bash
git add scripts/dev-stack.mjs src/sharednet/dev-stack.test.ts package.json .env.example README.md
git commit -m "feat: add coherent local stack launcher"
```

### Task 4: Add permanent full-stack E2E and recover the durable local stack

**Files:**
- Create: `scripts/e2e-sharednet-v1.mjs`
- Create: `src/e2e/sharednet-v1.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Runtime-only, uncommitted: `.env.local`
- Runtime-only backup: `/Users/wangxiang/.local/share/sharednet-runtime/webapp-v1/backups/`

**Interfaces:**
- Consumes `runStack()` from Task 3 and all existing Better Auth, BFF, Control, Room, and Decision HTTP contracts.
- Produces `pnpm e2e:sharednet` and a secret-free JSON receipt.
- Restores this machine's durable stack at Web `3001` / API `8766` without touching the separate legacy `8765` service.

- [ ] **Step 1: Write the opt-in E2E wrapper test**

Create `src/e2e/sharednet-v1.test.ts`:

```ts
const runLive = process.env.SHAREDNET_RUN_LIVE_E2E === "1";

describe.skipIf(!runLive)("SharedNet V1 full stack", () => {
  it("keeps account projections isolated and durable across restart", async () => {
    const receipt = await runSharedNetE2E();
    expect(receipt.status).toBe("accepted");
    expect(receipt.checks).toEqual([
      "api-compatible",
      "auth-session",
      "account-bootstrap",
      "network-projection",
      "room-roundtrip",
      "decision-roundtrip",
      "account-isolation",
      "restart-persistence",
    ]);
    expect(JSON.stringify(receipt).toLowerCase()).not.toMatch(
      /token|secret|credential|password|cookie/,
    );
  }, 180_000);
});
```

Export `runSharedNetE2E()` from the harness so the test does not parse display text.

- [ ] **Step 2: Run the opt-in test and verify RED**

```bash
SHAREDNET_RUN_LIVE_E2E=1 pnpm test -- src/e2e/sharednet-v1.test.ts
```

Expected: module-not-found failure for `scripts/e2e-sharednet-v1.mjs`.

- [ ] **Step 3: Implement isolated process and HTTP helpers**

Create helpers that:

- allocate ports by binding loopback sockets and release them immediately before child spawn;
- create a `mkdtemp` state root with mode `0700`;
- generate secrets with `randomBytes(32)` and keep them only in the child environment/closures;
- start the current API and Next children with stdout/stderr captured in bounded redacting buffers;
- maintain Better Auth cookies in an in-memory map from `Set-Cookie` response headers;
- provide `jsonRequest(url, { method, body, headers })` that rejects redirects and validates status/body explicitly;
- register `finally` cleanup before the first child starts and terminate exact owned PIDs only.

The receipt type is exactly:

```ts
type E2EReceipt = Readonly<{
  checks: readonly string[];
  counts: Readonly<{
    agents: number;
    decisions: number;
    messages: number;
    rooms: number;
  }>;
  status: "accepted";
}>;
```

- [ ] **Step 4: Implement the authenticated full-stack scenario**

In order:

1. migrate the fresh auth database;
2. require API health plus the exact `/v1` document;
3. create account A through `/api/auth/sign-up/email`, then sign in through `/api/auth/sign-in/email`;
4. `POST /api/sharednet/bootstrap` with account A's cookie;
5. seed account A through the server-side demo seed helper or guarded Console endpoint;
6. create pairing, approve it through the authenticated BFF, exchange it, and create two Agent/Runtime/Instance chains;
7. build a Room, join the second Agent, exchange two ordered messages, and request an approval Decision;
8. resolve that Decision through `/api/sharednet/decisions/{id}`;
9. verify Network, Rooms, Room detail, and Decisions through account A's BFF;
10. create account B and prove it cannot read account A's Room or identities;
11. stop and restart both API and Web using the same temp state/secrets;
12. sign in again and prove messages/Decision persist while expired presence becomes offline;
13. return only the typed receipt.

Use exact contract validators already present in `src/sharednet/contracts.ts`; do not treat HTTP 200 alone as acceptance.

- [ ] **Step 5: Add package command and run the permanent E2E**

Add:

```json
"e2e:sharednet": "SHAREDNET_RUN_LIVE_E2E=1 vitest run src/e2e/sharednet-v1.test.ts"
```

Run:

```bash
pnpm e2e:sharednet
```

Expected: one accepted secret-free receipt and no surviving child processes.

- [ ] **Step 6: Run the existing lower-level live acceptance test**

```bash
PYTHON=.venv/bin/python ./scripts/run_local_communication_e2e.sh
```

Expected: pass with a token-free Room/Decision restart receipt.

- [ ] **Step 7: Commit Task 4 code**

```bash
git add scripts/e2e-sharednet-v1.mjs src/e2e/sharednet-v1.test.ts package.json README.md
git commit -m "test: cover SharedNet full stack"
```

- [ ] **Step 8: Back up and migrate the durable local database**

Resolve and record exact target paths, stop only the verified stale API PID on `8766`, then use SQLite's online backup API while the old process is still available or after a clean stop with WAL checkpoint. Store the timestamped backup under:

```text
/Users/wangxiang/.local/share/sharednet-runtime/webapp-v1/backups/
```

Set backup mode `0600` and run `PRAGMA quick_check` against both source and backup. Record pre-migration counts for principals, agents, runtime registrations, rooms, memberships, and messages. Never stop or alter the separate API on `8765`.

- [ ] **Step 9: Configure and launch the recovered durable stack**

Update the ignored owner-only `.env.local` without printing its values:

```text
BETTER_AUTH_URL=http://127.0.0.1:3001
BETTER_AUTH_DATABASE_PATH=/Users/wangxiang/.local/share/sharednet-runtime/webapp-v1/sharednet.db
SHAREDNET_API_URL=http://127.0.0.1:8766
SHAREDNET_BLOB_PATH=/Users/wangxiang/.local/share/sharednet-runtime/webapp-v1/blobs
SHAREDNET_PYTHON=<compatible current Python interpreter>
```

Preserve the existing Better Auth secret and add one newly generated Console credential. Start `pnpm stack:dev` with the supported Node 24 / pnpm 11 toolchain. Run the idempotent demo seed for `xisen.demo@sharednet.local` without changing its password.

- [ ] **Step 10: Verify durable state and browser behavior**

Require:

- `GET http://127.0.0.1:8766/healthz` returns the exact health document;
- `GET http://127.0.0.1:8766/v1` returns the exact capability document;
- the demo account's authenticated BFF returns valid Network, Rooms, and Decisions projections;
- post-migration durable counts do not decrease;
- `/network` renders a real graph without `Network unavailable.`;
- `/api-explorer` successfully sends all five allowlisted reads, including Room detail for a returned Room ID;
- browser-visible content contains no credential value.

### Task 5: Whole-branch verification and review

**Files:**
- No production files unless review finds a defect.

**Interfaces:**
- Consumes all Task 1–4 commits and runtime evidence.
- Produces a clean verification record and review verdict.

- [ ] **Step 1: Run the complete automated verification suite**

```bash
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -v
pnpm test
pnpm typecheck
pnpm build
pnpm e2e:sharednet
```

Every command must exit `0`. Preserve exact failure output if one fails; do not claim later commands ran unless they did.

- [ ] **Step 2: Run secret and synthetic-state guards**

```bash
pnpm test -- src/sharednet/no-synthetic-state.test.ts src/sharednet/routes.test.ts \
  src/sharednet/server-client.test.ts src/e2e/sharednet-v1.test.ts
```

Confirm committed diffs contain no `.env.local`, generated database, backup, logs, tokens, passwords, or E2E state.

- [ ] **Step 3: Request independent whole-branch code review**

Review the complete diff from `a36d2b6` through `HEAD` for spec compliance, security boundaries, process cleanup, race behavior, test quality, accessibility, and unrelated-file contamination. Resolve every Critical or Important finding with focused tests and a scoped re-review.

- [ ] **Step 4: Final browser acceptance**

With the recovered stack running, reload `/network`, inspect the graph and account state, open `/api-explorer`, issue each endpoint request, verify mobile/narrow layout, and leave `/api-explorer` open for the user.

- [ ] **Step 5: Final status**

Report the running localhost URLs, exact commands/tests that passed, durable-data preservation counts, commits created, and any remaining non-blocking caveats. Do not report secrets or internal credential-bearing paths.
