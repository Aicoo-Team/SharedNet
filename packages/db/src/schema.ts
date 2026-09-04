import { sql } from "drizzle-orm";
import {
  boolean,
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
  AgentId,
  ApiKeyId,
  DecisionId,
  InstanceId,
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
const SHA256_HEX_RE = sql.raw("'^[0-9a-f]{64}$'");

export const principals = sharednetSchema.table(
  "principal",
  {
    id: text("id").$type<PrincipalId>().primaryKey(),
    authUserId: text("auth_user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("principal_auth_user_id_unique").on(table.authUserId),
    check("principal_id_format", sql`${table.id} ~ ${PRINCIPAL_ID_RE}`),
  ],
);

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
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("agent_principal_id_id_unique").on(table.principalId, table.id),
    unique("agent_principal_handle_unique").on(table.principalId, table.handle),
    uniqueIndex("agent_one_default_per_principal")
      .on(table.principalId)
      .where(sql`${table.isDefault}`),
    check("agent_id_format", sql`${table.id} ~ ${AGENT_ID_RE}`),
    check("agent_handle_format", sql`${table.handle} ~ '^[a-z][a-z0-9-]{0,31}$'`),
    check(
      "agent_default_handle_consistent",
      sql`(${table.isDefault} AND ${table.handle} = 'default') OR (NOT ${table.isDefault} AND ${table.handle} <> 'default')`,
    ),
  ],
);

