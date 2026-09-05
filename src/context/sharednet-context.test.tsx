import { useEffect, useState } from "react";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseDecisionId,
  parsePairingId,
  parseRoomId,
} from "@/src/sharednet/contracts";

import {
  SharedNetProvider,
  useSharedNet,
} from "./sharednet-context";

const NOW = "2026-09-03T05:00:00+00:00";
const PRINCIPAL_ID = "p_7CPHtWFsFn";
const FRESH_PRINCIPAL_ID = "p_odPBQxqOcm";
const AGENT_ID = "a_XHEYHw3zh8";
const RUNTIME_ID = "rt_brv633yxv2c0vbranwet0ekyfp";
const INSTANCE_ID = "i_xQqH1Bafyt";
const ROOM_ID = "room_launch";
const SECOND_ROOM_ID = "room_review";
const DECISION_ID = "decision_region";
const PAIRING_ID = "pairing.launch:1";
const parsedSecondRoomId = parseRoomId(SECOND_ROOM_ID)!;
const parsedDecisionId = parseDecisionId(DECISION_ID)!;
const parsedPairingId = parsePairingId(PAIRING_ID)!;

const principal = {
  created_at: NOW,
  diagnostic_label: "Xisen",
  kind: "human",
  principal_id: PRINCIPAL_ID,
  summary: "SharedNet account Principal",
};

const network = {
  agents: [],
  connected_principals: [],
  edges: [],
  instances: [],
  principal,
};

const freshNetwork = {
  ...network,
  principal: {
    ...principal,
    diagnostic_label: "Fresh account projection",
    principal_id: FRESH_PRINCIPAL_ID,
  },
};

const roomSummary = {
  description: "Coordinate the launch",
  latest_cursor: "cursor_1",
  latest_sequence: 1,
  member_count: 1,
  name: "Launch",
  owner_agent_ids: [AGENT_ID],
  room_id: ROOM_ID,
  status: "open",
  updated_at: NOW,
};

const secondRoomSummary = {
  ...roomSummary,
  description: "Review the launch",
  name: "Review",
  room_id: SECOND_ROOM_ID,
};

const actor = {
  agent_id: AGENT_ID,
  instance_id: INSTANCE_ID,
  principal_id: PRINCIPAL_ID,
};

const roomDetail = {
  memberships: [
    {
      agent_id: AGENT_ID,
      instance_id: INSTANCE_ID,
      joined_at: NOW,
      last_read_sequence: 1,
      left_at: null,
      principal_id: PRINCIPAL_ID,
      room_id: ROOM_ID,
      status: "active",
    },
  ],
  messages: [],
  next_cursor: "cursor_1",
  room: {
    access_policy: "principal_only",
    created_at: NOW,
    creator: actor,
    description: roomSummary.description,
    name: roomSummary.name,
    room_id: ROOM_ID,
    status: "open",
    updated_at: NOW,
  },
};

const secondRoomDetail = {
  ...roomDetail,
  memberships: roomDetail.memberships.map((membership) => ({
    ...membership,
    room_id: SECOND_ROOM_ID,
  })),
  room: {
    ...roomDetail.room,
    description: secondRoomSummary.description,
    name: secondRoomSummary.name,
    room_id: SECOND_ROOM_ID,
  },
};

const decision = {
  consequence: null,
  created_at: NOW,
  decision_id: DECISION_ID,
  description: "Choose one deployment region",
  requester: {
    agent_id: AGENT_ID,
    instance_id: INSTANCE_ID,
    principal_id: PRINCIPAL_ID,
  },
  resolved_at: null,
  response_mode: "text",
  response_text: null,
  room_id: ROOM_ID,
  status: "pending",
  target_principal_id: PRINCIPAL_ID,
  title: "Deployment region",
};

const resolvedDecision = {
  ...decision,
  resolved_at: NOW,
  response_text: "Ship it",
  status: "approved",
};

