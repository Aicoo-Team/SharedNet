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
  RuntimeId,
  RuntimeProjection,
} from "@/src/sharednet/contracts";

import { NetworkView } from "./network-view";

type SharedNetState = ReturnType<
  (typeof import("@/src/context/sharednet-context"))["useSharedNet"]
>;

const contextMocks = vi.hoisted(() => ({
  useSharedNet: vi.fn(),
}));

vi.mock("@/src/context/sharednet-context", () => ({
  useSharedNet: contextMocks.useSharedNet,
}));

const NOW = "2026-09-03T05:12:00+00:00";
const OWN_PRINCIPAL_ID = "p_7Hq2Lm9XsA" as PrincipalId;
const CONNECTED_PRINCIPAL_ID = "p_4Nv8Qk1RtB" as PrincipalId;
const SECOND_CONNECTED_PRINCIPAL_ID = "p_9Za3Wp6UcC" as PrincipalId;
const UNKNOWN_PRINCIPAL_ID = "p_5Jd9Fy2VeD" as PrincipalId;
const OWN_AGENT_ID = "a_2Kx7Vm4QpD" as AgentId;
const SECOND_OWN_AGENT_ID = "a_8Rt1Hs6ZnE" as AgentId;
const CONNECTED_AGENT_ID = "a_3Bw9Lc5YfF" as AgentId;
const PRIVATE_AGENT_ID = "a_6Pg2Jm8XuG" as AgentId;
const UNKNOWN_AGENT_ID = "a_1Qv7Nd4SkH" as AgentId;
const FIRST_RUNTIME_ID = "r_6Lb3Tn8HsE" as RuntimeId;
const SECOND_RUNTIME_ID = "r_9Wc4Kp1ZaF" as RuntimeId;
const ORPHAN_RUNTIME_ID = "r_2Gm7Vx5QdG" as RuntimeId;
const OTHER_RUNTIME_ID = "r_8Sr1Bj6NeH" as RuntimeId;
const FIRST_INSTANCE_ID = "i_4Tf9Mn2YwJ" as InstanceId;
const SECOND_INSTANCE_ID = "i_7Cx3Lp8RaK" as InstanceId;
const ORPHAN_INSTANCE_ID = "i_5Zh1Qv6DsL" as InstanceId;
const OTHER_INSTANCE_ID = "i_9Nk4Wb2PgM" as InstanceId;

function makePrincipal(
  principal_id: PrincipalId,
  diagnostic_label: string,
): PrincipalProjection {
  return {
    created_at: NOW,
    diagnostic_label,
    kind: "human",
    principal_id,
    summary: `${diagnostic_label} account`,
  };
}

function makeAgent(
  agent_id: AgentId,
  principal_id: PrincipalId,
  overrides: Partial<AgentProjection> = {},
): AgentProjection {
  return {
    agent_id,
    capabilities: ["coordination"],
    created_at: NOW,
    diagnostic_label: `Agent ${agent_id.slice(-4)}`,
    discoverability: true,
    official: false,
    principal_id,
    role: "Coordinator",
    runtime_kind: "codex",
    summary: "Coordinates exact backend work.",
    ...overrides,
  };
}

function makeRuntime(
  runtime_id: RuntimeId,
  agent_id: AgentId,
  principal_id: PrincipalId,
  overrides: Partial<RuntimeProjection> = {},
): RuntimeProjection {
  return {
    agent_id,
    created_at: NOW,
    principal_id,
    runtime_id,
    runtime_kind: "codex",
    status: "active",
    workspace_label: null,
    ...overrides,
  };
}

function makeInstance(
  instance_id: InstanceId,
  runtime_id: RuntimeId,
  agent_id: AgentId,
  principal_id: PrincipalId,
  overrides: Partial<InstanceProjection> = {},
): InstanceProjection {
  return {
    agent_id,
    ended_at: null,
    expires_at: "2026-09-03T06:12:00+00:00",
    instance_id,
    last_seen_at: NOW,
    presence: "offline",
    principal_id,
    runtime_id,
    runtime_type: "desktop",
    started_at: "2026-09-03T04:12:00+00:00",
    status: "online",
    workspace_label: null,
    ...overrides,
  };
}

const ownPrincipal = makePrincipal(OWN_PRINCIPAL_ID, "Northstar");
const connectedPrincipal = makePrincipal(
  CONNECTED_PRINCIPAL_ID,
  "Atlantic partner",
);

