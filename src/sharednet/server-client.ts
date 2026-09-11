import "server-only";

import { getDatabase } from "@/packages/db/src/client.ts";
import { PostgresSharedNetRepository } from "@/packages/server/src/postgres-repository.ts";
import {
  type DecisionAnswer,
  type DecisionOverview,
  RepositoryError,
  type CreditsOverview,
  type SharedNetRepository,
  type SharedRoomView,
} from "@/packages/server/src/repository.ts";
import {
  type Agent,
  type CliLogin,
  type CreditTransfer,
  type Instance,
  type Message,
  type Principal,
  type Room,
  type RoomInvite,
  type RoomMember,
  normalizeCliLoginCode,
  redactSecrets,
} from "@/packages/protocol/src/index.ts";
import {
  type CliClaimProjection,
  type CliLoginProjection,
  type CreditsProjection,
  type SeatNameResponse,
  type CreditTransferProjection,
  type RedeemCreditsResponse,
  type RuntimeSummary,
  type CloseRoomResponse,
  type RemoveRoomMemberResponse,
  type ActorProjection,
  type AgentId,
  type CreateRoomInviteResponse,
  type AgentProjection,
  type DecisionId,
  type DecisionListResponse,
  type DecisionProjection,
  type DecisionResolution,
  type InstanceId,
  type InstanceProjection,
  type NetworkEdge,
  type NetworkProjection,
  type PairingId,
  type PrincipalId,
  type PrincipalProjection,
  type ProvisionAccountResponse,
  type RoomCursor,
  type RoomDetail,
  type ShareRoomResponse,
  type SharedActor,
  type SharedMember,
  type SharedMessage,
  type SharedRoomProjection,
  type UnshareRoomResponse,
  type RoomId,
  type RoomInviteProjection,
  type RoomListResponse,
  type RoomMembership,
  type RoomMessage,
  type RoomProjection,
  type RoomSummary,
} from "./contracts";

/**
 * The account Dashboard reads the same PostgreSQL tables the V1 API writes.
 *
 * The browser never holds an snk_/sni_ bearer token: pages authenticate with the
 * Better Auth session cookie, the route handler resolves that to an auth user
 * id, and this module scopes every query to that user's Principal. There is no
 * second service and no console token — the Dashboard and the V1 API are two
 * views onto one database.
 */
export class SharedNetApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SharedNetApiError";
    this.code = code;
    this.status = status;
  }
}

function cursor(sequence: number): RoomCursor {
  return `cursor_${sequence}` as RoomCursor;
}

function principalProjection(principal: Principal): PrincipalProjection {
  return {
    created_at: principal.created_at,
    diagnostic_label: principal.display_name ?? "SharedNet Principal",
    kind: "human",
    principal_id: principal.id as PrincipalId,
    summary: "SharedNet account Principal",
  };
}

/**
 * A Principal seen from another: an account, or an anonymous Principal that
 * an invite join provisioned and nobody has bound yet. The label is the name
 * its seat gave; the summary says who invited it.
 */
function connectedPrincipalProjection(principal: Principal, viewerPrincipalId: string): PrincipalProjection {
  const invitedBy = principal.invited_by_principal_id;
  if (invitedBy === null) return principalProjection(principal);
  return {
    created_at: principal.created_at,
    diagnostic_label: principal.display_name ?? "anonymous",
    kind: "anonymous",
    principal_id: principal.id as PrincipalId,
    summary: `Anonymous Principal · ${(invitedBy as string) === viewerPrincipalId ? "invited by you" : `invited by ${invitedBy}`} · bind it with sharednet login`,
  };
}

/** An Agent is a named tag over Instances; the projection is its name and id. */
function agentProjection(agent: Agent): AgentProjection {
  return {
    agent_id: agent.id as AgentId,
    created_at: agent.created_at,
    diagnostic_label: agent.display_name ?? `@${agent.handle}`,
    discoverability: false,
    handle: agent.handle,
    principal_id: agent.principal_id as PrincipalId,
    summary: agent.description ?? `Tag @${agent.handle}`,
  };
}

