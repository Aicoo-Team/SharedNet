import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const OWN_PRINCIPAL_ID = "p_LKTYW3LByD" as PrincipalId;
const CONNECTED_PRINCIPAL_ID = "p_RkiSMcCIZl" as PrincipalId;
const SECOND_CONNECTED_PRINCIPAL_ID = "p_FP7b48IvOT" as PrincipalId;
const UNKNOWN_PRINCIPAL_ID = "p_1DxfhWuuZc" as PrincipalId;
const OWN_AGENT_ID = "a_Wdn8m8sB8q" as AgentId;
const SECOND_OWN_AGENT_ID = "a_USg2hJVzyZ" as AgentId;
const CONNECTED_AGENT_ID = "a_MnlsrBKS5T" as AgentId;
const PRIVATE_AGENT_ID = "a_qdAc5s3QBa" as AgentId;
const UNKNOWN_AGENT_ID = "a_1hEuF7ZrWP" as AgentId;
const FIRST_INSTANCE_ID = "i_xNr0mlza8I" as InstanceId;
const SECOND_INSTANCE_ID = "i_F9wNA7geV0" as InstanceId;
const ORPHAN_INSTANCE_ID = "i_IVuD2vNMyr" as InstanceId;
const OTHER_INSTANCE_ID = "i_lrfdChtuKj" as InstanceId;
const OWN_INSTANCE_ID = "i_Wdn8m8sB8q" as InstanceId;
const CONNECTED_INSTANCE_ID = "i_MnlsrBKS5T" as InstanceId;
const PRIVATE_INSTANCE_ID = "i_qdAc5s3QBa" as InstanceId;
const UNKNOWN_INSTANCE_ID = "i_1hEuF7ZrWP" as InstanceId;
const PRODUCT_SHELL_CSS = readFileSync(
  resolve(process.cwd(), "app/product-shell.css"),
  "utf8",
);

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
    created_at: NOW,
    diagnostic_label: `Agent ${agent_id.slice(-4)}`,
    discoverability: true,
    official: false,
    principal_id,
    role: "Coordinator",
    summary: "Coordinates exact backend work.",
    ...overrides,
  };
}

