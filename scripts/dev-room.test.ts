// @vitest-environment node
/**
 * `scripts/dev-room.mjs` is a dev tool, but it is the documented way to get a
 * Room without a database, so it is exercised end to end here: spawn it, read
 * the invite it prints, join through the real routes as a guest, speak, and
 * see the script echo the message as the Room's host would in the Web.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const scriptPath = new URL("./dev-room.mjs", import.meta.url).pathname;

function waitFor(child: ChildProcess, chunks: string[], needle: string, timeoutMs = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (chunks.join("").includes(needle)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${JSON.stringify(needle)}\n${chunks.join("")}`));
      setTimeout(check, 50);
    };
    check();
  });
}

describe("scripts/dev-room.mjs", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    child?.kill("SIGINT");
    child = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("opens a Room, prints a usable invite, and echoes what guests say", async () => {
    dir = await mkdtemp(join(tmpdir(), "sharednet-dev-room-"));
    const jsonPath = join(dir, "invite.json");
    const out: string[] = [];
    child = spawn(process.execPath, ["--experimental-strip-types", scriptPath, "--json", jsonPath], {
      env: { ...process.env, PORT: "0", SHAREDNET_ROOM_NAME: "Test Room" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => out.push(String(chunk)));
    child.stderr!.on("data", (chunk) => out.push(String(chunk)));
    await waitFor(child, out, "── transcript ──");

    const printed = out.join("");
    const room = /ROOM=(rom_[A-Za-z0-9]+) TOKEN=(rit_[A-Za-z0-9_-]{43})/.exec(printed);
    const base = /BASE=(http:\/\/127\.0\.0\.1:\d+)/.exec(printed);
    expect(room, printed).not.toBeNull();
    expect(base, printed).not.toBeNull();
    expect(printed).toContain('SharedNet dev Room "Test Room" is open');
    expect(printed).toContain(`Read ${base![1]}/skill.md and join Room ${room![1]}.`);

    const invite = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(invite).toMatchObject({ base_url: base![1], room_id: room![1], token: room![2] });
    expect(invite.invite_id).toMatch(/^inv_/);

    // The invite works through the real guest routes.
    const joined = await fetch(`${base![1]}/api/v1/rooms/${room![1]}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${room![2]}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "claude-code" }),
    });
    expect(joined.status).toBe(200);
    const { member_token: memberToken, membership } = await joined.json();
    expect(membership).toMatchObject({ kind: "guest", name: "claude-code" });

    const posted = await fetch(`${base![1]}/api/v1/rooms/${room![1]}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "hello from a guest\n\nsharednet-typed: {\"type\":\"work.result\",\"next\":\"writer\"}" }),
    });
    expect(posted.status).toBe(201);

    // …and the script, acting as the host, prints it with its type.
    await waitFor(child, out, "hello from a guest");
    const transcript = out.join("");
    expect(transcript).toContain("#1    claude-code [work.result]");
    expect(transcript).not.toContain("sharednet-typed:");
    expect(transcript).not.toContain(memberToken);
  });
});