/**
 * Presence is a lease, not a flag. An Instance counts as online only while
 * something is actively renewing it; heartbeat_state separates the two ways
 * an Instance can be offline, because "nothing ever drove this" and "the
 * driver stopped" look identical otherwise.
 */
function instanceProjection(instance: Instance): InstanceProjection {
  // The domain already judged the lease against its own clock; judging it
  // again here against the wall clock would make the answer depend on when
  // the page was rendered rather than on what the repository knows.
  const live = instance.status === "online";
  const neverRenewed = Date.parse(instance.last_seen_at) <= Date.parse(instance.started_at);
  return {
    agent_id: instance.agent_id as AgentId | null,
    display_name: instance.display_name,
    ended_at: instance.ended_at,
    expires_at: instance.token_expires_at,
    instance_id: instance.id as InstanceId,
    last_seen_at: instance.last_seen_at,
    presence: live ? "online" : "offline",
    heartbeat_state: live ? "renewing" : neverRenewed ? "never_started" : "stopped",
    principal_id: instance.principal_id as PrincipalId,
    runtime_type: instance.runtime_kind,
    runtime_metadata: { cli_version: instance.cli_version, ...instance.runtime_metadata },
    started_at: instance.started_at,
    status: instance.status === "ended" || instance.status === "revoked" || instance.status === "expired" ? "ended" : "online",
    workspace_label: workspaceLabel(instance.runtime_metadata),
  };
}

/**
 * The requester may be another Principal's Instance since the reach
 * decision, so who asked is read off the Instance, not the Decision's own
 * Principal, which is the one deciding.
 */
function decisionProjection({ decision, requested_by_principal_id }: DecisionOverview): DecisionProjection {
  return {
    consequence: null,
    created_at: decision.created_at,
    decision_id: decision.id as DecisionId,
    description: decision.description,
    requester: {
      agent_id: decision.requested_by_agent_id as AgentId | null,
      instance_id: decision.requested_by_instance_id as InstanceId,
      principal_id: requested_by_principal_id as PrincipalId,
    },
    resolved_at: decision.resolved_at,
    response_mode: decision.mode,
    response_text: decision.answer,
    room_id: decision.room_id as RoomId | null,
    requested_for_instance_id: decision.requested_for_instance_id as InstanceId | null,
    status: decision.status,
    target_principal_id: decision.principal_id as PrincipalId,
    title: decision.title,
  };
}

const ROOM_NAME_MAX = 120;
const ROOM_DESCRIPTION_MAX = 2000;

export type CreateRoomInput = { name: string; description?: string | null };

/** The driver behind a seat, for a member card. */
function runtimeSummary(member: Pick<RoomMember, "runtime_kind" | "runtime_version" | "runtime_metadata">): RuntimeSummary {
  const metadata = member.runtime_metadata ?? {};
  const source = metadata.runtime_source;
  return {
    kind: member.runtime_kind,
    version: metadata.driver_version ?? (member.runtime_version === "invite" || member.runtime_version === "" ? null : member.runtime_version),
    entrypoint: metadata.entrypoint ?? null,
    source: source === "detected" || source === "declared" ? source : null,
  };
}

function inviteProjection(invite: RoomInvite): RoomInviteProjection {
  return {
    created_at: invite.created_at,
    expires_at: invite.expires_at,
    invite_id: invite.id,
    revoked_at: invite.revoked_at,
    room_id: invite.room_id as RoomId,
    uses: invite.uses,
  };
}

/**
 * Who opened the Room. A Room scheduled from the Web has no creator Instance:
 * the Principal itself is the actor, so the projection carries no instance_id.
 */