function makeInstance(
  instance_id: InstanceId,
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
    heartbeat_state: "stopped",
    runtime_metadata: {},
    presence: "offline",
    principal_id,
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

/** Nodes are Instances, so a fixture Agent needs one to be drawn at all. */
function instanceIdFor(agentId: AgentId): InstanceId {
  return `i_${String(agentId).slice(2)}` as InstanceId;
}

function makeNetwork(
  overrides: Partial<NetworkProjection> = {},
): NetworkProjection {
  const agents = overrides.agents ?? [makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID)];
  return {
    agents,
    connected_principals: [connectedPrincipal],
    edges: [],
    instances: agents.map((agent) =>
      makeInstance(
        instanceIdFor(agent.agent_id),
        agent.agent_id,
        agent.principal_id,
      ),
    ),
    principal: ownPrincipal,
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

function inspectButton(id: InstanceId) {
  return screen.getByRole("button", { name: `Inspect Instance ${id}` });
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
    expect(inspectButton(OWN_INSTANCE_ID)).toBeVisible();
    expect(screen.queryByRole("group", { name: `Principal ${CONNECTED_PRINCIPAL_ID}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Inspect Instance ${CONNECTED_INSTANCE_ID}` })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));

    expect(principalGroup(OWN_PRINCIPAL_ID)).toBeVisible();
    expect(principalGroup(CONNECTED_PRINCIPAL_ID)).toBeVisible();
    expect(inspectButton(OWN_INSTANCE_ID)).toBeVisible();
    expect(inspectButton(CONNECTED_INSTANCE_ID)).toBeVisible();
    expect(screen.queryByRole("button", { name: `Inspect Instance ${PRIVATE_INSTANCE_ID}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Inspect Instance ${UNKNOWN_INSTANCE_ID}` })).toBeNull();
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
    expect(within(ownGroup).getByRole("button", { name: `Inspect Instance ${OWN_INSTANCE_ID}` })).toBeVisible();
    expect(within(ownGroup).queryByRole("button", { name: `Inspect Instance ${CONNECTED_INSTANCE_ID}` })).toBeNull();
    expect(within(externalGroup).getByText("Atlantic partner")).toBeVisible();
    expect(within(externalGroup).getByText(CONNECTED_PRINCIPAL_ID)).toBeVisible();
    expect(within(externalGroup).getByRole("button", { name: `Inspect Instance ${CONNECTED_INSTANCE_ID}` })).toBeVisible();
  });

  it("opens an Agent card listing exactly that Agent's Instances", () => {
    const selectedAgent = makeAgent(SECOND_OWN_AGENT_ID, OWN_PRINCIPAL_ID, {
      diagnostic_label: "Evidence analyst",
      role: "Research lead",
    });
    const otherAgent = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID);
    const firstInstance = makeInstance(
      FIRST_INSTANCE_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
      { presence: "online", heartbeat_state: "renewing" },
    );
    const secondInstance = makeInstance(
      SECOND_INSTANCE_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
    );
    const otherInstance = makeInstance(
      OTHER_INSTANCE_ID,
      OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
    );
    renderNetwork({
      network: makeNetwork({
        agents: [otherAgent, selectedAgent],
        instances: [otherInstance, secondInstance, firstInstance],
      }),
    });

    fireEvent.click(inspectButton(FIRST_INSTANCE_ID));

    const card = screen.getByRole("region", { name: "Agent Card" });
    expect(within(card).getByText(OWN_PRINCIPAL_ID)).toBeVisible();
    expect(within(card).getByText(SECOND_OWN_AGENT_ID)).toBeVisible();
    expect(within(card).getByText("Research lead")).toBeVisible();

    // exactly this Agent's Instances, and no others
    expect(within(card).getByText(FIRST_INSTANCE_ID)).toBeVisible();
    expect(within(card).getByText(SECOND_INSTANCE_ID)).toBeVisible();
    expect(within(card).queryByText(OTHER_INSTANCE_ID)).toBeNull();
  });

  it("derives online, offline, and template labels only from exact descendants", () => {
    const onlineAgent = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID, {
      diagnostic_label: "Online verifier",
    });
    const runtimeOnlyAgent = makeAgent(SECOND_OWN_AGENT_ID, OWN_PRINCIPAL_ID, {
      diagnostic_label: "Runtime-only worker",
    });
    const templateAgentId = "a_d2hNWU0Bml" as AgentId;
    const templateAgent = makeAgent(templateAgentId, OWN_PRINCIPAL_ID, {
      diagnostic_label: "Official starter",
      official: true,
    });
    const matchingOnlineInstance = makeInstance(
      FIRST_INSTANCE_ID,
      OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
      { presence: "online", heartbeat_state: "renewing" },
    );
    const unjoinedOnlineInstance = makeInstance(
      ORPHAN_INSTANCE_ID,
      SECOND_OWN_AGENT_ID,
      OWN_PRINCIPAL_ID,
      { presence: "online", heartbeat_state: "renewing" },
    );
    renderNetwork({
      network: makeNetwork({
        agents: [templateAgent, runtimeOnlyAgent, onlineAgent],
        instances: [unjoinedOnlineInstance, matchingOnlineInstance],
      }),
    });

    expect(within(inspectButton(FIRST_INSTANCE_ID)).getByText("online")).toBeVisible();
    expect(within(inspectButton(ORPHAN_INSTANCE_ID)).getByText("online")).toBeVisible();
    // An Agent with no Instances draws no dot at all.
    expect(
      screen.queryByRole("button", { name: `Inspect Instance ${templateAgentId}` }),
    ).toBeNull();
  });

  it("draws one dashed line per shared Room between two Instances", () => {
    const ownAgent = makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID);
    const first = makeInstance(FIRST_INSTANCE_ID, OWN_AGENT_ID, OWN_PRINCIPAL_ID);
    const second = makeInstance(SECOND_INSTANCE_ID, OWN_AGENT_ID, OWN_PRINCIPAL_ID);
    renderNetwork({
      network: makeNetwork({
        agents: [ownAgent],
        instances: [first, second],
        edges: [
          {
            kind: "room_co_membership",
            source_id: FIRST_INSTANCE_ID,
            target_id: SECOND_INSTANCE_ID,
            weight: 3,
          },
        ],
      }),
    });

    const graph = screen.getByRole("region", { name: "Relationship graph" });
    expect(
      graph.querySelectorAll(
        `[data-edge-kind="room_co_membership"][data-edge-source="${FIRST_INSTANCE_ID}"][data-edge-target="${SECOND_INSTANCE_ID}"]`,
      ),
    ).toHaveLength(3);
    const relationships = within(graph).getByRole("list", {
      name: "Visible relationships",
    });
    expect(within(relationships).getAllByRole("listitem")).toHaveLength(1);
    expect(relationships).toHaveTextContent(
      `room_co_membership: source ${FIRST_INSTANCE_ID}; target ${SECOND_INSTANCE_ID}; weight 3`,
    );
  });

  it("bounds huge room-edge multiplicity while reporting the exact backend weight", () => {
    const hugeWeight = 1_000;
    renderNetwork({
      network: makeNetwork({
        agents: [
          makeAgent(OWN_AGENT_ID, OWN_PRINCIPAL_ID),
          makeAgent(CONNECTED_AGENT_ID, CONNECTED_PRINCIPAL_ID),
        ],
        edges: [
          {
            kind: "room_co_membership",
            source_id: OWN_INSTANCE_ID,
            target_id: CONNECTED_INSTANCE_ID,
            weight: hugeWeight,
          },
        ],
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));
    const graph = screen.getByRole("region", { name: "Relationship graph" });
    const lines = graph.querySelectorAll(
      `[data-edge-kind="room_co_membership"][data-edge-source="${OWN_INSTANCE_ID}"][data-edge-target="${CONNECTED_INSTANCE_ID}"]`,
    );
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(line).toHaveAttribute("data-edge-weight", String(hugeWeight));
    }
    expect(
      within(graph).getByRole("list", { name: "Visible relationships" }),
    ).toHaveTextContent(
      `room_co_membership: source ${OWN_INSTANCE_ID}; target ${CONNECTED_INSTANCE_ID}; weight ${hugeWeight}`,
    );
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
            source_id: OWN_INSTANCE_ID,
            target_id: CONNECTED_INSTANCE_ID,
            weight: 1,
          },
          {
            kind: "room_co_membership",
            source_id: OWN_INSTANCE_ID,
            target_id: PRIVATE_INSTANCE_ID,
            weight: 2,
          },
          {
            kind: "room_co_membership",
            source_id: OWN_INSTANCE_ID,
            target_id: UNKNOWN_INSTANCE_ID,
            weight: 4,
          },
        ],
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cross-Principal" }));
    const graph = screen.getByRole("region", { name: "Relationship graph" });
    expect(graph.querySelectorAll('[data-edge-kind="room_co_membership"]')).toHaveLength(1);
    expect(graph.querySelector('[data-edge-target="' + PRIVATE_INSTANCE_ID + '"]')).toBeNull();
    expect(graph.querySelector('[data-edge-target="' + UNKNOWN_AGENT_ID + '"]')).toBeNull();
    expect(graph.querySelector('[data-edge-target="' + UNKNOWN_PRINCIPAL_ID + '"]')).toBeNull();
    const relationships = within(graph).getByRole("list", {
      name: "Visible relationships",
    });
    expect(within(relationships).getAllByRole("listitem")).toHaveLength(1);
    expect(relationships).toHaveTextContent(
      `room_co_membership: source ${OWN_INSTANCE_ID}; target ${CONNECTED_INSTANCE_ID}; weight 1`,
    );
    expect(relationships).not.toHaveTextContent(PRIVATE_AGENT_ID);
    expect(relationships).not.toHaveTextContent(UNKNOWN_AGENT_ID);
    expect(relationships).not.toHaveTextContent(UNKNOWN_PRINCIPAL_ID);
  });

  it("lays out one arbitrary Agent at finite coordinates", () => {
    const { container } = renderNetwork();
    const node = container.querySelector<HTMLElement>(`[data-agent-id="${OWN_AGENT_ID}"]`);

    expect(node).not.toBeNull();
    expect(Number.isFinite(Number(node!.dataset.layoutX))).toBe(true);
    expect(Number.isFinite(Number(node!.dataset.layoutY))).toBe(true);
    expect(node!.getAttribute("style")).not.toContain("NaN");
  });

  it("uses one unscaled pixel canvas for the SVG and positioned HTML nodes", () => {
    const { container } = renderNetwork();
    const canvas = container.querySelector<HTMLElement>(".network-canvas");
    const svg = container.querySelector<SVGElement>(".relationship-lines");

    expect(canvas).not.toBeNull();
    expect(svg).not.toBeNull();
    const canvasWidth = Number.parseFloat(canvas!.style.width);
    const canvasHeight = Number.parseFloat(canvas!.style.height);
    expect(svg).toHaveAttribute("width", String(canvasWidth));
    expect(svg).toHaveAttribute("height", String(canvasHeight));
    expect(svg).toHaveAttribute(
      "viewBox",
      `0 0 ${canvasWidth} ${canvasHeight}`,
    );

    const canvasRule = PRODUCT_SHELL_CSS.match(
      /\.network-canvas\s*\{([^}]*)\}/,
    )?.[1];
    const svgRule = PRODUCT_SHELL_CSS.match(
      /\.relationship-lines\s*\{([^}]*)\}/,
    )?.[1];
    expect(canvasRule).not.toMatch(/min-(?:width|height):\s*100%/);
    expect(svgRule).not.toMatch(/(?:width|height):\s*100%/);
  });

  it("sorts opaque IDs into deterministic non-overlapping coordinates for many Agents", () => {
    const thirdOwnAgentId = "a_sMaPxgLQhO" as AgentId;
    const secondExternalAgentId = "a_u8i1FruyXe" as AgentId;
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
    expect(screen.queryByRole("button", { name: /Inspect Instance/ })).toBeNull();
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

    const freshness = screen.getByRole("status");
    expect(freshness).toHaveTextContent("SharedNet data may be out of date.");
    expect(freshness).not.toHaveTextContent("Network data may be out of date.");
    expect(screen.getByRole("region", { name: "Relationship graph" })).toBeVisible();
    expect(inspectButton(OWN_INSTANCE_ID)).toBeVisible();
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
          source_id: OWN_INSTANCE_ID,
          target_id: CONNECTED_INSTANCE_ID,
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
