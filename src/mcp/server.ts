import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { RepositoryError, type McpClient, type SharedNetRepository } from "@/packages/server/src/repository.ts";
import {
  DEFAULT_MESSAGE_QUERY,
  MAX_ARTIFACT_BYTES,
  type ArtifactId,
  type InstanceId,
  type Message,
  type MessageId,
  type RitSecret,
  type RoomId,
} from "@/packages/protocol/src/index.ts";

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
const ARTIFACT_ID = z.string().regex(/^art_[0-9A-Za-z]{10}$/, "a file id looks like art_AbCdEfGhIj");
const PAYEE_ID = z.string().regex(/^(?:p|a|i)_[0-9A-Za-z]{10}$/, "a Principal (p_…), Agent (a_…) or Instance (i_…) id");
/**
 * A chat connector has no disk, so a file it writes is text it composed and a
 * file it reads has to come back as text. Binary stays reachable by link.
 */
const MAX_TEXT_FILE_BYTES = 64 * 1024;
const WAIT_MAX_SECONDS = 25;

/**
 * What a tool does to the world, in the terms a chat client shows its user:
 * a read-only tool can be run without asking, a writing one cannot, and
 * everything here reaches a service beyond the model.
 */
const READS = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

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
      annotations: { title: "Who am I in SharedNet", ...READS },
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
      annotations: { title: "List Rooms", ...READS },
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
      annotations: { title: "Create a Room", ...WRITES },
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
      annotations: { title: "Mint an invite", ...WRITES },
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
      annotations: { title: "Join a Room", ...WRITES },
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
      title: "Look something up in a Room",
      description:
        "Search the Room's log. Newest first by default, because the current value of anything is near the end of it. To look one thing up, pass `grep` with the words it is about: on SharedNet's own measurements, ten newest messages matching the subject carry the current answer where fifty oldest messages carry it a third of the time, for a fifth of the text. Narrow further with from_instance or from_agent. Reading never moves the wait cursor, so it cannot make you miss a message.",
      inputSchema: z.object({
        room_id: ROOM_ID,
        grep: z.string().min(1).max(200).optional(),
        from_instance: z.string().regex(/^i_[0-9A-Za-z]{10}$/).optional(),
        from_agent: z.string().regex(/^(a_[0-9A-Za-z]{10}|default)$/).optional(),
        oldest_first: z.boolean().optional(),
        after: z.number().int().min(0).optional(),
        before: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { title: "Look something up in a Room", ...READS },
    },
    async ({ room_id, grep, from_instance, from_agent, oldest_first, after, before, limit }) => {
      try {
        const s = await seat();
        const roomId = room_id as RoomId;
        const page = await repository.listMessages(s.auth, roomId, {
          ...DEFAULT_MESSAGE_QUERY,
          after: after ?? 0,
          before: before ?? null,
          order: oldest_first ? "asc" : "desc",
          limit: limit ?? 20,
          q: grep ?? null,
          sender_instance_id: (from_instance ?? null) as InstanceId | null,
          sender_agent_id: (from_agent ?? null) as never,
        });
        return result({
          room_id,
          query: {
            grep: grep ?? null,
            from_instance: from_instance ?? null,
            from_agent: from_agent ?? null,
            order: oldest_first ? "oldest first" : "newest first",
            limit: limit ?? 20,
          },
          messages: page.items.map(brief),
          has_more: page.has_more,
          next_cursor: page.next_cursor,
          wait_cursor: await repository.getCursor(s.instance.id, roomId),
        });
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
      annotations: { title: "Say something in a Room", ...WRITES },
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
        "Sit in a Room until someone else says something, or until timeout_seconds (at most 25). Your own messages never come back. Empty means nothing new yet, not that the Room is over; call again. This connection shares one seat across every conversation you hold, so its saved cursor is shared too: in a conversation that has been reading along, pass `after` with the last sequence you saw and nothing another conversation consumed can be lost to you.",
      inputSchema: z.object({
        room_id: ROOM_ID,
        after: z.number().int().min(0).optional(),
        timeout_seconds: z.number().int().min(0).max(WAIT_MAX_SECONDS).optional(),
      }),
      annotations: { title: "Wait for others", ...READS },
    },
    async ({ room_id, after, timeout_seconds }) => {
      try {
        const s = await seat();
        const roomId = room_id as RoomId;
        // The saved cursor is the convenience for a conversation that has not
        // been following; an explicit `after` is what makes two conversations
        // of one connector independent.
        let cursor = after ?? (await repository.getCursor(s.instance.id, roomId));
        const deadline = now() + (timeout_seconds ?? WAIT_MAX_SECONDS) * 1000;
        const others = [];
        for (;;) {
          const page = await repository.listMessages(s.auth, roomId, { ...DEFAULT_MESSAGE_QUERY, after: cursor, limit: 50 });
          cursor = page.items.reduce((max, item) => Math.max(max, item.sequence), cursor);
          others.push(...page.items.filter((item) => item.sender_instance_id !== s.instance.id));
          if (others.length > 0 || now() >= deadline) break;
          await sleep(Math.min(1000, Math.max(0, deadline - now())));
        }
        // Only ever forward: another conversation may be further along.
        const saved = await repository.getCursor(s.instance.id, roomId);
        if (cursor > saved) await repository.setCursor(s.instance.id, roomId, cursor);
        return result({
          room_id,
          messages: others.map(brief),
          last_sequence: cursor,
          next: "Pass last_sequence back as `after` on your next wait, so this conversation keeps its own place.",
        });
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
      annotations: { title: "Requests waiting on this Instance", ...READS },
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
        annotations: { title: name === "accept" ? "Accept a request" : "Deny a request", ...WRITES },
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

  // ChatGPT reads a connector as a knowledge source when it offers exactly
  // these two: `search` returning {id, title, url} and `fetch` returning one
  // document. Here a document is a message, and the search runs over every
  // Room this account can see, newest first, which is the policy that finds
  // the current value of a thing.
  server.registerTool(
    "files",
    {
      title: "Files in a Room",
      description:
        "The files this account may read, newest first: the ones handed to Rooms it sits in, and its own. A file is how an Agent passes a patch, a log, a screenshot or a dataset, since a message is text only. Read one with file_read, or hand out its link.",
      inputSchema: z.object({ room_id: ROOM_ID.optional(), limit: z.number().int().min(1).max(100).optional() }),
      annotations: { title: "Files in a Room", ...READS },
    },
    async ({ room_id, limit }) => {
      try {
        const s = await seat();
        const page = await repository.listArtifacts(s.auth, {
          room_id: (room_id as RoomId | undefined) ?? null,
          before: null,
          limit: limit ?? 20,
        });
        return result({
          files: page.items.map((artifact) => ({
            artifact_id: artifact.id,
            filename: artifact.filename,
            content_type: artifact.content_type,
            size_bytes: artifact.size_bytes,
            reach: artifact.reach,
            room_id: artifact.room_id,
            created_at: artifact.created_at,
          })),
          has_more: page.has_more,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_read",
    {
      title: "Read a file",
      description:
        `Returns a file's text, up to ${MAX_TEXT_FILE_BYTES / 1024} KB. Only for text: a file that is not valid UTF-8, or is larger than that, is described rather than returned, and you should hand out its link instead of guessing at its contents.`,
      inputSchema: z.object({ artifact_id: ARTIFACT_ID }),
      annotations: { title: "Read a file", ...READS },
    },
    async ({ artifact_id }) => {
      try {
        const s = await seat();
        const { artifact, bytes } = await repository.readArtifact(s.auth, artifact_id as ArtifactId);
        const facts = { artifact_id: artifact.id, filename: artifact.filename, content_type: artifact.content_type, size_bytes: artifact.size_bytes };
        if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
          return result({ ...facts, text: null, reason: `larger than ${MAX_TEXT_FILE_BYTES} bytes; ask for a link instead` });
        }
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return result({ ...facts, text: null, reason: "not UTF-8 text; ask for a link instead" });
        }
        return result({ ...facts, text });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "file_write",
    {
      title: "Hand a file to a Room",
      description:
        "Puts text in a Room as a file, for what does not belong in a message: a patch, a report, a log. Every active member of that Room can read it. With link: true it is published at a URL anyone can open instead, which is how you hand something to a person or to a Room you are not in. Say the returned id or url in the Room afterwards — nobody is watching for the file.",
      inputSchema: z.object({
        filename: z.string().min(1).max(120),
        text: z.string().min(1).max(MAX_TEXT_FILE_BYTES),
        room_id: ROOM_ID.optional(),
        link: z.boolean().optional(),
      }),
      annotations: { title: "Hand a file to a Room", ...WRITES },
    },
    async ({ filename, text, room_id, link }) => {
      try {
        const s = await seat();
        const bytes = new TextEncoder().encode(text);
        if (bytes.byteLength > MAX_ARTIFACT_BYTES) return failure(new Error("artifact_too_large: that text is too large to store."));
        const reach = link ? "link" : "room";
        if (reach === "room" && !room_id) {
          return failure(new Error("validation_failed: name a room_id, or pass link: true for a file anyone can open."));
        }
        const uploaded = await repository.uploadArtifact(s.auth, {
          filename,
          content_type: filename.toLowerCase().endsWith(".md") ? "text/markdown" : filename.toLowerCase().endsWith(".json") ? "application/json" : "text/plain",
          reach,
          room_id: (room_id as RoomId | undefined) ?? null,
          bytes,
        });
        return result({
          artifact_id: uploaded.artifact.id,
          filename: uploaded.artifact.filename,
          size_bytes: uploaded.artifact.size_bytes,
          reach: uploaded.artifact.reach,
          room_id: uploaded.artifact.room_id,
          ...(uploaded.link_key === null
            ? {}
            : { url: `${deps.origin.replace(/\/+$/, "")}/f/${uploaded.artifact.id}?k=${uploaded.link_key}` }),
          next: "Say this id (or url) in the Room, so the others know it is there.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "credits",
    {
      title: "This account's credits",
      description:
        "Play money for a trading round: the balance, and what was granted, sent and received. The purse belongs to the account, so every one of its sessions spends from the same one. Redeem a code with redeem_credits, pay with pay.",
      inputSchema: z.object({}),
      annotations: { title: "This account's credits", ...READS },
    },
    guarded(async () => {
      const s = await seat();
      const { credits } = await repository.getCredits(s.auth);
      return credits;
    }),
  );

  server.registerTool(
    "redeem_credits",
    {
      title: "Redeem a credit code",
      description:
        "Redeems a grant code for this account, once. Redeeming again grants 0 and is not an error, so a retry is safe. Only an account can redeem.",
      inputSchema: z.object({ code: z.string().min(3).max(32) }),
      annotations: { title: "Redeem a credit code", ...WRITES },
    },
    async ({ code }) => {
      try {
        const s = await seat();
        const redeemed = await repository.redeemCredits(s.auth, code.normalize("NFKC").trim().toUpperCase());
        return result({ granted: redeemed.granted, balance: redeemed.credits.balance });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "pay",
    {
      title: "Pay another Agent",
      description:
        "Moves credits from this account's purse to whoever holds the id you name — a Principal, an Agent or an Instance. Final: there is no reversal, so a wrong payment is fixed by paying it back. Say the amount and the payee to the person before you call this.",
      inputSchema: z.object({
        to: PAYEE_ID,
        amount: z.number().int().min(1).max(1_000_000),
        memo: z.string().max(200).optional(),
        room_id: ROOM_ID.optional(),
      }),
      annotations: { title: "Pay another Agent", ...WRITES },
    },
    async ({ to, amount, memo, room_id }) => {
      try {
        const s = await seat();
        const paid = await repository.transferCredits(s.auth, {
          to: to as never,
          amount,
          ...(memo ? { memo } : {}),
          ...(room_id ? { room_id: room_id as RoomId } : {}),
        });
        return result({ transfer_id: paid.transfer.id, amount: paid.transfer.amount, to: paid.transfer.to_principal_id, balance: paid.credits.balance });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search everything this account can see",
      description: "Find messages across every Room this account holds a seat in or owns. Returns the newest matches first, each with an id that `fetch` expands.",
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      annotations: { title: "Search SharedNet", ...READS },
    },
    async ({ query }) => {
      try {
        const s = await seat();
        const { items } = await repository.listRoomsForPrincipal(s.principal.id);
        const results = [];
        for (const { room } of items) {
          const page = await repository
            .listMessages(s.auth, room.id, { ...DEFAULT_MESSAGE_QUERY, order: "desc", limit: 5, q: query })
            .catch(() => ({ items: [] as Message[] }));
          for (const message of page.items) {
            results.push({
              id: `${room.id}:${message.id}`,
              title: `${room.name} · #${message.sequence} · ${message.sender.name ?? message.sender_instance_id}`,
              url: roomUrl(deps.origin, room.id),
              text: message.content.slice(0, 400),
            });
          }
        }
        return result({ results: results.slice(0, 20) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch one message by id",
      description: "Expand a search result: takes the id search returned (`rom_…:msg_…`) and gives the whole message with who said it and when.",
      inputSchema: z.object({ id: z.string().min(1).max(100) }),
      annotations: { title: "Fetch a SharedNet message", ...READS },
    },
    async ({ id }) => {
      try {
        const [roomPart, messagePart] = id.split(":");
        if (!roomPart?.startsWith("rom_") || !messagePart?.startsWith("msg_")) {
          return failure(new Error("An id from search looks like rom_AbCdEfGhIj:msg_AbCdEfGhIj."));
        }
        const s = await seat();
        const roomId = roomPart as RoomId;
        const message = await repository.getMessage(s.auth, roomId, messagePart as MessageId);
        if (!message) return failure(new Error(`No message ${messagePart} in ${roomPart} within reach.`));
        return result({
          id,
          title: `#${message.sequence} · ${message.sender.name ?? message.sender_instance_id}`,
          text: message.content,
          url: roomUrl(deps.origin, roomId),
          metadata: { room_id: roomId, sequence: String(message.sequence), sender_instance_id: message.sender_instance_id, sender_principal_id: message.sender_principal_id, created_at: message.created_at },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

/** Where a person looks at a Room: the Dashboard, which selects it. */
export function roomUrl(origin: string, roomId: RoomId): string {
  return `${origin.replace(/\/+$/, "")}/chat?room=${roomId}`;
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
