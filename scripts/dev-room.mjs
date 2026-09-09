/**
 * A Room to try the guest protocol against, with nothing but Node.
 *
 * Boots the in-memory V1 dev server, opens one Room through the same HTTP
 * routes an Agent uses, mints a standing invite for it, and prints the invite
 * in the exact shape the Web's "Invite an Agent" dialog produces. Then it keeps
 * serving and prints every message said in the Room, so a terminal stands in
 * for the Web while Agents talk.
 *
 *   node --experimental-strip-types scripts/dev-room.mjs            # port 3001
 *   PORT=0 node --experimental-strip-types scripts/dev-room.mjs     # any free port
 *   SHAREDNET_ROOM_NAME="ARK team" … --json invite.json             # also write the invite as JSON
 *
 * Nothing here persists: stop the process and the Room is gone. For a Room
 * that lasts, use the Web on a real deployment.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createSharedNetDevServer } from "../packages/server/src/dev-server.ts";
import { MemorySharedNetRepository } from "../packages/server/src/memory-repository.ts";

const host = process.env.HOST ?? "127.0.0.1";
const requestedPort = process.env.PORT === undefined ? 3001 : Number(process.env.PORT);
const roomName = process.env.SHAREDNET_ROOM_NAME?.trim() || "Dev Room";
const jsonFlag = process.argv.indexOf("--json");
const jsonPath = jsonFlag === -1 ? null : process.argv[jsonFlag + 1];
const quiet = process.argv.includes("--quiet");

if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  console.error("PORT must be an integer between 0 and 65535.");
  process.exit(1);
}

// A throwaway account key: it exists only inside this process.
const devApiKey = `snk_${Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64url").padEnd(43, "A").slice(0, 43)}`;
const store = new MemorySharedNetRepository({ devApiKey });
const server = createSharedNetDevServer(store);

const base = await new Promise((resolveBase) => {
  server.listen(requestedPort, host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : requestedPort;
    resolveBase(`http://${host}:${port}`);
  });
});

async function call(method, path, { token, body, idempotent } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotent) headers["idempotency-key"] = randomUUID();
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${parsed?.error?.code ?? response.status}`);
  }
  return parsed;
}

// The Room's host is an Instance of this account, exactly as the Web's Rooms
// belong to a Principal; the invite is minted for that Principal.
const started = await call("POST", "/api/v1/instances", {
  token: devApiKey,
  body: { runtime_kind: "custom", cli_version: "dev-room" },
});
const hostToken = started.token;
const principalId = started.instance.principal_id;
const created = await call("POST", "/api/v1/rooms", {
  token: hostToken,
  body: { name: roomName },
  idempotent: true,
});
const roomId = created.room.id;
const { token: inviteToken, invite } = await store.createRoomInvite({ roomId, principalId });

const inviteText = [
  `Read ${base}/skill.md and join Room ${roomId}.`,
  `ROOM=${roomId} TOKEN=${inviteToken}`,
  `BASE=${base}`,
].join("\n");

if (jsonPath) {
  writeFileSync(resolve(jsonPath), JSON.stringify({ base_url: base, room_id: roomId, token: inviteToken, invite_id: invite.id }, null, 2) + "\n");
}

console.log(`SharedNet dev Room "${roomName}" is open (in memory, this process only).\n`);
console.log(inviteText);
console.log(`\ninvite ${invite.id}: forever, until this process exits. Ctrl-C to close the Room.\n`);
if (!quiet) console.log("── transcript ──────────────────────────────────────────────────────────");

// Stand in for the Web: print what is said, as the Room's host.
let after = 0;
let closing = false;
async function tail() {
  while (!closing) {
    try {
      const page = await call("GET", `/api/v1/rooms/${roomId}/wait?after=${after}&timeout=25`, { token: hostToken });
      for (const message of page.items) {
        after = Math.max(after, message.sequence);
        if (quiet) continue;
        const who = message.sender.name ?? message.sender.member_id;
        const lines = message.content.split("\n");
        const trailer = lines.findLast((line) => line.startsWith("sharednet-typed: "));
        const kind = trailer ? ` [${JSON.parse(trailer.slice("sharednet-typed: ".length)).type}]` : "";
        const reply = message.reply_to_message_id ? ` ↩ ${message.reply_to_message_id}` : "";
        console.log(`#${String(message.sequence).padEnd(4)} ${who}${kind}${reply}`);
        for (const line of lines.filter((line) => !line.startsWith("sharednet-typed: ")).slice(0, 12)) {
          console.log(`      ${line}`);
        }
        if (lines.length > 12) console.log("      …");
      }
    } catch (error) {
      if (!closing) console.error(`tail: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
tail();

process.on("SIGINT", () => {
  closing = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
