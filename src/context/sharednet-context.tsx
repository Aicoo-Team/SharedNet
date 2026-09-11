"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  isDecisionProjection,
  isDecisionListResponse,
  isNetworkProjection,
  isProvisionAccountResponse,
  isRoomDetail,
  isRoomListResponse,
  isRoomSummary,
  type DecisionId,
  type DecisionProjection,
  type DecisionResolution,
  type NetworkProjection,
  type PairingId,
  type PrincipalProjection,
  isCloseRoomResponse,
  isCliClaimProjection,
  isCreateRoomInviteResponse,
  isRemoveRoomMemberResponse,
  isSeatNameResponse,
  isShareRoomResponse,
  isUnshareRoomResponse,
  type CliClaimProjection,
  type CreateRoomInviteResponse,
  type RoomMembership,
  type RoomProjection,
  type RoomDetail,
  type RoomId,
  type RoomSummary,
  type ShareRoomResponse,
} from "@/src/sharednet/contracts";

type SharedNetStatus = "loading" | "ready" | "stale";

export type CreateRoomInput = { description?: string | null; name: string };

type SharedNetContextValue = {
  claimPairing: (pairingId: PairingId) => Promise<void>;
  /** Close a Room this account owns; members' tokens stop working, history stays. */
  closeRoom: (roomId: RoomId) => Promise<RoomProjection>;
  /** Mint an invite token for a Room this account owns. The token is returned once. */
  createInvite: (roomId: RoomId) => Promise<CreateRoomInviteResponse>;
  /** Mint a one-time claim code for this account: the Agent that redeems it joins as this account. */
  createClaim: (label: string | null) => Promise<CliClaimProjection>;
  /** Schedule an empty Room owned by this account, then select it. */
  createRoom: (input: CreateRoomInput) => Promise<RoomSummary>;
  decisions: DecisionProjection[];
  error: string | null;
  network: NetworkProjection | null;
  principal: PrincipalProjection | null;
  resolveDecision: (
    decisionId: DecisionId,
    resolution: DecisionResolution,
  ) => Promise<void>;
  rooms: RoomSummary[];
  refresh: () => Promise<void>;
  /** Remove one member from a Room this account owns; its token stops working for it. */
  removeMember: (roomId: RoomId, memberId: string) => Promise<RoomMembership>;
  selectRoom: (roomId: RoomId) => void;
  selectedRoom: RoomDetail | null;
  selectedRoomId: RoomId | null;
  /**
   * Name a seat: your own takes a nickname the whole Room sees, anyone else's
   * takes a note only this account sees. An empty name takes it back off.
   */
  nameSeat: (instanceId: string, name: string | null) => Promise<string | null>;
  /** Publish a Room this account owns at a public link; the slug comes back with the Room. */
  shareRoom: (roomId: RoomId) => Promise<ShareRoomResponse>;
  status: SharedNetStatus;
  /** Stop publishing a Room this account owns; the link stops resolving at once. */
  unshareRoom: (roomId: RoomId) => Promise<RoomProjection>;
};

const SharedNetContext = createContext<SharedNetContextValue | null>(null);
const MUTATION_UNAVAILABLE_MESSAGE = "SharedNet mutation is unavailable.";

function mutationUnavailableError(): Error {
  return new Error(MUTATION_UNAVAILABLE_MESSAGE);
}

async function requestJson<T>(
  path: string,
  validator: (value: unknown) => value is T,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error("SharedNet request failed");

  const body: unknown = await response.json();
  if (!validator(body)) throw new Error("Invalid SharedNet response");
  return body;
}

