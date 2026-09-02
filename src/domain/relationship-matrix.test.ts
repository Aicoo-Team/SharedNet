import { describe, expect, it } from "vitest";
import { createInitialDemoState, submitChatPrompt } from "./network-demo";
import {
  getAgentInstanceId,
  getRelationshipMatrix,
} from "./relationship-matrix";

describe("SharedNet relationship matrix", () => {
  it("keeps room co-membership and direct delegation as separate weights", () => {
    const matrix = getRelationshipMatrix(createInitialDemoState(), "intra");
    const plannerCodex = matrix.edges.find(
      (edge) => edge.id === "planner-codex",
    );

    expect(plannerCodex).toEqual({
      id: "planner-codex",
      sourceAgentId: "agent-xisen-planner",
      targetAgentId: "agent-xisen-codex",
      sharedRooms: 3,
      delegations: 2,
      scope: "intra",
    });
  });

  it("adds one shared-room observation when both Agents join a new task", () => {
    const seeded = submitChatPrompt(createInitialDemoState(), "Build a website");
    const matrix = getRelationshipMatrix(seeded, "cross");
    const plannerBuilder = matrix.edges.find(
      (edge) => edge.id === "planner-web-builder",
    );

    expect(plannerBuilder?.sharedRooms).toBe(3);
    expect(plannerBuilder?.delegations).toBe(2);
  });

  it("derives a stable runtime identity for the Agent Card", () => {
    const agent = createInitialDemoState().agents.find(
      (candidate) => candidate.id === "agent-xisen-codex",
    )!;

    expect(getAgentInstanceId(agent)).toBe("runtime-local-xisen-codex");
  });
});
