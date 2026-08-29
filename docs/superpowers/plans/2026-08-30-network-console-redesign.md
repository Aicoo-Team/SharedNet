# SharedNet Network Console Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the six-stage Website Launch wizard with a three-page SharedNet network console centered on chat, Principal topology, human decisions, and platform-wide usage.

**Architecture:** A pure deterministic domain model supplies a client-side persisted demo provider. Three Next.js routes consume that shared state through a minimal application shell. Existing guarded connectors stay isolated behind server routes and are not required for demo operation.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 7, Vitest, Testing Library, CSS.

**Spec:** `docs/superpowers/specs/2026-08-30-network-console-redesign.md`

## Global Constraints

- Use test-driven development for domain and interaction behavior.
- Keep exactly three visible product destinations: Chat, Network, Decisions.
- Keep Aicoo Agents explicitly external and all execution explicitly simulated.
- Do not make real provider calls from the deterministic demo.
- Preserve existing guarded connector tests unless a documented incompatibility requires a change.

### Task 1: Build the network demo domain

**Files:**
- Create: `src/domain/network-demo.ts`
- Create: `src/domain/network-demo.test.ts`

1. Write failing tests for the two-Principal fixture, Agent ownership, prompt submission, generated decisions, usage aggregation, Agent selection, and decision resolution.
2. Run the focused test and verify it fails because the domain does not yet exist.
3. Implement typed fixtures, reducer-style pure functions, and exact aggregation helpers.
4. Run the focused test until green.
5. Commit the domain slice.

### Task 2: Add the persisted SharedNet provider and application shell

**Files:**
- Create: `src/context/sharednet-demo-context.tsx`
- Create: `src/components/app-shell.tsx`
- Create: `src/components/app-shell.test.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`

1. Write a failing shell test for exactly three links, demo truth label, pending count, and usage summary.
2. Implement the provider, semantic state actions, and hydration-safe local persistence.
3. Implement the compact shell and shared design tokens.
4. Run the shell test until green.
5. Commit the shared application frame.

### Task 3: Implement `/chat`

**Files:**
- Create: `app/chat/page.tsx`
- Create: `src/components/chat-view.tsx`
- Create: `src/components/chat-view.test.tsx`
- Modify: `app/page.tsx`

1. Write failing tests for the single prompt surface, example fill, prompt submission, Planning Agent response, external Aicoo participation, decision link, and task usage.
2. Implement the sparse transcript and accessible composer.
3. Redirect `/` to `/chat`.
4. Run the chat tests until green.
5. Commit the chat experience.

### Task 4: Implement `/network`

**Files:**
- Create: `app/network/page.tsx`
- Create: `src/components/network-view.tsx`
- Create: `src/components/network-view.test.tsx`

1. Write failing tests for Principal labels, owned/external partition, Aicoo specialists, connection/recruitment legend, and Agent details.
2. Implement a responsive Principal-first topology with selectable Agent rows.
3. Surface per-Principal and selected-Agent usage.
4. Run the network tests until green.
5. Commit the network view.

### Task 5: Implement `/decisions`

**Files:**
- Create: `app/decisions/page.tsx`
- Create: `src/components/decisions-view.tsx`
- Create: `src/components/decisions-view.test.tsx`

1. Write failing tests for the four decision types, pending/resolved grouping, and approve/deny transitions.
2. Implement the inline queue and audit resolution states.
3. Run the decisions tests until green.
4. Commit the decisions view.

### Task 6: Retire the wizard and align product documentation

**Files:**
- Remove: old stage and rail components that are no longer routed
- Modify: `README.md`
- Modify: `docs/product/PRD.md`
- Modify: `docs/product/PRD/specs/07-product-experience.md`
- Modify: `docs/product/PRD/specs/09-roadmap-evaluation.md`
- Replace: `docs/product/PRD/specs/10-website-launch-v1.md` with `docs/product/PRD/specs/10-network-console-v1.md`

1. Remove the obsolete six-stage surface and dead client hook/domain code while preserving connector boundaries.
2. Update documentation so V1 is the Network Console demo and Website Launch is its first task scenario.
3. Search for stale route and six-stage claims.
4. Run the complete automated suite.
5. Commit documentation and cleanup.

### Task 7: Verify the user experience and update the pull request

1. Run tests, typecheck, and production build with the bundled workspace package manager.
2. Exercise Chat, Network, Decisions, prompt submission, decision resolution, reload persistence, and 390px responsive behavior in a browser.
3. Inspect console errors and horizontal overflow.
4. Review the final diff for accidental or unrelated changes.
5. Push `codex/website-launch-v1` and update PR #1 title/body to describe the Network Console V1.
