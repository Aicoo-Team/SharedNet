"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useSharedNet } from "@/src/context/sharednet-context";

import { DriverMark } from "./driver-mark";
import { SplitHandle, useSplitWidth } from "./split-handle";
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

/**
 * The Network is a graph of Instances. Every Instance the Principal can see
 * is a node: its own, and every seat that shares a Room with one of them.
 * Two Instances are joined by one line for every Room they are both active
 * in, drawn once and weighted; a Room with five seats draws ten lines. No
 * boxes: a Principal is a fact about a node, shown on it and in its card,
 * not a fence around it.
 */

type Point = Readonly<{ x: number; y: number }>;

type GraphNode = Readonly<{
  instance: InstanceProjection;
  agent: AgentProjection | null;
  principal: PrincipalProjection | null;
  own: boolean;
  /** How many Instances this one shares at least one Room with. */
  degree: number;
  /** How many Room co-memberships it has in total (edge weights summed). */
  sharedRooms: number;
}>;

type GraphEdge = Readonly<{ source: InstanceId; target: InstanceId; weight: number }>;

const CANVAS_PADDING = 56;
const MIN_CANVAS = 560;

export function untaggedGroupId(principalId: PrincipalId): AgentId {
  return `default:${principalId}` as AgentId;
}

/** True for the UI-local header id above; no such Agent exists on the server. */
export function isUntaggedGroupId(agentId: AgentId): boolean {
  return agentId.startsWith("default:");
}

export function describeInstanceRuntime(instance: InstanceProjection): string {
  const metadata = instance.runtime_metadata;
  const cliVersion = metadata.cli_version && metadata.cli_version !== "invite" ? metadata.cli_version : undefined;
  const version = metadata.driver_version ?? cliVersion;
  const source = metadata.runtime_source;
  const trust = source === "detected" ? "detected" : source === "declared" ? "self-declared" : "not reported";
  return [
    `${instance.runtime_type}${version ? ` ${version}` : ""}`,
    ...(metadata.entrypoint ? [metadata.entrypoint] : []),
    trust,
  ].join(" · ");
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A small deterministic hash, so the same Network always lands the same way. */
function hashId(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 4294967295;
}

/** The nodes and the edges the projection draws between them, in a stable order. */
export function buildGraph(network: NetworkProjection): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const agents = new Map(network.agents.map((agent) => [agent.agent_id, agent]));
  const principals = new Map<PrincipalId, PrincipalProjection>([
    [network.principal.principal_id, network.principal],
    ...network.connected_principals.map((principal): [PrincipalId, PrincipalProjection] => [principal.principal_id, principal]),
  ]);
  const known = new Set(network.instances.map((instance) => instance.instance_id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const edge of network.edges) {
    if (edge.kind !== "room_co_membership") continue;
    if (!known.has(edge.source_id) || !known.has(edge.target_id) || edge.source_id === edge.target_id) continue;
    const [a, b] = [edge.source_id, edge.target_id].sort(compareIds) as [InstanceId, InstanceId];
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: a, target: b, weight: Math.max(1, Math.floor(edge.weight)) });
  }
  const degree = new Map<InstanceId, number>();
  const shared = new Map<InstanceId, number>();
  for (const edge of edges) {
    for (const end of [edge.source, edge.target]) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
      shared.set(end, (shared.get(end) ?? 0) + edge.weight);
    }
  }
  const nodes = [...network.instances]
    .sort((left, right) => compareIds(left.instance_id, right.instance_id))
    .map(
      (instance): GraphNode => ({
        instance,
        agent: instance.agent_id ? (agents.get(instance.agent_id) ?? null) : null,
        principal: principals.get(instance.principal_id) ?? null,
        own: instance.principal_id === network.principal.principal_id,
        degree: degree.get(instance.instance_id) ?? 0,
        sharedRooms: shared.get(instance.instance_id) ?? 0,
      }),
    );
  return { nodes, edges };
}

