# SharedNet Account Dashboard V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3001 browser demo state with a Better Auth account-scoped Dashboard backed by the real SharedNet API, while preserving the approved minimal Rooms, Network, Decisions, and Protocol interface.

**Architecture:** The Next.js application is a BFF: server routes authenticate the Better Auth user and call the SharedNet API with a server-only Console credential. Client components consume narrow same-origin JSON routes and short-poll for presence/message changes. `/chat` becomes a read-only Rooms viewer whose composer generates local CLI instructions; `/decisions` is the only ordinary human mutation surface.

**Tech Stack:** Next.js 16.3.3, React 19.2.8, TypeScript 7, Better Auth 1.7.2, Vitest/Testing Library, the Python SharedNet API from `2026-09-03-sharednet-local-identity-room-api-v1.md`, and the existing minimalist CSS system.

**Spec:** `docs/superpowers/specs/2026-09-03-local-agent-communication-v1-design.md`

## Global Constraints

- The active product runs on port `3001`; Better Auth base URL, redirects, and callback routes use the same origin.
- Use Node 24 from `/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin` in the current local environment.
- Browser code never opens SQLite and never receives `SHAREDNET_CONSOLE_TOKEN`, connector tokens, Runtime tokens, or Instance tokens.
- Every BFF operation derives Better Auth `user.id` server-side and ignores client-provided Principal IDs.
- `/chat` is labeled **Rooms** and cannot create Rooms or send messages.
- Submitting the Rooms composer only generates copyable Local instructions; it does not mutate SharedNet state.
- `/decisions` supports approval/denial and free-text answers; it does not post a Room message or execute work.
- Online status comes only from an unexpired Instance lease.
- Principal, Agent, Runtime, and Instance IDs are displayed as canonical typed opaque codes; aliases are not editable in V1.
- Existing visual proportions and palette remain: approximately 70% white/gray/black, 20% Atlantic blues, and 10% yellow/gold accents.
- Remove `sharednet:network-console:v3` and all other browser persistence of network state.
- Do not claim seeded Aicoo or owner Agent profiles are online, Hosted, recruitable, or working without runtime evidence.

---

### Task 1: Stabilize and checkpoint the current 3001 product branch

**Files:**
- Modify: `components/ui/modern-login-signup.tsx`
- Modify: `src/auth/modern-login-signup.test.tsx`
- Modify: `app/globals.css`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Commit existing intended auth/product files already present in the worktree; exclude all duplicate `* 2.*` files and unrelated user files.

**Interfaces:**
- Produces: a green website baseline on `codex/website-launch-v1` with Better Auth on port 3001 and no WebGL allocation.
- Consumes: the existing failing test requiring `.auth-dot-field`, `min-h-screen`, and no `<canvas>`.

- [ ] **Step 1: Run the existing login test and preserve the red evidence**

Run:

```bash
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm test -- src/auth/modern-login-signup.test.tsx
```

Expected: FAIL because the component still creates a Three.js canvas and uses `min-h-svh`.

- [ ] **Step 2: Replace the WebGL background with static CSS**

Remove all `three` imports, renderer lifecycle, animation frame logic, and canvas markup. Render this decorative element beneath the login card:

```tsx
<div aria-hidden="true" className="auth-dot-field" />
```

Use `min-h-screen` on the main landmark. Define `.auth-dot-field` with layered radial gradients, absolute viewport coverage, `pointer-events: none`, and no animation required for correctness.

- [ ] **Step 3: Remove unused Three.js packages**

Run:

```bash
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm remove three @types/three --virtual-store-dir /Users/wangxiang/.local/share/sharednet-runtime/website-launch-v1/virtual-store
```

- [ ] **Step 4: Run baseline verification**

Run:

```bash
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm test
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm typecheck
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm build
```

Expected: every test passes, TypeScript exits zero, and the production build includes `/login`, `/chat`, `/network`, `/decisions`, `/protocol`, and `/api/auth/[...all]`.

- [ ] **Step 5: Create an explicit checkpoint commit**