function makeNetwork(
  overrides: Partial<NetworkProjection> = {},
): NetworkProjection {
  return {
    agents: [makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID)],
    connected_principals: [connectedPrincipal],
    edges: [],
    instances: [],
    principal: ownPrincipal,
    runtimes: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<SharedNetState> = {}): SharedNetState {
  const network = overrides.network === undefined ? makeNetwork() : overrides.network;
  return {
    claimPairing: vi.fn(async () => undefined),
    decisions: [],
    error: null,
    network,
    principal: network?.principal ?? null,
    refresh: vi.fn(async () => undefined),
    resolveDecision: vi.fn(async () => undefined),
    rooms: [],
    selectRoom: vi.fn(),
    selectedRoom: null,
    selectedRoomId: null,
    status: "ready",
    ...overrides,
  };
}

function renderNetwork(overrides: Partial<SharedNetState> = {}) {
  const state = makeState(overrides);
  contextMocks.useSharedNet.mockReturnValue(state);
  return { state, ...render(<NetworkView />) };
}

function inspectButton(agentId: AgentId) {
  return screen.getByRole("button", { name: `Inspect Agent ${agentId}` });
}

function principalGroup(principalId: PrincipalId) {
  return screen.getByRole("group", { name: `Principal ${principalId}` });
}

function layoutByAgent(container: HTMLElement) {
  return Object.fromEntries(
    Array.from(
      container.querySelectorAll<HTMLElement>("[data-agent-id][data-layout-x][data-layout-y]"),
    ).map((node) => [
      node.dataset.agentId!,
      `${node.dataset.layoutX},${node.dataset.layoutY}`,
    ]),
  );
}