/**
 * A force layout, run to rest before render: nodes repel, shared Rooms pull,
 * Instances of one Principal drift together, and everything is drawn toward
 * the middle so islands stay on the canvas. Deterministic: the same ids
 * start from the same places and settle in the same ones.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  availableWidth = 0,
): { positions: Map<InstanceId, Point>; width: number; height: number } {
  const count = nodes.length;
  // The canvas fits the stage it is shown in and grows downward with the
  // crowd, so a Network never hides nodes off to the right.
  const wanted = Math.round(150 * Math.sqrt(Math.max(count, 1)) + 200);
  const width = availableWidth > 0 ? Math.max(MIN_CANVAS, Math.floor(availableWidth)) : Math.round(Math.max(MIN_CANVAS, wanted) * 1.4);
  const height = Math.max(Math.round(width / 1.6), Math.min(wanted, Math.round((wanted * wanted) / width) + 120), 420);
  const positions = new Map<InstanceId, Point>();
  if (count === 0) return { positions, width, height };
  const ids = nodes.map((node) => node.instance.instance_id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + hashId(ids[i]!) * 0.5;
    const radius = (Math.min(width, height) / 2 - CANVAS_PADDING) * (0.55 + 0.4 * hashId(`${ids[i]}:r`));
    x[i] = width / 2 + Math.cos(angle) * radius;
    y[i] = height / 2 + Math.sin(angle) * radius;
  }
  const area = width * height;
  const k = Math.sqrt(area / count) * 0.55;
  const springs = [
    ...edges.map((edge) => ({ a: index.get(edge.source)!, b: index.get(edge.target)!, strength: 1 + Math.min(edge.weight, 4) * 0.25 })),
  ];
  // Same Principal: a weak spring, so a Principal's seats read as a cluster.
  const byPrincipal = new Map<PrincipalId, number[]>();
  nodes.forEach((node, i) => byPrincipal.set(node.instance.principal_id, [...(byPrincipal.get(node.instance.principal_id) ?? []), i]));
  for (const members of byPrincipal.values()) {
    for (let a = 0; a < members.length; a += 1) for (let b = a + 1; b < members.length; b += 1) springs.push({ a: members[a]!, b: members[b]!, strength: 0.2 });
  }
  let temperature = Math.min(width, height) / 8;
  const iterations = 300;
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  for (let step = 0; step < iterations; step += 1) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let ddx = x[i]! - x[j]!;
        let ddy = y[i]! - y[j]!;
        let distance = Math.hypot(ddx, ddy);
        if (distance < 0.01) {
          ddx = hashId(`${ids[i]}${ids[j]}`) - 0.5;
          ddy = hashId(`${ids[j]}${ids[i]}`) - 0.5;
          distance = 0.01;
        }
        const repulsion = (k * k) / distance;
        dx[i]! += (ddx / distance) * repulsion;
        dy[i]! += (ddy / distance) * repulsion;
        dx[j]! -= (ddx / distance) * repulsion;
        dy[j]! -= (ddy / distance) * repulsion;
      }
    }
    for (const spring of springs) {
      const ddx = x[spring.a]! - x[spring.b]!;
      const ddy = y[spring.a]! - y[spring.b]!;
      const distance = Math.max(Math.hypot(ddx, ddy), 0.01);
      const attraction = ((distance * distance) / k) * spring.strength;
      dx[spring.a]! -= (ddx / distance) * attraction;
      dy[spring.a]! -= (ddy / distance) * attraction;
      dx[spring.b]! += (ddx / distance) * attraction;
      dy[spring.b]! += (ddy / distance) * attraction;
    }
    for (let i = 0; i < count; i += 1) {
      // Gravity toward the middle keeps disconnected Instances in view.
      dx[i]! += (width / 2 - x[i]!) * 0.02;
      dy[i]! += (height / 2 - y[i]!) * 0.02;
      const length = Math.max(Math.hypot(dx[i]!, dy[i]!), 0.01);
      const capped = Math.min(length, temperature);
      x[i] = Math.min(width - CANVAS_PADDING, Math.max(CANVAS_PADDING, x[i]! + (dx[i]! / length) * capped));
      y[i] = Math.min(height - CANVAS_PADDING, Math.max(CANVAS_PADDING, y[i]! + (dy[i]! / length) * capped));
    }
    temperature *= 0.985;
  }
  for (let i = 0; i < count; i += 1) positions.set(ids[i]!, { x: Math.round(x[i]!), y: Math.round(y[i]!) });
  return { positions, width, height };
}

/** The Instance a search names: an exact id, or the one id that starts with what was typed. */
export function findInstance(nodes: GraphNode[], query: string): GraphNode | null {
  const needle = query.trim();
  if (needle.length === 0) return null;
  const exact = nodes.find((node) => node.instance.instance_id === needle);
  if (exact) return exact;
  const prefix = nodes.filter((node) => node.instance.instance_id.startsWith(needle));
  return prefix.length === 1 ? prefix[0]! : null;
}

function agentLabel(node: GraphNode): string {
  if (node.agent) return node.agent.diagnostic_label;
  return node.principal?.kind === "anonymous" ? (node.instance.display_name ?? node.principal.diagnostic_label) : "Untagged";
}

