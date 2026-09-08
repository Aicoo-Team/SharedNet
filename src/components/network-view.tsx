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
  /** The same, each Room weighted by its size: what the layout and the card call weighted connections. */
  strength: number;
}>;

type GraphEdge = Readonly<{ source: InstanceId; target: InstanceId; weight: number; strength: number }>;

/** What the layout needs of a node: an id, and a group it should sit near. */
type LayoutNode = Readonly<{ id: string; group: string }>;
type LayoutEdge = Readonly<{ source: string; target: string; strength: number }>;

/** The Principal level: one node per Principal, one line per pair whose Instances share Rooms. */
type PrincipalNode = Readonly<{
  principal: PrincipalProjection;
  own: boolean;
  instances: number;
  online: number;
  degree: number;
  sharedRooms: number;
  strength: number;
}>;
type PrincipalEdge = Readonly<{ source: PrincipalId; target: PrincipalId; weight: number; strength: number }>;

/** mine: your own sessions and how they connect; principals: who you are tied to; instances: one Principal's seats and what they touch. */
type Level = "mine" | "principals" | "instances";

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
    edges.push({ source: a, target: b, weight: Math.max(1, Math.floor(edge.weight)), strength: Math.max(0, edge.strength) });
  }
  const degree = new Map<InstanceId, number>();
  const shared = new Map<InstanceId, number>();
  const strength = new Map<InstanceId, number>();
  for (const edge of edges) {
    for (const end of [edge.source, edge.target]) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
      shared.set(end, (shared.get(end) ?? 0) + edge.weight);
      strength.set(end, (strength.get(end) ?? 0) + edge.strength);
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
        strength: strength.get(instance.instance_id) ?? 0,
      }),
    );
  return { nodes, edges };
}

/** The Principal level, folded from the Instance graph: a line's weight is every shared Room between the two sides' Instances. */
export function buildPrincipalGraph(network: NetworkProjection, graph: { nodes: GraphNode[]; edges: GraphEdge[] }): { nodes: PrincipalNode[]; edges: PrincipalEdge[] } {
  const owner = new Map(graph.nodes.map((node) => [node.instance.instance_id, node.instance.principal_id]));
  const weights = new Map<string, PrincipalEdge>();
  for (const edge of graph.edges) {
    const a = owner.get(edge.source);
    const b = owner.get(edge.target);
    if (!a || !b || a === b) continue;
    const [source, target] = [a, b].sort(compareIds) as [PrincipalId, PrincipalId];
    const key = `${source}|${target}`;
    const existing = weights.get(key);
    weights.set(key, existing ? { ...existing, weight: existing.weight + edge.weight, strength: existing.strength + edge.strength } : { source, target, weight: edge.weight, strength: edge.strength });
  }
  const edges = [...weights.values()].sort((left, right) => compareIds(`${left.source}|${left.target}`, `${right.source}|${right.target}`));
  const degree = new Map<PrincipalId, number>();
  const shared = new Map<PrincipalId, number>();
  const strength = new Map<PrincipalId, number>();
  for (const edge of edges) {
    for (const end of [edge.source, edge.target]) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
      shared.set(end, (shared.get(end) ?? 0) + edge.weight);
      strength.set(end, (strength.get(end) ?? 0) + edge.strength);
    }
  }
  const principals = [network.principal, ...network.connected_principals];
  const nodes = principals
    .sort((left, right) => compareIds(left.principal_id, right.principal_id))
    .map((principal): PrincipalNode => {
      const mine = graph.nodes.filter((node) => node.instance.principal_id === principal.principal_id);
      return {
        principal,
        own: principal.principal_id === network.principal.principal_id,
        instances: mine.length,
        online: mine.filter((node) => node.instance.presence === "online").length,
        degree: degree.get(principal.principal_id) ?? 0,
        sharedRooms: shared.get(principal.principal_id) ?? 0,
        strength: strength.get(principal.principal_id) ?? 0,
      };
    });
  return { nodes, edges };
}