export const instances = sharednetSchema.table(
  "instance",
  {
    id: text("id").$type<InstanceId>().primaryKey(),
    principalId: text("principal_id").$type<PrincipalId>().notNull(),
    agentId: text("agent_id").$type<AgentId>().notNull(),
    issuedByKeyId: text("issued_by_key_id").$type<ApiKeyId>().notNull(),
    tokenDigest: text("token_digest").notNull(),
    runtimeKind: text("runtime_kind").$type<"codex" | "claude-code" | "custom">().notNull(),
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
    tokenExpiresAt: domainTimestamp("token_expires_at").notNull(),
    endedAt: domainTimestamp("ended_at"),
    revokedAt: domainTimestamp("revoked_at"),
  },
  (table) => [
    unique("instance_principal_agent_id_unique").on(
      table.principalId,
      table.agentId,
      table.id,
    ),
    unique("instance_token_digest_unique").on(table.tokenDigest),
    foreignKey({
      name: "instance_principal_agent_fk",
      columns: [table.principalId, table.agentId],
      foreignColumns: [agents.principalId, agents.id],
    }).onDelete("cascade"),
    index("instance_principal_idx").on(table.principalId),
    index("instance_agent_idx").on(table.agentId),
    index("instance_issued_by_key_idx").on(table.issuedByKeyId),
    index("instance_lease_expires_at_idx").on(table.leaseExpiresAt),
    check("instance_id_format", sql`${table.id} ~ ${INSTANCE_ID_RE}`),
    check(
      "instance_issued_by_key_id_format",
      sql`${table.issuedByKeyId} ~ '^key_[0-9A-Za-z]{10}$'`,
    ),
    check("instance_token_digest_format", sql`${table.tokenDigest} ~ ${SHA256_HEX_RE}`),
    check(
      "instance_runtime_kind_valid",
      sql`${table.runtimeKind} IN ('codex', 'claude-code', 'custom')`,
    ),
    check("instance_cli_version_length", sql`length(${table.cliVersion}) BETWEEN 1 AND 64`),
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
          AND ${table.tokenExpiresAt} > ${table.startedAt}`,
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
    creatorAgentId: text("creator_agent_id").$type<AgentId>().notNull(),
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
      name: "room_creator_agent_fk",
      columns: [table.principalId, table.creatorAgentId],
      foreignColumns: [agents.principalId, agents.id],
    }),
    index("room_principal_created_at_idx").on(table.principalId, table.createdAt),
    check("room_id_format", sql`${table.id} ~ ${ROOM_ID_RE}`),
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
    principalId: text("principal_id").$type<PrincipalId>().notNull(),
    roomId: text("room_id").$type<RoomId>().notNull(),
    agentId: text("agent_id").$type<AgentId>().notNull(),
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
  },
  (table) => [
    primaryKey({ name: "room_member_pk", columns: [table.roomId, table.instanceId] }),
    foreignKey({
      name: "room_member_room_fk",
      columns: [table.principalId, table.roomId],
      foreignColumns: [rooms.principalId, rooms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "room_member_agent_fk",
      columns: [table.principalId, table.agentId],
      foreignColumns: [agents.principalId, agents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "room_member_instance_fk",
      columns: [table.principalId, table.instanceId],
      foreignColumns: [instances.principalId, instances.id],
    }).onDelete("cascade"),
    index("room_member_principal_agent_idx").on(table.principalId, table.agentId),
    index("room_member_instance_idx").on(table.instanceId),
    check("room_member_room_id_format", sql`${table.roomId} ~ ${ROOM_ID_RE}`),
    check("room_member_agent_id_format", sql`${table.agentId} ~ ${AGENT_ID_RE}`),
    check("room_member_instance_id_format", sql`${table.instanceId} ~ ${INSTANCE_ID_RE}`),
    check(
      "room_member_state_consistent",
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
    senderAgentId: text("sender_agent_id").$type<AgentId>().notNull(),
    senderInstanceId: text("sender_instance_id").$type<InstanceId>().notNull(),
    content: text("content").notNull(),
    replyToMessageId: text("reply_to_message_id").$type<MessageId>(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("message_room_sequence_unique").on(table.roomId, table.sequence),
    unique("message_room_id_unique").on(table.roomId, table.id),
    foreignKey({
      name: "message_room_fk",
      columns: [table.senderPrincipalId, table.roomId],
      foreignColumns: [rooms.principalId, rooms.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_sender_agent_fk",
      columns: [table.senderPrincipalId, table.senderAgentId],
      foreignColumns: [agents.principalId, agents.id],
    }),
    foreignKey({
      name: "message_sender_instance_fk",
      columns: [table.senderPrincipalId, table.senderAgentId, table.senderInstanceId],
      foreignColumns: [instances.principalId, instances.agentId, instances.id],
    }),
    foreignKey({
      name: "message_sender_membership_fk",
      columns: [table.roomId, table.senderAgentId],
      foreignColumns: [roomMembers.roomId, roomMembers.agentId],
    }),
    foreignKey({
      name: "message_same_room_reply_fk",
      columns: [table.roomId, table.replyToMessageId],
      foreignColumns: [table.roomId, table.id],
    }),
    index("message_room_created_at_idx").on(table.roomId, table.createdAt),
    index("message_sender_instance_idx").on(table.senderInstanceId),
    check("message_id_format", sql`${table.id} ~ ${MESSAGE_ID_RE}`),
    check("message_sequence_positive", sql`${table.sequence} >= 1`),
    check(
      "message_content_valid",
      sql`length(btrim(${table.content})) > 0 AND octet_length(${table.content}) <= 32768`,
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
    requestedByAgentId: text("requested_by_agent_id").$type<AgentId>().notNull(),
    requestedByInstanceId: text("requested_by_instance_id").$type<InstanceId>().notNull(),
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
    foreignKey({
      name: "decision_requester_agent_fk",
      columns: [table.principalId, table.requestedByAgentId],
      foreignColumns: [agents.principalId, agents.id],
    }),
    foreignKey({
      name: "decision_requester_instance_fk",
      columns: [
        table.principalId,
        table.requestedByAgentId,
        table.requestedByInstanceId,
      ],
      foreignColumns: [instances.principalId, instances.agentId, instances.id],
    }),
    foreignKey({
      name: "decision_room_fk",
      columns: [table.principalId, table.roomId],
      foreignColumns: [rooms.principalId, rooms.id],
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
      .$type<"web_session" | "api_key" | "instance">()
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
      sql`${table.credentialClass} IN ('web_session', 'api_key', 'instance')`,
    ),
    check(
      "idempotency_actor_id_valid",
      sql`(${table.credentialClass} = 'web_session' AND length(${table.actorId}) > 0)
          OR (${table.credentialClass} = 'api_key' AND ${table.actorId} ~ '^key_[0-9A-Za-z]{10}$')
          OR (${table.credentialClass} = 'instance' AND ${table.actorId} ~ ${INSTANCE_ID_RE})`,
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

export const databaseSchema = {
  principals,
  agents,
  instances,
  rooms,
  roomMembers,
  messages,
  decisions,
  idempotencyRecords,
} as const;