Review `git diff --name-only`; stage the intended product/auth files explicitly and do not stage duplicate `* 2.*`, `.env.local`, `.sharednet`, credentials, or unrelated artifacts.

```bash
git commit -m "feat: checkpoint authenticated SharedNet console"
```

---

### Task 2: Integrate the real SharedNet backend into the website branch

**Files:**
- Merge: completed commits from `2026-09-03-sharednet-local-identity-room-api-v1.md`
- Resolve if changed on both branches: `README.md`, `.gitignore`
- Preserve from website branch: `package.json`, `pnpm-lock.yaml`, Next.js app files
- Preserve from backend branch: `pyproject.toml`, `src/sharednet/**`, `tests/**`, local bundle scripts, product/spec/plan docs

**Interfaces:**
- Produces: one integration branch containing both the Python API/Local package and the Next.js Web app.
- Consumes: a green checkpoint commit from Task 1 and the completed backend branch.

- [ ] **Step 1: Merge the completed backend branch without discarding website history**

Run from the clean website worktree:

```bash
git merge --no-ff codex/local-agent-communication-v1
```

Resolve README by retaining both Web and Local launch instructions. Resolve `.gitignore` by retaining Node, Python, local database/blob, credential, generated bundle, and Next build exclusions. Do not resolve by choosing an entire side for either file.

- [ ] **Step 2: Verify both stacks after the merge**

Run:

```bash
python -m unittest discover -s tests -v
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm test
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm typecheck
```

Expected: Python and TypeScript suites pass independently.

- [ ] **Step 3: Commit only conflict resolutions if Git did not create the merge commit automatically**

```bash
git commit -m "merge: combine SharedNet Local and Web"
```

---

### Task 3: Server-only SharedNet API client and account scope

**Files:**
- Create: `src/sharednet/contracts.ts`
- Create: `src/sharednet/server-client.ts`
- Create: `src/sharednet/current-account.ts`
- Create: `src/sharednet/server-client.test.ts`
- Create: `src/sharednet/current-account.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `requireAuthUserId(headers: Headers) -> Promise<string>`.
- Produces: `getSharedNetServerClient() -> SharedNetServerClient`.
- Produces methods: `provisionAccount`, `claimPairing`, `listRooms`, `getRoom`, `getNetwork`, `listDecisions`, and `resolveDecision`.
- Consumes environment: `SHAREDNET_API_URL` and `SHAREDNET_CONSOLE_TOKEN`.

- [ ] **Step 1: Write failing server-scope tests**

```ts
it("derives the account id from Better Auth instead of request JSON", async () => {
  authGetSession.mockResolvedValue({ user: { id: "auth-user-1" } });
  await requireAuthUserId(new Headers({ cookie: "session=test" }));
  expect(authGetSession).toHaveBeenCalledWith(expect.objectContaining({ headers: expect.any(Headers) }));
});

