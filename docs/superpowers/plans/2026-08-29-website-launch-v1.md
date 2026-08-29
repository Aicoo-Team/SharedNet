# Website Launch V1 Implementation Plan

> **Status:** Superseded on 2026-08-30 by [`2026-08-30-network-console-redesign.md`](2026-08-30-network-console-redesign.md). Retained as implementation history; its routes and UI are no longer current.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a runnable SharedNet Website Launch demo that interviews a user, forms an official Agent organization, executes a deterministic website mission, models safe Neon/Vercel integration, and returns an interactive preview with verified handoff artifacts.

**Architecture:** A Next.js TypeScript application keeps product logic in pure domain modules: interview readiness, brief compilation, official Agent selection, RAC graph transitions, artifact generation, and connector contracts. The browser owns the interactive Mission presentation and local restoration; server-only routes own provider credentials and execute either clearly labeled demo adapters or explicitly approved live adapters.

**Tech Stack:** Node.js 23+, Next.js, React, TypeScript, CSS, Lucide React, Vitest, Testing Library

**Historical spec:** replaced by `docs/product/PRD/specs/10-network-console-v1.md`

## Global Constraints

- “Official” means maintained by SharedNet and must not imply Neon or Vercel endorsement.
- Demo infrastructure is always labeled SIMULATED and uses a demo namespace.
- Provider credentials remain server-only and are never returned to the browser.
- External resource creation requires both credentials and explicit approval.
- The first build supports one blank-project, data-backed website archetype.
- Product logic remains deterministic and testable without network access.
- No live connector test may create or delete a provider resource.

---

### Task 1: Application foundation and product contracts

**Files:**

- Create: package.json
- Create: tsconfig.json
- Create: next.config.ts
- Create: vitest.config.ts
- Create: vitest.setup.ts
- Create: app/layout.tsx
- Create: app/page.tsx
- Create: app/globals.css
- Create: src/domain/types.ts
- Create: src/domain/official-agents.ts
- Test: src/domain/official-agents.test.ts

**Interfaces:**

- Produces Mission, ProductBrief, OfficialAgent, MissionTask, MissionEvent, Artifact, ConnectorManifest, and VerificationCheck.
- Produces OFFICIAL_AGENTS and getOfficialAgent(handle).

- [ ] **Step 1: Write the failing official-Agent registry test**

~~~ts
import { describe, expect, it } from "vitest";
import { OFFICIAL_AGENTS, getOfficialAgent } from "./official-agents";

describe("official Agent registry", () => {
  it("ships the Website Launch bench", () => {
    expect(OFFICIAL_AGENTS.map((agent) => agent.handle)).toEqual([
      "@sharednet/product",
      "@sharednet/research",
      "@sharednet/architect",
      "@sharednet/builder",
      "@sharednet/neon",
      "@sharednet/vercel",
      "@sharednet/quality",
    ]);
    expect(getOfficialAgent("@sharednet/neon").official).toBe(true);
  });
});
~~~

- [ ] **Step 2: Run the test and confirm failure**

Run: npm test -- src/domain/official-agents.test.ts

Expected: FAIL because the application and registry do not exist.

- [ ] **Step 3: Add the Next.js/Vitest foundation and typed seven-Agent registry**

Each Agent includes id, handle, name, role, summary, capabilities, official, providerDisclaimer, accent, and avatarInitials.

- [ ] **Step 4: Verify**

Run: npm test -- src/domain/official-agents.test.ts && npm run typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add package.json package-lock.json tsconfig.json next.config.ts vitest.config.ts vitest.setup.ts app src/domain
git commit -m "feat: scaffold Website Launch mission app"
~~~

### Task 2: Requirement interview and Product Brief compiler

**Files:**

- Create: src/domain/interview.ts
- Test: src/domain/interview.test.ts

**Interfaces:**

- Produces INTERVIEW_QUESTIONS, calculateReadiness(answers), getNextQuestion(answers), and compileProductBrief(idea, answers).

- [ ] **Step 1: Write failing interview tests**

~~~ts
import { describe, expect, it } from "vitest";
import { calculateReadiness, compileProductBrief, getNextQuestion } from "./interview";

describe("requirement interview", () => {
  it("waits for material decisions", () => {
    expect(calculateReadiness({ user: "Small teams" }).ready).toBe(false);
    expect(getNextQuestion({ user: "Small teams" })?.id).toBe("outcome");
  });

  it("compiles a buildable data-backed brief", () => {
    const answers = {
      user: "Small SaaS teams",
      outcome: "Collect and prioritize customer feedback",
      data: "Ideas, votes, and statuses",
      access: "Public submitters and private moderators",
      style: "Calm editorial interface",
      launch: "Public preview",
      acceptance: "Submit, vote, moderate, and persist after refresh",
    };
    expect(calculateReadiness(answers).ready).toBe(true);
    expect(compileProductBrief("Build a feedback board", answers).requiresDatabase).toBe(true);
  });
});
~~~

