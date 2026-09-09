import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentId,
  InstanceId,
  MessageId,
  NetworkProjection,
  PrincipalId,
  RoomCursor,
  RoomDetail,
  RoomId,
  RoomSummary,
} from "@/src/sharednet/contracts";

import { ChatView } from "./chat-view";

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
const EARLIER = "2026-09-03T04:45:00+00:00";
const ROOM_ID = "room_Launch:Alpha.7" as RoomId;
const SECOND_ROOM_ID = "room_Review:Beta.2" as RoomId;
const PRINCIPAL_ID = "p_7CPHtWFsFn" as PrincipalId;
const SECOND_PRINCIPAL_ID = "p_V80npHhNlU" as PrincipalId;
const AGENT_ID = "a_XHEYHw3zh8" as AgentId;
const SECOND_AGENT_ID = "a_5NyJVth3Ci" as AgentId;
const INSTANCE_ID = "i_xQqH1Bafyt" as InstanceId;
const SECOND_INSTANCE_ID = "i_GbUH57mxOZ" as InstanceId;
const FIRST_MESSAGE_ID = "message_launch.7" as MessageId;
const REPLY_MESSAGE_ID = "message_launch.12" as MessageId;
const PRODUCT_SHELL_CSS = readFileSync(
  resolve(process.cwd(), "app/product-shell.css"),
  "utf8",
);
const ORIGINAL_SHOW_MODAL = Object.getOwnPropertyDescriptor(
  window.HTMLDialogElement.prototype,
  "showModal",
);

const roomSummary: RoomSummary = {
  description: "Coordinate the production launch",
  latest_cursor: "cursor_12" as RoomCursor,
  latest_sequence: 12,
  member_count: 2,
  name: "Launch readiness",
  owner_agent_ids: [AGENT_ID],
  room_id: ROOM_ID,
  status: "open",
  updated_at: NOW,
};

const secondRoomSummary: RoomSummary = {
  description: "Review launch evidence",
  latest_cursor: "cursor_3" as RoomCursor,
  latest_sequence: 3,
  member_count: 1,
  name: "Evidence review",
  owner_agent_ids: [SECOND_AGENT_ID],
  room_id: SECOND_ROOM_ID,
  status: "closed",
  updated_at: EARLIER,
};

const roomDetail: RoomDetail = {
  memberships: [
    {
      agent_id: AGENT_ID,
      instance_id: INSTANCE_ID,
      joined_at: EARLIER,
      kind: "instance",
      last_read_sequence: 12,
      admitted_by: "room_id",
      added_by_instance_id: null,
      left_at: null,
      member_id: INSTANCE_ID,
      name: null,
      presence: "online",
      principal_id: PRINCIPAL_ID,
      room_id: ROOM_ID,
      runtime: { kind: "codex", version: "0.1.0", entrypoint: null, source: "detected" },
      status: "active",
    },
    {
      agent_id: SECOND_AGENT_ID,
      instance_id: SECOND_INSTANCE_ID,
      joined_at: EARLIER,
      kind: "instance",
      last_read_sequence: 10,
      admitted_by: "room_id",
      added_by_instance_id: null,
      left_at: null,
      member_id: SECOND_INSTANCE_ID,
      name: null,
      presence: "online",
      principal_id: SECOND_PRINCIPAL_ID,
      room_id: ROOM_ID,
      runtime: { kind: "codex", version: "0.1.0", entrypoint: null, source: "detected" },
      status: "active",
    },
  ],
  messages: [
    {
      attachment_ids: [],
      content: "Verification is complete.",
      created_at: NOW,
      message_id: REPLY_MESSAGE_ID,
      reply_to: FIRST_MESSAGE_ID,
      resolution_state: "not_required",
      room_id: ROOM_ID,
      sender: {
        agent_id: SECOND_AGENT_ID,
        instance_id: SECOND_INSTANCE_ID,
        principal_id: SECOND_PRINCIPAL_ID,
      },
      sequence: 12,
      tags: [],
    },
    {
      attachment_ids: [],
      content: "Please verify the launch checklist.",
      created_at: EARLIER,
      message_id: FIRST_MESSAGE_ID,
      reply_to: null,
      resolution_state: "not_required",
      room_id: ROOM_ID,
      sender: {
        agent_id: AGENT_ID,
        instance_id: INSTANCE_ID,
        principal_id: PRINCIPAL_ID,
      },
      sequence: 7,
      tags: [],
    },
  ],
  next_cursor: "cursor_12" as RoomCursor,
  room: {
    access_policy: "principal_only",
    created_at: EARLIER,
    creator: {
      agent_id: AGENT_ID,
      instance_id: INSTANCE_ID,
      principal_id: PRINCIPAL_ID,
    },
    description: roomSummary.description,
    name: roomSummary.name,
    room_id: ROOM_ID,
    status: "open",
    updated_at: NOW,
  },
};

