# SharedNet Agent-Native Room Join V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human tell an already-equipped local Agent to read one public SharedNet Skill and join one exact existing Room, while making the actual Next.js application deploy from the repository's production branch.

**Architecture:** The public entry point is `/skill.md`; it drives the existing `sharednet login`, `sharednet agent connect`, `sharednet room join`, and `sharednet room retrieve` commands without adding a new backend protocol. The Skill may register the current Agent when needed, but it never creates a Room, installs software, starts a background service, or exposes credentials. After tests and a production build pass, the completed website branch fast-forwards `main` so Vercel sees the Next.js application.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 7, Vitest, the existing Python SharedNet CLI and Room API, GitHub-triggered Vercel deployment.

**Spec:** `docs/superpowers/specs/2026-09-03-local-agent-communication-v1-design.md`

## Global Constraints

- V1 is only Local Agent registration plus joining and reading an exact existing Room.
- The human supplies the exact SharedNet API URL, Web URL, and Room ID; the Agent never substitutes another Room.
- V1 does not create Rooms from Web or from the onboarding Skill.
- V1 does not install SharedNet Local, install host plugins, start a background service, schedule heartbeats, recruit Agents, delegate work, or host Agents.
- The Skill must stop safely when `sharednet` is unavailable instead of installing anything.
- Principal, Agent, Runtime, and Instance IDs remain server-generated opaque identifiers.
- Credential and state files remain owner-only and must never be read, printed, copied, posted, or committed.
- `/protocol/skill.md` remains a compatibility alias for `/skill.md`.
- Do not stage the existing duplicate `* 2.*` files or `dist/` directory in the website worktree.
- Production promotion must be a fast-forward push; never force-push `main`.

---

### Task 1: Publish the Room-only Agent Skill at `/skill.md`

**Files:**
- Create: `app/skill.md/route.ts`
- Modify: `app/protocol/skill.md/route.ts`
- Modify: `src/protocol/registration-contract.ts`
- Modify: `src/protocol/registration-contract.test.ts`

**Interfaces:**
- Produces: `buildRoomJoinSkill(origin: string): string`.
- Produces: `GET /skill.md` and the compatibility `GET /protocol/skill.md`, both serving identical `text/plain` content.
- Consumes: existing CLI commands `sharednet login`, `sharednet agent connect`, `sharednet room join`, and `sharednet room retrieve`.

- [ ] **Step 1: Write failing Room-only Skill tests**

Add assertions that both routes return the same Skill and that it contains:

```ts
expect(skill).toContain("name: sharednet-room-join");
expect(skill).toContain("command -v sharednet");
expect(skill).toContain("sharednet login");
expect(skill).toContain("sharednet agent connect");
expect(skill).toContain("sharednet room join ROOM_ID");
expect(skill).toContain("sharednet room retrieve ROOM_ID");
expect(skill).toContain("Join only the exact Room ID provided by the human");
expect(skill).not.toContain("sharednet room build");
expect(skill).not.toContain("sharednet local run");
expect(skill).not.toContain("downloads/sharednet-local");
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm test -- src/protocol/registration-contract.test.ts
```

Expected: FAIL because `app/skill.md/route.ts` and `buildRoomJoinSkill` do not exist.

- [ ] **Step 3: Implement the minimal Skill contract**

Implement `buildRoomJoinSkill(origin)` with these ordered phases:

```text
verify CLI exists
verify exact SHAREDNET_URL, SHAREDNET_WEB_URL, and ROOM_ID were supplied
create/chmod .sharednet and .sharednet/instances without reading existing secrets
reuse .sharednet/account-session.json or run sharednet login
reuse .sharednet/agent-state.json and create one fresh Instance session path
detect codex / claude-code / custom and run sharednet agent connect
join the exact ROOM_ID
retrieve Room history before any optional post
return only IDs, Room ID, cursor, and a statement that history was read
```

The Skill must explicitly forbid Room creation, installation, background-service setup, credential inspection, and identity invention. Both routes call the same builder.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the Task 1 command again. Expected: PASS.

- [ ] **Step 5: Commit the public Skill**

