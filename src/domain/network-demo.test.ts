import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  createInitialDemoState,
  isDemoState,
  resolveDecision,
  selectAgent,
  submitChatPrompt,
} from "./network-demo";

describe("SharedNet network demo domain", () => {
  it("starts with owned and connected Principals and their persistent Agents", () => {
    const state = createInitialDemoState();

    expect(state.principals.map((principal) => principal.handle)).toEqual([
      "@xisen",
      "@aicoo",
    ]);
    expect(
      state.agents
        .filter((agent) => agent.principalId === "principal-xisen")
        .map((agent) => agent.handle),
    ).toEqual([
      "@xisen/planner",
      "@xisen/codex",
      "@xisen/research",
      "@xisen/reviewer",
    ]);
    expect(
      state.agents
        .filter((agent) => agent.principalId === "principal-aicoo")
        .map((agent) => agent.handle),
    ).toEqual([
      "@aicoo/web-builder",
      "@aicoo/design-engineer",
      "@aicoo/neon",
      "@aicoo/vercel",
      "@aicoo/quality",
    ]);
    expect(state.connections).toEqual([
      expect.objectContaining({
        fromPrincipalId: "principal-xisen",
        toPrincipalId: "principal-aicoo",
        status: "connected",
      }),
    ]);
  });

  it("turns one website prompt into an in-chat plan and a mixed-Principal organization", () => {
    const next = submitChatPrompt(
      createInitialDemoState(),
      "Build and launch a customer feedback website with Neon and Vercel.",
    );
    const task = next.tasks.at(-1);

    expect(task?.selectedAgentIds).toEqual([
      "agent-xisen-planner",
      "agent-xisen-codex",
      "agent-xisen-research",
      "agent-xisen-reviewer",
      "agent-aicoo-web-builder",
      "agent-aicoo-design-engineer",
      "agent-aicoo-neon",
      "agent-aicoo-vercel",
      "agent-aicoo-quality",
    ]);
    expect(next.messages.map((message) => message.kind)).toEqual([
      "user",
      "plan",
      "coordination",
      "work",
      "result",
    ]);
    expect(next.messages[1]?.agentId).toBe("agent-xisen-planner");
    expect(next.messages[2]?.agentIds).toContain("agent-aicoo-web-builder");
    expect(next.recruitments).toEqual([
      expect.objectContaining({
        principalId: "principal-aicoo",
        status: "pending",
      }),
    ]);
    expect(next.decisions.some((decision) => decision.type === "recruitment")).toBe(
      true,
    );
    expect(next.decisions.some((decision) => decision.type === "authorization")).toBe(
      true,
    );
  });

  it("aggregates raw usage and normalized cost across the platform", () => {
    const initial = aggregateUsage(createInitialDemoState().usage);

    expect(initial).toEqual({
      inputTokens: 12_500,
      outputTokens: 3_220,
      cachedTokens: 2_840,
      totalTokens: 15_720,
      costUsd: 0.084,
    });

    const next = submitChatPrompt(createInitialDemoState(), "Build a website");
    const total = aggregateUsage(next.usage);
    const currentTask = aggregateUsage(
      next.usage.filter((entry) => entry.taskId === next.tasks.at(-1)?.id),
    );

    expect(currentTask).toEqual({
      inputTokens: 26_400,
      outputTokens: 10_180,
      cachedTokens: 5_720,
      totalTokens: 36_580,
      costUsd: 0.207,
    });
    expect(total.totalTokens).toBe(52_300);
    expect(total.costUsd).toBe(0.291);
  });

  it("resolves authority decisions without deleting their audit record", () => {
    const state = createInitialDemoState();
    const pending = state.decisions.find(
      (decision) => decision.type === "inbound_use",
    );

    const next = resolveDecision(state, pending!.id, "approved");

    expect(next.decisions.find((decision) => decision.id === pending!.id)).toEqual(
      expect.objectContaining({
        status: "approved",
        resolvedAt: "2026-08-30T10:05:00.000Z",
      }),
    );
    expect(next.events.at(-1)).toEqual(
      expect.objectContaining({
        type: "decision_resolved",
        decisionId: pending!.id,
      }),
    );
  });

  it("keeps task and recruitment lifecycle coherent as decisions resolve", () => {
    const seeded = submitChatPrompt(createInitialDemoState(), "Build a website");
    const task = seeded.tasks.at(-1)!;
    const recruitmentDecision = seeded.decisions.find(
      (decision) => decision.taskId === task.id && decision.type === "recruitment",
    )!;
    const authorizationDecision = seeded.decisions.find(
      (decision) => decision.taskId === task.id && decision.type === "authorization",
    )!;

    const recruited = resolveDecision(seeded, recruitmentDecision.id, "approved");
    expect(recruited.tasks.at(-1)?.status).toBe("awaiting_decisions");
    expect(recruited.recruitments.at(-1)?.status).toBe("approved");

    const ready = resolveDecision(recruited, authorizationDecision.id, "denied");
    expect(ready.tasks.at(-1)?.status).toBe("ready");
  });

  it("keeps selected Agent state shareable across the Network page", () => {
    const state = createInitialDemoState();
    const next = selectAgent(state, "agent-aicoo-neon");

    expect(next.selectedAgentId).toBe("agent-aicoo-neon");
    expect(state.selectedAgentId).toBe("agent-xisen-planner");
  });

  it("rejects incomplete persisted state before the UI can hydrate it", () => {
    expect(
      isDemoState({
        version: 2,
        principals: [],
        agents: [],
        decisions: [],
        usage: [],
      }),
    ).toBe(false);
    expect(
      isDemoState({
        ...createInitialDemoState(),
        version: 2,
      }),
    ).toBe(false);
    expect(
      isDemoState({
        ...createInitialDemoState(),
        agents: [{}],
      }),
    ).toBe(false);
    expect(
      isDemoState({
        ...createInitialDemoState(),
        selectedAgentId: "missing-agent",
      }),
    ).toBe(false);
    expect(isDemoState(createInitialDemoState())).toBe(true);
  });
});