const networkProjection: NetworkProjection = {
  agents: [
    {
      agent_id: AGENT_ID,
      created_at: EARLIER,
      diagnostic_label: "Codex",
      discoverability: false,
      handle: "codex",
      principal_id: PRINCIPAL_ID,
      summary: "Launch owner",
    },
    {
      agent_id: SECOND_AGENT_ID,
      created_at: EARLIER,
      diagnostic_label: "Reviewer",
      discoverability: true,
      handle: "reviewer",
      principal_id: SECOND_PRINCIPAL_ID,
      summary: "Launch reviewer",
    },
  ],
  connected_principals: [
    {
      created_at: EARLIER,
      diagnostic_label: "Review Principal",
      kind: "connected",
      principal_id: SECOND_PRINCIPAL_ID,
      summary: "External review account",
    },
  ],
  edges: [],
  instances: [
    {
      agent_id: AGENT_ID,
      ended_at: null,
      expires_at: "2026-09-03T05:13:30+00:00",
      instance_id: INSTANCE_ID,
      last_seen_at: NOW,
      display_name: null,
      heartbeat_state: "renewing",
      runtime_metadata: { cli_version: "0.1.3", device_id: "dev-a" },
      presence: "online",
      principal_id: PRINCIPAL_ID,
      runtime_type: "codex",
      started_at: EARLIER,
      status: "online",
      workspace_label: "/workspace/sharednet",
    },
    {
      agent_id: SECOND_AGENT_ID,
      ended_at: null,
      expires_at: EARLIER,
      instance_id: SECOND_INSTANCE_ID,
      last_seen_at: EARLIER,
      display_name: null,
      heartbeat_state: "stopped",
      runtime_metadata: { cli_version: "0.1.3" },
      presence: "offline",
      principal_id: SECOND_PRINCIPAL_ID,
      runtime_type: "claude-code",
      started_at: EARLIER,
      status: "online",
      workspace_label: null,
    },
  ],
  principal: {
    created_at: EARLIER,
    diagnostic_label: "Owner Principal",
    kind: "account",
    principal_id: PRINCIPAL_ID,
    summary: "Signed-in account",
  },
};

const INVITE_TOKEN = `rit_${"t".repeat(43)}`;
const CLAIM = `clp_${"c".repeat(43)}`;

function mintedInvite(roomId: string) {
  return {
    invite: {
      created_at: NOW,
      expires_at: null,
      invite_id: "inv_0000000001",
      revoked_at: null,
      room_id: roomId as RoomId,
      uses: 0,
    },
    token: INVITE_TOKEN,
  };
}

function makeState(overrides: Partial<SharedNetState> = {}): SharedNetState {
  return {
    claimPairing: vi.fn(async () => undefined),
    closeRoom: vi.fn(async () => ({ ...roomDetail.room, status: "closed" as const })),
    createInvite: vi.fn(async (roomId: RoomId) => mintedInvite(roomId)),
    createClaim: vi.fn(async () => ({ claim: CLAIM, login_id: "cli_0000000001", expires_at: NOW, principal_id: PRINCIPAL_ID })),
    createRoom: vi.fn(async () => { throw new Error("createRoom not stubbed"); }),
    decisions: [],
    error: null,
    network: null,
    principal: null,
    refresh: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => ({ ...roomDetail.memberships[0]!, status: "left" as const })),
    resolveDecision: vi.fn(async () => undefined),
    rooms: [roomSummary, secondRoomSummary],
    selectRoom: vi.fn(),
    selectedRoom: roomDetail,
    selectedRoomId: ROOM_ID,
    status: "ready",
    ...overrides,
  };
}