export function SharedNetProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<PrincipalProjection | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [network, setNetwork] = useState<NetworkProjection | null>(null);
  const [decisions, setDecisions] = useState<DecisionProjection[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<RoomId | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<RoomDetail | null>(null);
  const [status, setStatus] = useState<SharedNetStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const bootstrapCompleteRef = useRef(false);
  const bootstrapRequestRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const mutationAbortControllerRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef(false);
  const roomsRef = useRef<RoomSummary[]>([]);
  const selectedRoomIdRef = useRef<RoomId | null>(null);

  const refresh = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    refreshInFlightRef.current = true;

    try {
      if (!bootstrapCompleteRef.current) {
        let bootstrapRequest = bootstrapRequestRef.current;
        if (bootstrapRequest === null) {
          bootstrapRequest = requestJson(
            "/api/sharednet/bootstrap",
            isProvisionAccountResponse,
            { method: "POST" },
          ).then(() => {
            bootstrapCompleteRef.current = true;
          });
          bootstrapRequestRef.current = bootstrapRequest;
        }
        try {
          await bootstrapRequest;
        } catch (cause) {
          if (bootstrapRequestRef.current === bootstrapRequest) {
            bootstrapRequestRef.current = null;
          }
          throw cause;
        }
        if (!mountedRef.current || generation !== generationRef.current) return;
      }

      const roomListRequest = requestJson(
        "/api/sharednet/rooms",
        isRoomListResponse,
        { signal: controller.signal },
      );
      const networkRequest = requestJson(
        "/api/sharednet/network",
        isNetworkProjection,
        { signal: controller.signal },
      );
      const decisionListRequest = requestJson(
        "/api/sharednet/decisions",
        isDecisionListResponse,
        { signal: controller.signal },
      );
      const roomSelectionRequest = roomListRequest.then(async (roomList) => {
        const currentSelection = selectedRoomIdRef.current;
        const nextSelectedRoomId =
          currentSelection &&
          roomList.rooms.some((room) => room.room_id === currentSelection)
            ? currentSelection
            : (roomList.rooms[0]?.room_id ?? null);
        if (nextSelectedRoomId === null) {
          return {
            detailFailed: false,
            nextSelectedRoom: null,
            nextSelectedRoomId,
          };
        }
        try {
          const nextSelectedRoom = await requestJson(
            `/api/sharednet/rooms/${encodeURIComponent(nextSelectedRoomId)}`,
            isRoomDetail,
            { signal: controller.signal },
          );
          return {
            detailFailed: false,
            nextSelectedRoom,
            nextSelectedRoomId,
          };
        } catch {
          return {
            detailFailed: true,
            nextSelectedRoom: null,
            nextSelectedRoomId,
          };
        }
      });
      const [roomListResult, roomSelectionResult, networkResult, decisionsResult] =
        await Promise.allSettled([
          roomListRequest,
          roomSelectionRequest,
          networkRequest,
          decisionListRequest,
        ]);
      if (!mountedRef.current || generation !== generationRef.current) return;

      if (roomListResult.status === "fulfilled") {
        roomsRef.current = roomListResult.value.rooms;
        setRooms(roomListResult.value.rooms);
      }
      if (roomSelectionResult.status === "fulfilled") {
        selectedRoomIdRef.current = roomSelectionResult.value.nextSelectedRoomId;
        setSelectedRoomId(roomSelectionResult.value.nextSelectedRoomId);
        if (roomSelectionResult.value.detailFailed) {
          setSelectedRoom((current) =>
            current?.room.room_id === roomSelectionResult.value.nextSelectedRoomId
              ? current
              : null,
          );
        } else {
          setSelectedRoom(roomSelectionResult.value.nextSelectedRoom);
        }
      }
      if (networkResult.status === "fulfilled") {
        setNetwork(networkResult.value);
        setPrincipal(networkResult.value.principal);
      }
      if (decisionsResult.status === "fulfilled") {
        setDecisions(decisionsResult.value.decisions);
      }

      const failed = [
        roomListResult,
        roomSelectionResult,
        networkResult,
        decisionsResult,
      ].some((result) => result.status === "rejected") ||
        (roomSelectionResult.status === "fulfilled" &&
          roomSelectionResult.value.detailFailed);
      setStatus(failed ? "stale" : "ready");
      setError(failed ? "SharedNet data may be out of date." : null);
    } catch {
      if (mountedRef.current && generation === generationRef.current) {
        setStatus("stale");
        setError("SharedNet data is unavailable.");
      }
    } finally {
      if (generation === generationRef.current) {
        refreshInFlightRef.current = false;
      }
    }
  }, []);

  const selectRoom = useCallback(
    (roomId: RoomId) => {
      if (!roomsRef.current.some((room) => room.room_id === roomId)) return;
      selectedRoomIdRef.current = roomId;
      setSelectedRoomId(roomId);
      setSelectedRoom((current) =>
        current?.room.room_id === roomId ? current : null,
      );
      void refresh();
    },
    [refresh],
  );

  const resolveDecision = useCallback(
    async (decisionId: DecisionId, resolution: DecisionResolution) => {
      const mutationController = mutationAbortControllerRef.current;
      if (
        !mountedRef.current ||
        mutationController === null ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      const body = {
        outcome: resolution.outcome,
        ...(resolution.responseText === undefined
          ? {}
          : { responseText: resolution.responseText }),
      };
      try {
        await requestJson(
          `/api/sharednet/decisions/${encodeURIComponent(decisionId)}`,
          isDecisionProjection,
          {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "PATCH",
            signal: mutationController.signal,
          },
        );
      } catch (cause) {
        if (
          !mountedRef.current ||
          mutationAbortControllerRef.current !== mutationController ||
          mutationController.signal.aborted
        ) {
          throw mutationUnavailableError();
        }
        throw cause;
      }
      if (
        !mountedRef.current ||
        mutationAbortControllerRef.current !== mutationController ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      await refresh();
      if (
        !mountedRef.current ||
        mutationAbortControllerRef.current !== mutationController ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
    },
    [refresh],
  );

  const createRoom = useCallback(
    async (input: CreateRoomInput) => {
      const mutationController = mutationAbortControllerRef.current;
      if (
        !mountedRef.current ||
        mutationController === null ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      let created: RoomSummary;
      try {
        created = await requestJson("/api/sharednet/rooms", isRoomSummary, {
          body: JSON.stringify({
            description: input.description ?? null,
            name: input.name,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: mutationController.signal,
        });
      } catch (cause) {
        if (
          !mountedRef.current ||
          mutationAbortControllerRef.current !== mutationController ||
          mutationController.signal.aborted
        ) {
          throw mutationUnavailableError();
        }
        throw cause;
      }
      if (
        !mountedRef.current ||
        mutationAbortControllerRef.current !== mutationController ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      // The next refresh keeps this selection because the new Room is in the list.
      selectedRoomIdRef.current = created.room_id;
      setSelectedRoomId(created.room_id);
      setSelectedRoom(null);
      await refresh();
      return created;
    },
    [refresh],
  );

  const createInvite = useCallback(async (roomId: RoomId) => {
    const mutationController = mutationAbortControllerRef.current;
    if (
      !mountedRef.current ||
      mutationController === null ||
      mutationController.signal.aborted
    ) {
      throw mutationUnavailableError();
    }
    return requestJson(
      `/api/sharednet/rooms/${encodeURIComponent(roomId)}/invites`,
      isCreateRoomInviteResponse,
      { method: "POST", signal: mutationController.signal },
    );
  }, []);

  const createClaim = useCallback(async (label: string | null) => {
    const mutationController = mutationAbortControllerRef.current;
    if (
      !mountedRef.current ||
      mutationController === null ||
      mutationController.signal.aborted
    ) {
      throw mutationUnavailableError();
    }
    return requestJson("/api/sharednet/cli/claims", isCliClaimProjection, {
      body: JSON.stringify({ label }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: mutationController.signal,
    });
  }, []);

  const closeRoom = useCallback(
    async (roomId: RoomId) => {
      const mutationController = mutationAbortControllerRef.current;
      if (
        !mountedRef.current ||
        mutationController === null ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      const { room } = await requestJson(
        `/api/sharednet/rooms/${encodeURIComponent(roomId)}/close`,
        isCloseRoomResponse,
        { method: "POST", signal: mutationController.signal },
      );
      await refresh();
      return room;
    },
    [refresh],
  );

  const nameSeat = useCallback(
    async (instanceId: string, name: string | null) => {
      const mutationController = mutationAbortControllerRef.current;
      if (!mountedRef.current || mutationController === null || mutationController.signal.aborted) {
        throw mutationUnavailableError();
      }
      const named = await requestJson(
        `/api/sharednet/instances/${encodeURIComponent(instanceId)}/name`,
        isSeatNameResponse,
        {
          body: JSON.stringify({ name }),
          headers: { "content-type": "application/json" },
          method: "PUT",
          signal: mutationController.signal,
        },
      );
      await refresh();
      return named.name;
    },
    [refresh],
  );

  const shareRoom = useCallback(
    async (roomId: RoomId) => {
      const mutationController = mutationAbortControllerRef.current;
      if (
        !mountedRef.current ||
        mutationController === null ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      const shared = await requestJson(
        `/api/sharednet/rooms/${encodeURIComponent(roomId)}/share`,
        isShareRoomResponse,
        { method: "POST", signal: mutationController.signal },
      );
      await refresh();
      return shared;
    },
    [refresh],
  );

  const unshareRoom = useCallback(
    async (roomId: RoomId) => {
      const mutationController = mutationAbortControllerRef.current;
      if (
        !mountedRef.current ||
        mutationController === null ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      const { room } = await requestJson(
        `/api/sharednet/rooms/${encodeURIComponent(roomId)}/share`,
        isUnshareRoomResponse,
        { method: "DELETE", signal: mutationController.signal },
      );
      await refresh();
      return room;
    },
    [refresh],
  );

  const removeMember = useCallback(
    async (roomId: RoomId, memberId: string) => {
      const mutationController = mutationAbortControllerRef.current;
      if (
        !mountedRef.current ||
        mutationController === null ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      const { membership } = await requestJson(
        `/api/sharednet/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`,
        isRemoveRoomMemberResponse,
        { method: "DELETE", signal: mutationController.signal },
      );
      await refresh();
      return membership;
    },
    [refresh],
  );

  const claimPairing = useCallback(
    async (pairingId: PairingId) => {
      const mutationController = mutationAbortControllerRef.current;
      if (
        !mountedRef.current ||
        mutationController === null ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      try {
        await requestJson(
          `/api/sharednet/pairings/${encodeURIComponent(pairingId)}/claim`,
          isDecisionProjection,
          { method: "POST", signal: mutationController.signal },
        );
      } catch (cause) {
        if (
          !mountedRef.current ||
          mutationAbortControllerRef.current !== mutationController ||
          mutationController.signal.aborted
        ) {
          throw mutationUnavailableError();
        }
        throw cause;
      }
      if (
        !mountedRef.current ||
        mutationAbortControllerRef.current !== mutationController ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
      await refresh();
      if (
        !mountedRef.current ||
        mutationAbortControllerRef.current !== mutationController ||
        mutationController.signal.aborted
      ) {
        throw mutationUnavailableError();
      }
    },
    [refresh],
  );

  useEffect(() => {
    const mutationController = new AbortController();
    mutationAbortControllerRef.current = mutationController;
    mountedRef.current = true;
    void refresh();
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (pollTimer === null) return;
      clearInterval(pollTimer);
      pollTimer = null;
    };
    const startPolling = () => {
      if (document.visibilityState !== "visible" || pollTimer !== null) return;
      pollTimer = setInterval(() => {
        if (!refreshInFlightRef.current) void refresh();
      }, 2_500);
    };
    const handleVisibilityChange = () => {
      stopPolling();
      if (document.visibilityState !== "visible") return;
      if (!refreshInFlightRef.current) void refresh();
      startPolling();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    startPolling();
    return () => {
      mountedRef.current = false;
      mutationController.abort();
      if (mutationAbortControllerRef.current === mutationController) {
        mutationAbortControllerRef.current = null;
      }
      abortControllerRef.current?.abort();
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  const value = useMemo(
    () => ({
      claimPairing,
      closeRoom,
      createInvite,
      createClaim,
      createRoom,
      decisions,
      error,
      nameSeat,
      network,
      principal,
      refresh,
      removeMember,
      resolveDecision,
      rooms,
      selectRoom,
      selectedRoom,
      selectedRoomId,
      shareRoom,
      status,
      unshareRoom,
    }),
    [
      claimPairing,
      closeRoom,
      createInvite,
      createClaim,
      createRoom,
      decisions,
      error,
      nameSeat,
      network,
      principal,
      refresh,
      removeMember,
      resolveDecision,
      rooms,
      selectRoom,
      selectedRoom,
      selectedRoomId,
      shareRoom,
      status,
      unshareRoom,
    ],
  );

  return (
    <SharedNetContext.Provider value={value}>
      {children}
    </SharedNetContext.Provider>
  );
}

export function useSharedNet(): SharedNetContextValue {
  const context = useContext(SharedNetContext);
  if (!context) {
    throw new Error("useSharedNet must be used inside SharedNetProvider");
  }
  return context;
}
