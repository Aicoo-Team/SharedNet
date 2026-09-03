"use client";

import { useMemo, useState } from "react";

import { useSharedNet } from "@/src/context/sharednet-context";
import type {
  AgentId,
  AgentProjection,
  InstanceProjection,
  NetworkEdge,
  NetworkProjection,
  PrincipalId,
  PrincipalProjection,
  RuntimeProjection,
} from "@/src/sharednet/contracts";

type RelationshipScope = "intra" | "cross";

type Point = Readonly<{ x: number; y: number }>;

type RuntimeTree = Readonly<{
  instances: InstanceProjection[];
  runtime: RuntimeProjection;
}>;

type AgentTree = Readonly<{
  agent: AgentProjection;
  presence: "online" | "offline";
  runtimes: RuntimeTree[];
  template: boolean;
}>;

type VisiblePrincipal = Readonly<{
  agents: AgentTree[];
  own: boolean;
  principal: PrincipalProjection;
}>;

type PrincipalPosition = Point &
  Readonly<{
    height: number;
    left: number;
    width: number;
  }>;

type NetworkLayout = Readonly<{
  agentPositions: Map<AgentId, Point>;
  height: number;
  principalPositions: Map<PrincipalId, PrincipalPosition>;
  width: number;
}>;

const MIN_CANVAS_WIDTH = 760;
const MIN_CANVAS_HEIGHT = 500;
const CANVAS_PADDING = 24;
const PRINCIPAL_GROUP_WIDTH = 208;
const PRINCIPAL_GROUP_GAP = 28;
const PRINCIPAL_GROUP_TOP = 18;
const PRINCIPAL_Y = 55;
const AGENT_START_Y = 148;
const AGENT_GAP = 88;

function compareOpaqueIds(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function joinAgentDescendants(
  agent: AgentProjection,
  network: NetworkProjection,
): AgentTree {
  const runtimes = network.runtimes
    .filter(
      (runtime) =>
        runtime.principal_id === agent.principal_id &&
        runtime.agent_id === agent.agent_id,
    )
    .sort((left, right) =>
      compareOpaqueIds(left.runtime_id, right.runtime_id),
    )
    .map((runtime) => ({
      runtime,
      instances: network.instances
        .filter(
          (instance) =>
            instance.principal_id === agent.principal_id &&
            instance.agent_id === agent.agent_id &&
            instance.runtime_id === runtime.runtime_id,
        )
        .sort((left, right) =>
          compareOpaqueIds(left.instance_id, right.instance_id),
        ),
    }));
  const presence = runtimes.some((runtime) =>
    runtime.instances.some((instance) => instance.presence === "online"),
  )
    ? "online"
    : "offline";

  return {
    agent,
    presence,
    runtimes,
    template:
      agent.official && agent.discoverability && runtimes.length === 0,
  };
}

function visibleNetwork(
  network: NetworkProjection,
  scope: RelationshipScope,
): VisiblePrincipal[] {
  const principalCandidates =
    scope === "cross"
      ? [network.principal, ...network.connected_principals]
      : [network.principal];
  const principalById = new Map<PrincipalId, PrincipalProjection>();
  for (const principal of principalCandidates) {
    if (!principalById.has(principal.principal_id)) {
      principalById.set(principal.principal_id, principal);
    }
  }
  const principals = [...principalById.values()].sort((left, right) =>
    compareOpaqueIds(left.principal_id, right.principal_id),
  );
  const visiblePrincipalIds = new Set(principals.map(({ principal_id }) => principal_id));
  const agents = network.agents
    .filter((agent) => {
      if (!visiblePrincipalIds.has(agent.principal_id)) return false;
      if (agent.principal_id === network.principal.principal_id) return true;
      return scope === "cross" && agent.discoverability;
    })
    .sort((left, right) => {
      const principalOrder = compareOpaqueIds(
        left.principal_id,
        right.principal_id,
      );
      return principalOrder || compareOpaqueIds(left.agent_id, right.agent_id);
    });

  return principals.map((principal) => ({
    agents: agents
      .filter((agent) => agent.principal_id === principal.principal_id)
      .map((agent) => joinAgentDescendants(agent, network)),
    own: principal.principal_id === network.principal.principal_id,
    principal,
  }));
}

function createNetworkLayout(principals: VisiblePrincipal[]): NetworkLayout {
  const maxAgentCount = Math.max(
    0,
    ...principals.map((principal) => principal.agents.length),
  );
  const contentWidth =
    principals.length === 0
      ? 0
      : principals.length * PRINCIPAL_GROUP_WIDTH +
        (principals.length - 1) * PRINCIPAL_GROUP_GAP;
  const width = Math.max(
    MIN_CANVAS_WIDTH,
    contentWidth + CANVAS_PADDING * 2,
  );
  const height = Math.max(
    MIN_CANVAS_HEIGHT,
    AGENT_START_Y + Math.max(0, maxAgentCount - 1) * AGENT_GAP + 86,
  );
  const firstGroupLeft = (width - contentWidth) / 2;
  const agentPositions = new Map<AgentId, Point>();
  const principalPositions = new Map<PrincipalId, PrincipalPosition>();

  principals.forEach((principal, principalIndex) => {
    const left =
      firstGroupLeft +
      principalIndex * (PRINCIPAL_GROUP_WIDTH + PRINCIPAL_GROUP_GAP);
    const x = left + PRINCIPAL_GROUP_WIDTH / 2;
    principalPositions.set(principal.principal.principal_id, {
      height: height - PRINCIPAL_GROUP_TOP * 2,
      left,
      width: PRINCIPAL_GROUP_WIDTH,
      x,
      y: PRINCIPAL_Y,
    });
    principal.agents.forEach(({ agent }, agentIndex) => {
      agentPositions.set(agent.agent_id, {
        x,
        y: AGENT_START_Y + agentIndex * AGENT_GAP,
      });
    });
  });

  return { agentPositions, height, principalPositions, width };
}

function lineCoordinates(
  source: Point,
  target: Point,
  index: number,
  total: number,
) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const offset = (index - (total - 1) / 2) * 4;
  const offsetX = (-dy / length) * offset;
  const offsetY = (dx / length) * offset;

  return {
    x1: source.x + offsetX,
    x2: target.x + offsetX,
    y1: source.y + offsetY,
    y2: target.y + offsetY,
  };
}

