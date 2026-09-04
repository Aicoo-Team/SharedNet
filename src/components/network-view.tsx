"use client";

import { useMemo, useState } from "react";

import { useSharedNet } from "@/src/context/sharednet-context";
import type {
  AgentId,
  AgentProjection,
  InstanceId,
  InstanceProjection,
  NetworkEdge,
  NetworkProjection,
  PrincipalId,
  PrincipalProjection,
} from "@/src/sharednet/contracts";

type RelationshipScope = "intra" | "cross";

type Point = Readonly<{ x: number; y: number }>;

type AgentTree = Readonly<{
  agent: AgentProjection;
  instances: InstanceProjection[];
  presence: "online" | "offline";
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

/**
 * The graph draws one dot per Instance. An Instance is the only thing that
 * actually holds a credential, joins a Room, and sends a message, so it is the
 * only node an edge can meaningfully connect.
 */
type NetworkLayout = Readonly<{
  height: number;
  instancePositions: Map<InstanceId, Point>;
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
const INSTANCE_SPREAD = 46;
const AGENT_GAP = 88;
const MAX_VISIBLE_ROOM_EDGE_LINES = 8;

function compareOpaqueIds(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function agentTree(agent: AgentProjection, instances: InstanceProjection[]): AgentTree {
  const sorted = [...instances].sort((left, right) =>
    compareOpaqueIds(left.instance_id, right.instance_id),
  );
  return {
    agent,
    instances: sorted,
    presence: sorted.some((instance) => instance.presence === "online")
      ? "online"
      : "offline",
  };
}

function joinAgentDescendants(
  agent: AgentProjection,
  network: NetworkProjection,
): AgentTree {
  return agentTree(
    agent,
    network.instances.filter(
      (instance) =>
        instance.principal_id === agent.principal_id &&
        instance.agent_id === agent.agent_id,
    ),
  );
}

/**
 * Untagged Instances are the normal case, not an error state. They render
 * under a synthetic "default" header so every Instance sits under exactly one
 * header and the graph has a single rendering path — but no row exists for it,
 * which is why the id is a UI-local sentinel rather than a real tag id.
 */
export function untaggedGroupId(principalId: PrincipalId): AgentId {
  return `default:${principalId}` as AgentId;
}

function untaggedGroup(
  principal: PrincipalProjection,
  network: NetworkProjection,
): AgentTree | null {
  const instances = network.instances.filter(
    (instance) =>
      instance.principal_id === principal.principal_id && instance.agent_id === null,
  );
  if (instances.length === 0) return null;
  return agentTree(
    {
      agent_id: untaggedGroupId(principal.principal_id),
      created_at: "",
      diagnostic_label: "default",
      discoverability: false,
      handle: "default",
      principal_id: principal.principal_id,
      summary: "Instances that have not been tagged.",
    },
    instances,
  );
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

  return principals.map((principal) => {
    const own = principal.principal_id === network.principal.principal_id;
    const tagged = agents
      .filter((agent) => agent.principal_id === principal.principal_id)
      .map((agent) => joinAgentDescendants(agent, network));
    // Only the caller's own untagged sessions are shown; another Principal's
    // untagged sessions are not discoverable by definition.
    const untagged = own ? untaggedGroup(principal, network) : null;
    return {
      agents: untagged ? [...tagged, untagged] : tagged,
      own,
      principal,
    };
  });
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
  const instancePositions = new Map<InstanceId, Point>();
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
    // Instances of one Agent fan out horizontally from that Agent's row so a
    // dot always sits under the Agent it belongs to.
    let row = 0;
    principal.agents.forEach(({ instances }) => {
      instances.forEach((instance, index) => {
        const spread = (index - (instances.length - 1) / 2) * INSTANCE_SPREAD;
        instancePositions.set(instance.instance_id, {
          x: x + spread,
          y: AGENT_START_Y + row * AGENT_GAP,
        });
      });
      row += 1;
    });
  });

  return { height, instancePositions, principalPositions, width };
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

function visibleNetworkEdges(
  edges: NetworkEdge[],
  layout: NetworkLayout,
): NetworkEdge[] {
  return edges.filter(
    (edge) =>
      edge.source_id !== edge.target_id &&
      layout.instancePositions.has(edge.source_id) &&
      layout.instancePositions.has(edge.target_id),
  );
}

function visibleEdgeLines(
  edges: NetworkEdge[],
  layout: NetworkLayout,
) {
  return edges.flatMap((edge, edgeIndex) => {
    const source = layout.instancePositions.get(edge.source_id);
    const target = layout.instancePositions.get(edge.target_id);
    if (!source || !target) return [];

    // Shared-Room edges are undirected and drawn as one dashed line per Room,
    // up to a cap. Delegation and verification are directed and drawn once;
    // neither is emitted yet — nothing records them. See the design spec TODO.
    const visibleLineCount =
      edge.kind === "room_co_membership"
        ? Math.min(edge.weight, MAX_VISIBLE_ROOM_EDGE_LINES)
        : 1;

    return Array.from({ length: visibleLineCount }, (_, weightIndex) => (
      <line
        {...lineCoordinates(source, target, weightIndex, visibleLineCount)}
        data-edge-kind={edge.kind}
        data-edge-source={edge.source_id}
        data-edge-target={edge.target_id}
        data-edge-weight={edge.weight}
        key={`${edge.kind}:${edge.source_id}:${edge.target_id}:${edgeIndex}:${weightIndex}`}
        markerEnd={edge.kind === "room_co_membership" ? undefined : "url(#edge-arrow)"}
      />
    ));
  });
}


function AgentCard({
  agentTree,
  onClose,
}: {
  agentTree: AgentTree;
  onClose: () => void;
}) {
  const { agent, instances, presence } = agentTree;

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
          <dt>Handle</dt>
          <dd>@{agent.handle}</dd>
        </div>
        <div>
          <dt>Presence</dt>
          <dd>{presence}</dd>
        </div>
      </dl>

      <section aria-label="Registered Instances" className="agent-descendants">
        <h3>Instances</h3>
        {instances.length === 0 ? (
          <p>No Instances registered.</p>
        ) : (
          <ol className="instance-list">
            {instances.map((instance) => (
              <li key={instance.instance_id}>
                <span>Instance ID</span>
                <code>{instance.instance_id}</code>
                <small>
                  {instance.presence === "online"
                    ? "Online · heartbeat renewing"
                    : instance.heartbeat_state === "never_started"
                      ? "Offline · no heartbeat ever received"
                      : "Offline · heartbeat stopped"}
                </small>
                {Object.keys(instance.runtime_metadata).length > 0 ? (
                  <details>
                    <summary>Runtime · {instance.runtime_type}</summary>
                    <dl>
                      {Object.entries(instance.runtime_metadata).map(
                        ([key, value]) => (
                          <div key={key}>
                            <dt>{key}</dt>
                            <dd>{value}</dd>
                          </div>
                        ),
                      )}
                    </dl>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

/**
 * One dot per Instance. The label carries the Agent it belongs to, because an
 * Instance id alone says nothing about whose session it is, but the node's
 * identity — and every edge endpoint — is the Instance.
 */
function InstanceNode({
  agent,
  instance,
  own,
  position,
  principalLeft,
  selected,
  onInspect,
}: {
  agent: AgentProjection;
  instance: InstanceProjection;
  own: boolean;
  position: Point;
  principalLeft: number;
  selected: boolean;
  onInspect: () => void;
}) {
  return (
    <button
      aria-label={`Inspect Instance ${instance.instance_id}`}
      aria-pressed={selected}
      className="relationship-node"
      data-agent-id={agent.agent_id}
      data-instance-id={instance.instance_id}
      data-layout-x={position.x}
      data-layout-y={position.y}
      data-presence={instance.presence}
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
      <code>{instance.instance_id}</code>
      <small>
        <span>{instance.presence}</span>
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
  const visibleEdges = useMemo(
    () => (network ? visibleNetworkEdges(network.edges, layout) : []),
    [layout, network],
  );
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
            ? "Refreshing SharedNet…"
            : "SharedNet data may be out of date."}
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
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                width={layout.width}
              >
                {visibleEdgeLines(visibleEdges, layout)}
              </svg>

              <ol aria-label="Visible relationships" className="sr-only">
                {visibleEdges.map((edge, index) => (
                  <li
                    key={`${edge.kind}:${edge.source_id}:${edge.target_id}:${index}`}
                  >
                    {edge.kind}: source {edge.source_id}; target {edge.target_id};
                    weight {edge.weight}
                  </li>
                ))}
              </ol>

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

                    {principal.agents.flatMap((agentTree) =>
                      agentTree.instances.map((instance) => {
                        const nodePosition = layout.instancePositions.get(
                          instance.instance_id,
                        );
                        if (!nodePosition) return null;
                        const agentId = agentTree.agent.agent_id;
                        return (
                          <InstanceNode
                            agent={agentTree.agent}
                            instance={instance}
                            key={instance.instance_id}
                            onInspect={() => {
                              setSelectedAgentId(agentId);
                              setCardOpen(true);
                            }}
                            own={principal.own}
                            position={nodePosition}
                            principalLeft={position.left}
                            selected={selectedAgent?.agent.agent_id === agentId}
                          />
                        );
                      }),
                    )}

                    {principal.agents.length === 0 ? (
                      <p className="principal-empty">
                        {principal.own
                          ? "No Instances for this Principal."
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
