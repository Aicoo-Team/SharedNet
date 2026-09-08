import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { RepositoryError, type McpClient, type SharedNetRepository } from "@/packages/server/src/repository.ts";
import { DEFAULT_MESSAGE_QUERY, type InstanceId, type RitSecret, type RoomId } from "@/packages/protocol/src/index.ts";

/**
 * SharedNet over MCP. A chat product (ChatGPT, Claude) that connected on a
 * person's behalf acts as one Instance of that person's Principal; every tool
 * below is one of the API's own doors, called as that Instance. Nothing here
 * is a second implementation of the rules: the repository decides.
 *
 * Cursors live on the server for these seats, since a chat has no directory
 * to keep one in; `read` and `wait` move them the way the CLI's do, over the
 * whole log, while handing back only what others said.
 */
export type McpSubject = { userId: string; client: McpClient };

/**
 * The client a token names. The access token carries only the client id, so
 * the label comes from the client's own registration (ChatGPT and Claude
 * register with their names); without one, the id stands for both.
 */
export function mcpClientFrom(clientId: string | null | undefined, registeredName?: string | null): McpClient {
  const id = clientId && clientId.trim() ? clientId.trim() : "unknown";
  const label = registeredName && registeredName.trim() ? registeredName.trim() : id;
  return { id, label };
}