function renderChat(overrides: Partial<SharedNetState> = {}) {
  const state = makeState(overrides);
  contextMocks.useSharedNet.mockReturnValue(state);
  return { state, ...render(<ChatView />) };
}

describe("SharedNet Rooms", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window.HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (ORIGINAL_SHOW_MODAL) {
      Object.defineProperty(
        window.HTMLDialogElement.prototype,
        "showModal",
        ORIGINAL_SHOW_MODAL,
      );
    } else {
      Reflect.deleteProperty(window.HTMLDialogElement.prototype, "showModal");
    }
  });

  it("lets the Rooms sidebar be resized from a divider that drives the workspace grid", () => {
    renderChat({ rooms: [], selectedRoom: null, selectedRoomId: null });

    const handle = screen.getByRole("separator", { name: "Resize Rooms sidebar" });
    const workspace = handle.closest(".rooms-workspace") as HTMLElement;
    expect(workspace.style.getPropertyValue("--split-width")).toBe("178px");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(workspace.style.getPropertyValue("--split-width")).toBe("194px");

    const gridRule = PRODUCT_SHELL_CSS.match(/\.rooms-workspace \{[^}]*\}/)?.[0] ?? "";
    expect(gridRule).toContain("grid-template-columns: var(--split-width) minmax(0, 1fr)");
    expect(PRODUCT_SHELL_CSS).toMatch(/body:has\(\.product-window\) \{[^}]*overflow: hidden;/);
  });

  it("offers to schedule a Room, like booking a meeting, when no Rooms exist", () => {
    renderChat({ rooms: [], selectedRoom: null, selectedRoomId: null });

    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(within(rooms).getByText("No rooms yet")).toBeVisible();
    expect(within(rooms).queryByRole("button")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "A Room is a meeting for Agents." }),
    ).toBeVisible();
    const steps = within(screen.getByRole("list", { name: "How SharedNet works" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(steps).toEqual([
      "Schedule a Room",
      "Invite your Agents by Room ID",
      "Watch them work and decide",
    ]);
    expect(screen.getByLabelText("Room name")).toBeVisible();
    expect(screen.getByPlaceholderText("Type here…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Schedule Room" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Invite an Agent to it" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Continue locally" })).toBeNull();
  });

  it("shows loading without falsely reporting an empty account", () => {
    renderChat({
      rooms: [],
      selectedRoom: null,
      selectedRoomId: null,
      status: "loading",
    });

    expect(screen.getByRole("status")).toHaveTextContent("Loading rooms…");
    expect(screen.queryByText("No rooms yet")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Rooms" })).toBeVisible();
  });

  it("reports Rooms unavailable when stale state has no last-good list", () => {
    renderChat({
      error: "Room list refresh failed.",
      rooms: [],
      selectedRoom: null,
      selectedRoomId: null,
      status: "stale",
    });

    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(within(rooms).getByRole("status")).toHaveTextContent(
      "Rooms unavailable while SharedNet data is stale.",
    );
    expect(within(rooms).queryByText("No rooms yet")).toBeNull();
    expect(within(rooms).queryByText("Loading rooms…")).toBeNull();
  });

  it("renders durable Room summaries with exact status, sequence, activity, and selection", () => {
    renderChat();

    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    const launch = within(rooms).getByRole("button", {
      name: "Open room Launch readiness",
    });
    const review = within(rooms).getByRole("button", {
      name: "Open room Evidence review",
    });

    expect(launch).toHaveAttribute("aria-current", "true");
    expect(launch).toHaveTextContent("open");
    expect(launch).toHaveTextContent("Sequence 12");
    expect(launch).toHaveTextContent(NOW);
    expect(review).not.toHaveAttribute("aria-current");
    expect(review).toHaveTextContent("closed");
    expect(review).toHaveTextContent("Sequence 3");
    expect(review).toHaveTextContent(EARLIER);
  });

  it("selects an account-visible Room by its canonical ID", () => {
    const selectRoom = vi.fn();
    renderChat({ selectRoom });

    fireEvent.click(
      screen.getByRole("button", { name: "Open room Evidence review" }),
    );

    expect(selectRoom).toHaveBeenCalledTimes(1);
    expect(selectRoom).toHaveBeenCalledWith(SECOND_ROOM_ID);
  });

  it("reflects Room list changes supplied by the live provider", () => {
    contextMocks.useSharedNet.mockReturnValue(makeState({ rooms: [roomSummary] }));
    const view = render(<ChatView />);

    expect(screen.queryByRole("button", { name: "Open room Evidence review" })).toBeNull();

    contextMocks.useSharedNet.mockReturnValue(makeState());
    view.rerender(<ChatView />);

    expect(
      screen.getByRole("button", { name: "Open room Evidence review" }),
    ).toBeVisible();
  });

  it("shows the selected Room's exact ID, member count, and cursor", () => {
    renderChat();

    expect(screen.getByRole("heading", { name: "Launch readiness" })).toBeVisible();
    expect(screen.getByText(ROOM_ID)).toBeVisible();
    expect(screen.getByText("2 members")).toBeVisible();
    expect(screen.getByText("Latest sequence 12")).toBeVisible();
  });

  it("shows member identities per Instance with heartbeat-derived presence", () => {
    renderChat({ network: networkProjection });

    fireEvent.click(screen.getByRole("button", { name: "Room actions" }));
    const members = screen.getByRole("list", { name: "Room members" });
    const owner = within(members).getByRole("article", {
      name: `Room member ${INSTANCE_ID}`,
    });
    const reviewer = within(members).getByRole("article", {
      name: `Room member ${SECOND_INSTANCE_ID}`,
    });

    expect(owner).toHaveAttribute("data-presence", "online");
    expect(owner).toHaveTextContent(`Principal${PRINCIPAL_ID}`);
    expect(owner).toHaveTextContent(`Agent${AGENT_ID}`);
    expect(owner).toHaveTextContent(`Instance${INSTANCE_ID}`);
    expect(owner).toHaveTextContent("Heartbeat renewing · lease active");

    expect(reviewer).toHaveAttribute("data-presence", "offline");
    expect(reviewer).toHaveTextContent(`Principal${SECOND_PRINCIPAL_ID}`);
    expect(reviewer).toHaveTextContent(`Agent${SECOND_AGENT_ID}`);
    expect(reviewer).toHaveTextContent(`Instance${SECOND_INSTANCE_ID}`);
    expect(reviewer).toHaveTextContent("Heartbeat stopped");
  });

  it("keeps active membership and presence visible when the Room has no messages", () => {
    renderChat({
      network: networkProjection,
      selectedRoom: { ...roomDetail, messages: [] },
    });

    fireEvent.click(screen.getByRole("button", { name: "Room actions" }));
    expect(screen.getByRole("list", { name: "Room members" })).toBeVisible();
    expect(
      screen.getByRole("article", { name: `Room member ${INSTANCE_ID}` }),
    ).toBeVisible();
    expect(screen.getByText("No messages yet")).toBeVisible();
  });

  it("renders real messages in ascending Room sequence order", () => {
    renderChat();

    const history = screen.getByRole("list", { name: "Room messages" });
    const messages = within(history).getAllByRole("article");

    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveAccessibleName("Message 7");
    expect(messages[0]).toHaveTextContent("Please verify the launch checklist.");
    expect(messages[1]).toHaveAccessibleName("Message 12");
    expect(messages[1]).toHaveTextContent("Verification is complete.");
  });

  it("shows the complete sender provenance tuple without rewriting canonical IDs", () => {
    renderChat();

    const message = screen.getByRole("article", { name: "Message 7" });
    const provenance = within(message).getByLabelText("Sender provenance");

    // The card behind the driver icon: Principal, Agent, Instance, in that order.
    expect(provenance).toHaveTextContent(`Principal${PRINCIPAL_ID}`);
    expect(provenance).toHaveTextContent(`Agent${AGENT_ID}`);
    expect(provenance).toHaveTextContent(`Instance${INSTANCE_ID}`);
    const text = provenance.textContent ?? "";
    expect(text.indexOf(PRINCIPAL_ID)).toBeLessThan(text.indexOf(AGENT_ID));
    expect(text.indexOf(AGENT_ID)).toBeLessThan(text.indexOf(INSTANCE_ID));
    // The Instance id is also on the row itself, next to the name.
    expect(within(message).getByText(INSTANCE_ID, { selector: ".room-message-instance" })).toBeVisible();
    expect(within(message).getByLabelText("Who sent message 7")).toHaveClass("room-message-avatar");
  });

  it("keeps exact Room and provenance IDs visibly wrappable", () => {
    renderChat();

    expect(screen.getByText(ROOM_ID)).toHaveClass("room-canonical-id");
    const provenance = within(
      screen.getByRole("article", { name: "Message 7" }),
    ).getByLabelText("Sender provenance");
    for (const id of [PRINCIPAL_ID, AGENT_ID, INSTANCE_ID]) {
      expect(within(provenance).getByText(id)).toHaveClass("room-canonical-id");
    }

    const canonicalIdRule = PRODUCT_SHELL_CSS.match(
      /\.room-canonical-id\s*\{([^}]*)\}/,
    )?.[1];
    expect(canonicalIdRule).toContain("overflow-wrap: anywhere;");
    expect(canonicalIdRule).toContain("white-space: normal;");
    expect(canonicalIdRule).not.toContain("text-overflow: ellipsis;");
  });

  it("links a reply to the exact parent message ID", () => {
    renderChat();

    const reply = screen.getByRole("article", { name: "Message 12" });
    expect(within(reply).getByText("Reply to")).toBeVisible();
    expect(within(reply).getByText(FIRST_MESSAGE_ID)).toBeVisible();
    expect(reply).toHaveTextContent(REPLY_MESSAGE_ID);
  });

  it("keeps current Room data visible while reporting stale state", () => {
    renderChat({
      error: "SharedNet data may be out of date.",
      status: "stale",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "SharedNet data may be out of date.",
    );
    expect(screen.getByRole("heading", { name: "Launch readiness" })).toBeVisible();
    expect(screen.getByText("Please verify the launch checklist.")).toBeVisible();
  });

  it("reports selected Room history loading without inventing messages", () => {
    renderChat({ selectedRoom: null });

    expect(screen.getByRole("status")).toHaveTextContent("Loading Room history…");
    expect(screen.queryByRole("list", { name: "Room messages" })).toBeNull();
    expect(screen.queryByText("No messages yet")).toBeNull();
  });

  it("reports selected Room history unavailable when stale state has no detail", () => {
    renderChat({
      error: "Room history refresh failed.",
      selectedRoom: null,
      status: "stale",
    });

    expect(screen.getByText("Room history unavailable while SharedNet data is stale.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.queryByText("Loading Room history…")).toBeNull();
    expect(screen.queryByRole("list", { name: "Room messages" })).toBeNull();
  });

  it("schedules a Room from the empty state and opens its invite", async () => {
    const created = {
      ...roomSummary,
      description: "Ship the launch review",
      member_count: 0,
      name: "Launch review",
      room_id: "room_Launch:Sched.1" as RoomId,
    };
    const createRoom = vi.fn(async () => created);
    const { state } = renderChat({ createRoom, rooms: [], selectedRoom: null, selectedRoomId: null });

    fireEvent.change(screen.getByLabelText("Room name"), {
      target: { value: "  Launch review  " },
    });
    fireEvent.change(screen.getByPlaceholderText("Type here…"), {
      target: { value: "Ship the launch review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule Room" }));

    await waitFor(() => {
      expect(createRoom).toHaveBeenCalledWith({
        description: "Ship the launch review",
        name: "Launch review",
      });
    });
    const dialog = await screen.findByRole("dialog", {
      name: "Invite an Agent to Launch review",
    });
    expect(within(dialog).getByText("room_Launch:Sched.1")).toBeVisible();
    // The dialog opens on "Invite my Agents": one command that joins as this account.
    const command = within(dialog).getByLabelText("Command for my Agent").textContent ?? "";
    expect(command).toBe(`npx -y sharednet@latest join 'ROOM=room_Launch:Sched.1 TOKEN=${INVITE_TOKEN} BASE=${window.location.origin}' --claim ${CLAIM}`);
    expect(within(dialog).getByRole("button", { name: "Copy command" })).toBeVisible();
    // A chat connector has no shell, so the same pane carries the invite as one line.
    expect(within(dialog).getByLabelText("Invite for a chat connector")).toHaveTextContent(`ROOM=room_Launch:Sched.1 TOKEN=${INVITE_TOKEN} BASE=${window.location.origin}`);
    expect(within(dialog).getByText(/no terminal and will try to run it in a sandbox/)).toBeVisible();
    // "Ask people" is the link and its QR; "Other" is the guest protocol.
    fireEvent.click(within(dialog).getByRole("tab", { name: "Ask people to invite their Agents" }));
    expect(within(dialog).getByText(`${window.location.origin}/join/${INVITE_TOKEN}`)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Copy link" })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Other" }));
    const invite = within(dialog).getByLabelText("Local Agent instructions").textContent ?? "";
    expect(state.createInvite).toHaveBeenCalledWith("room_Launch:Sched.1");
    expect(invite).toContain("Join SharedNet Room room_Launch:Sched.1");
    expect(invite).toContain("ROOM=room_Launch:Sched.1");
    expect(invite).toContain(`TOKEN=${INVITE_TOKEN}`);
    expect(invite).toContain(`BASE=${window.location.origin}`);
    expect(invite).toContain('curl -s -X POST "$BASE/api/v1/rooms/$ROOM/join"');
    expect(invite).toContain('"$BASE/api/v1/rooms/$ROOM/wait?after=$LAST_SEQ"');
    expect(invite).toContain("Ship the launch review");
    // The CLI path leads, naming the login that makes a join an account's; curl stays as the fallback.
    expect(invite).toContain("sharednet login");
    expect(invite.indexOf("npx -y sharednet@latest join")).toBeLessThan(invite.indexOf("curl -s -X POST"));
    expect(within(dialog).getByRole("button", { name: "Copy invite" })).toBeVisible();
  });

  it("still hands out a command without a claim when none can be minted, and says why", async () => {
    const { state } = renderChat({ createClaim: vi.fn(async () => { throw new Error("no claim"); }) });
    fireEvent.click(screen.getByRole("button", { name: "Invite an Agent" }));
    const dialog = await screen.findByRole("dialog", { name: `Invite an Agent to ${roomDetail.room.name}` });
    expect(state.createClaim).toHaveBeenCalled();
    const command = within(dialog).getByLabelText("Command for my Agent").textContent ?? "";
    expect(command).toBe(`npx -y sharednet@latest join 'ROOM=${ROOM_ID} TOKEN=${INVITE_TOKEN} BASE=${window.location.origin}'`);
    expect(within(dialog).getByText(/could not be minted/)).toBeVisible();
  });

  it("closes the Room only after the human confirms", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { state } = renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Close Room" }));
    expect(confirm).toHaveBeenCalledWith(
      "Close Launch readiness? Members' tokens stop working; the history stays readable here.",
    );
    expect(state.closeRoom).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Room" }));
    await waitFor(() => expect(state.closeRoom).toHaveBeenCalledWith(ROOM_ID));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains when the Room cannot be closed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const closeRoom = vi.fn(async () => {
      throw new Error("Room not found");
    });
    renderChat({ closeRoom });

    fireEvent.click(screen.getByRole("button", { name: "Close Room" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not close the Room: Room not found",
    );
  });

  it("removes a member from the members panel", async () => {
    const { state } = renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Room actions" }));
    const members = screen.getByRole("list", { name: "Room members" });
    fireEvent.click(within(members).getByRole("button", { name: `Remove ${INSTANCE_ID}` }));

    await waitFor(() => expect(state.removeMember).toHaveBeenCalledWith(ROOM_ID, INSTANCE_ID));
  });

  it("offers neither invite nor close on a Room another account owns, and says whose it is", () => {
    renderChat({
      principal: { created_at: EARLIER, diagnostic_label: "Me", kind: "account", principal_id: "p_SomeoneElse" as PrincipalId, summary: "" },
    });
    expect(screen.queryByRole("button", { name: "Invite an Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Room" })).toBeNull();
    expect(screen.getByText(`Owned by ${PRINCIPAL_ID} · only the owner invites or closes`)).toBeVisible();
  });

  it("offers neither invite, close, nor remove on a closed Room", () => {
    renderChat({
      selectedRoom: { ...roomDetail, room: { ...roomDetail.room, status: "closed" } },
    });

    expect(screen.queryByRole("button", { name: "Invite an Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Room" })).toBeNull();
    expect(screen.getByText("Closed · history stays readable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Room actions" }));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("explains when an invite cannot be minted and opens no dialog", async () => {
    const createInvite = vi.fn(async () => {
      throw new Error("Room not found");
    });
    renderChat({ createInvite });

    fireEvent.click(screen.getByRole("button", { name: "Invite an Agent" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create an invite: Room not found",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains a failed schedule and keeps the form filled", async () => {
    const createRoom = vi.fn(async () => {
      throw new Error("Room name must be 1–120 characters");
    });
    renderChat({ createRoom, rooms: [], selectedRoom: null, selectedRoomId: null });

    fireEvent.change(screen.getByLabelText("Room name"), { target: { value: "Retro" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule Room" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Room name must be 1–120 characters",
    );
    expect(screen.getByLabelText("Room name")).toHaveValue("Retro");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("builds an invite for a Room ID the user already has", async () => {
    const { state } = renderChat({ rooms: [], selectedRoom: null, selectedRoomId: null });

    fireEvent.change(screen.getByLabelText("Already have a Room ID?"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite an Agent to it" }));
    expect(screen.getByRole("alert")).toHaveTextContent("A Room ID looks like rom_");

    fireEvent.change(screen.getByLabelText("Already have a Room ID?"), {
      target: { value: "rom_lxw0rfaLIb" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite an Agent to it" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite an Agent to rom_lxw0rfaLIb" });
    expect(state.createInvite).toHaveBeenCalledWith("rom_lxw0rfaLIb");
    fireEvent.click(within(dialog).getByRole("tab", { name: "Ask people to invite their Agents" }));
    expect(within(dialog).getByText(`${window.location.origin}/join/${INVITE_TOKEN}`)).toBeVisible();
    // The same link as a QR code, drawn on the page.
    const qr = await within(dialog).findByLabelText("Join link QR code");
    expect(qr.querySelector("svg")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Other" }));
    const invite = within(dialog).getByLabelText("Local Agent instructions").textContent ?? "";
    expect(invite).toContain("Join SharedNet Room rom_lxw0rfaLIb.");
    expect(invite).toContain(`Link for people: ${window.location.origin}/join/${INVITE_TOKEN}`);
    // The CLI comes first; the curl route is the fallback.
    expect(invite.indexOf("npx -y sharednet@latest join 'ROOM=rom_lxw0rfaLIb")).toBeLessThan(invite.indexOf('curl -s -X POST "$BASE/api/v1/rooms/$ROOM/join"'));
    expect(invite).toContain("sharednet login");
    expect(invite).toContain(`TOKEN=${INVITE_TOKEN}`);
  });

  it("invites another Agent from an open Room's header", async () => {
    const { state } = renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Invite an Agent" }));

    const dialog = await screen.findByRole("dialog", {
      name: `Invite an Agent to ${roomDetail.room.name}`,
    });
    expect(state.createInvite).toHaveBeenCalledWith(ROOM_ID);
    expect(within(dialog).getByText(ROOM_ID)).toBeVisible();
    expect(within(dialog).getByLabelText("Command for my Agent").textContent).toContain(`ROOM=${ROOM_ID}`);
    fireEvent.click(within(dialog).getByRole("tab", { name: "Other" }));
    expect(within(dialog).getByLabelText("Local Agent instructions").textContent).toContain(
      `Join SharedNet Room ${ROOM_ID}`,
    );
  });

  it("lists a guest member by the name it gave, with its own presence", () => {
    renderChat({
      selectedRoom: {
        ...roomDetail,
        memberships: [
          ...roomDetail.memberships,
          {
            agent_id: null,
            instance_id: "i_guest00001" as InstanceId,
            joined_at: NOW,
            kind: "guest",
            last_read_sequence: 0,
            admitted_by: "room_id",
            added_by_instance_id: null,
            left_at: null,
            member_id: "i_guest00001",
            name: "claude-code",
            presence: "away",
            principal_id: PRINCIPAL_ID,
            room_id: ROOM_ID,
            runtime: { kind: "codex", version: "0.1.0", entrypoint: null, source: "detected" },
            status: "active",
          },
        ],
        messages: [
          ...roomDetail.messages,
          {
            attachment_ids: [],
            content: "hello from curl",
            created_at: NOW,
            message_id: "message_launch.13" as MessageId,
            reply_to: null,
            resolution_state: "not_required",
            room_id: ROOM_ID,
            sender: { agent_id: null, name: "claude-code", principal_id: PRINCIPAL_ID },
            sequence: 13,
            tags: [],
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Room actions" }));
    const guest = screen.getByRole("article", { name: "Room member i_guest00001" });
    expect(within(guest).getByText("claude-code")).toBeVisible();
    expect(within(guest).getByText("Away")).toBeVisible();
    expect(guest).toHaveAttribute("data-presence", "away");
    expect(within(guest).getByText("Instance")).toBeVisible();

    const message = screen.getByRole("article", { name: "Message 13" });
    expect(within(message).getByText("Anonymous")).toBeVisible();
    expect(within(message).getByText("claude-code")).toBeVisible();
  });

  it("opens the scheduler from the sidebar when Rooms already exist", () => {
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "New Room" }));

    const dialog = screen.getByRole("dialog", { name: "Schedule a Room" });
    expect(within(dialog).getByLabelText("Room name")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Schedule Room" })).toBeDisabled();
  });

  it("has no composer: a Room is read here and written to by Agents", () => {
    renderChat();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue locally" })).toBeNull();
    expect(screen.queryByPlaceholderText("Type here…")).toBeNull();
  });

  it("opens the invite as a native modal with focus contained over an inert background", async () => {
    renderChat();
    const trigger = screen.getByRole("button", { name: "Invite an Agent" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: `Invite an Agent to ${roomDetail.room.name}` });
    const primaryAction = within(dialog).getByRole("button", { name: "Copy command" });
    await waitFor(() => expect(primaryAction).toHaveFocus());
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");
    expect(trigger.closest(".rooms-workspace")).toHaveAttribute("inert");
    expect(dialog.closest("[inert]")).toBeNull();
  });

  it("closes the invite on Escape and restores focus to the button that opened it", async () => {
    renderChat();
    const trigger = screen.getByRole("button", { name: "Invite an Agent" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: `Invite an Agent to ${roomDetail.room.name}` });
    const primaryAction = within(dialog).getByRole("button", { name: "Copy command" });
    await waitFor(() => expect(primaryAction).toHaveFocus());

    fireEvent.keyDown(primaryAction, { code: "Escape", key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    expect(trigger.closest(".rooms-workspace")).not.toHaveAttribute("inert");
  });

  it("copies the invite through Clipboard and reports success, or explains a failure", async () => {
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Invite an Agent" }));
    const dialog = await screen.findByRole("dialog", { name: `Invite an Agent to ${roomDetail.room.name}` });
    // On "Invite my Agents" the clipboard gets the command with the claim, and a line of what comes next.
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]![0])).toContain(`TOKEN=${INVITE_TOKEN} BASE=${window.location.origin}' --claim ${CLAIM}`);
    expect(String(writeText.mock.calls[0]![0])).toContain("npx -y sharednet@latest wait");
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard.");
    // On "Ask people" it gets the link alone.
    fireEvent.click(within(dialog).getByRole("tab", { name: "Ask people to invite their Agents" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(String(writeText.mock.calls[1]![0])).toBe(`${window.location.origin}/join/${INVITE_TOKEN}`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "Invite an Agent" }));
    const again = await screen.findByRole("dialog", { name: `Invite an Agent to ${roomDetail.room.name}` });
    fireEvent.click(within(again).getByRole("button", { name: "Copy command" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard access failed. Copy it manually.");
  });

  it("does not expose the removed demo workflow or synthetic accounting", () => {
    renderChat();

    expect(screen.queryByText(/Candidate World/i)).toBeNull();
    expect(screen.queryByText(/Agents assembled/i)).toBeNull();
    expect(screen.queryByText(/Agent work/i)).toBeNull();
    expect(screen.queryByText(/tokens/i)).toBeNull();
    expect(screen.queryByText(/recruit/i)).toBeNull();
  });
});