function visibleEdgeLines(
  edges: NetworkEdge[],
  layout: NetworkLayout,
) {
  return edges.flatMap((edge, edgeIndex) => {
    if (edge.kind === "room_co_membership") {
      const source = layout.agentPositions.get(edge.source_id as AgentId);
      const target = layout.agentPositions.get(edge.target_id as AgentId);
      if (!source || !target) return [];
      return Array.from({ length: edge.weight }, (_, weightIndex) => (
        <line
          {...lineCoordinates(source, target, weightIndex, edge.weight)}
          data-edge-kind={edge.kind}
          data-edge-source={edge.source_id}
          data-edge-target={edge.target_id}
          data-edge-weight={edge.weight}
          key={`${edge.kind}:${edge.source_id}:${edge.target_id}:${edgeIndex}:${weightIndex}`}
        />
      ));
    }

    const source = layout.principalPositions.get(edge.source_id as PrincipalId);
    const target = layout.principalPositions.get(edge.target_id as PrincipalId);
    if (!source || !target || edge.source_id === edge.target_id) return [];
    return [
      <line
        {...lineCoordinates(source, target, 0, 1)}
        data-edge-kind={edge.kind}
        data-edge-source={edge.source_id}
        data-edge-target={edge.target_id}
        data-edge-weight={edge.weight}
        key={`${edge.kind}:${edge.source_id}:${edge.target_id}:${edgeIndex}`}
      />,
    ];
  });
}