/** The Instance level seen from one Principal: its Instances and every Instance directly connected to them. */
export function instancesAround(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, principalId: PrincipalId): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const mine = new Set(graph.nodes.filter((node) => node.instance.principal_id === principalId).map((node) => node.instance.instance_id));
  const keep = new Set(mine);
  for (const edge of graph.edges) {
    if (mine.has(edge.source)) keep.add(edge.target);
    if (mine.has(edge.target)) keep.add(edge.source);
  }
  return {
    nodes: graph.nodes.filter((node) => keep.has(node.instance.instance_id)),
    edges: graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
  };
}

/**
 * A force layout, run to rest before render: nodes repel, shared Rooms pull,
 * Instances of one Principal drift together, and everything is drawn toward
 * the middle so islands stay on the canvas. Deterministic: the same ids
 * start from the same places and settle in the same ones.
 */
/** Rounded to a tenth, for a card. */
function weighted(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

const RING_SPACING = 120;
const RING_GAP = 170;
/** A ring holds this many before the tier spills onto the next ring out. */
const RING_CAPACITY = 28;

/**
 * An ego layout, drawn to rest in one pass. The Network is always seen from
 * somewhere: the viewer's Principal, or the Principal drilled into. That
 * "ego" sits in the middle (one node, or its Instances on a small circle),
 * and everyone else stands on rings by how strongly they are tied to it:
 * the strongly tied on the inner ring, the weakly tied on the next, those
 * with no direct tie on the outer one, each ring in order of strength and
 * then id. Deterministic, readable at forty nodes and at four hundred, and
 * a ring is wide enough that its labels do not touch.
 */
export function layoutGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  ego: readonly string[] = [],
): { positions: Map<string, Point>; width: number; height: number } {
  const positions = new Map<string, Point>();
  const ids = new Set(nodes.map((node) => node.id));
  const centreIds = ego.filter((id) => ids.has(id));
  const centreSet = new Set(centreIds);
  if (nodes.length === 0) return { positions, width: MIN_CANVAS, height: MIN_CANVAS };

  // How strongly each outer node is tied to the ego.
  const pull = new Map<string, number>();
  for (const edge of edges) {
    if (centreSet.has(edge.source) && !centreSet.has(edge.target)) pull.set(edge.target, (pull.get(edge.target) ?? 0) + edge.strength);
    if (centreSet.has(edge.target) && !centreSet.has(edge.source)) pull.set(edge.source, (pull.get(edge.source) ?? 0) + edge.strength);
  }
  const outer = nodes.filter((node) => !centreSet.has(node.id));
  const strongest = Math.max(0, ...outer.map((node) => pull.get(node.id) ?? 0));
  const tier = (id: string): number => {
    const value = pull.get(id) ?? 0;
    if (value <= 0) return 2;
    return value >= strongest * 0.5 ? 0 : 1;
  };
  const rings: LayoutNode[][] = [[], [], []];
  for (const node of outer) rings[tier(node.id)]!.push(node);
  for (const ring of rings) ring.sort((left, right) => (pull.get(right.id) ?? 0) - (pull.get(left.id) ?? 0) || compareIds(left.id, right.id));

  // The ego: one node in the middle, or its Instances on a small circle.
  const innerRadius = centreIds.length <= 1 ? 0 : Math.max(48, (centreIds.length * RING_SPACING) / (2 * Math.PI));
  let radius = innerRadius;
  const placed: Array<{ ring: LayoutNode[]; radius: number; offset: number }> = [];
  rings.forEach((tierNodes, index) => {
    // A crowded tier spills over several rings rather than one enormous one.
    for (let from = 0; from < tierNodes.length; from += RING_CAPACITY) {
      const ring = tierNodes.slice(from, from + RING_CAPACITY);
      radius = Math.max(radius + RING_GAP, (ring.length * RING_SPACING) / (2 * Math.PI));
      placed.push({ ring, radius, offset: index * 0.35 + (from / RING_CAPACITY) * 0.11 });
    }
  });
  const extent = (placed.at(-1)?.radius ?? innerRadius) + RING_GAP * 0.6;
  const side = Math.max(MIN_CANVAS, Math.round(extent * 2));
  const centre = { x: side / 2, y: side / 2 };
  [...centreIds].sort(compareIds).forEach((id, i) => {
    if (centreIds.length === 1) {
      positions.set(id, { x: Math.round(centre.x), y: Math.round(centre.y) });
      return;
    }
    const angle = -Math.PI / 2 + (i / centreIds.length) * Math.PI * 2;
    positions.set(id, { x: Math.round(centre.x + Math.cos(angle) * innerRadius), y: Math.round(centre.y + Math.sin(angle) * innerRadius) });
  });
  for (const { ring, radius: r, offset } of placed) {
    ring.forEach((node, i) => {
      const angle = -Math.PI / 2 + offset + (i / ring.length) * Math.PI * 2;
      positions.set(node.id, { x: Math.round(centre.x + Math.cos(angle) * r), y: Math.round(centre.y + Math.sin(angle) * r) });
    });
  }
  return { positions, width: side, height: side };
}