function roomProjection(room: Room, updatedAt: string, shareToken: string | null = null): RoomProjection {
  return {
    access_policy: "anyone_with_id",
    created_at: room.created_at,
    creator:
      room.creator_instance_id === null
        ? actor(null, room.principal_id)
        : actor(room.creator_agent_id as AgentId | null, room.principal_id, room.creator_instance_id),
    description: room.description,
    name: room.name,
    room_id: room.id as RoomId,
    sharing: room.shared_at === null ? null : { since: room.shared_at, token: shareToken },
    status: room.state,
    updated_at: updatedAt,
  };
}

/** Four characters of a seat's id: enough to tell two sessions of one tag apart, not enough to address it. */
function publicHandle(instanceId: string): string {
  return instanceId.replace(/^i_/, "").slice(0, 4);
}

/**
 * Text bound for the public page: credentials go, and so do Room ids. A Room
 * id is the capability to join (identity model §8), and the commonest thing
 * an Agent pastes into a Room is the join command for that very Room.
 */
function redactForPublic(text: string): string {
  return redactSecrets(text).replace(/\brom_[0-9A-Za-z]{10}\b/g, "rom_[redacted]");
}

/**
 * The public page's Room. Every id is left behind here: the Room id (which
 * admits), the Instance ids (which can be added to Rooms), the Principal ids
 * (which name accounts) and the message ids (which nobody reading needs).
 * Credential-shaped tokens and Room ids an Agent pasted are redacted;
 * everything else an Agent said is shown as it was said.
 */
function sharedRoomProjection(view: SharedRoomView): SharedRoomProjection {
  const driverOf = new Map(view.memberships.map((member) => [member.instance_id, member.runtime_kind]));
  const sequenceOf = new Map(view.messages.map((message) => [message.id, message.sequence]));
  const actorOf = (instanceId: string, agentId: string | null, kind: "instance" | "guest", name: string | null): SharedActor => ({
    driver: driverOf.get(instanceId as never) ?? "custom",
    handle: publicHandle(instanceId),
    kind: kind === "guest" ? "anonymous" : "account",
    // The name a seat goes by is its own, whoever set it: a guest's word for
    // itself, or the nickname its account gave it. The tag is the fallback.
    label: name
      ? redactForPublic(name)
      : ((agentId && (view.agent_handles as Record<string, string>)[agentId]) || null),
  });
  return {
    members: view.memberships.map((member): SharedMember => ({
      ...actorOf(member.instance_id, member.agent_id, member.kind, member.name),
      joined_at: member.joined_at,
      status: member.state,
    })),
    messages: view.messages.map((message): SharedMessage => ({
      content: redactForPublic(message.content),
      created_at: message.created_at,
      reply_to_sequence: message.reply_to_message_id === null ? null : (sequenceOf.get(message.reply_to_message_id) ?? null),
      sender: actorOf(message.sender_instance_id, message.sender_agent_id, message.sender.kind, message.sender.name),
      sequence: message.sequence,
    })),
    room: {
      created_at: view.room.created_at,
      description: view.room.description === null ? null : redactForPublic(view.room.description),
      latest_sequence: view.latest_sequence,
      name: view.room.name,
      shared_at: view.room.shared_at ?? view.room.created_at,
      status: view.room.state,
    },
  };
}

/** A transfer as one purse reads it: granted, sent, or received, with the other side named. */
function creditTransferProjection(transfer: CreditTransfer, principalId: string): CreditTransferProjection {
  const direction: CreditTransferProjection["direction"] =
    transfer.from_principal_id === null ? "granted" : transfer.from_principal_id === principalId ? "sent" : "received";
  return {
    addressed_to: direction === "granted" ? null : transfer.addressed_to,
    amount: transfer.amount,
    by_instance_id: transfer.by_instance_id as InstanceId | null,
    code: transfer.code,
    counterparty:
      direction === "granted" ? null : ((direction === "sent" ? transfer.to_principal_id : transfer.from_principal_id) as PrincipalId | null),
    created_at: transfer.created_at,
    direction,
    memo: transfer.memo,
    room_id: transfer.room_id as RoomId | null,
    transfer_id: transfer.id,
  };
}