- [ ] **Step 2: Run and confirm failure**

Run: npm test -- src/domain/interview.test.ts

Expected: FAIL because the interview engine is absent.

- [ ] **Step 3: Implement seven material dimensions**

Implement user, outcome, data, access, style, launch, and acceptance. Readiness returns completion, clear dimensions, missing dimensions, and ready. Brief compilation returns title, summary, core loop, data model, access model, visual direction, launch target, assumptions, deferred decisions, and acceptance criteria.

- [ ] **Step 4: Verify and commit**

Run: npm test -- src/domain/interview.test.ts && npm run typecheck

~~~bash
git add src/domain/interview.ts src/domain/interview.test.ts
git commit -m "feat: add adaptive product interview"
~~~

### Task 3: RAC Mission engine and handoff artifacts

**Files:**

- Create: src/domain/orchestrator.ts
- Create: src/domain/artifacts.ts
- Test: src/domain/orchestrator.test.ts
- Test: src/domain/artifacts.test.ts

**Interfaces:**

- Produces createMission(brief), advanceMission(mission), getRunnableTasks(mission), createHandoffArtifacts(mission), and isHandoffComplete(mission).

- [ ] **Step 1: Write failing orchestration tests**

~~~ts
import { describe, expect, it } from "vitest";
import { createMission, getRunnableTasks } from "./orchestrator";

describe("Website Launch RAC graph", () => {
  it("selects the Neon Agent for data-backed products", () => {
    const mission = createMission({ requiresDatabase: true } as never);
    expect(mission.selectedAgentHandles).toContain("@sharednet/neon");
  });

  it("does not deploy at mission start", () => {
    const mission = createMission({ requiresDatabase: true } as never);
    expect(getRunnableTasks(mission).map((task) => task.kind)).not.toContain("deploy");
  });
});
~~~

- [ ] **Step 2: Run and confirm failure**

Run: npm test -- src/domain/orchestrator.test.ts src/domain/artifacts.test.ts

Expected: FAIL because Mission behavior is absent.

- [ ] **Step 3: Implement the dependency graph**

Use research, architecture, database, build, deploy, verify, and handoff tasks. Each task records dependencies, Agent, status, selection reason, duration label, and artifact IDs. advanceMission completes one runnable wave and opens dependents. Omit database when requiresDatabase is false.

- [ ] **Step 4: Implement real textual artifacts**

Generate PRODUCT_BRIEF.md, ARCHITECTURE.md, schema.sql, app/page.tsx, README.md, redacted infrastructure manifests, and VERIFICATION.md from the Product Brief.

- [ ] **Step 5: Verify and commit**

Run: npm test -- src/domain/orchestrator.test.ts src/domain/artifacts.test.ts && npm run typecheck

~~~bash
git add src/domain/orchestrator.ts src/domain/orchestrator.test.ts src/domain/artifacts.ts src/domain/artifacts.test.ts
git commit -m "feat: add Website Launch RAC mission engine"
~~~

### Task 4: Safe Neon and Vercel connectors

**Files:**

- Create: src/connectors/types.ts
- Create: src/connectors/neon.ts
- Create: src/connectors/vercel.ts
- Create: src/connectors/index.ts
- Create: app/api/connectors/status/route.ts
- Create: app/api/launch/route.ts
- Test: src/connectors/connectors.test.ts

**Interfaces:**

- Produces Connector with inspectCapability, plan, requireApproval, execute, verify, and redact.
- Produces createNeonConnector(env, fetcher), createVercelConnector(env, fetcher), and getConnectorStatus(env).

- [ ] **Step 1: Write failing safety tests**

~~~ts
import { describe, expect, it, vi } from "vitest";
import { createNeonConnector } from "./neon";
import { createVercelConnector } from "./vercel";