function StateProbe() {
  const state = useSharedNet();

  return (
    <dl>
      <dt>Status</dt>
      <dd>{state.status}</dd>
      <dt>Error</dt>
      <dd data-testid="error">{state.error ?? "none"}</dd>
      <dt>Principal</dt>
      <dd data-testid="principal-id">
        {state.principal?.principal_id ?? "none"}
      </dd>
      <dt>Rooms</dt>
      <dd data-testid="room-list">
        {state.rooms
          .map((room) => `${room.room_id}:${room.latest_sequence}`)
          .join(",") || "none"}
      </dd>
      <dt>Decisions</dt>
      <dd data-testid="decision-list">
        {state.decisions
          .map((item) => `${item.decision_id}:${item.status}`)
          .join(",") || "none"}
      </dd>
      <dt>Selected room</dt>
      <dd data-testid="selected-room-id">{state.selectedRoomId ?? "none"}</dd>
      <dt>Selected room detail</dt>
      <dd data-testid="selected-room-detail">
        {state.selectedRoom?.room.room_id ?? "none"}
      </dd>
      <button onClick={() => void state.refresh()} type="button">
        Refresh
      </button>
      <button onClick={() => state.selectRoom(parsedSecondRoomId)} type="button">
        Select review
      </button>
      <button
        onClick={() =>
          void state.resolveDecision(parsedDecisionId, {
            outcome: "approved",
            responseText: "Ship it",
          })
        }
        type="button"
      >
        Resolve decision
      </button>
      <button onClick={() => void state.claimPairing(parsedPairingId)} type="button">
        Claim pairing
      </button>
      <button
        onClick={() => void state.createRoom({ description: null, name: "Launch review" })}
        type="button"
      >
        Schedule room
      </button>
    </dl>
  );
}

function MutationProbe({
  kind,
  onMutation,
}: {
  kind: "claim" | "resolve";
  onMutation: (mutation: Promise<void>) => void;
}) {
  const state = useSharedNet();

  return (
    <>
      <span>{state.status}</span>
      <button
        onClick={() => {
          const mutation =
            kind === "resolve"
              ? state.resolveDecision(parsedDecisionId, {
                  outcome: "approved",
                  responseText: "Ship it",
                })
              : state.claimPairing(parsedPairingId);
          onMutation(mutation);
        }}
        type="button"
      >
        Start mutation
      </button>
      <button onClick={() => void state.refresh()} type="button">
        Refresh projections
      </button>
    </>
  );
}

function ColdMountClaimProbe() {
  const { claimPairing } = useSharedNet();
  const [outcome, setOutcome] = useState("pending");

  useEffect(() => {
    void claimPairing(parsedPairingId).then(
      () => setOutcome("fulfilled"),
      (cause: unknown) =>
        setOutcome(
          cause instanceof Error ? `rejected:${cause.message}` : "rejected:non-error",
        ),
    );
  }, [claimPairing]);

  return <span data-testid="cold-mount-claim">{outcome}</span>;
}

function successfulFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input);
  if (path === "/api/sharednet/bootstrap") {
    return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
  }
  if (path === "/api/sharednet/rooms") {
    return Promise.resolve(Response.json({ rooms: [roomSummary] }));
  }
  if (path === "/api/sharednet/network") {
    return Promise.resolve(Response.json(network));
  }
  if (path === `/api/sharednet/rooms/${ROOM_ID}`) {
    return Promise.resolve(Response.json(roomDetail));
  }
  if (path === "/api/sharednet/decisions") {
    return Promise.resolve(Response.json({ decisions: [decision] }));
  }
  return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("SharedNetProvider", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects a pairing claim started before the provider lifecycle is ready", async () => {
    const fetchMock = vi.fn(successfulFetch);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <ColdMountClaimProbe />
      </SharedNetProvider>,
    );

    expect(await screen.findByTestId("cold-mount-claim")).toHaveTextContent(
      "rejected:SharedNet mutation is unavailable.",
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "/api/sharednet/pairings/pairing.launch%3A1/claim",
    );
  });

  it("loads validated account projections in memory", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    vi.stubGlobal("fetch", vi.fn(successfulFetch));

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    expect(screen.getByText("loading")).toBeVisible();
    expect(await screen.findByText(PRINCIPAL_ID)).toBeVisible();
    expect(screen.getByText("ready")).toBeVisible();
    expect(screen.getByTestId("room-list")).toHaveTextContent(`${ROOM_ID}:1`);
    expect(screen.getByTestId("decision-list")).toHaveTextContent(
      `${DECISION_ID}:pending`,
    );
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("starts all projection reads only after bootstrap completes", async () => {
    const bootstrap = deferred<Response>();
    const rooms = deferred<Response>();
    const nextNetwork = deferred<Response>();
    const decisions = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/sharednet/bootstrap") return bootstrap.promise;
      if (path === "/api/sharednet/rooms") return rooms.promise;
      if (path === "/api/sharednet/network") return nextNetwork.promise;
      if (path === "/api/sharednet/decisions") return decisions.promise;
      return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sharednet/bootstrap");

    bootstrap.resolve(Response.json({ principal_id: PRINCIPAL_ID }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(
      fetchMock.mock.calls.slice(1).map(([input]) => String(input)).sort(),
    ).toEqual([
      "/api/sharednet/decisions",
      "/api/sharednet/network",
      "/api/sharednet/rooms",
    ]);

    rooms.resolve(Response.json({ rooms: [] }));
    nextNetwork.resolve(Response.json(network));
    decisions.resolve(Response.json({ decisions: [] }));

    expect(await screen.findByText(PRINCIPAL_ID)).toBeVisible();
  });

  it("shares one in-flight bootstrap across overlapping refreshes", async () => {
    const bootstrap = deferred<Response>();
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        if (path === "/api/sharednet/bootstrap") {
          return new Promise((resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
            void bootstrap.promise.then(resolve, reject);
          });
        }
        if (path === "/api/sharednet/rooms") {
          return Promise.resolve(Response.json({ rooms: [] }));
        }
        if (path === "/api/sharednet/network") {
          return Promise.resolve(Response.json(network));
        }
        if (path === "/api/sharednet/decisions") {
          return Promise.resolve(Response.json({ decisions: [] }));
        }
        return Promise.reject(
          new Error(`Unexpected Dashboard request: ${path}`),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/sharednet/bootstrap",
      ),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/sharednet/bootstrap",
      ),
    ).toHaveLength(1);

    bootstrap.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
    expect(await screen.findByText(PRINCIPAL_ID)).toBeVisible();
    expect(screen.getByText("ready")).toBeVisible();
  });

  it("retries bootstrap after a genuine failed attempt", async () => {
    let bootstrapCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === "/api/sharednet/bootstrap") {
        bootstrapCalls += 1;
        return Promise.resolve(
          bootstrapCalls === 1
            ? new Response(null, { status: 503 })
            : Response.json({ principal_id: PRINCIPAL_ID }),
        );
      }
      if (path === "/api/sharednet/rooms") {
        return Promise.resolve(Response.json({ rooms: [] }));
      }
      if (path === "/api/sharednet/network") {
        return Promise.resolve(Response.json(network));
      }
      if (path === "/api/sharednet/decisions") {
        return Promise.resolve(Response.json({ decisions: [] }));
      }
      return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    expect(await screen.findByText("stale")).toBeVisible();
    expect(bootstrapCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(PRINCIPAL_ID)).toBeVisible();
    expect(screen.getByText("ready")).toBeVisible();
    expect(bootstrapCalls).toBe(2);
  });

  it("loads detail for the first room returned by the scoped list", async () => {
    const fetchMock = vi.fn(successfulFetch);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    expect(await screen.findByTestId("selected-room-detail")).toHaveTextContent(
      ROOM_ID,
    );
    expect(screen.getByTestId("selected-room-id")).toHaveTextContent(ROOM_ID);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      `/api/sharednet/rooms/${ROOM_ID}`,
    );
  });

  it("starts room detail only after that room appears in the returned list", async () => {
    const rooms = deferred<Response>();
    const nextNetwork = deferred<Response>();
    const decisions = deferred<Response>();
    const detail = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/sharednet/bootstrap") {
        return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
      }
      if (path === "/api/sharednet/rooms") return rooms.promise;
      if (path === "/api/sharednet/network") return nextNetwork.promise;
      if (path === "/api/sharednet/decisions") return decisions.promise;
      if (path === `/api/sharednet/rooms/${ROOM_ID}`) return detail.promise;
      return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      `/api/sharednet/rooms/${ROOM_ID}`,
    );

    rooms.resolve(Response.json({ rooms: [roomSummary] }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
        `/api/sharednet/rooms/${ROOM_ID}`,
      );
    });

    detail.resolve(Response.json(roomDetail));
    nextNetwork.resolve(Response.json(network));
    decisions.resolve(Response.json({ decisions: [] }));
    expect(await screen.findByText("ready")).toBeVisible();
  });

  it("retains last-good data when one projection refresh is malformed", async () => {
    let roomListReads = 0;
    let networkReads = 0;
    let decisionReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/sharednet/bootstrap") {
        return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
      }
      if (path === "/api/sharednet/rooms") {
        roomListReads += 1;
        return Promise.resolve(
          Response.json({
            rooms: [
              roomListReads === 1
                ? roomSummary
                : {
                    ...roomSummary,
                    latest_cursor: "cursor_2",
                    latest_sequence: 2,
                  },
            ],
          }),
        );
      }
      if (path === `/api/sharednet/rooms/${ROOM_ID}`) {
        return Promise.resolve(Response.json(roomDetail));
      }
      if (path === "/api/sharednet/network") {
        networkReads += 1;
        return Promise.resolve(
          Response.json(
            networkReads === 1
              ? network
              : { ...network, principal: { ...principal, principalId: PRINCIPAL_ID } },
          ),
        );
      }
      if (path === "/api/sharednet/decisions") {
        decisionReads += 1;
        return Promise.resolve(
          Response.json({ decisions: decisionReads === 1 ? [decision] : [] }),
        );
      }
      return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    expect(await screen.findByText("ready")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("stale")).toBeVisible();
    expect(screen.getByText(PRINCIPAL_ID)).toBeVisible();
    expect(screen.getByTestId("room-list")).toHaveTextContent(`${ROOM_ID}:2`);
    expect(screen.getByTestId("decision-list")).toHaveTextContent("none");
    expect(screen.getByTestId("error")).not.toHaveTextContent("none");
  });

  it("aborts requests from the prior refresh generation", async () => {
    const firstRooms = deferred<Response>();
    const firstNetwork = deferred<Response>();
    const firstDecisions = deferred<Response>();
    const readCounts = new Map<string, number>();
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        if (path === "/api/sharednet/bootstrap") {
          return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
        }

        const count = (readCounts.get(path) ?? 0) + 1;
        readCounts.set(path, count);
        if (count === 1) {
          if (path === "/api/sharednet/rooms") return firstRooms.promise;
          if (path === "/api/sharednet/network") return firstNetwork.promise;
          if (path === "/api/sharednet/decisions") return firstDecisions.promise;
        }
        if (path === "/api/sharednet/rooms") {
          return Promise.resolve(Response.json({ rooms: [] }));
        }
        if (path === "/api/sharednet/network") {
          return Promise.resolve(Response.json(network));
        }
        if (path === "/api/sharednet/decisions") {
          return Promise.resolve(Response.json({ decisions: [] }));
        }
        return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const firstReadSignals = fetchMock.mock.calls
      .slice(1, 4)
      .map(([, init]) => init?.signal);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    expect(firstReadSignals).toHaveLength(3);
    for (const signal of firstReadSignals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
    }

    firstRooms.resolve(Response.json({ rooms: [] }));
    firstNetwork.resolve(Response.json(network));
    firstDecisions.resolve(Response.json({ decisions: [] }));
  });

  it("ignores late results from an older refresh generation", async () => {
    const firstRooms = deferred<Response>();
    const firstNetwork = deferred<Response>();
    const firstDecisions = deferred<Response>();
    const readCounts = new Map<string, number>();
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === "/api/sharednet/bootstrap") {
        return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
      }

      const count = (readCounts.get(path) ?? 0) + 1;
      readCounts.set(path, count);
      if (count === 1) {
        if (path === "/api/sharednet/rooms") return firstRooms.promise;
        if (path === "/api/sharednet/network") return firstNetwork.promise;
        if (path === "/api/sharednet/decisions") return firstDecisions.promise;
      }
      if (path === "/api/sharednet/rooms") {
        return Promise.resolve(Response.json({ rooms: [] }));
      }
      if (path === "/api/sharednet/network") {
        return Promise.resolve(Response.json(freshNetwork));
      }
      if (path === "/api/sharednet/decisions") {
        return Promise.resolve(Response.json({ decisions: [] }));
      }
      return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(screen.getByTestId("principal-id")).toHaveTextContent(
        FRESH_PRINCIPAL_ID,
      );
    });

    await act(async () => {
      firstRooms.resolve(Response.json({ rooms: [] }));
      firstNetwork.resolve(Response.json(network));
      firstDecisions.resolve(Response.json({ decisions: [decision] }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("principal-id")).toHaveTextContent(
      FRESH_PRINCIPAL_ID,
    );
    expect(screen.getByTestId("decision-list")).toHaveTextContent("none");
  });

  it("retains a selected listed room and falls back when it disappears", async () => {
    let roomListReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === "/api/sharednet/bootstrap") {
        return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
      }
      if (path === "/api/sharednet/rooms") {
        roomListReads += 1;
        return Promise.resolve(
          Response.json({
            rooms:
              roomListReads < 4
                ? [roomSummary, secondRoomSummary]
                : [roomSummary],
          }),
        );
      }
      if (path === `/api/sharednet/rooms/${ROOM_ID}`) {
        return Promise.resolve(Response.json(roomDetail));
      }
      if (path === `/api/sharednet/rooms/${SECOND_ROOM_ID}`) {
        return Promise.resolve(Response.json(secondRoomDetail));
      }
      if (path === "/api/sharednet/network") {
        return Promise.resolve(Response.json(network));
      }
      if (path === "/api/sharednet/decisions") {
        return Promise.resolve(Response.json({ decisions: [] }));
      }
      return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-room-detail")).toHaveTextContent(ROOM_ID);
    });
    fireEvent.click(screen.getByRole("button", { name: "Select review" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-room-detail")).toHaveTextContent(
        SECOND_ROOM_ID,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(roomListReads).toBe(3));
    expect(screen.getByTestId("selected-room-id")).toHaveTextContent(
      SECOND_ROOM_ID,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-room-detail")).toHaveTextContent(ROOM_ID);
    });
    expect(screen.getByTestId("selected-room-id")).toHaveTextContent(ROOM_ID);
  });

  it("clears mismatched detail when fallback room detail fails", async () => {
    let roomListReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === "/api/sharednet/bootstrap") {
        return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
      }
      if (path === "/api/sharednet/rooms") {
        roomListReads += 1;
        return Promise.resolve(
          Response.json({
            rooms: roomListReads === 1 ? [roomSummary] : [secondRoomSummary],
          }),
        );
      }
      if (path === `/api/sharednet/rooms/${ROOM_ID}`) {
        return Promise.resolve(Response.json(roomDetail));
      }
      if (path === `/api/sharednet/rooms/${SECOND_ROOM_ID}`) {
        return Promise.reject(new Error("room detail unavailable"));
      }
      if (path === "/api/sharednet/network") {
        return Promise.resolve(Response.json(network));
      }
      if (path === "/api/sharednet/decisions") {
        return Promise.resolve(Response.json({ decisions: [] }));
      }
      return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-room-detail")).toHaveTextContent(ROOM_ID);
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("stale")).toBeVisible();
    expect(screen.getByTestId("room-list")).toHaveTextContent(
      `${SECOND_ROOM_ID}:1`,
    );
    expect(screen.getByTestId("selected-room-id")).toHaveTextContent(
      SECOND_ROOM_ID,
    );
    expect(screen.getByTestId("selected-room-detail")).toHaveTextContent("none");
  });

  it("pauses polling while hidden and resumes on a 2.5 second cadence", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    const fetchMock = vi.fn(successfulFetch);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );
    await flushMicrotasks();

    expect(screen.getByText("ready")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(5);

    visibilityState = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(9);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_499);
    });
    expect(fetchMock).toHaveBeenCalledTimes(9);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(13);
  });

  it("skips automatic poll ticks while a refresh is still in flight", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const slowRooms = deferred<Response>();
    const slowNetwork = deferred<Response>();
    const slowDecisions = deferred<Response>();
    const readCounts = new Map<string, number>();
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        if (path === "/api/sharednet/bootstrap") {
          return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
        }

        const count = (readCounts.get(path) ?? 0) + 1;
        readCounts.set(path, count);
        if (count === 2) {
          if (path === "/api/sharednet/rooms") return slowRooms.promise;
          if (path === "/api/sharednet/network") return slowNetwork.promise;
          if (path === "/api/sharednet/decisions") return slowDecisions.promise;
        }
        if (path === "/api/sharednet/rooms") {
          return Promise.resolve(Response.json({ rooms: [] }));
        }
        if (path === "/api/sharednet/network") {
          return Promise.resolve(Response.json(network));
        }
        if (path === "/api/sharednet/decisions") {
          return Promise.resolve(Response.json({ decisions: [] }));
        }
        return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    const slowSignals = fetchMock.mock.calls.slice(4, 7).map(([, init]) => init?.signal);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const signal of slowSignals) expect(signal?.aborted).toBe(false);

    slowRooms.resolve(Response.json({ rooms: [] }));
    slowNetwork.resolve(Response.json(network));
    slowDecisions.resolve(Response.json({ decisions: [] }));
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it.each([
    [
      "resolveDecision",
      "resolve" as const,
      `/api/sharednet/decisions/${DECISION_ID}`,
      resolvedDecision,
    ],
    [
      "claimPairing",
      "claim" as const,
      "/api/sharednet/pairings/pairing.launch%3A1/claim",
      decision,
    ],
  ])(
    "aborts %s on provider unmount without starting refresh reads",
    async (_label, kind, mutationPath, mutationResult) => {
      const mutationResponse = deferred<Response>();
      let mutationInit: RequestInit | undefined;
      let mutationPromise: Promise<void> | null = null;
      let providerUnmounted = false;
      let postUnmountProjectionReads = 0;
      const projectionPaths = new Set([
        "/api/sharednet/rooms",
        "/api/sharednet/network",
        "/api/sharednet/decisions",
      ]);
      const fetchMock = vi.fn(
        (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const path = String(input);
          if (projectionPaths.has(path) && providerUnmounted) {
            postUnmountProjectionReads += 1;
          }
          if (path === "/api/sharednet/bootstrap") {
            return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
          }
          if (path === "/api/sharednet/rooms") {
            return Promise.resolve(Response.json({ rooms: [] }));
          }
          if (path === "/api/sharednet/network") {
            return Promise.resolve(Response.json(network));
          }
          if (path === "/api/sharednet/decisions") {
            return Promise.resolve(Response.json({ decisions: [] }));
          }
          if (path === mutationPath) {
            mutationInit = init;
            return mutationResponse.promise;
          }
          return Promise.reject(
            new Error(`Unexpected Dashboard request: ${path}`),
          );
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const view = render(
        <SharedNetProvider>
          <MutationProbe
            kind={kind}
            onMutation={(mutation) => {
              mutationPromise = mutation;
            }}
          />
        </SharedNetProvider>,
      );

      expect(await screen.findByText("ready")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Start mutation" }));
      await waitFor(() => expect(mutationPromise).not.toBeNull());
      const pendingMutation = mutationPromise;
      if (pendingMutation === null) throw new Error("Mutation did not start");

      providerUnmounted = true;
      view.unmount();
      mutationResponse.resolve(Response.json(mutationResult));
      await expect(pendingMutation).rejects.toThrow(
        "SharedNet mutation is unavailable.",
      );

      expect.soft(mutationInit?.signal).toBeInstanceOf(AbortSignal);
      expect.soft(mutationInit?.signal?.aborted).toBe(true);
      expect.soft(postUnmountProjectionReads).toBe(0);
    },
  );

  it("keeps an in-flight mutation alive across an ordinary refresh", async () => {
    const mutationResponse = deferred<Response>();
    let mutationInit: RequestInit | undefined;
    let mutationPromise: Promise<void> | null = null;
    let networkReads = 0;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        if (path === "/api/sharednet/bootstrap") {
          return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
        }
        if (path === "/api/sharednet/rooms") {
          return Promise.resolve(Response.json({ rooms: [] }));
        }
        if (path === "/api/sharednet/network") {
          networkReads += 1;
          return Promise.resolve(Response.json(network));
        }
        if (path === "/api/sharednet/decisions") {
          return Promise.resolve(Response.json({ decisions: [] }));
        }
        if (path === `/api/sharednet/decisions/${DECISION_ID}`) {
          mutationInit = init;
          return mutationResponse.promise;
        }
        return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <MutationProbe
          kind="resolve"
          onMutation={(mutation) => {
            mutationPromise = mutation;
          }}
        />
      </SharedNetProvider>,
    );

    expect(await screen.findByText("ready")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start mutation" }));
    await waitFor(() => expect(mutationPromise).not.toBeNull());
    const pendingMutation = mutationPromise;
    if (pendingMutation === null) throw new Error("Mutation did not start");

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh projections" }),
    );
    await waitFor(() => expect(networkReads).toBe(2));
    const abortedByRefresh = mutationInit?.signal?.aborted;

    mutationResponse.resolve(Response.json(resolvedDecision));
    await act(async () => {
      await pendingMutation;
    });

    expect(mutationInit?.signal).toBeInstanceOf(AbortSignal);
    expect(abortedByRefresh).toBe(false);
  });

  it("schedules a Room, then selects it once the refreshed list contains it", async () => {
    const scheduled = {
      ...roomSummary,
      member_count: 0,
      name: "Launch review",
      room_id: "rom_sched00001",
    };
    let roomsScheduled = false;
    const requestLog: Array<{ init?: RequestInit; path: string }> = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        requestLog.push({ init, path });
        if (path === "/api/sharednet/bootstrap") {
          return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
        }
        if (path === "/api/sharednet/rooms" && init?.method === "POST") {
          roomsScheduled = true;
          return Promise.resolve(Response.json(scheduled));
        }
        if (path === "/api/sharednet/rooms") {
          return Promise.resolve(
            Response.json({ rooms: roomsScheduled ? [roomSummary, scheduled] : [roomSummary] }),
          );
        }
        if (path === `/api/sharednet/rooms/${ROOM_ID}`) {
          return Promise.resolve(Response.json(roomDetail));
        }
        if (path === "/api/sharednet/rooms/rom_sched00001") {
          return Promise.resolve(
            Response.json({
              ...roomDetail,
              memberships: [],
              messages: [],
              room: { ...roomDetail.room, name: "Launch review", room_id: "rom_sched00001" },
            }),
          );
        }
        if (path === "/api/sharednet/network") {
          return Promise.resolve(Response.json(network));
        }
        if (path === "/api/sharednet/decisions") {
          return Promise.resolve(Response.json({ decisions: [] }));
        }
        return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-room-id")).toHaveTextContent(ROOM_ID);
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule room" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-room-detail")).toHaveTextContent("rom_sched00001");
    });

    const mutation = requestLog.find(
      ({ init, path }) => path === "/api/sharednet/rooms" && init?.method === "POST",
    );
    expect(mutation?.init).toMatchObject({
      body: JSON.stringify({ description: null, name: "Launch review" }),
      method: "POST",
    });
    expect(screen.getByTestId("room-list")).toHaveTextContent("rom_sched00001:");
  });

  it("resolves a durable decision and then refreshes projections", async () => {
    let decisionReads = 0;
    const requestLog: Array<{ init?: RequestInit; path: string }> = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        requestLog.push({ init, path });
        if (path === "/api/sharednet/bootstrap") {
          return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
        }
        if (path === "/api/sharednet/rooms") {
          return Promise.resolve(Response.json({ rooms: [] }));
        }
        if (path === "/api/sharednet/network") {
          return Promise.resolve(Response.json(network));
        }
        if (path === "/api/sharednet/decisions") {
          decisionReads += 1;
          return Promise.resolve(
            Response.json({
              decisions: [decisionReads === 1 ? decision : resolvedDecision],
            }),
          );
        }
        if (path === `/api/sharednet/decisions/${DECISION_ID}`) {
          return Promise.resolve(Response.json(resolvedDecision));
        }
        return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("decision-list")).toHaveTextContent(
        `${DECISION_ID}:pending`,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Resolve decision" }));
    await waitFor(() => {
      expect(screen.getByTestId("decision-list")).toHaveTextContent(
        `${DECISION_ID}:approved`,
      );
    });

    const mutationIndex = requestLog.findIndex(
      ({ path }) => path === `/api/sharednet/decisions/${DECISION_ID}`,
    );
    expect(mutationIndex).toBeGreaterThan(-1);
    expect(requestLog[mutationIndex]?.init).toMatchObject({
      body: JSON.stringify({ outcome: "approved", responseText: "Ship it" }),
      method: "PATCH",
    });
    expect(
      requestLog
        .slice(mutationIndex + 1)
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "/api/sharednet/decisions",
      "/api/sharednet/network",
      "/api/sharednet/rooms",
    ]);
    expect(requestLog.some(({ path }) => path.includes("/messages"))).toBe(false);
  });

  it("claims a parsed pairing and then refreshes projections", async () => {
    let decisionReads = 0;
    const requestLog: Array<{ init?: RequestInit; path: string }> = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = String(input);
        requestLog.push({ init, path });
        if (path === "/api/sharednet/bootstrap") {
          return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
        }
        if (path === "/api/sharednet/rooms") {
          return Promise.resolve(Response.json({ rooms: [] }));
        }
        if (path === "/api/sharednet/network") {
          return Promise.resolve(Response.json(network));
        }
        if (path === "/api/sharednet/decisions") {
          decisionReads += 1;
          return Promise.resolve(
            Response.json({ decisions: decisionReads === 1 ? [] : [decision] }),
          );
        }
        if (path === "/api/sharednet/pairings/pairing.launch%3A1/claim") {
          return Promise.resolve(Response.json(decision));
        }
        return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SharedNetProvider>
        <StateProbe />
      </SharedNetProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("decision-list")).toHaveTextContent("none");
      expect(screen.getByText("ready")).toBeVisible();
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim pairing" }));
    await waitFor(() => {
      expect(screen.getByTestId("decision-list")).toHaveTextContent(
        `${DECISION_ID}:pending`,
      );
    });

    const mutationPath = "/api/sharednet/pairings/pairing.launch%3A1/claim";
    const mutationIndex = requestLog.findIndex(({ path }) => path === mutationPath);
    expect(mutationIndex).toBeGreaterThan(-1);
    expect(requestLog[mutationIndex]?.init).toMatchObject({ method: "POST" });
    expect(requestLog[mutationIndex]?.init?.body).toBeUndefined();
    expect(
      requestLog
        .slice(mutationIndex + 1)
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "/api/sharednet/decisions",
      "/api/sharednet/network",
      "/api/sharednet/rooms",
    ]);
  });
});
