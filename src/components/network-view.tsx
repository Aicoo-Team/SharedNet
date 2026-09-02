"use client";

import { useMemo, useState } from "react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import type { Agent } from "@/src/domain/network-demo";
import {
  getAgentInstanceId,
  getRelationshipMatrix,
  type RelationshipEdge,
  type RelationshipScope,
} from "@/src/domain/relationship-matrix";

const VIEWBOX = { width: 760, height: 500 };

const POSITIONS: Record<
  RelationshipScope,
  Record<string, { x: number; y: number }>
> = {
  intra: {
    "agent-xisen-planner": { x: 190, y: 135 },
    "agent-xisen-codex": { x: 470, y: 120 },
    "agent-xisen-research": { x: 225, y: 350 },
    "agent-xisen-reviewer": { x: 520, y: 350 },
  },
  cross: {
    "agent-xisen-planner": { x: 150, y: 125 },
    "agent-xisen-codex": { x: 155, y: 275 },
    "agent-xisen-research": { x: 260, y: 405 },
    "agent-xisen-reviewer": { x: 385, y: 365 },
    "agent-aicoo-web-builder": { x: 535, y: 115 },
    "agent-aicoo-design-engineer": { x: 625, y: 245 },
    "agent-aicoo-neon": { x: 515, y: 415 },
    "agent-aicoo-vercel": { x: 660, y: 370 },
    "agent-aicoo-quality": { x: 400, y: 170 },
  },
};

function lineCoordinates(
  edge: RelationshipEdge,
  scope: RelationshipScope,
  index: number,
  total: number,
  bandOffset: number,
) {
  const source = POSITIONS[scope][edge.sourceAgentId];
  const target = POSITIONS[scope][edge.targetAgentId];
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const offset = (index - (total - 1) / 2) * 4 + bandOffset;
  const ox = (-dy / length) * offset;
  const oy = (dx / length) * offset;

  return {
    x1: source.x + ox,
    y1: source.y + oy,
    x2: target.x + ox,
    y2: target.y + oy,
  };
}

function AgentCard({
  agent,
  sharedRooms,
  delegations,
  onClose,
}: {
  agent: Agent;
  sharedRooms: number;
  delegations: number;
  onClose: () => void;
}) {
  return (
    <aside aria-label="Agent Card" className="agent-card" role="region">
      <header>
        <p>Agent Card</p>
        <button aria-label="Close Agent Card" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <h2>{agent.handle}</h2>
      <dl>
        <div>
          <dt>Principal ID</dt>
          <dd>{agent.principalId}</dd>
        </div>
        <div>
          <dt>Agent ID</dt>
          <dd>{agent.id}</dd>
        </div>
        <div>
          <dt>Instance ID</dt>
          <dd>{getAgentInstanceId(agent)}</dd>
        </div>
      </dl>
      <footer>
        <span>{sharedRooms} shared rooms</span>
        <span>{delegations} delegations</span>
      </footer>
    </aside>
  );
}

export function NetworkView() {
  const { state, selectAgent } = useSharedNetDemo();
  const [scope, setScope] = useState<RelationshipScope>("intra");
  const [cardOpen, setCardOpen] = useState(true);
  const matrix = useMemo(
    () => getRelationshipMatrix(state, scope),
    [scope, state],
  );
  const selectedAgent =
    state.agents.find((agent) => agent.id === state.selectedAgentId) ?? state.agents[0];
  const selectedRelationships = matrix.edges.filter(
    (edge) =>
      edge.sourceAgentId === selectedAgent.id ||
      edge.targetAgentId === selectedAgent.id,
  );
  const sharedRooms = selectedRelationships.reduce(
    (sum, edge) => sum + edge.sharedRooms,
    0,
  );
  const delegations = selectedRelationships.reduce(
    (sum, edge) => sum + edge.delegations,
    0,
  );

  function inspectAgent(agentId: string) {
    selectAgent(agentId);
    setCardOpen(true);
  }

  return (
    <div className="network-workspace">
      {cardOpen ? (
        <AgentCard
          agent={selectedAgent}
          delegations={delegations}
          onClose={() => setCardOpen(false)}
          sharedRooms={sharedRooms}
        />
      ) : (
        <button
          aria-label="Open Agent Card"
          className="agent-card-open"
          onClick={() => setCardOpen(true)}
          type="button"
        >
          Agent Card →
        </button>
      )}

      <section aria-label="Relationship graph" className="relationship-graph">
        <header className="graph-toolbar">
          <div className="scope-switcher">
            <button
              aria-pressed={scope === "intra"}
              onClick={() => setScope("intra")}
              type="button"
            >
              Intra-Principal
            </button>
            <button
              aria-pressed={scope === "cross"}
              onClick={() => setScope("cross")}
              type="button"
            >
              Cross-Principal
            </button>
          </div>
          <p>{scope === "intra" ? "Same Principal ID" : "Different Principal IDs"}</p>
        </header>

        <div className="graph-stage">
          <svg
            aria-hidden="true"
            className="relationship-lines"
            preserveAspectRatio="none"
            viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
          >
            {matrix.edges.flatMap((edge) => [
              ...Array.from({ length: edge.sharedRooms }, (_, index) => (
                <line
                  {...lineCoordinates(
                    edge,
                    scope,
                    index,
                    edge.sharedRooms,
                    -5,
                  )}
                  data-edge-id={edge.id}
                  data-edge-kind="shared-room"
                  data-scope={edge.scope}
                  key={`${edge.id}-room-${index}`}
                />
              )),
              ...Array.from({ length: edge.delegations }, (_, index) => (
                <line
                  {...lineCoordinates(
                    edge,
                    scope,
                    index,
                    edge.delegations,
                    6,
                  )}
                  data-edge-id={edge.id}
                  data-edge-kind="delegation"
                  data-scope={edge.scope}
                  key={`${edge.id}-delegation-${index}`}
                />
              )),
            ])}
          </svg>

          {matrix.agentIds.map((agentId) => {
            const agent = state.agents.find((candidate) => candidate.id === agentId);
            const position = POSITIONS[scope][agentId];
            if (!agent || !position) return null;
            const ownPrincipal = agent.principalId === "principal-xisen";

            return (
              <button
                aria-label={`Inspect ${agent.handle}`}
                aria-pressed={selectedAgent.id === agent.id}
                className="relationship-node"
                data-principal={ownPrincipal ? "self" : "external"}
                data-scope={scope}
                key={agent.id}
                onClick={() => inspectAgent(agent.id)}
                style={{
                  left: `${(position.x / VIEWBOX.width) * 100}%`,
                  top: `${(position.y / VIEWBOX.height) * 100}%`,
                }}
                type="button"
              >
                <span aria-hidden="true" />
                <strong>{agent.handle}</strong>
              </button>
            );
          })}
        </div>

        <footer className="graph-legend" aria-label="Relationship legend">
          <span>
            <i className="legend-room" aria-hidden="true" />
            dotted · rooms together
          </span>
          <span>
            <i className="legend-delegation" aria-hidden="true" />
            solid · direct delegation
          </span>
        </footer>
      </section>
    </div>
  );
}