describe("provider connector safety", () => {
  it("simulates without credentials and does not call fetch", async () => {
    const fetcher = vi.fn();
    const neon = createNeonConnector({}, fetcher);
    const result = await neon.execute(await neon.plan({ slug: "signal-board" }), true);
    expect(result.label).toBe("SIMULATED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses live execution without approval", async () => {
    const vercel = createVercelConnector({ VERCEL_TOKEN: "secret" }, vi.fn());
    await expect(vercel.execute(await vercel.plan({ slug: "signal-board" }), false))
      .rejects.toThrow("approval");
  });
});
~~~

- [ ] **Step 2: Run and confirm failure**

Run: npm test -- src/connectors/connectors.test.ts

Expected: FAIL because connector modules are absent.

- [ ] **Step 3: Implement demo and guarded live adapters**

Demo Neon returns a demo-neon namespace and SIMULATED. Demo Vercel returns a sharednet-demo.local URL and SIMULATED. Live Neon uses Bearer auth and documented project/connection endpoints. Live Vercel uses Bearer auth and server-side project/environment/deployment endpoints. Both reject unapproved execution, redact sensitive values, and surface reconciliation-required state after ambiguous resource-creation failures.

- [ ] **Step 4: Add status and launch routes**

The status route returns only mode and availability. The launch route validates slug, mode, and approvedExternalActions; demo always works, and live mode fails closed without credentials or approval.

- [ ] **Step 5: Verify and commit**

Run: npm test -- src/connectors/connectors.test.ts && npm run typecheck

~~~bash
git add src/connectors app/api
git commit -m "feat: add guarded Neon and Vercel connectors"
~~~

### Task 5: Complete Mission workspace UI

**Files:**

- Create: src/components/sharednet-launch.tsx
- Create: src/components/mission-header.tsx
- Create: src/components/agent-rail.tsx
- Create: src/components/describe-stage.tsx
- Create: src/components/interview-stage.tsx
- Create: src/components/brief-stage.tsx
- Create: src/components/build-stage.tsx
- Create: src/components/handoff-stage.tsx
- Create: src/components/product-preview.tsx
- Create: src/hooks/use-mission.ts
- Create: src/lib/download.ts
- Modify: app/page.tsx
- Modify: app/globals.css
- Test: src/components/sharednet-launch.test.tsx

**Interfaces:**

- Produces six-stage UI and useMission actions startIdea, answerQuestion, confirmBrief, startBuild, advanceBuild, resetMission, and downloadHandoff.

- [ ] **Step 1: Write the failing primary-flow test**

~~~tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SharedNetLaunch } from "./sharednet-launch";

describe("SharedNet Website Launch", () => {
  it("starts requirement discovery from an idea", () => {
    render(<SharedNetLaunch />);
    fireEvent.change(screen.getByLabelText("What do you want to launch?"), {
      target: { value: "Build a customer feedback board" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Shape the product" }));
    expect(screen.getByText("Who is this for?")).toBeTruthy();
    expect(screen.getByText("Requirement readiness")).toBeTruthy();
  });
});
~~~

- [ ] **Step 2: Run and confirm failure**

Run: npm test -- src/components/sharednet-launch.test.tsx

Expected: FAIL because the workspace is absent.

- [ ] **Step 3: Implement Mission state and restoration**

Store safe Mission state under sharednet:website-launch:v1. Never persist provider credentials.

- [ ] **Step 4: Implement the six product stages**

Build Describe, Clarify, Confirm, Organize/Build, and Handoff surfaces in one responsive workspace. Show one question at a time, readiness, editable brief summary, official Agent cards, dependency-aware timeline, meaningful events, simulated/live labels, interactive preview, verification checklist, and downloadable artifacts.

- [ ] **Step 5: Implement visual system**

Use dark ink, warm text, electric mint/cyan state accents, restrained purple Agent transitions, fine grid texture, monospaced operational metadata, responsive desktop/mobile layouts, visible focus, and reduced-motion support.

- [ ] **Step 6: Verify and commit**

Run: npm test && npm run typecheck && npm run build

~~~bash
git add app src/components src/hooks src/lib
git commit -m "feat: build end-to-end Website Launch experience"
~~~

### Task 6: Documentation and final verification

**Files:**

- Modify: README.md
- Modify: docs/product/PRD.md
- Modify: docs/product/PRD/specs/07-product-experience.md
- Modify: docs/product/PRD/specs/09-roadmap-evaluation.md
- Create: .env.example

**Interfaces:**

- Documents local run, test, demo/live modes, credential names, truth boundaries, and Website Launch as the outcome-shaped V1.

- [ ] **Step 1: Run and inspect every stage**

Run: npm run dev

Inspect idea entry, all interview questions, brief confirmation, organization, task progression, preview interaction, simulated infrastructure labels, narrow-screen layout, and handoff downloads.

- [ ] **Step 2: Fix observed hierarchy, overflow, focus, state-truth, and interaction defects**

- [ ] **Step 3: Update product documentation**

README includes npm install, npm run dev, npm test, and npm run build. The master PRD and roadmap make Website Launch the first outcome release while retaining Connected Principals as the later network expansion.

- [ ] **Step 4: Run final verification**

Run: npm test && npm run typecheck && npm run build && git diff --check

Expected: all tests pass, TypeScript and production build exit zero, and Git reports no whitespace errors.

- [ ] **Step 5: Commit**

~~~bash
git add README.md .env.example docs app src
git commit -m "docs: make Website Launch the SharedNet V1 wedge"
~~~
