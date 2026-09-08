import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type {
  CliLoginId,
  AgentId,
  ApiKeyId,
  DecisionId,
  InstanceId,
  InviteId,
  MemberId,
  MessageId,
  PrincipalId,
  RoomId,
} from "../../protocol/src/index.ts";
import { authUser } from "./auth-schema.ts";

export const sharednetSchema = pgSchema("sharednet");

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

// Static SQL fragments are intentionally raw: interpolating plain strings would make
// drizzle-kit emit unusable `$1` placeholders inside migration CHECK constraints.
const PRINCIPAL_ID_RE = sql.raw("'^p_[0-9A-Za-z]{10}$'");
const AGENT_ID_RE = sql.raw("'^a_[0-9A-Za-z]{10}$'");
const INSTANCE_ID_RE = sql.raw("'^i_[0-9A-Za-z]{10}$'");
const ROOM_ID_RE = sql.raw("'^rom_[0-9A-Za-z]{10}$'");
const MESSAGE_ID_RE = sql.raw("'^msg_[0-9A-Za-z]{10}$'");
const DECISION_ID_RE = sql.raw("'^dec_[0-9A-Za-z]{10}$'");
const MEMBER_ID_RE = sql.raw("'^mem_[0-9A-Za-z]{10}$'");
const INVITE_ID_RE = sql.raw("'^inv_[0-9A-Za-z]{10}$'");
const SHA256_HEX_RE = sql.raw("'^[0-9a-f]{64}$'");