describe("SharedNet Network", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("uses arbitrary backend IDs and applies exact intra/cross visibility rules", () => {
    const ownHiddenProfile = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID, {
      diagnostic_label: "Private local worker",
      discoverability: false,
    });
    const connectedPublic = makeAgent(
      CONNECTED_AGENT_ID,
      CONNECTED_PRINCIPAL_ID,
      { diagnostic_label: "Discoverable reviewer" },
    );
    const connectedPrivate = makeAgent(
      PRIVATE_AGENT_ID,
      CONNECTED_PRINCIPAL_ID,
      { diagnostic_label: "Private external worker", discoverability: false },
    );
    const unconnectedPublic = makeAgent(
      UNKNOWN_AGENT_ID,
      UNKNOWN_PRINCIPAL_ID,
      { diagnostic_label: "Unconnected worker" },
    );
    const network = makeNetwork({
      agents: [
        connectedPrivate,
        unconnectedPublic,
        connectedPublic,
        ownHiddenProfile,
      ],
    });

    renderNetwork({
      network,
      principal: makePrincipal(UNKNOWN_PRINCIPAL_ID, "Unrelated context Principal"),
    });

    expect(screen.getByRole("button", { name: "Intra-Principal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(principalGroup(OWN_PRINCIPAL_ID)).toBeVisible();
    expect(inspectButton(OWN_AGENT_ID)).toBeVisible();
    expect(screen.queryByRole("group", { name: `Principal ${CONNECTED_PRINCIPAL_ID}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Inspect Agent ${CONNECTED_AGENT_ID}` })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));

    expect(principalGroup(OWN_PRINCIPAL_ID)).toBeVisible();
    expect(principalGroup(CONNECTED_PRINCIPAL_ID)).toBeVisible();
    expect(inspectButton(OWN_AGENT_ID)).toBeVisible();
    expect(inspectButton(CONNECTED_AGENT_ID)).toBeVisible();
    expect(screen.queryByRole("button", { name: `Inspect Agent ${PRIVATE_AGENT_ID}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Inspect Agent ${UNKNOWN_AGENT_ID}` })).toBeNull();
    expect(screen.queryByText("Unrelated context Principal")).toBeNull();
  });

  it("groups each visible Agent beneath its exact Principal identity", () => {
    const ownAgent = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID);
    const connectedAgent = makeAgent(
      CONNECTED_AGENT_ID,
      CONNECTED_PRINCIPAL_ID,
    );
    renderNetwork({ network: makeNetwork({ agents: [connectedAgent, ownAgent] }) });

    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));

    const ownGroup = principalGroup(OWN_PRINCIPAL_ID);
    const externalGroup = principalGroup(CONNECTED_PRINCIPAL_ID);
    expect(within(ownGroup).getByText("Northstar")).toBeVisible();
    expect(within(ownGroup).getByText(OWN_PRINCIPAL_ID)).toBeVisible();
    expect(within(ownGroup).getByRole("button", { name: `Inspect Agent ${OWN_AGENT_ID}` })).toBeVisible();
    expect(within(ownGroup).queryByRole("button", { name: `Inspect Agent ${CONNECTED_AGENT_ID}` })).toBeNull();
    expect(within(externalGroup).getByText("Atlantic partner")).toBeVisible();
    expect(within(externalGroup).getByText(CONNECTED_PRINCIPAL_ID)).toBeVisible();
    expect(within(externalGroup).getByRole("button", { name: `Inspect Agent ${CONNECTED_AGENT_ID}` })).toBeVisible();
  });

  it("opens an exact Agent → Runtime → Instance card without inventing descendants", () => {
    const selectedAgent = makeAgent(SECOND_OWN_AGENT_ID, OWN_PRINCIPAL_ID, {
      capabilities: ["research", "verification"],
      diagnostic_label: "Evidence analyst",
      role: "Research lead",
    });
    const otherAgent = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID);
    const runtimeWithoutInstance = makeRuntime(
      FIRST_RUNTIME_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
    );
    const runtimeWithInstances = makeRuntime(
      SECOND_RUNTIME_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
    );
    const firstInstance = makeInstance(
      FIRST_INSTANCE_ID,
      SECOND_RUNTIME_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
      { presence: "online" },
    );
    const secondInstance = makeInstance(
      SECOND_INSTANCE_ID,
      SECOND_RUNTIME_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
    );
    const otherRuntime = makeRuntime(
      OTHER_RUNTIME_ID,
      OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
    );
    const otherInstance = makeInstance(
      OTHER_INSTANCE_ID,
      OTHER_RUNTIME_ID,
      OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
    );
    const orphanInstance = makeInstance(
      ORPHAN_INSTANCE_ID,
      ORPHAN_RUNTIME_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
      { presence: "online" },
    );
    renderNetwork({
      network: makeNetwork({
        agents: [otherAgent, selectedAgent],
        instances: [otherInstance, orphanInstance, secondInstance, firstInstance],
        runtimes: [otherRuntime, runtimeWithInstances, runtimeWithoutInstance],
      }),
    });

    fireEvent.click(inspectButton(SECOND_OWN_AGENT_ID));

    const card = screen.getByRole("region", { name: "Agent Card" });
    expect(within(card).getByText(OWN_PRINCIPAL_ID)).toBeVisible();
    expect(within(card).getByText(SECOND_OWN_AGENT_ID)).toBeVisible();
    expect(within(card).getByText("Research lead")).toBeVisible();
    expect(within(card).getByText("research")).toBeVisible();
    expect(within(card).getByText("verification")).toBeVisible();

    const firstRuntime = within(card).getByRole("group", {
      name: `Runtime ${FIRST_RUNTIME_ID}`,
    });
    expect(within(firstRuntime).getByText(FIRST_RUNTIME_ID)).toBeVisible();
    expect(within(firstRuntime).getByText("No Instances registered.")).toBeVisible();

    const secondRuntime = within(card).getByRole("group", {
      name: `Runtime ${SECOND_RUNTIME_ID}`,
    });
    expect(within(secondRuntime).getByText(FIRST_INSTANCE_ID)).toBeVisible();
    expect(within(secondRuntime).getByText(SECOND_INSTANCE_ID)).toBeVisible();
    expect(within(card).queryByText(OTHER_RUNTIME_ID)).toBeNull();
    expect(within(card).queryByText(OTHER_INSTANCE_ID)).toBeNull();
    expect(within(card).queryByText(ORPHAN_RUNTIME_ID)).toBeNull();
    expect(within(card).queryByText(ORPHAN_INSTANCE_ID)).toBeNull();
  });

  it("derives online, offline, and template labels only from exact descendants", () => {
    const onlineAgent = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID, {
      diagnostic_label: "Online verifier",
    });
    const runtimeOnlyAgent = makeAgent(SECOND_OWN_AGENT_ID, OWN_PRINCIPAL_ID, {
      diagnostic_label: "Runtime-only worker",
    });
    const templateAgentId = "a_5Mz8Qc2LvN" as AgentId;
    const templateAgent = makeAgent(templateAgentId, OWN_PRINCIPAL_ID, {
      diagnostic_label: "Official starter",
      official: true,
    });
    const onlineRuntime = makeRuntime(
      FIRST_RUNTIME_ID,
      OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
      { status: "revoked" },
    );
    const runtimeWithoutInstance = makeRuntime(
      SECOND_RUNTIME_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
    );
    const matchingOnlineInstance = makeInstance(
      FIRST_INSTANCE_ID,
      FIRST_RUNTIME_ID,
      OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
      { presence: "online" },
    );
    const unjoinedOnlineInstance = makeInstance(
      ORPHAN_INSTANCE_ID,
      ORPHAN_RUNTIME_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
      { presence: "online" },
    );
    renderNetwork({
      network: makeNetwork({
        agents: [templateAgent, runtimeOnlyAgent, onlineAgent],
        instances: [unjoinedOnlineInstance, matchingOnlineInstance],
        runtimes: [runtimeWithoutInstance, onlineRuntime],
      }),
    });

    expect(within(inspectButton(OWN_AGENT_ID)).getByText("online")).toBeVisible();
    expect(within(inspectButton(SECOND_OWN_AGENT_ID)).getByText("offline")).toBeVisible();
    const templateButton = inspectButton(templateAgentId);
    expect(within(templateButton).getByText("offline")).toBeVisible();
    expect(within(templateButton).getByText("template")).toBeVisible();
  });

  it("renders weighted room co-membership and Principal connections from backend edges", () => {
    const ownAgent = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID);
    const connectedAgent = makeAgent(
      CONNECTED_AGENT_ID,
      CONNECTED_PRINCIPAL_ID,
    );
    renderNetwork({
      network: makeNetwork({
        agents: [ownAgent, connectedAgent],
        edges: [
          {
            kind: "room_co_membership",
            source_id: OWN_AGENT_ID,
            target_id: CONNECTED_AGENT_ID,
            weight: 3,
          },
          {
            kind: "principal_connection",
            source_id: OWN_PRINCIPAL_ID,
            target_id: CONNECTED_PRINCIPAL_ID,
            weight: 1,
          },
        ],
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));
    const graph = screen.getByRole("region", { name: "Relationship graph" });
    expect(
      graph.querySelectorAll(
        `[data-edge-kind="room_co_membership"][data-edge-source="${OWN_AGENT_ID}"][data-edge-target="${CONNECTED_AGENT_ID}"]`,
      ),
    ).toHaveLength(3);
    expect(
      graph.querySelectorAll(
        `[data-edge-kind="principal_connection"][data-edge-source="${OWN_PRINCIPAL_ID}"][data-edge-target="${CONNECTED_PRINCIPAL_ID}"]`,
      ),
    ).toHaveLength(1);
    expect(within(graph).getByText("dotted · shared rooms × weight")).toBeVisible();
    expect(within(graph).getByText("solid · Principal connection")).toBeVisible();
  });

  it("omits backend edges when either exact endpoint is absent from the scope", () => {
    const ownAgent = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID);
    const visibleAgent = makeAgent(
      CONNECTED_AGENT_ID,
      CONNECTED_PRINCIPAL_ID,
    );
    const hiddenAgent = makeAgent(PRIVATE_AGENT_ID, CONNECTED_PRINCIPAL_ID, {
      discoverability: false,
    });
    renderNetwork({
      network: makeNetwork({
        agents: [ownAgent, visibleAgent, hiddenAgent],
        edges: [
          {
            kind: "room_co_membership",
            source_id: OWN_AGENT_ID,
            target_id: CONNECTED_AGENT_ID,
            weight: 1,
          },
          {
            kind: "room_co_membership",
            source_id: OWN_AGENT_ID,
            target_id: PRIVATE_AGENT_ID,
            weight: 2,
          },
          {
            kind: "room_co_membership",
            source_id: OWN_AGENT_ID,
            target_id: UNKNOWN_AGENT_ID,
            weight: 4,
          },
          {
            kind: "principal_connection",
            source_id: OWN_PRINCIPAL_ID,
            target_id: UNKNOWN_PRINCIPAL_ID,
            weight: 1,
          },
        ],
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));
    const graph = screen.getByRole("region", { name: "Relationship graph" });
    expect(graph.querySelectorAll('[data-edge-kind="room_co_membership"]')).toHaveLength(1);
    expect(graph.querySelector('[data-edge-target="' + PRIVATE_AGENT_ID + '"]')).toBeNull();
    expect(graph.querySelector('[data-edge-target="' + UNKNOWN_AGENT_ID + '"]')).toBeNull();
    expect(graph.querySelector('[data-edge-target="' + UNKNOWN_PRINCIPAL_ID + '"]')).toBeNull();
  });

  it("lays out one arbitrary Agent at finite coordinates", () => {
    const { container } = renderNetwork();
    const node = container.querySelector<HTMLElement>(`[data-agent-id="${OWN_AGENT_ID}"]`);

    expect(node).not.toBeNull();
    expect(Number.isFinite(Number(node!.dataset.layoutX))).toBe(true);
    expect(Number.isFinite(Number(node!.dataset.layoutY))).toBe(true);
    expect(node!.getAttribute("style")).not.toContain("NaN");
  });

  it("sorts opaque IDs into deterministic non-overlapping coordinates for many Agents", () => {
    const thirdOwnAgentId = "a_4Hs9Yn1CqP" as AgentId;
    const secondExternalAgentId = "a_7Dj2Wm5KrQ" as AgentId;
    const secondConnectedPrincipal = makePrincipal(
      SECOND_CONNECTED_PRINCIPAL_ID,
      "Pacific partner",
    );
    const agents = [
      makeAgent(CONNECTED_AGENT_ID, CONNECTED_PRINCIPAL_ID),
      makeAgent(SECOND_OWN_AGENT_ID, OWN_PRINCIPAL_ID),
      makeAgent(secondExternalAgentId, SECOND_CONNECTED_PRINCIPAL_ID),
      makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID),
      makeAgent(thirdOwnAgentId, OWN_PRINCIPAL_ID),
    ];
    const network = makeNetwork({
      agents,
      connected_principals: [secondConnectedPrincipal, connectedPrincipal],
    });
    const { container, rerender } = renderNetwork({ network });
    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));
    const firstLayout = layoutByAgent(container);

    expect(Object.keys(firstLayout)).toHaveLength(agents.length);
    expect(new Set(Object.values(firstLayout)).size).toBe(agents.length);
    for (const coordinates of Object.values(firstLayout)) {
      const [x, y] = coordinates.split(",").map(Number);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }

    contextMocks.useSharedNet.mockReturnValue(
      makeState({
        network: {
          ...network,
          agents: [...agents].reverse(),
          connected_principals: [...network.connected_principals].reverse(),
        },
      }),
    );
    rerender(<NetworkView />);

    expect(layoutByAgent(container)).toEqual(firstLayout);
  });

  it("renders a finite empty graph with the own Principal and no fabricated Agent", () => {
    const { container } = renderNetwork({ network: makeNetwork({ agents: [] }) });

    expect(principalGroup(OWN_PRINCIPAL_ID)).toBeVisible();
    expect(screen.getByText("No Agents registered for this Principal.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Inspect Agent/ })).toBeNull();
    const canvas = container.querySelector<HTMLElement>(".network-canvas");
    expect(canvas).not.toBeNull();
    expect(Number.isFinite(Number.parseFloat(canvas!.style.width))).toBe(true);
    expect(Number.isFinite(Number.parseFloat(canvas!.style.height))).toBe(true);
    expect(canvas!.getAttribute("style")).not.toContain("NaN");
  });

  it("reports loading and unavailable states without displaying a graph", () => {
    const { rerender } = renderNetwork({ network: null, status: "loading" });

    expect(screen.getByRole("status")).toHaveTextContent("Loading Network…");
    expect(screen.queryByRole("region", { name: "Relationship graph" })).toBeNull();

    contextMocks.useSharedNet.mockReturnValue(
      makeState({
        error: "SharedNet data is unavailable.",
        network: null,
        status: "stale",
      }),
    );
    rerender(<NetworkView />);

    expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable.");
    expect(screen.queryByRole("region", { name: "Relationship graph" })).toBeNull();
  });

  it("keeps last-good Network data visible while marking it stale", () => {
    renderNetwork({
      error: "SharedNet data may be out of date.",
      network: makeNetwork(),
      status: "stale",
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Network data may be out of date.",
    );
    expect(screen.getByRole("region", { name: "Relationship graph" })).toBeVisible();
    expect(inspectButton(OWN_AGENT_ID)).toBeVisible();
  });

  it("never presents delegation, hosting, readiness, activity, or recruitment claims", () => {
    const network = makeNetwork({
      agents: [
        makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID, {
          official: true,
        }),
        makeAgent(CONNECTED_AGENT_ID, CONNECTED_PRINCIPAL_ID),
      ],
      edges: [
        {
          kind: "room_co_membership",
          source_id: OWN_AGENT_ID,
          target_id: CONNECTED_AGENT_ID,
          weight: 2,
        },
      ],
    });
    const { container } = renderNetwork({ network });
    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));

    expect(container.textContent).not.toMatch(
      /delegation|hosted|ready|active work|recruitable|recruitment/i,
    );
    expect(container.querySelector('[data-edge-kind="delegation"]')).toBeNull();
  });
});