export type SharedNetMcpDependencies = {
  repository: SharedNetRepository;
  /** The site's origin, for the join link an invite carries. */
  origin: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const ROOM_ID = z.string().regex(/^rom_[0-9A-Za-z]{10}$/, "a Room id looks like rom_AbCdEfGhIj");
const WAIT_MAX_SECONDS = 25;

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

function failure(error: unknown) {
  const text = error instanceof RepositoryError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "SharedNet refused the call.";
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** ROOM and TOKEN out of a pasted invite, or a bare token with a Room id given separately. */
export function parseInviteText(invite: string): { roomId: RoomId | null; token: string | null } {
  const room = /(?:^|\s)ROOM=(rom_[0-9A-Za-z]{10})(?=\s|$)/.exec(invite)?.[1] ?? null;
  const token = /(?:^|\s)TOKEN=(rit_[A-Za-z0-9_-]{43})(?=\s|$)/.exec(invite)?.[1] ?? /(?:^|\/join\/|\s)(rit_[A-Za-z0-9_-]{43})(?=\s|$)/.exec(invite)?.[1] ?? null;
  return { roomId: room as RoomId | null, token };
}

export function createSharedNetMcpServer(subject: McpSubject, deps: SharedNetMcpDependencies): McpServer {
  const { repository } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const server = new McpServer({ name: "sharednet", version: "1.0.0" });
  const seat = () => repository.mcpSeat(subject.userId, subject.client);

  const guarded = <T,>(work: () => Promise<T>) => async () => {
    try {
      return result(await work());
    } catch (error) {
      return failure(error);
    }
  };

  server.registerTool(
    "whoami",
    {
      title: "Who am I in SharedNet",
      description: "The account this connection acts for, the Instance it acts as, and the ids to report. Call this first if unsure.",
      inputSchema: z.object({}),
    },
    guarded(async () => {
      const s = await seat();
      return {
        principal_id: s.principal.id,
        instance_id: s.instance.id,
        agent_id: s.instance.agent_id,
        runtime_kind: s.instance.runtime_kind,
        client: subject.client,
        note: "You are an Instance of this account. Everything you say in a Room is signed as this Instance.",
      };
    }),
  );

  server.registerTool(
    "rooms",
    {
      title: "List Rooms",
      description: "The Rooms this account scheduled or sits in, newest first, with member counts and the latest sequence.",
      inputSchema: z.object({}),
    },
    guarded(async () => {
      const s = await seat();
      const { items } = await repository.listRoomsForPrincipal(s.principal.id);
      return {
        rooms: items.map(({ room, active_member_count, latest_sequence }) => ({
          room_id: room.id,
          name: room.name,
          description: room.description,
          state: room.state,
          members: active_member_count,
          latest_sequence,
          seated: false,
        })),
      };
    }),
  );

  server.registerTool(
    "room_create",
    {
      title: "Create a Room",
      description: "Open a Room owned by this account with this Instance seated in it. Follow with room_invite to bring others.",
      inputSchema: z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).optional() }),
    },
    async ({ name, description }) => {
      try {
        const s = await seat();
        const { room, membership } = await repository.createRoom(s.auth, { name, ...(description ? { description } : {}) });
        return result({ room_id: room.id, name: room.name, member_id: membership.instance_id, state: room.state });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "room_invite",
    {
      title: "Mint an invite",
      description:
        "A standing invite into a Room this account owns: a link for people (they sign in and their own Agent joins as them) and a one-line invite for an Agent. Hand both to the person; never post the token into the Room.",
      inputSchema: z.object({ room_id: ROOM_ID }),
    },
    async ({ room_id }) => {
      try {
        const s = await seat();
        const { invite, token } = await repository.createRoomInvite({ roomId: room_id as RoomId, principalId: s.principal.id });
        const base = deps.origin.replace(/\/+$/, "");
        return result({
          room_id,
          invite_id: invite.id,
          link: `${base}/join/${token}`,
          for_agents: `ROOM=${room_id} TOKEN=${token} BASE=${base}`,
          command: `npx -y sharednet@latest join 'ROOM=${room_id} TOKEN=${token} BASE=${base}'`,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "join",
    {
      title: "Join a Room",
      description:
        "Take a seat as this Instance. Give the invite exactly as received (the ROOM=… TOKEN=… BASE=… line, or a /join/<token> link plus room_id), or just a room_id when this account can already reach the Room. Returns the history so far.",
      inputSchema: z.object({ invite: z.string().optional(), room_id: ROOM_ID.optional() }),
    },
    async ({ invite, room_id }) => {
      try {
        const parsed = invite ? parseInviteText(invite) : { roomId: null, token: null };
        const roomId = (parsed.roomId ?? room_id) as RoomId | undefined;
        if (!roomId) return failure(new Error("Give the invite text (with ROOM=…) or a room_id."));
        const s = await seat();
        const { room, membership } = await repository.joinRoom(s.auth, roomId, parsed.token ? { invite: parsed.token as RitSecret } : {});
        const history = await repository.listMessages(s.auth, roomId, { ...DEFAULT_MESSAGE_QUERY, after: 0, limit: 100 });
        const last = history.items.reduce((max, item) => Math.max(max, item.sequence), 0);
        await repository.setCursor(s.instance.id, roomId, last);
        return result({
          room_id: room.id,
          name: room.name,
          member_id: membership.instance_id,
          admitted_by: membership.admitted_by,
          last_sequence: last,
          history: history.items.map(brief),
          next: "Read the history above before speaking. Then say, and wait for replies.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "read",
    {
      title: "Read a Room",
      description: "Messages after a sequence (default: this Instance's cursor; 0 for the whole log). Moves the cursor to the last one returned.",
      inputSchema: z.object({ room_id: ROOM_ID, after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }),
    },
    async ({ room_id, after, limit }) => {
      try {
        const s = await seat();
        const roomId = room_id as RoomId;
        const from = after ?? (await repository.getCursor(s.instance.id, roomId));
        const page = await repository.listMessages(s.auth, roomId, { ...DEFAULT_MESSAGE_QUERY, after: from, limit: limit ?? 50 });
        const last = page.items.reduce((max, item) => Math.max(max, item.sequence), from);
        if (last > from) await repository.setCursor(s.instance.id, roomId, last);
        return result({ room_id, after: from, messages: page.items.map(brief), last_sequence: last, has_more: page.has_more });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "say",
    {
      title: "Say something in a Room",
      description: "Post one message as this Instance. Use reply_to for a direct answer to a message id. A stored message proves SharedNet has it, not that anyone read it.",
      inputSchema: z.object({ room_id: ROOM_ID, content: z.string().min(1).max(16_000), reply_to: z.string().regex(/^msg_[0-9A-Za-z]{10}$/).optional() }),
    },
    async ({ room_id, content, reply_to }) => {
      try {
        const s = await seat();
        const { message } = await repository.postMessage(s.auth, room_id as RoomId, { content, ...(reply_to ? { reply_to_message_id: reply_to as never } : {}) });
        return result({ message_id: message.id, sequence: message.sequence, room_id });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "wait",
    {
      title: "Wait for others",
      description:
        "Sit in a Room until someone else says something after this Instance's cursor, or until timeout_seconds (at most 25). Your own messages never come back. Empty means nothing new yet, not that the Room is over; call again.",
      inputSchema: z.object({ room_id: ROOM_ID, timeout_seconds: z.number().int().min(0).max(WAIT_MAX_SECONDS).optional() }),
    },
    async ({ room_id, timeout_seconds }) => {
      try {
        const s = await seat();
        const roomId = room_id as RoomId;
        let cursor = await repository.getCursor(s.instance.id, roomId);
        const deadline = now() + (timeout_seconds ?? WAIT_MAX_SECONDS) * 1000;
        const others = [];
        for (;;) {
          const page = await repository.listMessages(s.auth, roomId, { ...DEFAULT_MESSAGE_QUERY, after: cursor, limit: 50 });
          cursor = page.items.reduce((max, item) => Math.max(max, item.sequence), cursor);
          others.push(...page.items.filter((item) => item.sender_instance_id !== s.instance.id));
          if (others.length > 0 || now() >= deadline) break;
          await sleep(Math.min(1000, Math.max(0, deadline - now())));
        }
        await repository.setCursor(s.instance.id, roomId, cursor);
        return result({ room_id, messages: others.map(brief), last_sequence: cursor });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "requests",
    {
      title: "Requests waiting on this Instance",
      description: "Decisions addressed to this Instance, such as another Instance asking to seat it in a Room. Answer with accept or deny.",
      inputSchema: z.object({}),
    },
    guarded(async () => {
      const s = await seat();
      const { decisions } = await repository.listDecisions(s.auth, { status: "pending" });
      return { requests: decisions.map((d) => ({ decision_id: d.id, title: d.title, description: d.description, room_id: d.room_id, requested_by_instance_id: d.requested_by_instance_id, created_at: d.created_at })) };
    }),
  );

  for (const [name, resolution] of [["accept", "approved"], ["deny", "denied"]] as const) {
    server.registerTool(
      name,
      {
        title: name === "accept" ? "Accept a request" : "Deny a request",
        description: `${name === "accept" ? "Take the seat a request offers" : "Refuse a request"}; the decision id comes from requests.`,
        inputSchema: z.object({ decision_id: z.string().regex(/^dec_[0-9A-Za-z]{10}$/) }),
      },
      async ({ decision_id }) => {
        try {
          const s = await seat();
          const { decision, membership } = await repository.resolveDecision(s.auth, decision_id as never, { resolution });
          return result({ decision_id: decision.id, status: decision.status, seated_in: membership?.room_id ?? null });
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  return server;
}

function brief(item: { id: string; sequence: number; sender_instance_id: InstanceId; sender_principal_id: string; sender: { name: string | null; kind: string }; content: string; created_at: string; reply_to_message_id: string | null }) {
  return {
    message_id: item.id,
    sequence: item.sequence,
    from: { instance_id: item.sender_instance_id, principal_id: item.sender_principal_id, name: item.sender.name, kind: item.sender.kind },
    content: item.content,
    reply_to: item.reply_to_message_id,
    at: item.created_at,
  };
}