it("keeps the Console credential on the server request", async () => {
  await getSharedNetServerClient().listRooms("auth-user-1");
  expect(fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:8765/v1/console/accounts/auth-user-1/rooms",
    expect.objectContaining({ headers: expect.objectContaining({ "X-SharedNet-Console-Token": "console-test" }) }),
  );
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `pnpm test -- src/sharednet/server-client.test.ts src/sharednet/current-account.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement exact JSON contracts and fail-closed client**

Define `PrincipalProjection`, `AgentProjection`, `RuntimeProjection`, `InstanceProjection`, `RoomSummary`, `RoomDetail`, `RoomMessage`, `DecisionProjection`, and `NetworkProjection`. Every ID field is a branded string type and every API response is checked by a narrow runtime predicate before use.

`SharedNetServerClient` sets the Console token and JSON headers itself, uses `cache: "no-store"`, applies a 10-second `AbortSignal.timeout`, and maps API errors into `SharedNetApiError(code, status, message)`. It never serializes environment values into a client component.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- src/sharednet/server-client.test.ts src/sharednet/current-account.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the server boundary**

```bash
git add src/sharednet .env.example
git commit -m "feat: add the account-scoped SharedNet BFF client"
```

---

### Task 4: Same-origin Dashboard API routes

**Files:**
- Create: `app/api/sharednet/bootstrap/route.ts`
- Create: `app/api/sharednet/rooms/route.ts`
- Create: `app/api/sharednet/rooms/[roomId]/route.ts`
- Create: `app/api/sharednet/network/route.ts`
- Create: `app/api/sharednet/decisions/route.ts`
- Create: `app/api/sharednet/decisions/[decisionId]/route.ts`
- Create: `app/api/sharednet/pairings/[pairingId]/claim/route.ts`
- Create: `src/sharednet/routes.test.ts`

**Interfaces:**
- Browser routes: `POST /api/sharednet/bootstrap`, `GET /api/sharednet/rooms`, `GET /api/sharednet/rooms/:id`, `GET /api/sharednet/network`, `GET /api/sharednet/decisions`, `PATCH /api/sharednet/decisions/:id`, and `POST /api/sharednet/pairings/:id/claim`.
- Every route consumes only the Better Auth request headers plus route-specific non-identity fields.

- [ ] **Step 1: Write failing route authorization tests**

```ts
it("ignores a forged principal id while resolving a decision", async () => {
  authGetSession.mockResolvedValue({ user: { id: "auth-user-1" } });
  const response = await PATCH(
    request({ outcome: "approved", principalId: "p_Attacker00" }),
    { params: Promise.resolve({ decisionId: "decision_1" }) },
  );
  expect(response.status).toBe(200);
  expect(sharedNetClient.resolveDecision).toHaveBeenCalledWith(
    "auth-user-1",
    "decision_1",
    { outcome: "approved", responseText: undefined },
  );
});
```

Cover unauthenticated `401`, backend `404` preservation, invalid decision payload `400`, and no secret fields in serialized responses.

- [ ] **Step 2: Run the route test and verify it fails**

Run: `pnpm test -- src/sharednet/routes.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement thin authenticated route handlers**

Use `requireAuthUserId(request.headers)` first. Validate only:

```ts
type DecisionResolutionBody = {
  outcome: "approved" | "denied" | "answered";
  responseText?: string;
};
```

Never accept `principalId`, `agentId`, `runtimeId`, or `instanceId` from a Dashboard mutation. Pairing claim takes the route pairing ID and current auth user only.

- [ ] **Step 4: Run route and auth regression tests**

Run: `pnpm test -- src/sharednet/routes.test.ts src/auth/auth.integration.test.ts src/auth/proxy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Dashboard routes**

```bash
git add app/api/sharednet src/sharednet/routes.test.ts
git commit -m "feat: expose authenticated Dashboard routes"
```

---

### Task 5: Idempotent account-scoped demo seed

**Files:**
- Create: `src/sharednet/demo-seed.ts`
- Create: `src/sharednet/demo-seed.test.ts`
- Create: `scripts/seed-demo-account.mjs`
- Modify: `src/sharednet/control/store.py`
- Modify: `src/sharednet/room/api.py`
- Create: `tests/control/test_demo_seed.py`

**Interfaces:**
- Produces internal Console endpoint: `POST /v1/console/accounts/{auth_user_id}/demo-seed`.
- Produces command: `node scripts/seed-demo-account.mjs --email xisen.demo@sharednet.local`.
- Seed creates one account Principal profile, one Aicoo Principal profile, offline Agent profiles, and one Principal connection; it creates no Runtime, Instance, Room, message, recruitment, or fake usage row.

- [ ] **Step 1: Write failing idempotency and truthfulness tests**

```python
def test_demo_seed_uses_opaque_ids_and_never_fakes_presence(self) -> None:
    first = self.service.seed_demo_account("auth-user-1")
    second = self.service.seed_demo_account("auth-user-1")
    self.assertEqual(first, second)
    self.assertRegex(first.principal_id, r"^p_[0-9A-Za-z]{10}$")
    self.assertTrue(all(agent.agent_id.startswith("a_") for agent in first.agents))
    self.assertEqual(self.store.count_rows("runtime_registrations"), 0)
    self.assertEqual(self.store.count_rows("agent_instances"), 0)
```

The seed keys are internal constants such as `demo.owner.planner` and `demo.aicoo.web-builder`; returned network IDs remain opaque.

- [ ] **Step 2: Run seed tests and verify they fail**

Run:

```bash
python -m unittest tests.control.test_demo_seed -v
pnpm test -- src/sharednet/demo-seed.test.ts
```

Expected: FAIL because seed operations do not exist.

- [ ] **Step 3: Implement the transactional seed**

Migrate the useful current demo records:

- owner profiles: Planner, Codex, Research, Reviewer;
- Aicoo profiles: Web Builder, Design Engineer, Neon, Vercel, Quality;
- capabilities, summaries, discoverability, and the owner-to-Aicoo connection.

Set all seed profile availability to `offline` or `template`. Do not migrate fake tasks, recruitments, Cloud runtime labels, token usage, synthetic messages, or `online` state from `src/domain/network-demo.ts`.

- [ ] **Step 4: Make the Node seed script resolve Better Auth user ID safely**

The script opens the configured Better Auth database server-side, finds exactly one user by the explicit email argument, then calls the internal Console endpoint using `SHAREDNET_CONSOLE_TOKEN`. It prints generated IDs and counts but no credentials. Zero or multiple matching users is a hard failure.

- [ ] **Step 5: Run seed tests twice against a temporary database**

Run the script twice and assert row counts and IDs are unchanged on the second run.

- [ ] **Step 6: Commit seed migration**

```bash
git add src/sharednet/demo-seed.ts src/sharednet/demo-seed.test.ts scripts/seed-demo-account.mjs src/sharednet/control/store.py src/sharednet/room/api.py tests/control/test_demo_seed.py
git commit -m "feat: seed truthful account-scoped demo profiles"
```

---

### Task 6: Replace localStorage with a live Dashboard provider

**Files:**
- Create: `src/context/sharednet-context.tsx`
- Create: `src/context/sharednet-context.test.tsx`
- Modify: `app/layout.tsx`
- Modify: `src/components/app-shell.tsx`
- Delete after consumers migrate: `src/context/sharednet-demo-context.tsx`
- Delete after consumers migrate: `src/context/sharednet-demo-context.test.tsx`

**Interfaces:**
- Produces hook: `useSharedNet() -> { rooms, selectedRoom, network, decisions, status, error, selectRoom, refresh, resolveDecision }`.
- Polls Room list, selected Room detail, Network, and Decisions every 2.5 seconds while `document.visibilityState === "visible"`.
- Consumes only same-origin `/api/sharednet/**` routes.

- [ ] **Step 1: Write failing provider tests**

```tsx
it("loads account data without reading or writing localStorage", async () => {
  const getItem = vi.spyOn(Storage.prototype, "getItem");
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/bootstrap")) return Response.json({ principalId: "p_15COsXY9aK" });
    if (path.endsWith("/rooms")) return Response.json({ rooms: [] });
    if (path.endsWith("/network")) return Response.json({
      principal: { principalId: "p_15COsXY9aK" }, connectedPrincipals: [], agents: [], runtimes: [], instances: [], edges: [],
    });
    if (path.endsWith("/decisions")) return Response.json({ decisions: [] });
    throw new Error(`unexpected Dashboard request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<SharedNetProvider><StateProbe /></SharedNetProvider>);

  expect(await screen.findByText("p_15COsXY9aK")).toBeVisible();
  expect(getItem).not.toHaveBeenCalled();
  expect(setItem).not.toHaveBeenCalled();
});
```

Also test loading, backend unavailable, stale response cancellation, visibility pause/resume, selected Room retention, and resolve-then-refresh.

- [ ] **Step 2: Run the provider test and verify it fails**

Run: `pnpm test -- src/context/sharednet-context.test.tsx`

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Implement one focused async provider**

Use an `AbortController` per refresh generation. Keep selection as ephemeral component state, not browser storage. On partial refresh failure retain the last valid projection and expose a compact stale/error state. Provision the account once through `/api/sharednet/bootstrap` before the first read.

- [ ] **Step 4: Move AppShell pending count to live Decisions**

Replace `useSharedNetDemo()` with `useSharedNet()`. The rail badge counts only `status === "pending"`. Keep login and account-control behavior unchanged.

- [ ] **Step 5: Run provider and shell tests**

Run: `pnpm test -- src/context/sharednet-context.test.tsx src/components/app-shell.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit live state**

```bash
git add src/context app/layout.tsx src/components/app-shell.tsx src/components/app-shell.test.tsx
git commit -m "feat: load SharedNet Dashboard state from the API"
```

---

### Task 7: Convert `/chat` into the read-only Rooms viewer

**Files:**
- Modify: `src/components/chat-view.tsx`
- Modify: `src/components/chat-view.test.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `app/product-shell.css`
- Create: `src/components/local-handoff-dialog.tsx`
- Create: `src/components/local-handoff-dialog.test.tsx`

**Interfaces:**
- Consumes: `rooms`, `selectedRoom`, `selectRoom`, and `refresh` from `useSharedNet()`.
- Produces: copy-only local instructions; no POST request to create a Room or message.

- [ ] **Step 1: Write failing non-mutation tests**

```tsx
it("turns a draft into local instructions without creating or posting", async () => {
  render(<ChatView />);
  fireEvent.change(screen.getByPlaceholderText("Type here…"), { target: { value: "Review this API" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue locally" }));

  expect(await screen.findByRole("dialog", { name: "Continue in SharedNet Local" })).toBeVisible();
  expect(screen.getByText(/sharednet room post room_/)).toBeVisible();
  expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/messages"), expect.objectContaining({ method: "POST" }));
});
```

Also test the empty-state instruction uses `sharednet room build`, selected Room instruction includes the exact Room ID, room list changes from polling are visible, message sequence is ordered, and secrets never appear.

- [ ] **Step 2: Run Chat tests and verify they fail**

Run: `pnpm test -- src/components/chat-view.test.tsx src/components/local-handoff-dialog.test.tsx`

Expected: FAIL because Chat still synthesizes demo tasks.

- [ ] **Step 3: Implement Rooms semantics**

Change the navigation label from `Chat` to `Rooms` while retaining `/chat`. Render real Room name/ID, active members, ordered messages, reply linkage, opaque identity tuple, cursor, and stale/offline states. Remove Candidate World, assembled fake Agents, synthetic work ledger, and token usage from this route.

The handoff dialog builds one of these non-secret templates:

```text
Create a SharedNet Room for this brief from your local Agent, then post the brief as its first plain-text message: <draft>
```

```text
Use SharedNet Room <exact-room-id>. Join it if needed, retrieve its history first, then post this plain-text message from your current local Agent Instance: <draft>
```

- [ ] **Step 4: Run Chat and accessibility tests**

Run: `pnpm test -- src/components/chat-view.test.tsx src/components/local-handoff-dialog.test.tsx src/components/app-shell.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit Rooms viewer**

```bash
git add src/components/chat-view.tsx src/components/chat-view.test.tsx src/components/local-handoff-dialog.tsx src/components/local-handoff-dialog.test.tsx src/components/app-shell.tsx app/product-shell.css
git commit -m "feat: turn Chat into the local Rooms viewer"
```

---

### Task 8: Render the real Principal–Agent–Runtime–Instance network

**Files:**
- Modify: `src/components/network-view.tsx`
- Modify: `src/components/network-view.test.tsx`
- Modify: `src/domain/relationship-matrix.ts`
- Modify: `src/domain/relationship-matrix.test.ts`
- Modify: `app/product-shell.css`

**Interfaces:**
- Consumes: `NetworkProjection` from `useSharedNet()`.
- Produces: deterministic graph nodes and edges from real projections, with Agent cards showing canonical IDs and expandable execution descendants.

- [ ] **Step 1: Write failing dynamic-network tests**

```tsx
it("shows opaque identities and derives online state from Instance leases", () => {
  render(<NetworkView />);
  expect(screen.getByText("p_15COsXY9aK")).toBeVisible();
  expect(screen.getByText("a_7Qm2Zx8WpL")).toBeVisible();
  expect(screen.getByText("r_4Nk8Vm2QaT")).toBeVisible();
  expect(screen.getByText("i_8pQ2Km7XaN")).toBeVisible();
  expect(screen.getByText("Online · lease active")).toBeVisible();
  expect(screen.getByText("Web Builder").closest("[data-presence]"))
    .toHaveAttribute("data-presence", "offline");
});
```

Also test intra/cross filters, co-Room dotted edge counts, no delegation edges in V1, empty network, and deterministic positions for unknown generated IDs.

- [ ] **Step 2: Run Network tests and verify they fail**

Run: `pnpm test -- src/components/network-view.test.tsx src/domain/relationship-matrix.test.ts`

Expected: FAIL because positions and Agent IDs are hard-coded.

- [ ] **Step 3: Replace hard-coded matrices with deterministic projection**

Hash each canonical Agent ID only for stable visual placement; never use that layout hash as identity. Dotted lines represent shared Room counts. Hide the current solid delegation legend because Typed Delegation is a V2 feature.

Agent inspection displays Principal ID, Agent ID, diagnostic label, capabilities, runtime metadata, and active/offline Instances. Do not expose credential paths or provider-native session IDs.

- [ ] **Step 4: Run Network tests**

Run: `pnpm test -- src/components/network-view.test.tsx src/domain/relationship-matrix.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Network projection**

```bash
git add src/components/network-view.tsx src/components/network-view.test.tsx src/domain/relationship-matrix.ts src/domain/relationship-matrix.test.ts app/product-shell.css
git commit -m "feat: visualize live SharedNet identities and presence"
```

---

### Task 9: Connect pairing and durable Decisions

**Files:**
- Modify: `src/components/decisions-view.tsx`
- Modify: `src/components/decisions-view.test.tsx`
- Modify: `app/decisions/page.tsx`
- Modify: `app/product-shell.css`

**Interfaces:**
- Consumes: live Decisions and `resolveDecision` from `useSharedNet()`.
- Consumes optional `pairing` query parameter and claims it through the authenticated pairing route.
- Produces no Room message or execution request.

- [ ] **Step 1: Write failing live Decision tests**

```tsx
it("submits a text answer and refreshes durable history", async () => {
  render(<DecisionsView pairingId={null} />);
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "Use Singapore" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  expect(resolveDecision).toHaveBeenCalledWith("decision_region", {
    outcome: "answered",
    responseText: "Use Singapore",
  });
});
```

Also test approve, deny, optional approval note, conflicting response error, pairing claim, pairing denial, resolved history, and another account's invisible Decision.

- [ ] **Step 2: Run Decision tests and verify they fail**

Run: `pnpm test -- src/components/decisions-view.test.tsx`

Expected: FAIL because the component mutates demo context synchronously.

- [ ] **Step 3: Implement async durable resolution**

Disable controls while the request is pending. Keep the pending Decision visible on network failure and show one concise retry message. For pairing URLs, claim once after authentication, select the resulting authorization Decision, and remove the query parameter with `router.replace("/decisions")` after a terminal response.

- [ ] **Step 4: Run Decision and route tests**

Run: `pnpm test -- src/components/decisions-view.test.tsx src/sharednet/routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Decisions**

```bash
git add src/components/decisions-view.tsx src/components/decisions-view.test.tsx app/decisions/page.tsx app/product-shell.css
git commit -m "feat: resolve SharedNet Decisions from the Dashboard"
```

---

### Task 10: Align Protocol, LLM instructions, and installer download

**Files:**
- Modify: `src/protocol/registration-contract.ts`
- Modify: `src/protocol/registration-contract.test.ts`
- Modify: `src/components/protocol-view.tsx`
- Modify: `src/components/protocol-view.test.tsx`
- Modify: `app/llms.txt/route.ts`
- Modify: `app/llms-full.txt/route.ts`
- Modify: `app/protocol/skill.md/route.ts`
- Create: `app/downloads/sharednet-local/route.ts`
- Create: `src/sharednet/download.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces canonical instructions for `sharednet login`, `sharednet agent connect`, Room build/join/post/retrieve, Instance identity, and Decisions.
- Produces download route backed by `SHAREDNET_LOCAL_BUNDLE_PATH` and adjacent `.sha256` file.

- [ ] **Step 1: Write failing protocol truthfulness tests**

```ts
it("documents server-generated opaque identity and the Web write boundary", () => {
  const text = buildLlmsFullText("https://sharednet.ai");
  expect(text).toContain("Principal → Agent → Runtime → Instance");
  expect(text).toContain("p_ + 10 Base62 characters");
  expect(text).toContain("The website cannot create Rooms or post Agent messages");
  expect(text).not.toContain("--principal-id");
  expect(text).not.toContain("--agent-id");
});
```

Also prove the Skill says to retrieve before posting, never inspect credential files, and join only an exact human-provided Room ID.

- [ ] **Step 2: Run protocol tests and verify they fail**

Run: `pnpm test -- src/protocol/registration-contract.test.ts src/components/protocol-view.test.tsx src/sharednet/download.test.ts`

Expected: FAIL because current instructions use caller-supplied Principal/Agent IDs and Session terminology.

- [ ] **Step 3: Replace protocol copy and commands**

Use `Instance` consistently. Explain that alias editing is a later DNS-like resolution feature and canonical IDs remain opaque. The primary page CTA downloads SharedNet Local; the secondary action copies the exact instruction telling the current Agent to read `/protocol/skill.md`.

- [ ] **Step 4: Implement safe bundle streaming**

The download route resolves only the configured absolute bundle path, checks its exact filename and checksum file, streams as `application/gzip`, and returns `503 bundle_unavailable` when missing. It never accepts a filesystem path from URL parameters.

- [ ] **Step 5: Run protocol/download tests**

Run: `pnpm test -- src/protocol/registration-contract.test.ts src/components/protocol-view.test.tsx src/sharednet/download.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit protocol and download**

```bash
git add src/protocol src/components/protocol-view.tsx src/components/protocol-view.test.tsx app/llms.txt app/llms-full.txt app/protocol app/downloads .env.example src/sharednet/download.test.ts
git commit -m "feat: publish SharedNet Local onboarding protocol"
```

---

### Task 11: Remove synthetic orchestration state

**Files:**
- Delete: `src/domain/network-demo.ts`
- Delete: `src/domain/network-demo.test.ts`
- Delete: `src/context/sharednet-demo-context.tsx`
- Delete: `src/context/sharednet-demo-context.test.tsx`
- Modify: any remaining imports reported by `rg "network-demo|SharedNetDemo|localStorage"`.

**Interfaces:**
- Produces: no runtime dependency on the old demo state and no browser network persistence.
- Preserves: useful test fixtures only as explicit projection fixture factories under `src/sharednet/test-fixtures.ts`.

- [ ] **Step 1: Add a guard test**

```ts
it("does not ship the orchestration demo storage key", () => {
  const roots = ["app", "src", "components", "lib"];
  const source = roots.flatMap((root) => readSourceTree(root)).join("\n");
  expect(source).not.toContain("sharednet:network-console:v3");
  expect(source).not.toContain("submitChatPrompt");
});
```

Define `readSourceTree(root)` in the test with `readdirSync(..., { withFileTypes: true })`, recurse only through directories, and read only `.ts`, `.tsx`, and `.css` files. Exclude the guard test's own filename before concatenation so its assertion strings do not match themselves.

- [ ] **Step 2: Delete migrated modules and resolve imports**

Run `rg -n "network-demo|SharedNetDemo|submitChatPrompt|sharednet:network-console|localStorage" app src components lib`. Replace test fixture imports with `src/sharednet/test-fixtures.ts`; no production match may remain.

- [ ] **Step 3: Run the entire web suite and build**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: PASS with no production references to synthetic orchestration state.

- [ ] **Step 4: Commit removal**

```bash
git add -A src/domain/network-demo.ts src/domain/network-demo.test.ts src/context src/sharednet app components lib
git commit -m "refactor: remove synthetic SharedNet orchestration state"
```

---

### Task 12: Full Web + Local end-to-end launch proof

**Files:**
- Create: `scripts/e2e-sharednet-v1.mjs`
- Create: `src/e2e/sharednet-v1.test.ts`
- Modify: `README.md`
- Modify: `docs/product/PRD.md`
- Modify: `docs/product/PRD/specs/01-principals-agents-agentcards.md`
- Modify: `docs/product/PRD/specs/06-runtime-session-bridges.md`
- Modify: `docs/product/PRD/specs/07-product-experience.md`
- Modify: `docs/product/PRD/specs/09-roadmap-evaluation.md`
- Modify: `docs/product/PRD/specs/10-website-launch-v1.md`
- Modify: `docs/superpowers/specs/2026-08-31-sharednet-room-v1-design.md`

**Interfaces:**
- Consumes: built SharedNet Local binary, SharedNet API, Next.js Web, temporary database/blob directories, and two Better Auth accounts.
- Produces: a token-free E2E receipt plus exact human demo instructions.

- [ ] **Step 1: Implement the E2E runner**

The runner must use fresh temporary ports and state, then:

1. start SharedNet API and Web;
2. create/sign in the demo Better Auth account and a second isolation account;
3. complete `sharednet login` pairing through the authenticated Decisions BFF;
4. register two opaque Agent IDs, two Runtime IDs, and two Instance IDs through the built Local binary;
5. let Agent A build a Room and Agent B join the exact returned Room ID;
6. post/retrieve/reply in both directions;
7. verify `/api/sharednet/rooms/:id` and `/api/sharednet/network` reflect the exact identities and sequences;
8. request approval and text Decisions, resolve them through the authenticated BFF, and retrieve them from the requesting Instance;
9. verify the second account receives `404` for Room and Decision detail;
10. restart API, Web, and Local connector, then verify durable rows remain and expired Instances become offline.

No process output may contain a connector, Runtime, Instance, or Better Auth secret.

- [ ] **Step 2: Run E2E and all verification suites**

Run:

```bash
SHAREDNET_RUN_LIVE_E2E=1 node scripts/e2e-sharednet-v1.mjs
python -m unittest discover -s tests -v
pnpm test
pnpm typecheck
pnpm build
```

Expected: every command exits zero. The receipt contains only typed IDs, Room/message/Decision IDs, sequences, statuses, and cursors.

- [ ] **Step 3: Update product documents to the approved V1 boundary**

Make these exact semantic corrections:

- replace Agent-as-chat/session with persistent Agent plus Runtime/Instance;
- add opaque typed IDs and defer aliases to the DNS-like resolution layer;
- establish SharedNet Web + SharedNet Local packaging;
- state that CLI/Agent Instances create and post to Rooms while Web observes;
- move Typed Delegation and obligation semantics after V1;
- insert Local Agent Communication before Local Cowork in the roadmap;
- label `/chat` as the compatibility route for the Rooms viewer;
- preserve Hosted Agent execution, RAC/RGE, and Composio as later versions.

- [ ] **Step 4: Start the durable local demo and smoke the browser**

Start API on `127.0.0.1:8765` and Web on `127.0.0.1:3001` using the demo database. Sign in as the seeded demo account and inspect `/chat`, `/network`, `/decisions`, and `/protocol`. Confirm the Rooms composer opens only local instructions and no Web control creates a Room or message.

- [ ] **Step 5: Commit the launch proof**

```bash
git add scripts/e2e-sharednet-v1.mjs src/e2e/sharednet-v1.test.ts README.md docs/product docs/superpowers/specs/2026-08-31-sharednet-room-v1-design.md
git commit -m "feat: launch SharedNet local communication v1"
```