export const principals = sharednetSchema.table(
  "principal",
  {
    id: text("id").$type<PrincipalId>().primaryKey(),
    /**
     * The account behind this Principal. Null for an anonymous Principal: one
     * provisioned by an invite join for an Agent that arrived with nothing,
     * which `sharednet login` can bind to an account later.
     */
    authUserId: text("auth_user_id").references(() => authUser.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    /** For an anonymous Principal: whose invite admitted it. */
    invitedByPrincipalId: text("invited_by_principal_id").$type<PrincipalId>(),
    /** Set when an anonymous Principal was bound into an existing one. */
    mergedIntoPrincipalId: text("merged_into_principal_id").$type<PrincipalId>(),
    /** What a new Instance's reach is when its registration does not say. */
    defaultReach: text("default_reach").$type<"public" | "private">().default("public").notNull(),
  },
  (table) => [
    unique("principal_auth_user_id_unique").on(table.authUserId),
    foreignKey({
      name: "principal_invited_by_fk",
      columns: [table.invitedByPrincipalId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    foreignKey({
      name: "principal_merged_into_fk",
      columns: [table.mergedIntoPrincipalId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    check("principal_id_format", sql`${table.id} ~ ${PRINCIPAL_ID_RE}`),
    check("principal_default_reach_valid", sql`${table.defaultReach} IN ('public', 'private')`),
    check(
      "principal_bound_or_invited",
      sql`${table.authUserId} IS NOT NULL OR ${table.invitedByPrincipalId} IS NOT NULL`,
    ),
  ],
);

/**
 * An Agent is a named tag over a Principal's Instances, nothing more. It holds
 * no credential and never acts; it is the name that outlives the sessions it
 * groups. An Instance points at at most one Agent, and that pointer is the
 * single place the grouping lives — nothing else stores an agent id, so
 * regrouping an Instance changes one column and every projection follows.
 *
 * There is no default Agent. An untagged Instance has a null pointer, which
 * the Dashboard renders under a synthetic "default" header.
 */
export const agents = sharednetSchema.table(
  "agent",
  {
    id: text("id").$type<AgentId>().primaryKey(),
    principalId: text("principal_id")
      .$type<PrincipalId>()
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("agent_principal_id_id_unique").on(table.principalId, table.id),
    unique("agent_principal_handle_unique").on(table.principalId, table.handle),
    check("agent_id_format", sql`${table.id} ~ ${AGENT_ID_RE}`),
    check("agent_handle_format", sql`${table.handle} ~ '^[a-z][a-z0-9-]{0,31}$'`),
  ],
);

export const instances = sharednetSchema.table(
  "instance",
  {
    id: text("id").$type<InstanceId>().primaryKey(),
    principalId: text("principal_id").$type<PrincipalId>().notNull(),
    /** The tag this Instance is grouped under, or null for untagged. */
    agentId: text("agent_id").$type<AgentId>(),
    /** The API key that registered it; null when an invite admitted it instead. */
    issuedByKeyId: text("issued_by_key_id").$type<ApiKeyId>(),
    /** The invite that admitted it; null when an API key registered it. */
    admittedByInviteId: text("admitted_by_invite_id").$type<InviteId>(),
    /** What an invite-admitted Instance calls itself in a Room. Display only. */
    displayName: text("display_name"),
    /**
     * Public: anyone who knows the id may seat this Instance in a Room at
     * once. Private: they have to ask, and the Instance (or its human) says
     * yes. Decision 2026-09-06 reach.
     */
    reach: text("reach").$type<"public" | "private">().default("public").notNull(),
    tokenDigest: text("token_digest").notNull(),
    /**
     * HMAC-SHA256(installation secret, runtime kind ‖ provider session anchor),
     * computed by the CLI. It lets the server recognise a re-registration of the
     * same runtime session and hand back the same Instance instead of minting a
     * ghost — the invariant is one session, one live Instance. The raw session
     * id never leaves the machine; the server learns only that two calls are
     * the same session, not which session. It is a dedupe key, never authority:
     * the API key has already established the Principal, and this only selects
     * among that Principal's own Instances. Null when the caller cannot or does
     * not identify its session, in which case every call is a fresh Instance.
     */
    localInstanceKey: text("local_instance_key"),
    /** The driver behind the session: a handle such as claude-code or codex. Open; clients keep the known list. */
    runtimeKind: text("runtime_kind").notNull(),
    cliVersion: text("cli_version").notNull(),
    /**
     * Everything a caller reports about where this Instance runs: runtime
     * build, device or host identifier, workspace label, OS. There is no
     * Runtime entity — a Runtime is not addressable and never was reachable on
     * its own, so recording it as an addressable row only added a layer the UI
     * had to flatten again. This is diagnostic metadata hanging off the one id
     * that is actually addressable, and it is never used for authorization.
     */
    runtimeMetadata: jsonb("runtime_metadata").$type<Record<string, string>>().default({}).notNull(),
    state: text("state").$type<"active" | "ended" | "revoked">().default("active").notNull(),
    startedAt: domainTimestamp("started_at").defaultNow().notNull(),
    lastSeenAt: domainTimestamp("last_seen_at").notNull(),
    leaseExpiresAt: domainTimestamp("lease_expires_at").notNull(),
    /** Null for an invite-admitted Instance: its seat lasts until removed. */
    tokenExpiresAt: domainTimestamp("token_expires_at"),
    endedAt: domainTimestamp("ended_at"),
    revokedAt: domainTimestamp("revoked_at"),
  },
  (table) => [
    /** Referenced by every Principal-scoped foreign key onto an Instance. */
    unique("instance_principal_id_unique").on(table.principalId, table.id),
    unique("instance_token_digest_unique").on(table.tokenDigest),
    /**
     * One live Instance per runtime session. Ended and revoked rows keep their
     * key as history, so a session that ends and starts again gets a fresh row
     * rather than reviving a closed fact.
     */
    uniqueIndex("instance_principal_active_local_key_unique")
      .on(table.principalId, table.localInstanceKey)
      .where(sql`${table.state} = 'active' AND ${table.localInstanceKey} IS NOT NULL`),
    foreignKey({
      name: "instance_principal_fk",
      columns: [table.principalId],
      foreignColumns: [principals.id],
    }).onDelete("cascade"),
    // Composite so an Instance can only point at a tag of its own Principal.
    // MATCH SIMPLE skips the check while agent_id is null. No cascade: deleting
    // a tag must not delete sessions; the repository untags first.
    foreignKey({
      name: "instance_principal_agent_fk",
      columns: [table.principalId, table.agentId],
      foreignColumns: [agents.principalId, agents.id],
    }),
    index("instance_principal_idx").on(table.principalId),
    index("instance_agent_idx").on(table.agentId),
    index("instance_issued_by_key_idx").on(table.issuedByKeyId),
    index("instance_lease_expires_at_idx").on(table.leaseExpiresAt),
    // instance_admitted_by_invite_fk (→ room_invite.id) exists in the database
    // (migration 0007) but is not declared here: instance → room_invite → room
    // → instance would be a type cycle for Drizzle's inference.
    check("instance_id_format", sql`${table.id} ~ ${INSTANCE_ID_RE}`),
    check(
      "instance_issued_by_key_id_format",
      sql`${table.issuedByKeyId} IS NULL OR ${table.issuedByKeyId} ~ '^key_[0-9A-Za-z]{10}$'`,
    ),
    check(
      "instance_issued_or_admitted",
      sql`${table.issuedByKeyId} IS NOT NULL OR ${table.admittedByInviteId} IS NOT NULL`,
    ),
    check(
      "instance_display_name_length",
      sql`${table.displayName} IS NULL OR length(${table.displayName}) BETWEEN 1 AND 64`,
    ),
    check("instance_token_digest_format", sql`${table.tokenDigest} ~ ${SHA256_HEX_RE}`),
    check(
      "instance_local_instance_key_format",
      sql`${table.localInstanceKey} IS NULL OR ${table.localInstanceKey} ~ ${SHA256_HEX_RE}`,
    ),
    check(
      "instance_runtime_kind_valid",
      sql`${table.runtimeKind} ~ '^[a-z][a-z0-9-]{0,31}$'`,
    ),
    check("instance_cli_version_length", sql`length(${table.cliVersion}) BETWEEN 1 AND 64`),
    check("instance_reach_valid", sql`${table.reach} IN ('public', 'private')`),
    check("instance_state_valid", sql`${table.state} IN ('active', 'ended', 'revoked')`),
    check(
      "instance_terminal_state_consistent",
      sql`(${table.state} = 'active' AND ${table.endedAt} IS NULL AND ${table.revokedAt} IS NULL)
          OR (${table.state} = 'ended' AND ${table.endedAt} IS NOT NULL AND ${table.revokedAt} IS NULL)
          OR (${table.state} = 'revoked' AND ${table.revokedAt} IS NOT NULL AND ${table.endedAt} IS NULL)`,
    ),
    check(
      "instance_time_order_valid",
      sql`${table.lastSeenAt} >= ${table.startedAt}
          AND ${table.leaseExpiresAt} > ${table.lastSeenAt}
          AND (${table.tokenExpiresAt} IS NULL OR ${table.tokenExpiresAt} > ${table.startedAt})`,
    ),
  ],
);

export const rooms = sharednetSchema.table(
  "room",
  {
    id: text("id").$type<RoomId>().primaryKey(),
    principalId: text("principal_id").$type<PrincipalId>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    state: text("state").$type<"open" | "closed">().default("open").notNull(),
    /**
     * The Instance that opened the Room — the immutable fact; its tag is derived.
     * Null when the Principal scheduled the Room from the Web before any Instance
     * joined: the account owns the empty container, no Instance acted.
     */
    creatorInstanceId: text("creator_instance_id").$type<InstanceId>(),
    nextSequence: integer("next_sequence").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    closedAt: domainTimestamp("closed_at"),
  },
  (table) => [
    unique("room_principal_id_id_unique").on(table.principalId, table.id),
    foreignKey({
      name: "room_principal_fk",
      columns: [table.principalId],
      foreignColumns: [principals.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "room_creator_instance_fk",
      columns: [table.principalId, table.creatorInstanceId],
      foreignColumns: [instances.principalId, instances.id],
    }).onUpdate("cascade"),
    index("room_principal_created_at_idx").on(table.principalId, table.createdAt),
    check("room_id_format", sql`${table.id} ~ ${ROOM_ID_RE}`),
    check(
      "room_creator_instance_id_format",
      sql`${table.creatorInstanceId} IS NULL OR ${table.creatorInstanceId} ~ ${INSTANCE_ID_RE}`,
    ),
    check("room_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
    check("room_description_length", sql`${table.description} IS NULL OR length(${table.description}) <= 2000`),
    check("room_next_sequence_positive", sql`${table.nextSequence} >= 1`),
    check(
      "room_state_consistent",
      sql`(${table.state} = 'open' AND ${table.closedAt} IS NULL)
          OR (${table.state} = 'closed' AND ${table.closedAt} IS NOT NULL)`,
    ),
  ],
);

export const roomMembers = sharednetSchema.table(
  "room_member",
  {
    /** The member's own Principal, tied to the Instance below. */
    principalId: text("principal_id").$type<PrincipalId>().notNull(),
    roomId: text("room_id").$type<RoomId>().notNull(),
    /**
     * Membership is per Instance, not per Agent. Two Codex sessions of the same
     * Agent are two participants: they hold separate credentials, join and
     * leave independently, and the member list has to show both. Keying this on
     * agent_id collapsed them into one row and made a three-way conversation
     * report a single member.
     */
    instanceId: text("instance_id").$type<InstanceId>().notNull(),
    state: text("state").$type<"active" | "left">().default("active").notNull(),
    joinedAt: domainTimestamp("joined_at").defaultNow().notNull(),
    leftAt: domainTimestamp("left_at"),
    /**
     * How this seat was admitted: by knowing the Room id, by an invite, by
     * being added as a public Instance, or by accepting a request as a
     * private one.
     */
    admittedBy: text("admitted_by")
      .$type<"room_id" | "invite" | "added" | "accepted">()
      .default("room_id")
      .notNull(),
    inviteId: text("invite_id").$type<InviteId>(),
    /** For an added or accepted seat: the Instance that asked. */
    addedByInstanceId: text("added_by_instance_id").$type<InstanceId>(),
  },
  (table) => [
    primaryKey({ name: "room_member_pk", columns: [table.roomId, table.instanceId] }),
    foreignKey({
      name: "room_member_invite_fk",
      columns: [table.roomId, table.inviteId],
      foreignColumns: [roomInvites.roomId, roomInvites.id],
    }),
    check(
      "room_member_admitted_by_valid",
      sql`${table.admittedBy} IN ('room_id', 'invite', 'added', 'accepted')`,
    ),
    check(
      "room_member_admitted_by_invite_consistent",
      sql`(${table.admittedBy} = 'invite') = (${table.inviteId} IS NOT NULL)`,
    ),
    check(
      "room_member_added_by_consistent",
      sql`(${table.admittedBy} IN ('added', 'accepted')) = (${table.addedByInstanceId} IS NOT NULL)`,
    ),
    foreignKey({
      name: "room_member_added_by_instance_fk",
      columns: [table.addedByInstanceId],
      foreignColumns: [instances.id],
    }).onUpdate("cascade"),
    // A Room id is the capability: any Instance that knows it may join, so a
    // member's Principal is not required to be the Room's. principal_id here
    // is the member's own, tied to its Instance by the foreign key below.
    foreignKey({
      name: "room_member_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    // ON UPDATE CASCADE: binding an anonymous Principal re-points its
    // Instances, and every row that carries the Instance's Principal follows.
    foreignKey({
      name: "room_member_instance_fk",
      columns: [table.principalId, table.instanceId],
      foreignColumns: [instances.principalId, instances.id],
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("room_member_principal_idx").on(table.principalId),
    index("room_member_instance_idx").on(table.instanceId),
    check("room_member_room_id_format", sql`${table.roomId} ~ ${ROOM_ID_RE}`),
    check("room_member_instance_id_format", sql`${table.instanceId} ~ ${INSTANCE_ID_RE}`),
    check(
      "room_member_state_consistent",
      sql`(${table.state} = 'active' AND ${table.leftAt} IS NULL)
          OR (${table.state} = 'left' AND ${table.leftAt} IS NOT NULL AND ${table.leftAt} >= ${table.joinedAt})`,
    ),
  ],
);

/**
 * A Room invite is the join capability for guests: a token scoped to one Room,
 * minted by the Room's Principal from the Web. Only its digest is stored. It
 * never expires unless asked to, and stays valid until revoked.
 */
export const roomInvites = sharednetSchema.table(
  "room_invite",
  {
    id: text("id").$type<InviteId>().primaryKey(),
    roomId: text("room_id").$type<RoomId>().notNull(),
    /** Who minted it; guests it admits are attributed to this Principal. */
    principalId: text("principal_id").$type<PrincipalId>().notNull(),
    tokenDigest: text("token_digest").notNull(),
    expiresAt: domainTimestamp("expires_at"),
    revokedAt: domainTimestamp("revoked_at"),
    uses: integer("uses").default(0).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("room_invite_token_digest_unique").on(table.tokenDigest),
    unique("room_invite_room_id_id_unique").on(table.roomId, table.id),
    foreignKey({
      name: "room_invite_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "room_invite_principal_fk",
      columns: [table.principalId],
      foreignColumns: [principals.id],
    }).onDelete("cascade"),
    index("room_invite_room_idx").on(table.roomId),
    check("room_invite_id_format", sql`${table.id} ~ ${INVITE_ID_RE}`),
    check("room_invite_token_digest_format", sql`${table.tokenDigest} ~ ${SHA256_HEX_RE}`),
    check("room_invite_uses_nonnegative", sql`${table.uses} >= 0`),
  ],
);

/**
 * A guest is a Room member admitted by an invite rather than by an Instance.
 * Every join creates a new guest with its own member token; the name is
 * display text and never recovers an earlier guest's identity.
 */
/**
 * Retired by migration 0007: every former guest is now an Instance of an
 * anonymous Principal. The table stays until a later migration drops it;
 * nothing reads or writes it.
 */
export const roomGuests = sharednetSchema.table(
  "room_guest",
  {
    id: text("id").$type<MemberId>().primaryKey(),
    roomId: text("room_id").$type<RoomId>().notNull(),
    inviteId: text("invite_id").$type<InviteId>().notNull(),
    /** The Principal whose invite admitted this guest. */
    principalId: text("principal_id").$type<PrincipalId>().notNull(),
    name: text("name").notNull(),
    tokenDigest: text("token_digest").notNull(),
    state: text("state").$type<"active" | "left">().default("active").notNull(),
    joinedAt: domainTimestamp("joined_at").defaultNow().notNull(),
    leftAt: domainTimestamp("left_at"),
    /** Renewed by every authenticated request; presence is derived from it. */
    lastSeenAt: domainTimestamp("last_seen_at").defaultNow().notNull(),
  },
  (table) => [
    unique("room_guest_token_digest_unique").on(table.tokenDigest),
    unique("room_guest_room_id_id_unique").on(table.roomId, table.id),
    foreignKey({
      name: "room_guest_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "room_guest_invite_fk",
      columns: [table.roomId, table.inviteId],
      foreignColumns: [roomInvites.roomId, roomInvites.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "room_guest_principal_fk",
      columns: [table.principalId],
      foreignColumns: [principals.id],
    }).onDelete("cascade"),
    index("room_guest_room_idx").on(table.roomId),
    check("room_guest_id_format", sql`${table.id} ~ ${MEMBER_ID_RE}`),
    check("room_guest_token_digest_format", sql`${table.tokenDigest} ~ ${SHA256_HEX_RE}`),
    check("room_guest_name_length", sql`length(${table.name}) BETWEEN 1 AND 64`),
    check(
      "room_guest_state_consistent",
      sql`(${table.state} = 'active' AND ${table.leftAt} IS NULL)
          OR (${table.state} = 'left' AND ${table.leftAt} IS NOT NULL AND ${table.leftAt} >= ${table.joinedAt})`,
    ),
  ],
);

export const messages = sharednetSchema.table(
  "message",
  {
    id: text("id").$type<MessageId>().primaryKey(),
    roomId: text("room_id").$type<RoomId>().notNull(),
    sequence: integer("sequence").notNull(),
    senderPrincipalId: text("sender_principal_id").$type<PrincipalId>().notNull(),
    /** Who acted. The sender's tag is derived from this at read time. Nullable in SQL only for history; always set. */
    senderInstanceId: text("sender_instance_id").$type<InstanceId>(),
    /** Retired with the guest model (migration 0007); always null now. */
    senderGuestId: text("sender_guest_id").$type<MemberId>(),
    content: text("content").notNull(),
    replyToMessageId: text("reply_to_message_id").$type<MessageId>(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("message_room_sequence_unique").on(table.roomId, table.sequence),
    unique("message_room_id_unique").on(table.roomId, table.id),
    // Senders may belong to a Principal other than the Room's; membership,
    // enforced by message_sender_membership_fk, is what admits them.
    foreignKey({
      name: "message_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_sender_instance_fk",
      columns: [table.senderPrincipalId, table.senderInstanceId],
      foreignColumns: [instances.principalId, instances.id],
    }).onUpdate("cascade"),
    foreignKey({
      name: "message_sender_membership_fk",
      // The sending Instance must be a member, not merely some Instance of a
      // member Agent, which is what keying this on sender_agent_id allowed.
      columns: [table.roomId, table.senderInstanceId],
      foreignColumns: [roomMembers.roomId, roomMembers.instanceId],
    }),
    foreignKey({
      name: "message_same_room_reply_fk",
      columns: [table.roomId, table.replyToMessageId],
      foreignColumns: [table.roomId, table.id],
    }),
    index("message_room_created_at_idx").on(table.roomId, table.createdAt),
    index("message_sender_instance_idx").on(table.senderInstanceId),
    check("message_id_format", sql`${table.id} ~ ${MESSAGE_ID_RE}`),
    check(
      "message_sender_is_instance",
      sql`${table.senderInstanceId} IS NOT NULL AND ${table.senderGuestId} IS NULL`,
    ),
    check("message_sequence_positive", sql`${table.sequence} >= 1`),
    check(
      "message_content_valid",
      sql`length(btrim(${table.content})) > 0 AND octet_length(${table.content}) <= 32768`,
    ),
  ],
);

/**
 * A CLI login in flight: the CLI starts it, the human approves it in the Web,
 * the CLI polls and receives an API key minted at that moment. Only digests of
 * the user code and the poll token are stored. `bind_instance_ids` are the
 * anonymous seats the CLI proved it holds; approval binds their Principals.
 */
export const cliLogins = sharednetSchema.table(
  "cli_login",
  {
    id: text("id").$type<CliLoginId>().primaryKey(),
    codeDigest: text("code_digest").notNull(),
    pollTokenDigest: text("poll_token_digest").notNull(),
    label: text("label"),
    state: text("state")
      .$type<"pending" | "approved" | "consumed" | "denied" | "expired">()
      .default("pending")
      .notNull(),
    bindInstanceIds: text("bind_instance_ids").array().$type<InstanceId[]>().default([]).notNull(),
    principalId: text("principal_id").$type<PrincipalId>(),
    apiKeyId: text("api_key_id").$type<ApiKeyId>(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    expiresAt: domainTimestamp("expires_at").notNull(),
    approvedAt: domainTimestamp("approved_at"),
    consumedAt: domainTimestamp("consumed_at"),
  },
  (table) => [
    unique("cli_login_code_digest_unique").on(table.codeDigest),
    unique("cli_login_poll_token_digest_unique").on(table.pollTokenDigest),
    foreignKey({
      name: "cli_login_principal_fk",
      columns: [table.principalId],
      foreignColumns: [principals.id],
    }).onDelete("set null"),
    index("cli_login_expires_at_idx").on(table.expiresAt),
    check("cli_login_id_format", sql`${table.id} ~ '^cli_[0-9A-Za-z]{10}$'`),
    check("cli_login_code_digest_format", sql`${table.codeDigest} ~ ${SHA256_HEX_RE}`),
    check("cli_login_poll_token_digest_format", sql`${table.pollTokenDigest} ~ ${SHA256_HEX_RE}`),
    check(
      "cli_login_state_valid",
      sql`${table.state} IN ('pending', 'approved', 'consumed', 'denied', 'expired')`,
    ),
    check(
      "cli_login_label_length",
      sql`${table.label} IS NULL OR length(${table.label}) BETWEEN 1 AND 120`,
    ),
    check(
      "cli_login_approved_has_principal",
      sql`${table.state} NOT IN ('approved', 'consumed') OR ${table.principalId} IS NOT NULL`,
    ),
  ],
);

export const decisions = sharednetSchema.table(
  "decision",
  {
    id: text("id").$type<DecisionId>().primaryKey(),
    principalId: text("principal_id").$type<PrincipalId>().notNull(),
    mode: text("mode").$type<"approval" | "text">().notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status")
      .$type<"pending" | "approved" | "denied" | "answered">()
      .default("pending")
      .notNull(),
    /**
     * Who asked. Since the reach decision this may be another Principal's
     * Instance: a request to seat a private Instance is asked of that
     * Instance's Principal by whoever wants it in the Room.
     */
    requestedByInstanceId: text("requested_by_instance_id").$type<InstanceId>().notNull(),
    /** For a request to seat a private Instance: the Instance being asked. */
    requestedForInstanceId: text("requested_for_instance_id").$type<InstanceId>(),
    roomId: text("room_id").$type<RoomId>(),
    answer: text("answer"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    resolvedAt: domainTimestamp("resolved_at"),
  },
  (table) => [
    foreignKey({
      name: "decision_principal_fk",
      columns: [table.principalId],
      foreignColumns: [principals.id],
    }).onDelete("cascade"),
    // The requester and the Room may belong to another Principal (migration
    // 0011 relaxed both keys, as 0004 did for room_member).
    foreignKey({
      name: "decision_requester_instance_fk",
      columns: [table.requestedByInstanceId],
      foreignColumns: [instances.id],
    }).onUpdate("cascade"),
    foreignKey({
      name: "decision_requested_for_instance_fk",
      columns: [table.requestedForInstanceId],
      foreignColumns: [instances.id],
    }).onUpdate("cascade"),
    foreignKey({
      name: "decision_room_fk",
      columns: [table.roomId],
      foreignColumns: [rooms.id],
    }),
    index("decision_principal_created_at_idx").on(table.principalId, table.createdAt),
    index("decision_principal_status_idx").on(table.principalId, table.status),
    check("decision_id_format", sql`${table.id} ~ ${DECISION_ID_RE}`),
    check("decision_mode_valid", sql`${table.mode} IN ('approval', 'text')`),
    check(
      "decision_state_consistent",
      sql`(
            ${table.mode} = 'approval'
            AND (
              (${table.status} = 'pending' AND ${table.answer} IS NULL AND ${table.resolvedAt} IS NULL)
              OR (${table.status} IN ('approved', 'denied') AND ${table.answer} IS NULL AND ${table.resolvedAt} IS NOT NULL)
            )
          ) OR (
            ${table.mode} = 'text'
            AND (
              (${table.status} = 'pending' AND ${table.answer} IS NULL AND ${table.resolvedAt} IS NULL)
              OR (${table.status} = 'answered' AND ${table.answer} IS NOT NULL AND length(btrim(${table.answer})) > 0 AND ${table.resolvedAt} IS NOT NULL)
            )
          )`,
    ),
  ],
);

export const idempotencyRecords = sharednetSchema.table(
  "idempotency_record",
  {
    principalId: text("principal_id")
      .$type<PrincipalId>()
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    credentialClass: text("credential_class")
      .$type<"web_session" | "api_key" | "instance" | "guest">()
      .notNull(),
    actorId: text("actor_id").notNull(),
    operationId: text("operation_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    expiresAt: domainTimestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "idempotency_record_pk",
      columns: [
        table.principalId,
        table.credentialClass,
        table.actorId,
        table.operationId,
        table.idempotencyKey,
      ],
    }),
    index("idempotency_record_expiry_idx").on(table.expiresAt),
    check(
      "idempotency_credential_class_valid",
      sql`${table.credentialClass} IN ('web_session', 'api_key', 'instance', 'guest')`,
    ),
    check(
      "idempotency_actor_id_valid",
      sql`(${table.credentialClass} = 'web_session' AND length(${table.actorId}) > 0)
          OR (${table.credentialClass} = 'api_key' AND ${table.actorId} ~ '^key_[0-9A-Za-z]{10}$')
          OR (${table.credentialClass} = 'instance' AND ${table.actorId} ~ ${INSTANCE_ID_RE})
          OR (${table.credentialClass} = 'guest' AND ${table.actorId} ~ ${MEMBER_ID_RE})`,
    ),
    check(
      "idempotency_uuid_v4",
      sql`${table.idempotencyKey}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "idempotency_request_fingerprint_format",
      sql`${table.requestFingerprint} ~ ${SHA256_HEX_RE}`,
    ),
    check(
      "idempotency_response_status_success",
      sql`${table.responseStatus} BETWEEN 200 AND 299`,
    ),
    check(
      "idempotency_response_body_bounded",
      sql`octet_length(${table.responseBody}) <= 65536`,
    ),
    check(
      "idempotency_retention_minimum",
      sql`${table.expiresAt} >= ${table.createdAt} + interval '24 hours'`,
    ),
  ],
);

/**
 * A cursor the service keeps for a seat that has nowhere local to keep one:
 * a chat product's Instance (ChatGPT, Claude) reads a Room through MCP and has
 * no `.sharednet/` directory. One row per Instance per Room; the CLI's seats
 * keep theirs in the project directory and never write here.
 */
export const instanceCursors = sharednetSchema.table(
  "instance_cursor",
  {
    instanceId: text("instance_id").$type<InstanceId>().notNull(),
    roomId: text("room_id").$type<RoomId>().notNull(),
    lastSequence: integer("last_sequence").default(0).notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "instance_cursor_pk", columns: [table.instanceId, table.roomId] }),
    foreignKey({ name: "instance_cursor_instance_fk", columns: [table.instanceId], foreignColumns: [instances.id] })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({ name: "instance_cursor_room_fk", columns: [table.roomId], foreignColumns: [rooms.id] }).onDelete("cascade"),
  ],
);

export const databaseSchema = {
  principals,
  agents,
  instances,
  rooms,
  roomMembers,
  roomInvites,
  roomGuests,
  messages,
  decisions,
  idempotencyRecords,
  cliLogins,
  instanceCursors,
} as const;
