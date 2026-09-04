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
      last_read_sequence: 12,
      left_at: null,
      principal_id: PRINCIPAL_ID,
      room_id: ROOM_ID,
      status: "active",
    },
    {
      agent_id: SECOND_AGENT_ID,
      instance_id: SECOND_INSTANCE_ID,
      joined_at: EARLIER,
      last_read_sequence: 10,
      left_at: null,
      principal_id: SECOND_PRINCIPAL_ID,
      room_id: ROOM_ID,
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
      official: false,
      principal_id: PRINCIPAL_ID,
      role: "Local agent",
      summary: "Launch owner",
    },
    {
      agent_id: SECOND_AGENT_ID,
      created_at: EARLIER,
      diagnostic_label: "Reviewer",
      discoverability: true,
      official: false,
      principal_id: SECOND_PRINCIPAL_ID,
      role: "Review agent",
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
      heartbeat_state: "renewing",
      runtime_metadata: { cli_version: "0.1.0", device_id: "dev-a" },
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
      heartbeat_state: "stopped",
      runtime_metadata: { cli_version: "0.1.0" },
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

const DRAFT = "Review the release evidence before launch.";
const NEWER_DRAFT = "Preserve this newer handoff draft.";

function deferredClipboardWrite() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = (reason) => rejectPromise(reason);
  });

  return { promise, reject, resolve };
}

function emptyInstruction(draft: string): string {
  return `Build a SharedNet Room from your local Agent. Use this draft as the initial brief, post it locally as the Room's first plain-text message, and return the new Room ID:\n\n${draft}`;
}

function selectedInstruction(draft: string): string {
  return `Use SharedNet Room ${ROOM_ID}. Join it if needed, retrieve its current history first, then post this draft locally as a plain-text message from your current local Agent Instance. Return the resulting message ID/cursor:\n\n${draft}`;
}