/**
 * Your own sessions, on one ring in the order given (tag, then id, so the
 * sessions of one Agent sit together), every line among them drawn. A small
 * graph read as a chord diagram, which is what "how do my sessions connect"
 * asks for.
 */
export function layoutRing(ids: readonly string[]): { positions: Map<string, Point>; width: number; height: number } {
  const positions = new Map<string, Point>();
  if (ids.length === 0) return { positions, width: MIN_CANVAS, height: MIN_CANVAS };
  const radius = ids.length === 1 ? 0 : Math.max(140, (ids.length * RING_SPACING) / (2 * Math.PI));
  const side = Math.max(MIN_CANVAS, Math.round((radius + RING_GAP * 0.6) * 2));
  const centre = { x: side / 2, y: side / 2 };
  ids.forEach((id, i) => {
    const angle = -Math.PI / 2 + (i / ids.length) * Math.PI * 2;
    positions.set(id, { x: Math.round(centre.x + Math.cos(angle) * radius), y: Math.round(centre.y + Math.sin(angle) * radius) });
  });
  return { positions, width: side, height: side };
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
        <div>
          <dt>Weighted</dt>
          <dd>{`${weighted(node.strength)} · each Room counts 1/(members − 1)`}</dd>
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

function PrincipalCard({ node, onClose, onOpen }: { node: PrincipalNode; onClose: () => void; onOpen: () => void }) {
  const { principal } = node;
  return (
    <aside aria-label="Agent Card" className="agent-card" role="region">
      <header>
        <p>Principal Card</p>
        <button aria-label="Close Agent Card" onClick={onClose} type="button">
          ×
        </button>
      </header>
      <h2>{principal.diagnostic_label}</h2>
      <dl className="agent-card-facts">
        <div>
          <dt>Principal ID</dt>
          <dd>
            {principal.principal_id}
            {node.own ? " · you" : principal.kind === "anonymous" ? " · anonymous" : ""}
          </dd>
        </div>
        <div>
          <dt>Instances</dt>
          <dd>{`${node.instances} · ${node.online} online`}</dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd>{`${node.degree} Principal${node.degree === 1 ? "" : "s"} across ${node.sharedRooms} shared Room membership${node.sharedRooms === 1 ? "" : "s"}`}</dd>
        </div>
        <div>
          <dt>Weighted</dt>
          <dd>{`${weighted(node.strength)} · each Room counts 1/(members − 1)`}</dd>
        </div>
      </dl>
      {!node.own ? <p className="agent-card-note">{principal.summary}</p> : null}
      <button className="agent-card-drill" onClick={onOpen} type="button">
        {`Open its ${node.instances} Instance${node.instances === 1 ? "" : "s"} →`}
      </button>
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
  const [level, setLevel] = useState<Level>("principals");
  const [focus, setFocus] = useState<PrincipalId | null>(null);
  // Instances level: the ego's own Instances and what they touch, or everyone.
  const [everyone, setEveryone] = useState(false);
  const [selectedPrincipalId, setSelectedPrincipalId] = useState<PrincipalId | null>(null);
  const [selectedId, setSelectedId] = useState<InstanceId | null>(null);
  const [cardOpen, setCardOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // The view: a scale and an offset over the canvas. Wheel zooms around the
  // pointer, dragging the stage pans, Fit puts the whole canvas back.
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((current) => {
        const scale = Math.min(4, Math.max(0.25, current.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
        const ratio = scale / current.scale;
        return { scale, tx: px - (px - current.tx) * ratio, ty: py - (py - current.ty) * ratio };
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [network]);
  const whole = useMemo(() => (network ? buildGraph(network) : { nodes: [], edges: [] }), [network]);
  const principalGraph = useMemo(() => (network ? buildPrincipalGraph(network, whole) : { nodes: [], edges: [] }), [network, whole]);
  // The Instance level is always seen from one Principal: the one drilled into, or your own.
  const focusPrincipal = focus ?? network?.principal.principal_id ?? null;
  // Mine: your own Instances and the lines among them, in tag order.
  const mine = useMemo(() => {
    if (!network) return { nodes: [], edges: [] };
    const own = new Set(whole.nodes.filter((node) => node.instance.principal_id === network.principal.principal_id).map((node) => node.instance.instance_id));
    return {
      nodes: whole.nodes
        .filter((node) => own.has(node.instance.instance_id))
        .sort((left, right) => compareIds(left.instance.agent_id ?? "~", right.instance.agent_id ?? "~") || compareIds(left.instance.instance_id, right.instance.instance_id)),
      edges: whole.edges.filter((edge) => own.has(edge.source) && own.has(edge.target)),
    };
  }, [whole, network]);
  const graph = useMemo(
    () => (level === "mine" ? mine : focusPrincipal && !everyone ? instancesAround(whole, focusPrincipal) : whole),
    [level, mine, whole, focusPrincipal, everyone],
  );
  const layout = useMemo(
    () =>
      level === "mine"
        ? layoutRing(graph.nodes.map((node) => node.instance.instance_id))
        : level === "principals"
        ? layoutGraph(
            principalGraph.nodes.map((node) => ({ id: node.principal.principal_id, group: node.principal.principal_id })),
            principalGraph.edges,
            network ? [network.principal.principal_id] : [],
          )
        : layoutGraph(
            graph.nodes.map((node) => ({ id: node.instance.instance_id, group: node.instance.principal_id })),
            graph.edges,
            graph.nodes.filter((node) => node.instance.principal_id === focusPrincipal).map((node) => node.instance.instance_id),
          ),
    [level, principalGraph, graph, network, focusPrincipal],
  );
  function zoomBy(factor: number) {
    const stage = stageRef.current;
    const px = stage ? stage.clientWidth / 2 : 0;
    const py = stage ? stage.clientHeight / 2 : 0;
    setView((current) => {
      const scale = Math.min(4, Math.max(0.25, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, tx: px - (px - current.tx) * ratio, ty: py - (py - current.ty) * ratio };
    });
  }
  function fitView() {
    const stage = stageRef.current;
    if (!stage || stage.clientHeight === 0) {
      setView({ scale: 1, tx: 0, ty: 0 });
      return;
    }
    const scale = Math.min(1, stage.clientWidth / layout.width, stage.clientHeight / layout.height);
    setView({ scale, tx: (stage.clientWidth - layout.width * scale) / 2, ty: (stage.clientHeight - layout.height * scale) / 2 });
  }
  // A fresh layout (new data, a new level, a resized stage) starts fitted.
  useEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);
  // A selection made by search or by drilling down is brought to the middle of the stage.
  useEffect(() => {
    const stage = stageRef.current;
    const id = level === "principals" ? selectedPrincipalId : selectedId;
    if (!stage || !id || stage.clientHeight === 0) return;
    const point = layout.positions.get(id);
    if (!point) return;
    setView((current) => ({ ...current, tx: stage.clientWidth / 2 - point.x * current.scale, ty: stage.clientHeight / 2 - point.y * current.scale }));
  }, [selectedId, selectedPrincipalId, level, layout]);
  const selected = level !== "principals" ? (graph.nodes.find((node) => node.instance.instance_id === selectedId) ?? null) : null;
  const selectedPrincipal = level === "principals" ? (principalGraph.nodes.find((node) => node.principal.principal_id === selectedPrincipalId) ?? null) : null;

  function select(id: InstanceId) {
    setSelectedId(id);
    setCardOpen(true);
  }

  function selectPrincipal(id: PrincipalId) {
    setSelectedPrincipalId(id);
    setCardOpen(true);
  }

  /** Down to one Principal's Instances. */
  function drillInto(id: PrincipalId) {
    setFocus(id);
    setLevel("instances");
    setSelectedId(null);
    setCardOpen(true);
  }

  function search(value: string, submitted: boolean) {
    setQuery(value);
    const needle = value.trim();
    if (needle.startsWith("p_")) {
      const hit = principalGraph.nodes.find((node) => node.principal.principal_id === needle) ?? (principalGraph.nodes.filter((node) => node.principal.principal_id.startsWith(needle)).length === 1 ? principalGraph.nodes.find((node) => node.principal.principal_id.startsWith(needle))! : null);
      if (hit) {
        setLevel("principals");
        selectPrincipal(hit.principal.principal_id);
        setSearchNote(null);
        return;
      }
      setSearchNote(submitted ? `No Principal ${needle} in your Network. A Principal is here only when one of its Instances shares a Room with one of yours.` : null);
      return;
    }
    const found = findInstance(whole.nodes, needle);
    if (found) {
      // An Instance id opens the Instance level, seen from its own Principal.
      setFocus(found.instance.principal_id);
      setLevel("instances");
      select(found.instance.instance_id);
      setSearchNote(null);
    } else if (submitted && needle.length > 0) {
      setSearchNote(`No Instance ${needle} in your Network. It is visible here only if it is yours or shares a Room with one of yours.`);
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
  // Lines are drawn from the ego outward always; a line between two outer
  // nodes only when one of them is selected. Otherwise a crowded Room, which
  // ties every pair, is a hairball.
  const egoInstances = new Set(graph.nodes.filter((node) => node.instance.principal_id === focusPrincipal).map((node) => node.instance.instance_id));
  const instanceEdgeShown = (edge: GraphEdge) =>
    level === "mine" ||
    egoInstances.has(edge.source) ||
    egoInstances.has(edge.target) ||
    (selected !== null && (edge.source === selected.instance.instance_id || edge.target === selected.instance.instance_id));
  const egoPrincipal = network.principal.principal_id;
  const principalEdgeShown = (edge: PrincipalEdge) =>
    edge.source === egoPrincipal || edge.target === egoPrincipal || (selectedPrincipal !== null && (edge.source === selectedPrincipal.principal.principal_id || edge.target === selectedPrincipal.principal.principal_id));

  return (
    <div className="network-surface">
      {status !== "ready" ? (
        <p className="network-freshness" role="status">
          {status === "loading" ? "Refreshing SharedNet…" : "SharedNet data may be out of date."}
        </p>
      ) : null}

      <div className="network-workspace" data-card-state={selected || selectedPrincipal ? (cardOpen ? "open" : "closed") : "empty"} style={cardSplit.style}>
        {selected && cardOpen ? (
          <>
            <InstanceCard node={selected} onClose={() => setCardOpen(false)} onSelect={select} siblings={siblings} />
            <SplitHandle label="Resize Agent Card" split={cardSplit} />
          </>
        ) : selectedPrincipal && cardOpen ? (
          <>
            <PrincipalCard node={selectedPrincipal} onClose={() => setCardOpen(false)} onOpen={() => drillInto(selectedPrincipal.principal.principal_id)} />
            <SplitHandle label="Resize Agent Card" split={cardSplit} />
          </>
        ) : selected || selectedPrincipal ? (
          <button aria-label="Open Agent Card" className="agent-card-open" onClick={() => setCardOpen(true)} type="button">
            Agent Card →
          </button>
        ) : null}

        <section aria-label="Relationship graph" className="relationship-graph">
          <div className="graph-top">
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
            <div className="graph-level" role="tablist" aria-label="Level">
              <button aria-selected={level === "mine"} onClick={() => setLevel("mine")} role="tab" type="button">
                Mine
              </button>
              <button aria-selected={level === "principals"} onClick={() => setLevel("principals")} role="tab" type="button">
                Principals
              </button>
              <button aria-selected={level === "instances"} onClick={() => setLevel("instances")} role="tab" type="button">
                Instances
              </button>
            </div>
            <div className="graph-zoom" role="group" aria-label="Zoom">
              <button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)} type="button">
                −
              </button>
              <button aria-label="Zoom in" onClick={() => zoomBy(1.25)} type="button">
                +
              </button>
              <button aria-label="Fit the whole graph" onClick={fitView} type="button">
                Fit
              </button>
            </div>
            <p>
              {level === "principals"
                ? `${principalGraph.nodes.length} Principal${principalGraph.nodes.length === 1 ? "" : "s"} · ${principalGraph.edges.length} connection${principalGraph.edges.length === 1 ? "" : "s"}`
                : level === "mine"
                  ? `${graph.nodes.length} of your session${graph.nodes.length === 1 ? "" : "s"} · ${graph.edges.length} connection${graph.edges.length === 1 ? "" : "s"} among them`
                  : `${graph.nodes.length} Instance${graph.nodes.length === 1 ? "" : "s"} · ${graph.edges.length} connection${graph.edges.length === 1 ? "" : "s"}`}
            </p>
          </header>
          {level === "instances" ? (
            <nav aria-label="Where you are" className="graph-crumbs">
              <button onClick={() => { setLevel("principals"); setFocus(null); setSelectedId(null); }} type="button">
                All Principals
              </button>
              <span aria-hidden="true">›</span>
              <span>
                {everyone
                  ? `everyone · every Instance in your Network, seen from ${focusPrincipal === network.principal.principal_id ? "you" : focusPrincipal}`
                  : `${focusPrincipal === network.principal.principal_id ? "your" : ""} ${focusPrincipal} · its Instances and what they connect to`.trim()}
              </span>
              <span aria-hidden="true">·</span>
              <button aria-pressed={everyone} onClick={() => setEveryone((current) => !current)} type="button">
                {everyone ? "Only what this Principal touches" : "Everyone"}
              </button>
            </nav>
          ) : null}
          {searchNote ? (
            <p className="graph-search-note" role="status">
              {searchNote}
            </p>
          ) : null}
          </div>

          <div
            className="graph-stage"
            data-dragging={drag.current !== null ? "true" : undefined}
            onClickCapture={(event) => {
              // A drag that ends on a node is not a click on it.
              if (drag.current?.moved) {
                event.stopPropagation();
                event.preventDefault();
              }
              drag.current = null;
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              drag.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty, moved: false };
            }}
            onPointerLeave={() => {
              drag.current = null;
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start) return;
              const ddx = event.clientX - start.x;
              const ddy = event.clientY - start.y;
              if (!start.moved && Math.hypot(ddx, ddy) < 4) return;
              start.moved = true;
              setView((current) => ({ ...current, tx: start.tx + ddx, ty: start.ty + ddy }));
            }}
            onPointerUp={() => {
              if (drag.current && !drag.current.moved) drag.current = null;
            }}
            ref={stageRef}
          >
            <div
              className="network-canvas"
              data-scale={view.scale.toFixed(2)}
              data-tx={Math.round(view.tx)}
              data-ty={Math.round(view.ty)}
              style={{ height: `${layout.height}px`, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, transformOrigin: "0 0", width: `${layout.width}px` }}
            >
              <svg aria-hidden="true" className="relationship-lines" height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width}>
                {level === "principals"
                  ? principalGraph.edges.filter(principalEdgeShown).map((edge) => {
                      const from = layout.positions.get(edge.source);
                      const to = layout.positions.get(edge.target);
                      if (!from || !to) return null;
                      const lit = selectedPrincipal !== null && (edge.source === selectedPrincipal.principal.principal_id || edge.target === selectedPrincipal.principal.principal_id);
                      return <line data-edge-kind="principal_connection" data-lit={lit ? "true" : undefined} data-strength={edge.strength.toFixed(3)} data-weight={edge.weight} key={`${edge.source}|${edge.target}`} strokeOpacity={0.25 + Math.min(edge.strength, 2) * 0.35} strokeWidth={1 + Math.min(edge.strength, 3) * 1.2} x1={from.x} x2={to.x} y1={from.y} y2={to.y} />;
                    })
                  : graph.edges.filter(instanceEdgeShown).map((edge) => {
                  const from = layout.positions.get(edge.source);
                  const to = layout.positions.get(edge.target);
                  if (!from || !to) return null;
                  const lit = selected !== null && (edge.source === selected.instance.instance_id || edge.target === selected.instance.instance_id);
                  return (
                    <line
                      data-edge-kind="room_co_membership"
                      data-lit={lit ? "true" : undefined}
                      data-strength={edge.strength.toFixed(3)}
                      data-weight={edge.weight}
                      key={`${edge.source}|${edge.target}`}
                      strokeOpacity={0.25 + Math.min(edge.strength, 2) * 0.35}
                      strokeWidth={1 + Math.min(edge.strength, 3) * 1.2}
                      x1={from.x}
                      x2={to.x}
                      y1={from.y}
                      y2={to.y}
                    />
                  );
                })}
              </svg>

              <ol aria-label="Visible relationships" className="sr-only">
                {level === "principals"
                  ? principalGraph.edges.map((edge) => (
                      <li key={`${edge.source}|${edge.target}`}>{`principal_connection: source ${edge.source}; target ${edge.target}; weight ${edge.weight}; strength ${edge.strength.toFixed(3)}`}</li>
                    ))
                  : graph.edges.map((edge) => (
                      <li key={`${edge.source}|${edge.target}`}>{`room_co_membership: source ${edge.source}; target ${edge.target}; weight ${edge.weight}; strength ${edge.strength.toFixed(3)}`}</li>
                    ))}
              </ol>

              {level === "principals"
                ? principalGraph.nodes.map((node) => {
                    const id = node.principal.principal_id;
                    const position = layout.positions.get(id);
                    if (!position) return null;
                    const connected = selectedPrincipal === null || selectedPrincipal.principal.principal_id === id || principalGraph.edges.some((edge) => (edge.source === id && edge.target === selectedPrincipal.principal.principal_id) || (edge.target === id && edge.source === selectedPrincipal.principal.principal_id));
                    return (
                      <button
                        aria-label={`Inspect Principal ${id}`}
                        aria-pressed={selectedPrincipal?.principal.principal_id === id}
                        className="relationship-node relationship-principal"
                        data-layout-x={position.x}
                        data-layout-y={position.y}
                        data-lit={connected ? "true" : "false"}
                        data-principal={node.own ? "self" : node.principal.kind === "anonymous" ? "anonymous" : "external"}
                        data-principal-id={id}
                        key={id}
                        onClick={() => selectPrincipal(id)}
                        onDoubleClick={() => drillInto(id)}
                        style={{ left: `${position.x}px`, top: `${position.y}px` }}
                        type="button"
                      >
                        <span aria-hidden="true" className="relationship-node-mark" style={{ height: `${44 + Math.min(node.instances, 12) * 4}px`, width: `${44 + Math.min(node.instances, 12) * 4}px` }}>
                          {node.instances}
                        </span>
                        <strong>{node.own ? "You" : node.principal.diagnostic_label}</strong>
                        <code>{id}</code>
                      </button>
                    );
                  })
                : graph.nodes.map((node) => {
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
                      <DriverMark kind={node.instance.runtime_type} size={24} />
                    </span>
                    <strong>{node.instance.display_name ?? agentLabel(node)}</strong>
                    <code>{id}</code>
                  </button>
                );
              })}

              {level !== "principals" && graph.nodes.length === 0 ? <p className="principal-empty">No Instances yet. Register one with the CLI, or take a seat in a Room.</p> : null}
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
              line · shared Rooms weighted by Room size, thicker for stronger; lines between others show when one is selected
            </span>
          </footer>
        </section>
      </div>
    </div>
  );
}
