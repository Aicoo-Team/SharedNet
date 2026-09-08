import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentId,
  AgentProjection,
  InstanceId,
  InstanceProjection,
  NetworkProjection,
  PrincipalId,
  PrincipalProjection,
} from "@/src/sharednet/contracts";

import { NetworkView, buildGraph, describeInstanceRuntime, findInstance, layoutGraph } from "./network-view";

type SharedNetState = ReturnType<(typeof import("@/src/context/sharednet-context"))["useSharedNet"]>;

const contextMocks = vi.hoisted(() => ({ useSharedNet: vi.fn() }));

vi.mock("@/src/context/sharednet-context", () => ({ useSharedNet: contextMocks.useSharedNet }));

const NOW = "2026-09-03T05:12:00+00:00";
const OWN_PRINCIPAL_ID = "p_LKTYW3LByD" as PrincipalId;
const OTHER_PRINCIPAL_ID = "p_RkiSMcCIZl" as PrincipalId;
const GUEST_PRINCIPAL_ID = "p_anonGuest01" as PrincipalId;
const OWN_AGENT_ID = "a_Wdn8m8sB8q" as AgentId;
const OTHER_AGENT_ID = "a_MnlsrBKS5T" as AgentId;
const OWN_A = "i_ownAaaaaaa" as InstanceId;
const OWN_B = "i_ownBbbbbbb" as InstanceId;
const OTHER = "i_otherCcccc" as InstanceId;
const GUEST = "i_guestDdddd" as InstanceId;

function principal(id: PrincipalId, label: string, kind: "human" | "anonymous" = "human"): PrincipalProjection {
  return { created_at: NOW, diagnostic_label: label, kind, principal_id: id, summary: kind === "anonymous" ? "Anonymous Principal · invited by you · bind it with sharednet login" : `${label} account` };
}

function agent(id: AgentId, principalId: PrincipalId, label: string): AgentProjection {
  return { agent_id: id, created_at: NOW, diagnostic_label: label, discoverability: principalId !== OWN_PRINCIPAL_ID, handle: label.toLowerCase(), principal_id: principalId, summary: `Tag @${label.toLowerCase()}` };
}

function instance(id: InstanceId, principalId: PrincipalId, agentId: AgentId | null, overrides: Partial<InstanceProjection> = {}): InstanceProjection {
  return {
    agent_id: agentId, display_name: null, ended_at: null, expires_at: null, instance_id: id, last_seen_at: NOW,
    heartbeat_state: "renewing", runtime_metadata: { cli_version: "0.1.2" }, presence: "online", principal_id: principalId,
    runtime_type: "claude-code", started_at: NOW, status: "online", workspace_label: null, ...overrides,
  };
}

/** Two of my Instances, one of another account, one anonymous guest; all four sat in one Room, and my two also in a second. */
function network(overrides: Partial<NetworkProjection> = {}): NetworkProjection {
  const ids = [OWN_A, OWN_B, OTHER, GUEST];
  const edges: NetworkProjection["edges"] = [];
  for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) edges.push({ kind: "room_co_membership", source_id: ids[i]!, target_id: ids[j]!, weight: 1 });
  edges[0] = { ...edges[0]!, weight: 2 };
  return {
    agents: [agent(OWN_AGENT_ID, OWN_PRINCIPAL_ID, "Reviewer"), agent(OTHER_AGENT_ID, OTHER_PRINCIPAL_ID, "Planner")],
    connected_principals: [principal(OTHER_PRINCIPAL_ID, "Atlantic partner"), principal(GUEST_PRINCIPAL_ID, "claude-code", "anonymous")],
    edges,
    instances: [
      instance(OWN_A, OWN_PRINCIPAL_ID, OWN_AGENT_ID),
      instance(OWN_B, OWN_PRINCIPAL_ID, OWN_AGENT_ID, { presence: "offline", heartbeat_state: "stopped", runtime_type: "codex" }),
      instance(OTHER, OTHER_PRINCIPAL_ID, OTHER_AGENT_ID),
      instance(GUEST, GUEST_PRINCIPAL_ID, null, { display_name: "claude-code", runtime_metadata: { cli_version: "invite", driver_version: "1.0.0", runtime_source: "detected" } }),
    ],
    principal: principal(OWN_PRINCIPAL_ID, "Northstar"),
    ...overrides,
  };
}

function makeState(overrides: Partial<SharedNetState> = {}): SharedNetState {
  const net = overrides.network === undefined ? network() : overrides.network;
  return {
    claimPairing: vi.fn(async () => undefined),
    closeRoom: vi.fn(async () => { throw new Error("closeRoom not stubbed"); }),
    createInvite: vi.fn(async () => { throw new Error("createInvite not stubbed"); }),
    createClaim: vi.fn(async () => { throw new Error("createClaim not stubbed"); }),
    createRoom: vi.fn(async () => { throw new Error("createRoom not stubbed"); }),
    decisions: [], error: null, network: net, principal: net?.principal ?? null,
    refresh: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => { throw new Error("removeMember not stubbed"); }),
    resolveDecision: vi.fn(async () => undefined),
    rooms: [], selectRoom: vi.fn(), selectedRoom: null, selectedRoomId: null, status: "ready",
    ...overrides,
  };
}