function InstanceCard({
  node,
  siblings,
  onClose,
  onSelect,
}: {
  node: GraphNode;
  siblings: GraphNode[];
  onClose: () => void;
  onSelect: (id: InstanceId) => void;
}) {
  const { instance } = node;
  return (
    <aside aria-label="Agent Card" className="agent-card" role="region">
      <header>
        <p>Agent Card</p>
        <button aria-label="Close Agent Card" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <h2>
        <DriverMark kind={instance.runtime_type} size={18} /> {instance.display_name ?? agentLabel(node)}
      </h2>
      <dl className="agent-card-facts">
        <div>
          <dt>Principal ID</dt>
          <dd>
            {instance.principal_id}
            {node.own ? " · you" : node.principal?.kind === "anonymous" ? " · anonymous" : ""}
          </dd>
        </div>
        <div>
          <dt>Agent ID</dt>
          <dd>{instance.agent_id ?? "None · untagged"}</dd>
        </div>
        <div>
          <dt>Instance ID</dt>
          <dd>{instance.instance_id}</dd>
        </div>
        <div>
          <dt>Presence</dt>
          <dd>
            {instance.presence === "online"
              ? "Online · heartbeat renewing"
              : instance.heartbeat_state === "never_started"
                ? "Offline · no heartbeat ever received"
                : "Offline · heartbeat stopped"}
          </dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>{describeInstanceRuntime(instance)}</dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd>{`${node.degree} Instance${node.degree === 1 ? "" : "s"} across ${node.sharedRooms} shared Room membership${node.sharedRooms === 1 ? "" : "s"}`}</dd>
        </div>
      </dl>
      {node.principal && !node.own ? <p className="agent-card-note">{node.principal.summary}</p> : null}
      {siblings.length > 0 ? (
        <section aria-label="Same Agent" className="agent-descendants">
          <h3>{node.agent ? `Other Instances of ${node.agent.diagnostic_label}` : "Other Instances of this Principal"}</h3>
          <ol className="instance-list">
            {siblings.map((sibling) => (
              <li key={sibling.instance.instance_id}>
                <button onClick={() => onSelect(sibling.instance.instance_id)} type="button">
                  <code>{sibling.instance.instance_id}</code>
                </button>
                <small>{sibling.instance.presence}</small>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </aside>
  );
}

export function NetworkView() {
  const cardSplit = useSplitWidth({
    defaultWidth: 240,
    maxWidth: 420,
    minWidth: 200,
    storageKey: "sharednet.network.card-width",
  });
  const { network, status } = useSharedNet();
  const [selectedId, setSelectedId] = useState<InstanceId | null>(null);
  const [cardOpen, setCardOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(Math.floor(entry?.contentRect.width ?? 0)));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [network]);
  const graph = useMemo(() => (network ? buildGraph(network) : { nodes: [], edges: [] }), [network]);
  const layout = useMemo(() => layoutGraph(graph.nodes, graph.edges, stageWidth), [graph, stageWidth]);
  useEffect(() => {
    if (!selectedId || !stageRef.current) return;
    const element = stageRef.current.querySelector<HTMLElement>(`[data-instance-id="${selectedId}"]`);
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center", inline: "center" });
  }, [selectedId, layout]);
  const selected = graph.nodes.find((node) => node.instance.instance_id === selectedId) ?? null;

  function select(id: InstanceId) {
    setSelectedId(id);
    setCardOpen(true);
  }

  function search(value: string, submitted: boolean) {
    setQuery(value);
    const found = findInstance(graph.nodes, value);
    if (found) {
      select(found.instance.instance_id);
      setSearchNote(null);
    } else if (submitted && value.trim().length > 0) {
      setSearchNote(`No Instance ${value.trim()} in your Network. It is visible here only if it is yours or shares a Room with one of yours.`);
    } else {
      setSearchNote(null);
    }
  }

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

  const siblings = selected
    ? graph.nodes.filter(
        (node) =>
          node.instance.instance_id !== selected.instance.instance_id &&
          node.instance.principal_id === selected.instance.principal_id &&
          node.instance.agent_id === selected.instance.agent_id,
      )
    : [];
  const highlighted = new Set<InstanceId>(
    selected ? [selected.instance.instance_id, ...graph.edges.flatMap((edge) => (edge.source === selected.instance.instance_id ? [edge.target] : edge.target === selected.instance.instance_id ? [edge.source] : []))] : [],
  );

  return (
    <div className="network-surface">
      {status !== "ready" ? (
        <p className="network-freshness" role="status">
          {status === "loading" ? "Refreshing SharedNet…" : "SharedNet data may be out of date."}
        </p>
      ) : null}

      <div className="network-workspace" data-card-state={selected ? (cardOpen ? "open" : "closed") : "empty"} style={cardSplit.style}>
        {selected && cardOpen ? (
          <>
            <InstanceCard node={selected} onClose={() => setCardOpen(false)} onSelect={select} siblings={siblings} />
            <SplitHandle label="Resize Agent Card" split={cardSplit} />
          </>
        ) : selected ? (
          <button aria-label="Open Agent Card" className="agent-card-open" onClick={() => setCardOpen(true)} type="button">
            Agent Card →
          </button>
        ) : null}

        <section aria-label="Relationship graph" className="relationship-graph">
          <header className="graph-toolbar">
            <form
              aria-label="Find an Instance"
              className="graph-search"
              onSubmit={(event) => {
                event.preventDefault();
                search(query, true);
              }}
              role="search"
            >
              <input
                aria-label="Instance ID"
                autoComplete="off"
                onChange={(event) => search(event.target.value, false)}
                placeholder="Find an Instance: i_…"
                spellCheck={false}
                type="search"
                value={query}
              />
              <button type="submit">Find</button>
            </form>
            <p>
              {`${graph.nodes.length} Instance${graph.nodes.length === 1 ? "" : "s"} · ${graph.edges.length} connection${graph.edges.length === 1 ? "" : "s"}`}
            </p>
          </header>
          {searchNote ? (
            <p className="graph-search-note" role="status">
              {searchNote}
            </p>
          ) : null}

          <div className="graph-stage" ref={stageRef}>
            <div className="network-canvas" style={{ height: `${layout.height}px`, width: `${layout.width}px` }}>
              <svg aria-hidden="true" className="relationship-lines" height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width}>
                {graph.edges.map((edge) => {
                  const from = layout.positions.get(edge.source);
                  const to = layout.positions.get(edge.target);
                  if (!from || !to) return null;
                  const lit = selected !== null && (edge.source === selected.instance.instance_id || edge.target === selected.instance.instance_id);
                  return (
                    <line
                      data-edge-kind="room_co_membership"
                      data-lit={lit ? "true" : undefined}
                      data-weight={edge.weight}
                      key={`${edge.source}|${edge.target}`}
                      strokeWidth={1 + Math.min(edge.weight, 4) * 0.75}
                      x1={from.x}
                      x2={to.x}
                      y1={from.y}
                      y2={to.y}
                    />
                  );
                })}
              </svg>

              <ol aria-label="Visible relationships" className="sr-only">
                {graph.edges.map((edge) => (
                  <li key={`${edge.source}|${edge.target}`}>
                    {`room_co_membership: source ${edge.source}; target ${edge.target}; weight ${edge.weight}`}
                  </li>
                ))}
              </ol>

              {graph.nodes.map((node) => {
                const position = layout.positions.get(node.instance.instance_id);
                if (!position) return null;
                const id = node.instance.instance_id;
                return (
                  <button
                    aria-label={`Inspect Instance ${id}`}
                    aria-pressed={selected?.instance.instance_id === id}
                    className="relationship-node"
                    data-agent-id={node.instance.agent_id ?? untaggedGroupId(node.instance.principal_id)}
                    data-instance-id={id}
                    data-layout-x={position.x}
                    data-layout-y={position.y}
                    data-lit={selected === null || highlighted.has(id) ? "true" : "false"}
                    data-presence={node.instance.presence}
                    data-principal={node.own ? "self" : node.principal?.kind === "anonymous" ? "anonymous" : "external"}
                    key={id}
                    onClick={() => select(id)}
                    style={{ left: `${position.x}px`, top: `${position.y}px` }}
                    type="button"
                  >
                    <span aria-hidden="true" className="relationship-node-mark">
                      <DriverMark kind={node.instance.runtime_type} size={16} />
                    </span>
                    <strong>{node.instance.display_name ?? agentLabel(node)}</strong>
                    <code>{id}</code>
                  </button>
                );
              })}

              {graph.nodes.length === 0 ? <p className="principal-empty">No Instances yet. Register one with the CLI, or take a seat in a Room.</p> : null}
            </div>
          </div>

          <footer className="graph-legend" aria-label="Relationship legend">
            <span>
              <i className="legend-self" aria-hidden="true" />
              filled · your Principal
            </span>
            <span>
              <i className="legend-external" aria-hidden="true" />
              outlined · another Principal
            </span>
            <span>
              <i className="legend-anonymous" aria-hidden="true" />
              dashed · anonymous seat
            </span>
            <span>
              <i className="legend-room" aria-hidden="true" />
              line · shared Rooms, thicker for more
            </span>
          </footer>
        </section>
      </div>
    </div>
  );
}