```bash
git add app/skill.md/route.ts app/protocol/skill.md/route.ts src/protocol/registration-contract.ts src/protocol/registration-contract.test.ts
git commit -m "feat: add agent-native Room join skill"
```

---

### Task 2: Make Web copy match the Room-only V1

**Files:**
- Modify: `src/components/protocol-view.tsx`
- Modify: `src/components/protocol-view.test.tsx`
- Modify: `src/protocol/registration-contract.ts`
- Modify: `src/protocol/registration-contract.test.ts`
- Modify: `app/page.tsx`
- Modify: `app/page.test.tsx`

**Interfaces:**
- Produces: a primary `Copy instruction for Agent` action pointing the Agent to `/skill.md`.
- Produces: a homepage `Join a Room` link to `/protocol`.
- Preserves: `/downloads/sharednet-local` as an unadvertised existing artifact; this task does not modify package delivery.

- [ ] **Step 1: Write failing copy and scope tests**

Assert:

```ts
expect(writeText.mock.calls[0]?.[0]).toContain("Read https://sharednet.ai/skill.md");
expect(writeText.mock.calls[0]?.[0]).toContain("exact Room ID");
expect(screen.queryByRole("link", { name: "Download SharedNet Local" })).toBeNull();
expect(screen.getByRole("link", { name: "Join a Room" })).toHaveAttribute("href", "/protocol");
```

Also assert `llms.txt` links `/skill.md`, describes joining an existing Room, and does not advertise installation or Room creation.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm test -- src/components/protocol-view.test.tsx src/protocol/registration-contract.test.ts app/page.test.tsx
```

Expected: FAIL on the old download-first and registration copy.

- [ ] **Step 3: Implement Room-only copy**

Change the Protocol heading to `Join this Agent to a Room.` and make the copy button the primary action. Explain that V1 assumes the local CLI is already available and that package installation comes later. Point all Agent-facing discovery text to `${origin}/skill.md`. Change the homepage CTA from `Register my agents.` to `Join a Room` and link it to `/protocol`.

- [ ] **Step 4: Run focused tests and verify they pass**

Run the Task 2 command again. Expected: PASS.

- [ ] **Step 5: Commit the V1 surface**

```bash
git add src/components/protocol-view.tsx src/components/protocol-view.test.tsx src/protocol/registration-contract.ts src/protocol/registration-contract.test.ts app/page.tsx app/page.test.tsx
git commit -m "feat: focus V1 onboarding on Room join"
```

---

### Task 3: Verify and promote the Next.js application to Vercel's production branch

**Files:**
- Verify only: `package.json`, `next.config.ts`, `app/page.tsx`
- No `vercel.json` unless fresh evidence proves Vercel needs one.

**Interfaces:**
- Consumes: `codex/website-launch-v1` with Tasks 1–2 committed.
- Produces: a fast-forwarded `origin/main` containing the complete Next.js application.

- [ ] **Step 1: Run complete Web verification**

Run:

```bash
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm test
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm typecheck
PATH="/Users/wangxiang/.local/share/sharednet-toolchain/node-v24.20.0-darwin-arm64/bin:$PATH" pnpm build
```

Expected: all tests pass, typecheck exits zero, and the build route table contains `/`, `/skill.md`, `/protocol/skill.md`, `/login`, `/chat`, `/network`, and `/decisions`.

- [ ] **Step 2: Prove production promotion is fast-forward only**

Run:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git status --short --branch
```

Expected: ancestry exits zero; only the known untracked duplicate files and `dist/` may remain.

- [ ] **Step 3: Push the reviewed feature branch and production branch**

Run:

```bash
git push origin codex/website-launch-v1
git push origin HEAD:main
```

Expected: both pushes are fast-forward updates. Never add `--force`.

- [ ] **Step 4: Verify the remote contains the deployable application**

Run:

```bash
git ls-tree -r --name-only origin/main -- package.json app/page.tsx app/skill.md/route.ts next.config.ts
```

Expected: all four paths are listed. Check the resulting Vercel deployment status; if it fails, capture the exact build/runtime error before making another change.
