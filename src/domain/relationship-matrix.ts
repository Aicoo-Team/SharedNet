import type { Agent, SharedNetDemoState } from "./network-demo";

export type RelationshipScope = "intra" | "cross";

export interface RelationshipEdge {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  sharedRooms: number;
  delegations: number;
  scope: RelationshipScope;
}

export interface RelationshipMatrix {
  agentIds: string[];
  edges: RelationshipEdge[];
}

const BASE_EDGES: Record<RelationshipScope, RelationshipEdge[]> = {
  intra: [
    {
      id: "planner-codex",
      sourceAgentId: "agent-xisen-planner",
      targetAgentId: "agent-xisen-codex",
      sharedRooms: 3,
      delegations: 2,
      scope: "intra",
    },
    {
      id: "planner-research",
      sourceAgentId: "agent-xisen-planner",
      targetAgentId: "agent-xisen-research",
      sharedRooms: 2,
      delegations: 1,
      scope: "intra",
    },
    {
      id: "codex-reviewer",
      sourceAgentId: "agent-xisen-codex",
      targetAgentId: "agent-xisen-reviewer",
      sharedRooms: 2,
      delegations: 2,
      scope: "intra",
    },
    {
      id: "research-reviewer",
      sourceAgentId: "agent-xisen-research",
      targetAgentId: "agent-xisen-reviewer",
      sharedRooms: 1,
      delegations: 1,
      scope: "intra",
    },
  ],
  cross: [
    {
      id: "planner-web-builder",
      sourceAgentId: "agent-xisen-planner",
      targetAgentId: "agent-aicoo-web-builder",
      sharedRooms: 2,
      delegations: 2,
      scope: "cross",
    },
    {
      id: "codex-design-engineer",
      sourceAgentId: "agent-xisen-codex",
      targetAgentId: "agent-aicoo-design-engineer",
      sharedRooms: 2,
      delegations: 3,
      scope: "cross",
    },
    {
      id: "research-neon",
      sourceAgentId: "agent-xisen-research",
      targetAgentId: "agent-aicoo-neon",
      sharedRooms: 1,
      delegations: 1,
      scope: "cross",
    },
    {
      id: "codex-vercel",
      sourceAgentId: "agent-xisen-codex",
      targetAgentId: "agent-aicoo-vercel",
      sharedRooms: 1,
      delegations: 2,
      scope: "cross",
    },
    {
      id: "reviewer-quality",
      sourceAgentId: "agent-xisen-reviewer",
      targetAgentId: "agent-aicoo-quality",
      sharedRooms: 2,
      delegations: 2,
      scope: "cross",
    },
  ],
};

function taskRoomCount(
  state: SharedNetDemoState,
  sourceAgentId: string,
  targetAgentId: string,
): number {
  return state.tasks.filter(
    (task) =>
      task.selectedAgentIds.includes(sourceAgentId) &&
      task.selectedAgentIds.includes(targetAgentId),
  ).length;
}

export function getRelationshipMatrix(
  state: SharedNetDemoState,
  scope: RelationshipScope,
): RelationshipMatrix {
  const edges = BASE_EDGES[scope].map((edge) => ({
    ...edge,
    sharedRooms:
      edge.sharedRooms +
      taskRoomCount(state, edge.sourceAgentId, edge.targetAgentId),
  }));

  return {
    agentIds: Array.from(
      new Set(
        edges.flatMap((edge) => [edge.sourceAgentId, edge.targetAgentId]),
      ),
    ),
    edges,
  };
}

export function getAgentInstanceId(agent: Agent): string {
  return `runtime-${agent.runtime.kind}-${agent.id.replace(/^agent-/, "")}`;
}