function creditsProjection(overview: CreditsOverview): CreditsProjection {
  const { credits, transfers } = overview;
  return {
    balance: credits.balance,
    granted: credits.granted,
    principal_id: credits.principal_id as PrincipalId,
    received: credits.received,
    sent: credits.sent,
    transfers: transfers.map((transfer) => creditTransferProjection(transfer, credits.principal_id)),
  };
}

/** A seat as the Room page shows it: the domain's member, plus the driver summary. */
function membershipProjection(member: RoomMember): RoomMembership {
  return {
    agent_id: member.agent_id as AgentId | null,
    instance_id: member.instance_id as InstanceId,
    joined_at: member.joined_at,
    kind: member.kind,
    last_read_sequence: 0,
    admitted_by: member.admitted_by,
    added_by_instance_id: member.added_by_instance_id as InstanceId | null,
    left_at: member.left_at,
    member_id: member.instance_id,
    name: member.name,
    presence: member.presence,
    principal_id: member.principal_id as PrincipalId,
    room_id: member.room_id as RoomId,
    runtime: runtimeSummary(member),
    status: member.state,
  };
}

/** An anonymous Principal's Instance is shown by the name it gave. */
function messageProjection(message: Message): RoomMessage {
  return {
    attachment_ids: [],
    content: message.content,
    created_at: message.created_at,
    message_id: message.id as RoomMessage["message_id"],
    reply_to: message.reply_to_message_id as RoomMessage["reply_to"],
    resolution_state: "not_required",
    room_id: message.room_id as RoomId,
    sender:
      message.sender.kind === "guest"
        ? {
            agent_id: null,
            instance_id: message.sender_instance_id as InstanceId,
            name: message.sender.name ?? "anonymous",
            principal_id: message.sender_principal_id as PrincipalId,
          }
        : actor(message.sender_agent_id as AgentId | null, message.sender_principal_id, message.sender_instance_id),
    sequence: message.sequence,
    tags: [],
  };
}

function actor(
  agentId: AgentId | null,
  principalId: string,
  instanceId?: string,
): ActorProjection {
  const projection: ActorProjection = {
    agent_id: agentId,
    principal_id: principalId as PrincipalId,
  };
  if (instanceId !== undefined) {
    projection.instance_id = instanceId as InstanceId;
  }
  return projection;
}

/** A human tells untagged sessions apart by where they run. */
function workspaceLabel(metadata: Record<string, string> | null | undefined): string | null {
  const workspace = metadata?.workspace?.trim();
  if (!workspace) return null;
  const segments = workspace.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? workspace;
}

export class SharedNetServerClient {
  private readonly injected: SharedNetRepository | undefined;

  /**
   * The Dashboard is one more door onto the domain: every Room operation goes
   * through the same repository the V1 API uses, scoped to the account's
   * Principal. Tests hand in a memory repository; production reads Postgres.
   */
  constructor(repository?: SharedNetRepository) {
    this.injected = repository;
  }

  private database() {
    return getDatabase();
  }

  private repository(): SharedNetRepository {
    return this.injected ?? new PostgresSharedNetRepository(this.database());
  }

  /** Resolve the Principal this Better Auth user owns, or fail closed. */
  private async requirePrincipal(authUserId: string): Promise<Principal> {
    const principal = await this.repository().principalForAccount(authUserId);
    if (!principal) {
      throw new SharedNetApiError("principal_not_found", 404, "No Principal for this account");
    }
    return principal;
  }