function AgentCard({
  agentTree,
  onClose,
}: {
  agentTree: AgentTree;
  onClose: () => void;
}) {
  const { agent, presence, runtimes, template } = agentTree;

  return (
    <aside aria-label="Agent Card" className="agent-card" role="region">
      <header>
        <p>Agent Card</p>
        <button aria-label="Close Agent Card" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <h2>{agent.diagnostic_label}</h2>
      <dl className="agent-card-facts">
        <div>
          <dt>Principal ID</dt>
          <dd>{agent.principal_id}</dd>
        </div>
        <div>
          <dt>Agent ID</dt>
          <dd>{agent.agent_id}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{agent.role}</dd>
        </div>
        <div>
          <dt>Presence</dt>
          <dd>
            {presence}
            {template ? <span className="agent-template-label">template</span> : null}
          </dd>
        </div>
        <div>
          <dt>Capabilities</dt>
          <dd>
            {agent.capabilities.length > 0 ? (
              <ul className="agent-capabilities">
                {agent.capabilities.map((capability) => (
                  <li key={capability}>{capability}</li>
                ))}
              </ul>
            ) : (
              "None declared"
            )}
          </dd>
        </div>
      </dl>

      <section
        aria-label="Registered Runtime and Instance descendants"
        className="agent-descendants"
      >
        <h3>Runtime → Instance</h3>
        {runtimes.length === 0 ? (
          <p>No Runtimes registered.</p>
        ) : (
          <ol className="runtime-list">
            {runtimes.map(({ instances, runtime }) => (
              <li
                aria-label={`Runtime ${runtime.runtime_id}`}
                key={runtime.runtime_id}
                role="group"
              >
                <span>Runtime ID</span>
                <code>{runtime.runtime_id}</code>
                {instances.length === 0 ? (
                  <p>No Instances registered.</p>
                ) : (
                  <ol className="instance-list">
                    {instances.map((instance) => (
                      <li key={instance.instance_id}>
                        <span>Instance ID</span>
                        <code>{instance.instance_id}</code>
                        <small>{instance.presence}</small>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

function AgentNode({
  agentTree,
  own,
  position,
  principalLeft,
  selected,
  onInspect,
}: {
  agentTree: AgentTree;
  own: boolean;
  position: Point;
  principalLeft: number;
  selected: boolean;
  onInspect: () => void;
}) {
  const { agent, presence, template } = agentTree;

  return (
    <button
      aria-label={`Inspect Agent ${agent.agent_id}`}
      aria-pressed={selected}
      className="relationship-node"
      data-agent-id={agent.agent_id}
      data-layout-x={position.x}
      data-layout-y={position.y}
      data-presence={presence}
      data-principal={own ? "self" : "external"}
      onClick={onInspect}
      style={{
        left: `${position.x - principalLeft}px`,
        top: `${position.y - PRINCIPAL_GROUP_TOP}px`,
      }}
      type="button"
    >
      <span aria-hidden="true" className="relationship-node-mark" />
      <strong>{agent.diagnostic_label}</strong>
      <code>{agent.agent_id}</code>
      <small>
        <span>{presence}</span>
        {template ? <em>template</em> : null}
      </small>
    </button>
  );
}

export function NetworkView() {
  const { network, status } = useSharedNet();
  const [scope, setScope] = useState<RelationshipScope>("intra");
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(null);
  const [cardOpen, setCardOpen] = useState(true);
  const principals = useMemo(
    () => (network ? visibleNetwork(network, scope) : []),
    [network, scope],
  );
  const layout = useMemo(() => createNetworkLayout(principals), [principals]);
  const agentTrees = principals.flatMap((principal) => principal.agents);
  const selectedAgent =
    agentTrees.find(({ agent }) => agent.agent_id === selectedAgentId) ??
    agentTrees[0] ??
    null;

  if (network === null) {
    return status === "loading" ? (
      <div className="network-state" role="status">
        Loading Network…
      </div>
    ) : (
      <div className="network-state" role="alert">
        Network unavailable.
      </div>
    );
  }

  return (
    <div className="network-surface">
      {status !== "ready" ? (
        <p className="network-freshness" role="status">
          {status === "loading"
            ? "Refreshing Network…"
            : "Network data may be out of date."}
        </p>
      ) : null}

      <div
        className="network-workspace"
        data-card-state={selectedAgent ? (cardOpen ? "open" : "closed") : "empty"}
      >
        {selectedAgent && cardOpen ? (
          <AgentCard
            agentTree={selectedAgent}
            onClose={() => setCardOpen(false)}
          />
        ) : selectedAgent ? (
          <button
            aria-label="Open Agent Card"
            className="agent-card-open"
            onClick={() => setCardOpen(true)}
            type="button"
          >
            Agent Card →
          </button>
        ) : null}

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
            <p>
              {scope === "intra"
                ? "Own Principal and Agents"
                : "Connected Principal groups"}
            </p>
          </header>

          <div className="graph-stage">
            <div
              className="network-canvas"
              style={{ height: `${layout.height}px`, width: `${layout.width}px` }}
            >
              <svg
                aria-hidden="true"
                className="relationship-lines"
                viewBox={`0 0 ${layout.width} ${layout.height}`}
              >
                {visibleEdgeLines(network.edges, layout)}
              </svg>

              {principals.map((principal) => {
                const principalId = principal.principal.principal_id;
                const position = layout.principalPositions.get(principalId);
                if (!position) return null;

                return (
                  <section
                    aria-label={`Principal ${principalId}`}
                    className="principal-group"
                    data-layout-x={position.x}
                    data-layout-y={position.y}
                    data-principal={principal.own ? "self" : "external"}
                    key={principalId}
                    role="group"
                    style={{
                      height: `${position.height}px`,
                      left: `${position.left}px`,
                      top: `${PRINCIPAL_GROUP_TOP}px`,
                      width: `${position.width}px`,
                    }}
                  >
                    <header className="principal-identity">
                      <p>{principal.own ? "Own Principal" : "Connected Principal"}</p>
                      <h2>{principal.principal.diagnostic_label}</h2>
                      <code>{principalId}</code>
                    </header>

                    {principal.agents.map((agentTree) => {
                      const agentId = agentTree.agent.agent_id;
                      const agentPosition = layout.agentPositions.get(agentId);
                      if (!agentPosition) return null;
                      return (
                        <AgentNode
                          agentTree={agentTree}
                          key={agentId}
                          onInspect={() => {
                            setSelectedAgentId(agentId);
                            setCardOpen(true);
                          }}
                          own={principal.own}
                          position={agentPosition}
                          principalLeft={position.left}
                          selected={selectedAgent?.agent.agent_id === agentId}
                        />
                      );
                    })}

                    {principal.agents.length === 0 ? (
                      <p className="principal-empty">
                        {principal.own
                          ? "No Agents registered for this Principal."
                          : "No discoverable Agents."}
                      </p>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </div>

          <footer className="graph-legend" aria-label="Relationship legend">
            <span>
              <i className="legend-room" aria-hidden="true" />
              dotted · shared rooms × weight
            </span>
            <span>
              <i className="legend-principal" aria-hidden="true" />
              solid · Principal connection
            </span>
          </footer>
        </section>
      </div>
    </div>
  );
}