function renderNetwork(overrides: Partial<SharedNetState> = {}) {
  const state = makeState(overrides);
  contextMocks.useSharedNet.mockReturnValue(state);
  return { state, ...render(<NetworkView />) };
}

const node = (id: InstanceId) => screen.getByRole("button", { name: `Inspect Instance ${id}` });

describe("SharedNet Network", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("draws one node per visible Instance, with no box around a Principal, and marks whose each is", () => {
    renderNetwork();
    expect(screen.getAllByRole("button", { name: /^Inspect Instance / })).toHaveLength(4);
    expect(screen.queryByRole("group", { name: /^Principal / })).toBeNull();
    expect(node(OWN_A).dataset.principal).toBe("self");
    expect(node(OTHER).dataset.principal).toBe("external");
    expect(node(GUEST).dataset.principal).toBe("anonymous");
    // A guest seat is named by the name it gave; an untagged own seat says so; a tagged one carries its tag.
    expect(node(GUEST)).toHaveTextContent("claude-code");
    expect(node(OWN_A)).toHaveTextContent("Reviewer");
    expect(screen.getByText("4 Instances · 6 connections")).toBeVisible();
  });

  it("joins every pair that shares a Room with one line, weighted by how many Rooms they share", () => {
    const { container } = renderNetwork();
    const lines = container.querySelectorAll('line[data-edge-kind="room_co_membership"]');
    expect(lines).toHaveLength(6);
    const heavy = Array.from(lines).find((line) => line.getAttribute("data-weight") === "2")!;
    expect(Number(heavy.getAttribute("stroke-width"))).toBeGreaterThan(Number(Array.from(lines).find((line) => line.getAttribute("data-weight") === "1")!.getAttribute("stroke-width")));
    const listed = within(screen.getByRole("list", { name: "Visible relationships" })).getAllByRole("listitem").map((item) => item.textContent);
    expect(listed).toContain(`room_co_membership: source ${OWN_A}; target ${OWN_B}; weight 2`);
    // Every line ends on a drawn node.
    const positions = new Map(Array.from(container.querySelectorAll<HTMLElement>("[data-instance-id]")).map((n) => [`${n.dataset.layoutX},${n.dataset.layoutY}`, n.dataset.instanceId]));
    for (const line of Array.from(lines)) {
      expect(positions.has(`${line.getAttribute("x1")},${line.getAttribute("y1")}`)).toBe(true);
      expect(positions.has(`${line.getAttribute("x2")},${line.getAttribute("y2")}`)).toBe(true);
    }
  });

  it("drops an edge whose endpoint is not a visible Instance, and never draws an edge twice", () => {
    const net = network();
    net.edges = [
      ...net.edges,
      { kind: "room_co_membership", source_id: OWN_B, target_id: OWN_A, weight: 5 },
      { kind: "room_co_membership", source_id: OWN_A, target_id: "i_nobody00001" as InstanceId, weight: 1 },
    ];
    const graph = buildGraph(net);
    expect(graph.edges).toHaveLength(6);
    expect(graph.edges.find((edge) => edge.source === OWN_A && edge.target === OWN_B)?.weight).toBe(2);
  });

  it("lays every Instance out at a finite, distinct, on-canvas position, the same way each time", () => {
    const graph = buildGraph(network());
    const first = layoutGraph(graph.nodes, graph.edges);
    const second = layoutGraph(graph.nodes, graph.edges);
    expect(first.positions.size).toBe(4);
    const seen = new Set<string>();
    for (const [id, point] of first.positions) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(first.width);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(first.height);
      expect(seen.has(`${point.x},${point.y}`)).toBe(false);
      seen.add(`${point.x},${point.y}`);
      expect(second.positions.get(id)).toEqual(point);
    }
    // Instances that share Rooms sit closer than a stranger sits to them.
    const d = (a: InstanceId, b: InstanceId) => Math.hypot(first.positions.get(a)!.x - first.positions.get(b)!.x, first.positions.get(a)!.y - first.positions.get(b)!.y);
    expect(d(OWN_A, OWN_B)).toBeLessThan(first.width);
  });

  it("keeps a large Network on one canvas with room for every node", () => {
    const many: InstanceProjection[] = Array.from({ length: 40 }, (_, i) => instance(`i_many${String(i).padStart(6, "0")}` as InstanceId, OWN_PRINCIPAL_ID, null));
    const graph = buildGraph(network({ instances: many, edges: [], connected_principals: [] }));
    const layout = layoutGraph(graph.nodes, graph.edges);
    expect(layout.positions.size).toBe(40);
    expect(layout.width).toBeGreaterThan(900);
    const minGap = Math.min(...graph.nodes.flatMap((a, i) => graph.nodes.slice(i + 1).map((b) => Math.hypot(layout.positions.get(a.instance.instance_id)!.x - layout.positions.get(b.instance.instance_id)!.x, layout.positions.get(a.instance.instance_id)!.y - layout.positions.get(b.instance.instance_id)!.y))));
    expect(minGap).toBeGreaterThan(20);
  });

  it("opens the Agent Card for the Instance clicked, ids in order, with its connections and its siblings", () => {
    renderNetwork();
    fireEvent.click(node(OWN_A));
    const card = screen.getByRole("region", { name: "Agent Card" });
    const terms = within(card).getAllByRole("term").map((term) => term.textContent);
    expect(terms.slice(0, 3)).toEqual(["Principal ID", "Agent ID", "Instance ID"]);
    expect(within(card).getByText(`${OWN_PRINCIPAL_ID} · you`)).toBeVisible();
    expect(within(card).getByText(OWN_AGENT_ID)).toBeVisible();
    expect(within(card).getByText(OWN_A)).toBeVisible();
    expect(within(card).getByText("3 Instances across 4 shared Room memberships")).toBeVisible();
    // The sibling under the same tag is one click away.
    fireEvent.click(within(card).getByRole("button", { name: OWN_B }));
    expect(within(screen.getByRole("region", { name: "Agent Card" })).getByText(OWN_B)).toBeVisible();
    expect(node(OWN_B)).toHaveAttribute("aria-pressed", "true");
    // Selecting dims what the selection is not connected to; here everything is.
    expect(node(OTHER).dataset.lit).toBe("true");
  });

  it("says None for an untagged Instance and names an anonymous seat's Principal as such", () => {
    renderNetwork();
    fireEvent.click(node(GUEST));
    const card = screen.getByRole("region", { name: "Agent Card" });
    expect(within(card).getByText("None · untagged")).toBeVisible();
    expect(within(card).getByText(`${GUEST_PRINCIPAL_ID} · anonymous`)).toBeVisible();
    expect(within(card).getByText(/bind it with sharednet login/)).toBeVisible();
    expect(within(card).getByText("claude-code 1.0.0 · detected")).toBeVisible();
  });

  it("finds an Instance by id, or by a unique prefix, and opens its card; says so when there is none", () => {
    renderNetwork();
    const input = screen.getByRole("searchbox", { name: "Instance ID" });
    fireEvent.change(input, { target: { value: "i_other" } });
    expect(node(OTHER)).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("region", { name: "Agent Card" })).getByText(OTHER)).toBeVisible();
    fireEvent.change(input, { target: { value: "i_own" } });
    // Two matches: nothing changes until the id is unambiguous.
    expect(node(OTHER)).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(input, { target: { value: OWN_B } });
    expect(node(OWN_B)).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(input, { target: { value: "i_nowhere0001" } });
    fireEvent.submit(screen.getByRole("search", { name: "Find an Instance" }));
    expect(screen.getByRole("status")).toHaveTextContent("No Instance i_nowhere0001 in your Network");
    expect(findInstance(buildGraph(network()).nodes, "")).toBeNull();
  });

  it("renders an empty Network without inventing anything, and the loading and unavailable states", () => {
    renderNetwork({ network: network({ instances: [], edges: [], agents: [], connected_principals: [] }) });
    expect(screen.queryAllByRole("button", { name: /^Inspect Instance / })).toHaveLength(0);
    expect(screen.getByText(/No Instances yet/)).toBeVisible();
    cleanup();
    renderNetwork({ network: null, status: "loading" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading Network…");
    cleanup();
    renderNetwork({ network: null, status: "stale" });
    expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable.");
  });

  it("keeps last-good Network data visible while marking it stale", () => {
    renderNetwork({ status: "stale" });
    expect(screen.getByRole("status")).toHaveTextContent("SharedNet data may be out of date.");
    expect(screen.getAllByRole("button", { name: /^Inspect Instance / })).toHaveLength(4);
  });

  it("never presents delegation, hosting, readiness, activity, or recruitment claims", () => {
    renderNetwork();
    for (const banned of [/delegat/i, /hosting/i, /ready to/i, /activity/i, /recruit/i, /verification/i]) {
      expect(screen.queryByText(banned)).toBeNull();
    }
  });

  it("describes an Instance's driver from its runtime report, and never shows the invite placeholder as a version", () => {
    expect(describeInstanceRuntime(instance(OWN_A, OWN_PRINCIPAL_ID, null, { runtime_type: "codex", runtime_metadata: { cli_version: "0.1.2", runtime_source: "detected", entrypoint: "cli" } }))).toBe("codex 0.1.2 · cli · detected");
    expect(describeInstanceRuntime(instance(OWN_A, OWN_PRINCIPAL_ID, null, { runtime_type: "claude-code", runtime_metadata: { cli_version: "invite" } }))).toBe("claude-code · not reported");
    expect(describeInstanceRuntime(instance(OWN_A, OWN_PRINCIPAL_ID, null, { runtime_type: "custom", runtime_metadata: { cli_version: "invite", driver_version: "2.0", runtime_source: "declared" } }))).toBe("custom 2.0 · self-declared");
  });
});