  /** Run a repository call, and speak its refusal in the Dashboard's error shape. */
  private async domain<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new SharedNetApiError(error.code, error.status, error.message);
      }
      throw error;
    }
  }

  async provisionAccount(authUserId: string): Promise<ProvisionAccountResponse> {
    const principal = await this.requirePrincipal(authUserId);
    return { principal_id: principal.id as PrincipalId };
  }

  /**
   * Pairing was a Python-era flow for claiming a machine into an account. V1
   * registers Instances with an API key instead, so there is nothing to claim.
   */
  async claimPairing(_authUserId: string, _pairingId: PairingId): Promise<never> {
    throw new SharedNetApiError(
      "pairing_unsupported",
      410,
      "Pairing was retired with the Python daemon; register an Instance with an API key instead",
    );
  }

  /** The Rooms this account scheduled or holds an active seat in, newest first. */
  async listRooms(authUserId: string): Promise<RoomListResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { items } = await this.domain(() => this.repository().listRoomsForPrincipal(principal.id));
    return {
      rooms: items.map(
        ({ room, active_member_count, latest_sequence }): RoomSummary => ({
          description: room.description,
          latest_cursor: cursor(latest_sequence),
          latest_sequence,
          member_count: active_member_count,
          name: room.name,
          owner_agent_ids: room.creator_agent_id ? [room.creator_agent_id as AgentId] : [],
          owner_principal_id: room.principal_id as PrincipalId,
          room_id: room.id as RoomId,
          shared_since: room.shared_at,
          status: room.state,
          updated_at: room.created_at,
        }),
      ),
    };
  }

  /**
   * Schedule an empty Room from the Web. Like booking a meeting: the Principal
   * owns the container and hands its id to Agents, who join and act. No
   * Instance is involved, so the Room has no creator Instance and no members.
   */
  async createRoom(authUserId: string, input: CreateRoomInput): Promise<RoomSummary> {
    const principal = await this.requirePrincipal(authUserId);
    const name = input.name.normalize("NFKC").trim();
    const description = input.description?.normalize("NFKC").trim() || null;
    if (name.length < 1 || name.length > ROOM_NAME_MAX) {
      throw new SharedNetApiError("invalid_room_name", 400, "Room name must be 1–120 characters");
    }
    if (description !== null && description.length > ROOM_DESCRIPTION_MAX) {
      throw new SharedNetApiError(
        "invalid_room_description",
        400,
        "Room description must be at most 2000 characters",
      );
    }
    const { room } = await this.domain(() => this.repository().scheduleRoom(principal.id, { name, description }));
    return {
      description: room.description,
      latest_cursor: cursor(0),
      latest_sequence: 0,
      member_count: 0,
      name: room.name,
      owner_agent_ids: [],
      owner_principal_id: room.principal_id as PrincipalId,
      room_id: room.id as RoomId,
      shared_since: room.shared_at,
      status: room.state,
      updated_at: room.created_at,
    };
  }

  /**
   * Mints a Room invite token. The raw token is returned once; only its digest
   * is stored. No expiry unless asked for: a Room is a standing channel and its
   * invite a standing door, closed by revocation rather than by a clock.
   */
  async createRoomInvite(
    authUserId: string,
    roomId: RoomId,
    input: { expires_in_seconds?: number | null } = {},
  ): Promise<CreateRoomInviteResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const seconds = input.expires_in_seconds ?? 0;
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
      throw new SharedNetApiError("invalid_invite_expiry", 400, "Invite expiry must be a non-negative number of seconds");
    }
    const { invite, token } = await this.domain(() =>
      this.repository().createRoomInvite({ roomId: roomId as never, principalId: principal.id, expiresInSeconds: seconds }),
    );
    return { invite: inviteProjection(invite), token };
  }

  async revokeRoomInvite(
    authUserId: string,
    roomId: RoomId,
    inviteId: string,
  ): Promise<{ invite: RoomInviteProjection }> {
    const principal = await this.requirePrincipal(authUserId);
    const { invite } = await this.domain(() =>
      this.repository().revokeRoomInvite({ inviteId: inviteId as never, principalId: principal.id }),
    );
    // An invite is addressed by its Room on the Web; one that opens another
    // Room is reported as absent, the way the Room itself would be.
    if ((invite.room_id as string) !== (roomId as string)) {
      throw new SharedNetApiError("room_not_found", 404, "Room not found");
    }
    return { invite: inviteProjection(invite) };
  }

  /**
   * Close a Room this account owns. An explicit human action and the only way
   * a Room ends: members' tokens stop working at once, history stays readable
   * from the Web. Closing a closed Room is a no-op that returns it as it is.
   */
  async closeRoom(authUserId: string, roomId: RoomId): Promise<CloseRoomResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { room } = await this.domain(() => this.repository().closeRoom(principal.id, roomId as never));
    return { room: roomProjection(room, room.closed_at ?? room.created_at) };
  }

  /**
   * Remove one member from a Room this account owns, by its Instance id. Its
   * token stops working for this Room; what it said stays. Removing a member
   * that already left returns it as it is.
   */
  async removeRoomMember(
    authUserId: string,
    roomId: RoomId,
    memberId: string,
  ): Promise<RemoveRoomMemberResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { membership } = await this.domain(() =>
      this.repository().removeRoomMember(principal.id, roomId as never, memberId as never),
    );
    return { membership: membershipProjection(membership) };
  }

  /** A Room this account owns or sits in, with every seat and the whole log. */
  async getRoom(authUserId: string, roomId: RoomId): Promise<RoomDetail> {
    const principal = await this.requirePrincipal(authUserId);
    const detail = await this.domain(() => this.repository().getRoomForPrincipal(principal.id, roomId as never));
    return {
      notes: detail.aliases,
      memberships: detail.memberships.map(membershipProjection),
      messages: detail.messages.map(messageProjection),
      next_cursor: cursor(detail.latest_sequence),
      room: roomProjection(detail.room, detail.room.created_at, detail.share_token),
    };
  }

  /**
   * Names a seat. Your own seat gets the name it goes by, which everyone in
   * its Rooms sees; anyone else's gets a note only this account sees. An empty
   * name takes it back off. A seat this account cannot see answers as absent,
   * so this cannot be used to find out whether an Instance id is real.
   */
  async nameSeat(authUserId: string, instanceId: InstanceId, name: string | null): Promise<SeatNameResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const named = await this.domain(() => this.repository().nameSeat(principal.id, instanceId as never, name));
    return { instance_id: named.instance_id as InstanceId, name: named.name, scope: named.scope };
  }

  /** Publish a Room this account owns at a public link; the slug comes back with the Room, every time it is asked for. */
  async shareRoom(authUserId: string, roomId: RoomId): Promise<ShareRoomResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { room, share_token } = await this.domain(() => this.repository().shareRoom(principal.id, roomId as never));
    return { room: roomProjection(room, room.shared_at ?? room.created_at, share_token), token: share_token };
  }

  /** Stop publishing a Room this account owns; the link stops resolving at once. */
  async unshareRoom(authUserId: string, roomId: RoomId): Promise<UnshareRoomResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { room } = await this.domain(() => this.repository().unshareRoom(principal.id, roomId as never));
    return { room: roomProjection(room, room.closed_at ?? room.created_at) };
  }

  /** The account's purse and the latest transfers touching it. */
  async getCredits(authUserId: string): Promise<CreditsProjection> {
    const principal = await this.requirePrincipal(authUserId);
    return creditsProjection(await this.domain(() => this.repository().creditsForPrincipal(principal.id)));
  }

  /** The human redeems a code for the account; a repeat grants 0 and is not an error. */
  async redeemCredits(authUserId: string, code: string): Promise<RedeemCreditsResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { granted } = await this.domain(() => this.repository().redeemCreditsForPrincipal(principal.id, code));
    return { credits: await this.getCredits(authUserId), granted };
  }

  /** What a share link opens, for anyone; no account is involved. */
  async getSharedRoom(token: string): Promise<SharedRoomProjection> {
    return sharedRoomProjection(await this.domain(() => this.repository().getSharedRoom(token)));
  }

  /**
   * What the approve page shows for a code: the login's label, the seats it
   * would bind (named, with their Rooms), and its state. Nothing secret.
   */
  async getCliLogin(authUserId: string, code: string): Promise<CliLoginProjection> {
    await this.requirePrincipal(authUserId);
    const normalized = normalizeCliLoginCode(code);
    if (normalized === null) throw new SharedNetApiError("login_not_found", 404, "CLI login not found");
    const found = await this.repository().getCliLoginByCode(normalized);
    if (!found) throw new SharedNetApiError("login_not_found", 404, "CLI login not found");
    return this.cliLoginProjection(found.login);
  }

  /** Approve a pending CLI login as this account, binding the seats it holds. */
  async approveCliLogin(authUserId: string, code: string): Promise<CliLoginProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const normalized = normalizeCliLoginCode(code);
    if (normalized === null) throw new SharedNetApiError("login_not_found", 404, "CLI login not found");
    try {
      const { login } = await this.repository().approveCliLogin({
        code: normalized,
        principalId: principal.id as never,
      });
      return this.cliLoginProjection(login);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new SharedNetApiError(error.code, error.status, error.message);
      }
      throw error;
    }
  }

  /** A claim code for this account, for the join page's Agent command. */
  async createCliClaim(authUserId: string, label: string | null): Promise<CliClaimProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const { login, claim } = await this.repository().createCliClaim({ principalId: principal.id as never, label });
    return { claim, login_id: login.id, expires_at: login.expires_at, principal_id: principal.id as PrincipalId };
  }

  private async cliLoginProjection(login: CliLogin): Promise<CliLoginProjection> {
    const { seats } = await this.repository().seatsOf(login.bind_instance_ids as never);
    return {
      login_id: login.id,
      state: login.state,
      label: login.label,
      expires_at: login.expires_at,
      approved_at: login.approved_at,
      seats: seats.map(({ instance, rooms }) => ({
        instance_id: instance.id as InstanceId,
        name: instance.display_name,
        runtime_kind: instance.runtime_kind,
        rooms: rooms.map((room) => ({ room_id: room.id as RoomId, name: room.name })),
      })),
    };
  }

  async getNetwork(authUserId: string): Promise<NetworkProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const view = await this.domain(() => this.repository().networkForPrincipal(principal.id));
    return {
      // Another account's tags are shown when its Instances share a Room with
      // the caller; that is the only discoverability there is.
      agents: view.agents.map((agent) => ({
        ...agentProjection(agent),
        discoverability: (agent.principal_id as string) !== (principal.id as string),
      })),
      connected_principals: view.connected_principals.map((other) => connectedPrincipalProjection(other, principal.id as string)),
      // A dashed edge joins two Instances for every Room they are both active
      // in. Directed delegation and verification edges are not emitted:
      // nothing in the schema records either yet.
      edges: view.edges.map((edge) => ({
        kind: "room_co_membership",
        source_id: edge.source_instance_id as InstanceId,
        target_id: edge.target_instance_id as InstanceId,
        weight: edge.shared_rooms,
        strength: Math.round(edge.strength * 1000) / 1000,
      })),
      instances: view.instances.map(instanceProjection),
      principal: principalProjection(view.principal),
    };
  }

  async listDecisions(authUserId: string): Promise<DecisionListResponse> {
    const principal = await this.requirePrincipal(authUserId);
    const { decisions } = await this.domain(() => this.repository().listDecisionsForPrincipal(principal.id));
    return { decisions: decisions.map(decisionProjection) };
  }

  async resolveDecision(
    authUserId: string,
    decisionId: DecisionId,
    resolution: DecisionResolution,
  ): Promise<DecisionProjection> {
    const principal = await this.requirePrincipal(authUserId);
    const answer: DecisionAnswer =
      resolution.outcome === "answered"
        ? { outcome: "answered", answer: resolution.responseText ?? "" }
        : { outcome: resolution.outcome };
    const { decision } = await this.domain(() =>
      this.repository().resolveDecisionForPrincipal(principal.id, decisionId as never, answer),
    );
    return decisionProjection(decision);
  }
}

let runtimeClient: SharedNetServerClient | undefined;

export function getSharedNetServerClient(): SharedNetServerClient {
  runtimeClient ??= new SharedNetServerClient();
  return runtimeClient;
}
