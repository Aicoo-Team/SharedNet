import { StrictMode } from "react";

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
  DecisionId,
  DecisionProjection,
  InstanceId,
  PairingId,
  PrincipalId,
  RoomId,
} from "@/src/sharednet/contracts";

import { DecisionsView } from "./decisions-view";

type SharedNetState = ReturnType<
  (typeof import("@/src/context/sharednet-context"))["useSharedNet"]
>;

const contextMocks = vi.hoisted(() => ({
  useSharedNet: vi.fn(),
}));

const navigationMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("@/src/context/sharednet-context", () => ({
  useSharedNet: contextMocks.useSharedNet,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigationMocks.replace }),
  useSearchParams: () => navigationMocks.searchParams,
}));

const CREATED_AT = "2026-09-03T05:12:00+00:00";
const RESOLVED_AT = "2026-09-03T05:19:30+00:00";
const APPROVAL_ID = "decision_Launch:Approval.7" as DecisionId;
const TEXT_ID = "decision_Launch:Region.8" as DecisionId;
const APPROVED_ID = "decision_History:Approved.1" as DecisionId;
const DENIED_ID = "decision_History:Denied.2" as DecisionId;
const ANSWERED_ID = "decision_History:Answered.3" as DecisionId;
const ROOM_ID = "room_Launch:Alpha.7" as RoomId;
const PRINCIPAL_ID = "p_7CPHtWFsFn" as PrincipalId;
const AGENT_ID = "a_XHEYHw3zh8" as AgentId;
const INSTANCE_ID = "i_xQqH1Bafyt" as InstanceId;
const PAIRING_ID = "pairing_Launch:Alpha.7" as PairingId;

const approvalDecision: DecisionProjection = {
  consequence: "Production remains paused until a human approves it.",
  created_at: CREATED_AT,
  decision_id: APPROVAL_ID,
  description: "Review the signed launch evidence before production release.",
  requester: {
    agent_id: AGENT_ID,
    instance_id: INSTANCE_ID,
    principal_id: PRINCIPAL_ID,
  },
  resolved_at: null,
  response_mode: "approval",
  response_text: null,
  room_id: ROOM_ID,
  status: "pending",
  target_principal_id: PRINCIPAL_ID,
  title: "Approve the production launch",
};

const textDecision: DecisionProjection = {
  consequence: null,
  created_at: "2026-09-03T05:14:00+00:00",
  decision_id: TEXT_ID,
  description: "Choose the deployment region for the first production release.",
  requester: null,
  resolved_at: null,
  response_mode: "text",
  response_text: null,
  room_id: null,
  status: "pending",
  target_principal_id: PRINCIPAL_ID,
  title: "Which deployment region should launch first?",
};

const approvedDecision: DecisionProjection = {
  ...approvalDecision,
  decision_id: APPROVED_ID,
  resolved_at: RESOLVED_AT,
  response_text: "Signed evidence verified.",
  status: "approved",
  title: "Approve release candidate 4",
};

const deniedDecision: DecisionProjection = {
  ...approvalDecision,
  decision_id: DENIED_ID,
  resolved_at: "2026-09-03T05:20:00+00:00",
  response_text: "The rollback proof is incomplete.",
  status: "denied",
  title: "Approve the rollback plan",
};

const answeredDecision: DecisionProjection = {
  ...textDecision,
  decision_id: ANSWERED_ID,
  resolved_at: "2026-09-03T05:21:00+00:00",
  response_text: "Singapore",
  status: "answered",
  title: "Choose the primary region",
};