function makeState(overrides: Partial<SharedNetState> = {}): SharedNetState {
  return {
    claimPairing: vi.fn(async () => undefined),
    decisions: [],
    error: null,
    network: null,
    principal: null,
    refresh: vi.fn(async () => undefined),
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

function enterDraftAndContinue(draft = DRAFT) {
  fireEvent.change(screen.getByLabelText("What do you want done?"), {
    target: { value: draft },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue locally" }));
}

describe("SharedNet Rooms", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("keeps the Rooms sidebar and local handoff composer visible when no Rooms exist", () => {
    renderChat({ rooms: [], selectedRoom: null, selectedRoomId: null });

    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(within(rooms).getByText("No rooms yet")).toBeVisible();
    expect(within(rooms).queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("What do you want done?")).toBeVisible();
    expect(screen.getByPlaceholderText("Type here…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue locally" })).toBeDisabled();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
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
    expect(screen.getByText("Latest cursor cursor_12")).toBeVisible();
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

    expect(provenance).toHaveTextContent(`Principal${PRINCIPAL_ID}`);
    expect(provenance).toHaveTextContent(`Agent${AGENT_ID}`);
    expect(provenance).toHaveTextContent(`Instance${INSTANCE_ID}`);
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

  it("builds the no-selection instruction and leaves the draft unsubmitted", () => {
    renderChat({ rooms: [], selectedRoom: null, selectedRoomId: null });

    enterDraftAndContinue();

    const dialog = screen.getByRole("dialog", {
      name: "Continue in SharedNet Local",
    });
    const instructions = within(dialog).getByLabelText("Local Agent instructions");
    expect(instructions.textContent).toBe(emptyInstruction(DRAFT));
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByLabelText("What do you want done?")).toHaveValue(DRAFT);
    expect(screen.queryByText(DRAFT, { selector: ".room-message-content" })).toBeNull();
  });

  it("builds the selected instruction with the exact Room ID and local return contract", () => {
    renderChat();

    enterDraftAndContinue();

    const instructions = screen.getByLabelText("Local Agent instructions");
    const instructionValue = instructions.textContent ?? "";
    expect(instructionValue).toBe(selectedInstruction(DRAFT));
    expect(instructionValue).toContain(ROOM_ID);
    expect(instructionValue).not.toContain(SECOND_ROOM_ID);
    expect(instructionValue).toContain("Join it if needed");
    expect(instructionValue).toContain("retrieve its current history first");
    expect(instructionValue).toContain("message ID/cursor");
  });

  it("opens a native modal with initial focus contained over an inert background", async () => {
    renderChat();
    const trigger = screen.getByRole("button", { name: "Continue locally" });
    trigger.focus();

    enterDraftAndContinue();

    const dialog = screen.getByRole("dialog", {
      name: "Continue in SharedNet Local",
    });
    const primaryAction = within(dialog).getByRole("button", {
      name: "Copy instructions",
    });
    const workspace = trigger.closest(".rooms-workspace");
    await waitFor(() => expect(primaryAction).toHaveFocus());
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(workspace).toHaveAttribute("inert");
    expect(dialog.closest("[inert]")).toBeNull();
  });

  it("closes the modal on Escape and restores focus to its Continue locally trigger", async () => {
    renderChat();
    const trigger = screen.getByRole("button", { name: "Continue locally" });
    trigger.focus();
    enterDraftAndContinue();

    const dialog = screen.getByRole("dialog", {
      name: "Continue in SharedNet Local",
    });
    const primaryAction = within(dialog).getByRole("button", {
      name: "Copy instructions",
    });
    await waitFor(() => expect(primaryAction).toHaveFocus());

    fireEvent.keyDown(primaryAction, { code: "Escape", key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    expect(trigger.closest(".rooms-workspace")).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("What do you want done?")).toHaveValue(DRAFT);
  });

  it("retains a visible composer focus indicator under product-window specificity", () => {
    const focusWithinRule = PRODUCT_SHELL_CSS.match(
      /\.room-composer:focus-within\s*\{([^}]*)\}/,
    )?.[1];
    expect(focusWithinRule).toContain("outline: 2px solid");
    expect(PRODUCT_SHELL_CSS).not.toMatch(
      /\.product-window \.room-composer:focus-within[^{]*\{[^}]*outline:\s*none;/,
    );
  });

  it("copies instructions through Clipboard and clears the draft only after success", async () => {
    renderChat();
    enterDraftAndContinue();

    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(selectedInstruction(DRAFT));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard.");
    expect(screen.getByLabelText("What do you want done?")).toHaveValue("");
    expect(
      screen.getByRole("dialog", { name: "Continue in SharedNet Local" }),
    ).toBeVisible();
  });

  it("restores focus to the composer after copied content disables the Continue trigger", async () => {
    renderChat();
    const textarea = screen.getByLabelText("What do you want done?");
    const trigger = screen.getByRole("button", { name: "Continue locally" });
    const workspace = trigger.closest(".rooms-workspace");
    enterDraftAndContinue();

    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    await screen.findByText("Copied to clipboard.");
    expect(trigger).toBeDisabled();
    expect(workspace).toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(textarea).toHaveFocus();
    expect(trigger).toBeDisabled();
    expect(workspace).not.toHaveAttribute("inert");
  });

  it("shows Clipboard failure and preserves the draft", async () => {
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    renderChat();
    enterDraftAndContinue();

    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Clipboard access failed. Copy the instructions manually.",
    );
    expect(screen.getByLabelText("What do you want done?")).toHaveValue(DRAFT);
    expect(
      screen.getByRole("dialog", { name: "Continue in SharedNet Local" }),
    ).toBeVisible();
  });

  it("ignores delayed Clipboard success from a closed dialog revision", async () => {
    const staleWrite = deferredClipboardWrite();
    writeText.mockReturnValueOnce(staleWrite.promise);
    renderChat();
    enterDraftAndContinue();
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.change(screen.getByLabelText("What do you want done?"), {
      target: { value: NEWER_DRAFT },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue locally" }));
    expect(
      screen.getByLabelText("Local Agent instructions").textContent,
    ).toBe(selectedInstruction(NEWER_DRAFT));

    await act(async () => {
      staleWrite.resolve();
      await staleWrite.promise;
    });

    expect(screen.getByLabelText("What do you want done?")).toHaveValue(
      NEWER_DRAFT,
    );
    expect(screen.queryByText("Copied to clipboard.")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy instructions" })).toBeVisible();
  });

  it("ignores delayed Clipboard failure from a closed dialog revision", async () => {
    const staleWrite = deferredClipboardWrite();
    writeText.mockReturnValueOnce(staleWrite.promise);
    renderChat();
    enterDraftAndContinue();
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.change(screen.getByLabelText("What do you want done?"), {
      target: { value: NEWER_DRAFT },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue locally" }));

    await act(async () => {
      staleWrite.reject(new Error("Old Clipboard denial"));
      await staleWrite.promise.catch(() => undefined);
    });

    expect(screen.getByLabelText("What do you want done?")).toHaveValue(
      NEWER_DRAFT,
    );
    expect(
      screen.queryByText("Clipboard access failed. Copy the instructions manually."),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Copy instructions" })).toBeVisible();
  });

  it("closes the dialog without clearing an uncopied draft", () => {
    renderChat();
    enterDraftAndContinue();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("What do you want done?")).toHaveValue(DRAFT);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("offers an explicit close-and-clear action", () => {
    renderChat();
    enterDraftAndContinue();

    fireEvent.click(screen.getByRole("button", { name: "Close and clear" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("What do you want done?")).toHaveValue("");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("restores focus to the composer when Close and clear disables the Continue trigger", async () => {
    renderChat();
    const textarea = screen.getByLabelText("What do you want done?");
    const trigger = screen.getByRole("button", { name: "Continue locally" });
    const workspace = trigger.closest(".rooms-workspace");
    enterDraftAndContinue();
    expect(workspace).toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "Close and clear" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveFocus();
    expect(trigger).toBeDisabled();
    expect(workspace).not.toHaveAttribute("inert");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("never POSTs a Room or message from browser handoff actions", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderChat();
    enterDraftAndContinue();

    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    const prohibitedWrites = fetchMock.mock.calls.filter(([input, init]) => {
      const path = String(input);
      const method = String(
        (init as RequestInit | undefined)?.method ?? "GET",
      ).toUpperCase();
      return (
        method === "POST" &&
        (path === "/api/sharednet/rooms" || path.includes("/messages"))
      );
    });
    expect(prohibitedWrites).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("list", { name: "Room messages" })).getAllByRole(
        "article",
      ),
    ).toHaveLength(2);
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