function makeState(overrides: Partial<SharedNetState> = {}): SharedNetState {
  return {
    claimPairing: vi.fn(async () => undefined),
    createRoom: vi.fn(async () => { throw new Error("createRoom not stubbed"); }),
    decisions: [
      approvalDecision,
      textDecision,
      approvedDecision,
      deniedDecision,
      answeredDecision,
    ],
    error: null,
    network: null,
    principal: null,
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

function renderDecisions(
  overrides: Partial<SharedNetState> = {},
  options: { strict?: boolean } = {},
) {
  const state = makeState(overrides);
  contextMocks.useSharedNet.mockReturnValue(state);
  const view = <DecisionsView />;

  return {
    state,
    ...render(options.strict ? <StrictMode>{view}</StrictMode> : view),
  };
}

function deferredVoid() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function selectedWorkbench(title: string) {
  return within(screen.getByRole("region", { name: "Pending decisions" })).getByRole(
    "article",
    { name: title },
  );
}

describe("SharedNet Decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationMocks.searchParams = new URLSearchParams();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders durable fields and complete requester provenance for the selected decision", () => {
    renderDecisions({ decisions: [approvalDecision] });

    const workbench = selectedWorkbench(approvalDecision.title);
    expect(within(workbench).getByText(approvalDecision.description)).toBeVisible();
    expect(within(workbench).getByText(approvalDecision.consequence!)).toBeVisible();
    expect(within(workbench).getByText("Pending")).toBeVisible();
    expect(within(workbench).getByText(CREATED_AT)).toHaveAttribute(
      "datetime",
      CREATED_AT,
    );
    expect(within(workbench).getByText("Not resolved")).toBeVisible();
    expect(within(workbench).getByText(ROOM_ID)).toBeVisible();
    expect(within(workbench).getByText(PRINCIPAL_ID)).toBeVisible();
    expect(within(workbench).getByText(AGENT_ID)).toBeVisible();
    expect(within(workbench).getByText(INSTANCE_ID)).toBeVisible();
  });

  it("renders nullable consequence, Room, response, and requester values without inventing provenance", () => {
    renderDecisions({ decisions: [textDecision] });

    const workbench = selectedWorkbench(textDecision.title);
    expect(within(workbench).getByText("No consequence provided.")).toBeVisible();
    expect(within(workbench).getByText("No Room")).toBeVisible();
    expect(within(workbench).getByText("No response yet.")).toBeVisible();
    expect(within(workbench).getByText("Requester not available")).toBeVisible();
    expect(within(workbench).queryByText(PRINCIPAL_ID)).toBeNull();
    expect(within(workbench).queryByText(AGENT_ID)).toBeNull();
    expect(within(workbench).queryByText(INSTANCE_ID)).toBeNull();
  });

  it("approves with the exact durable payload and omits a blank optional note", async () => {
    const resolveDecision = vi.fn(async () => undefined);
    renderDecisions({ decisions: [approvalDecision], resolveDecision });
    fireEvent.change(screen.getByLabelText("Optional note"), {
      target: { value: "   " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(resolveDecision).toHaveBeenCalledWith(APPROVAL_ID, {
        outcome: "approved",
      }),
    );
    expect(resolveDecision).toHaveBeenCalledTimes(1);
  });

  it("denies with the exact durable payload and no response text when the note is empty", async () => {
    const resolveDecision = vi.fn(async () => undefined);
    renderDecisions({ decisions: [approvalDecision], resolveDecision });

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(resolveDecision).toHaveBeenCalledWith(APPROVAL_ID, {
        outcome: "denied",
      }),
    );
    expect(resolveDecision).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Approve", "approved"],
    ["Deny", "denied"],
  ] as const)(
    "includes one trimmed optional note when choosing %s",
    async (buttonName, outcome) => {
      const resolveDecision = vi.fn(async () => undefined);
      renderDecisions({ decisions: [approvalDecision], resolveDecision });
      fireEvent.change(screen.getByLabelText("Optional note"), {
        target: { value: "  Verify the audit signature first.  " },
      });

      fireEvent.click(screen.getByRole("button", { name: buttonName }));

      await waitFor(() =>
        expect(resolveDecision).toHaveBeenCalledWith(APPROVAL_ID, {
          outcome,
          responseText: "Verify the audit signature first.",
        }),
      );
      expect(resolveDecision).toHaveBeenCalledTimes(1);
    },
  );

  it("requires a nonempty text answer and submits the exact answered payload", async () => {
    const resolveDecision = vi.fn(async () => undefined);
    renderDecisions({ decisions: [textDecision], resolveDecision });
    const answer = screen.getByLabelText("Your answer");
    const submit = screen.getByRole("button", { name: "Submit answer" });

    expect(submit).toBeDisabled();
    fireEvent.change(answer, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(answer, { target: { value: "  Singapore  " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(resolveDecision).toHaveBeenCalledWith(TEXT_ID, {
        outcome: "answered",
        responseText: "Singapore",
      }),
    );
    expect(resolveDecision).toHaveBeenCalledTimes(1);
  });

  it("disables the selected mutation controls and keeps the Decision pending until provider refresh resolves", async () => {
    const resolution = deferredVoid();
    const resolveDecision = vi.fn(() => resolution.promise);
    renderDecisions({ decisions: [approvalDecision], resolveDecision });
    fireEvent.change(screen.getByLabelText("Optional note"), {
      target: { value: "Keep this draft until refresh." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(resolveDecision).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.getByLabelText("Optional note")).toBeDisabled();
    expect(screen.getByLabelText("Optional note")).toHaveValue(
      "Keep this draft until refresh.",
    );
    expect(selectedWorkbench(approvalDecision.title)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show past decisions" }));
    expect(
      within(screen.getByRole("region", { name: "Resolved decisions" })).queryByText(
        approvalDecision.title,
      ),
    ).toBeNull();

    await act(async () => {
      resolution.resolve();
      await resolution.promise;
    });

    await waitFor(() => expect(screen.getByLabelText("Optional note")).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(selectedWorkbench(approvalDecision.title)).toBeVisible();
  });

  it("keeps a failed approval note and durable pending Decision available for retry", async () => {
    const resolveDecision = vi
      .fn()
      .mockRejectedValueOnce(new Error("sensitive backend detail"))
      .mockResolvedValueOnce(undefined);
    renderDecisions({ decisions: [approvalDecision], resolveDecision });
    fireEvent.change(screen.getByLabelText("Optional note"), {
      target: { value: "  Wait for the audit.  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Unable to save this decision. Try again.");
    expect(failure).not.toHaveTextContent("sensitive backend detail");
    expect(screen.getByLabelText("Optional note")).toHaveValue(
      "  Wait for the audit.  ",
    );
    expect(selectedWorkbench(approvalDecision.title)).toBeVisible();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(resolveDecision).toHaveBeenCalledTimes(2));
    expect(resolveDecision).toHaveBeenNthCalledWith(1, APPROVAL_ID, {
      outcome: "denied",
      responseText: "Wait for the audit.",
    });
    expect(resolveDecision).toHaveBeenNthCalledWith(2, APPROVAL_ID, {
      outcome: "denied",
      responseText: "Wait for the audit.",
    });
    await waitFor(() => expect(screen.getByLabelText("Optional note")).toHaveValue(""));
    expect(screen.queryByText("Unable to save this decision. Try again.")).toBeNull();
  });

  it("keeps a failed text answer for an answered retry", async () => {
    const resolveDecision = vi
      .fn()
      .mockRejectedValueOnce(new Error("request failed"))
      .mockResolvedValueOnce(undefined);
    renderDecisions({ decisions: [textDecision], resolveDecision });
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "  Singapore  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    await screen.findByText("Unable to save this decision. Try again.");
    expect(screen.getByLabelText("Your answer")).toHaveValue("  Singapore  ");
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => expect(resolveDecision).toHaveBeenCalledTimes(2));
    expect(resolveDecision).toHaveBeenNthCalledWith(2, TEXT_ID, {
      outcome: "answered",
      responseText: "Singapore",
    });
    await waitFor(() => expect(screen.getByLabelText("Your answer")).toHaveValue(""));
  });

  it("falls back to the first pending Decision when polling removes the selection", () => {
    const { rerender } = renderDecisions({
      decisions: [approvalDecision, textDecision],
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: `Open decision 2: ${textDecision.title}`,
      }),
    );
    expect(selectedWorkbench(textDecision.title)).toBeVisible();

    contextMocks.useSharedNet.mockReturnValue(
      makeState({ decisions: [approvalDecision, answeredDecision] }),
    );
    rerender(<DecisionsView />);

    expect(selectedWorkbench(approvalDecision.title)).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: `Open decision 1: ${approvalDecision.title}`,
      }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("keeps resolved history hidden until toggled and labels every durable outcome read-only", () => {
    renderDecisions({
      decisions: [approvedDecision, deniedDecision, answeredDecision],
    });

    expect(screen.queryByRole("region", { name: "Resolved decisions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show past decisions" }));

    const history = screen.getByRole("region", { name: "Resolved decisions" });
    const approved = within(history).getByRole("article", {
      name: approvedDecision.title,
    });
    const denied = within(history).getByRole("article", {
      name: deniedDecision.title,
    });
    const answered = within(history).getByRole("article", {
      name: answeredDecision.title,
    });
    expect(within(approved).getByText("Approved")).toBeVisible();
    expect(within(denied).getByText("Denied")).toBeVisible();
    expect(within(answered).getByText("Answered")).toBeVisible();
    expect(within(approved).getByText("Signed evidence verified.")).toBeVisible();
    expect(within(denied).getByText("The rollback proof is incomplete.")).toBeVisible();
    expect(within(answered).getByText("Singapore")).toBeVisible();
    expect(within(approved).getByText(RESOLVED_AT)).toHaveAttribute(
      "datetime",
      RESOLVED_AT,
    );
    expect(within(history).queryByRole("button")).toBeNull();
    expect(within(history).queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide past decisions" }));
    expect(screen.queryByRole("region", { name: "Resolved decisions" })).toBeNull();
  });

  it("shows loading without falsely claiming the durable queue is empty", () => {
    renderDecisions({ decisions: [], status: "loading" });

    expect(screen.getByRole("status")).toHaveTextContent("Loading decisions…");
    expect(screen.queryByText("No decisions need you.")).toBeNull();
  });

  it("reports stale empty data as unavailable instead of a genuine empty queue", () => {
    renderDecisions({
      decisions: [],
      error: "SharedNet data may be out of date.",
      status: "stale",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "SharedNet data may be out of date.",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Decisions unavailable while SharedNet data is stale.",
    );
    expect(screen.queryByText("No decisions need you.")).toBeNull();
  });

  it("shows a real empty queue only after SharedNet is ready", () => {
    renderDecisions({ decisions: [], status: "ready" });

    expect(screen.getByText("No decisions need you.")).toBeVisible();
    expect(screen.queryByText("Loading decisions…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show past decisions" }));
    expect(screen.getByText("No past decisions.")).toBeVisible();
  });

  it("keeps last-good Decisions visible while reporting stale provider data", () => {
    renderDecisions({
      decisions: [approvalDecision],
      error: "SharedNet data may be out of date.",
      status: "stale",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "SharedNet data may be out of date.",
    );
    expect(selectedWorkbench(approvalDecision.title)).toBeVisible();
  });

  it("waits for provider readiness before claiming a valid pairing exactly once", async () => {
    const claim = deferredVoid();
    const claimPairing = vi.fn(() => claim.promise);
    navigationMocks.searchParams = new URLSearchParams({ pairing: PAIRING_ID });
    const { rerender } = renderDecisions({
      claimPairing,
      decisions: [],
      status: "loading",
    });

    expect(claimPairing).not.toHaveBeenCalled();
    expect(navigationMocks.replace).not.toHaveBeenCalled();

    contextMocks.useSharedNet.mockReturnValue(
      makeState({ claimPairing, decisions: [], status: "ready" }),
    );
    rerender(<DecisionsView />);

    await waitFor(() => expect(claimPairing).toHaveBeenCalledWith(PAIRING_ID));
    expect(claimPairing).toHaveBeenCalledTimes(1);
    expect(navigationMocks.replace).not.toHaveBeenCalled();

    await act(async () => {
      claim.resolve();
      await claim.promise;
    });

    await waitFor(() =>
      expect(navigationMocks.replace).toHaveBeenCalledWith("/decisions"),
    );
    expect(navigationMocks.replace).toHaveBeenCalledTimes(1);
  });

  it("claims one valid pairing exactly once, ignores URL identity inputs, and cleans the URL after refresh", async () => {
    const claim = deferredVoid();
    const claimPairing = vi.fn(() => claim.promise);
    navigationMocks.searchParams = new URLSearchParams({
      agent_id: "a_pS0epN3RsY",
      instance_id: "i_uWXBpep8RP",
      pairing: PAIRING_ID,
      principal_id: "p_G1Hsy86THY",
    });
    const { rerender } = renderDecisions({ decisions: [], claimPairing });

    await waitFor(() => expect(claimPairing).toHaveBeenCalledWith(PAIRING_ID));
    expect(claimPairing).toHaveBeenCalledTimes(1);
    expect(claimPairing.mock.calls[0]).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Claiming pairing…");

    rerender(<DecisionsView />);
    expect(claimPairing).toHaveBeenCalledTimes(1);

    await act(async () => {
      claim.resolve();
      await claim.promise;
    });

    await waitFor(() => expect(navigationMocks.replace).toHaveBeenCalledWith("/decisions"));
    expect(navigationMocks.replace).toHaveBeenCalledTimes(1);
    expect(claimPairing).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByText("No decisions need you.")).toBeVisible();
  });

  it("claims a valid pairing only once under React Strict Mode", async () => {
    const claim = deferredVoid();
    const claimPairing = vi.fn(() => claim.promise);
    navigationMocks.searchParams = new URLSearchParams({ pairing: PAIRING_ID });
    renderDecisions({ decisions: [], claimPairing }, { strict: true });

    await waitFor(() => expect(claimPairing).toHaveBeenCalledTimes(1));

    await act(async () => {
      claim.resolve();
      await claim.promise;
    });
    await waitFor(() => expect(navigationMocks.replace).toHaveBeenCalledTimes(1));
  });

  it("rejects an invalid pairing locally without trusting any URL identity", async () => {
    const claimPairing = vi.fn(async () => undefined);
    navigationMocks.searchParams = new URLSearchParams({
      agent_id: "a_XHEYHw3zh8",
      pairing: "1-invalid-pairing",
      principal_id: "p_7CPHtWFsFn",
    });
    renderDecisions({ decisions: [], claimPairing });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This pairing link is invalid.",
    );
    expect(claimPairing).not.toHaveBeenCalled();
    expect(navigationMocks.replace).not.toHaveBeenCalled();
  });

  it("shows a safe pairing failure and retries only after explicit approval", async () => {
    const retry = deferredVoid();
    const claimPairing = vi
      .fn()
      .mockRejectedValueOnce(new Error("private pairing service detail"))
      .mockImplementationOnce(() => retry.promise);
    navigationMocks.searchParams = new URLSearchParams({ pairing: PAIRING_ID });
    renderDecisions({ decisions: [], claimPairing });

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Unable to claim this pairing. Try again.");
    expect(failure).not.toHaveTextContent("private pairing service detail");
    expect(claimPairing).toHaveBeenCalledTimes(1);
    expect(navigationMocks.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry pairing" }));

    await waitFor(() => expect(claimPairing).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Retry pairing" })).toBeDisabled();
    expect(claimPairing).toHaveBeenNthCalledWith(2, PAIRING_ID);

    await act(async () => {
      retry.resolve();
      await retry.promise;
    });
    await waitFor(() => expect(navigationMocks.replace).toHaveBeenCalledWith("/decisions"));
  });

  it("never exposes bulk, Room-message, delegation, recruitment, or execution writes", async () => {
    const fetchMock = vi.fn();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const resolveDecision = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    renderDecisions({ decisions: [approvalDecision], resolveDecision });

    expect(
      screen.queryByRole("button", {
        name: /approve all|post.*room|send.*message|delegate|recruit|execute/i,
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolveDecision).toHaveBeenCalledTimes(1));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
  });
});
