/**
 * Protocol conformance gate.
 *
 * The typed-coordination protocol has exactly one definition: the reference semantics in the
 * research repository (runtime-coordination/protocol). It publishes fixtures — sequences of
 * canonical events with the admission outcome and projection digest the reference produces — and
 * this package vendors them. Three things are enforced here:
 *
 *  1. the vendored files are byte-identical to what FIXTURES.lock.json pins, so a silent edit on
 *     either side fails CI instead of drifting;
 *  2. every event type the schema allows is either implemented by this server or explicitly listed
 *     as reserved for V2 — no third state;
 *  3. once the V2 event endpoint exists, the server must replay every fixture and reproduce every
 *     outcome and digest. Until then that test is `todo`, which keeps the gap visible in every run.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "..", "fixtures");
const read = (name: string) => readFileSync(join(dir, name));
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const lock = JSON.parse(read("FIXTURES.lock.json").toString()) as Record<string, string>;
const schema = JSON.parse(read("envelope.schema.json").toString());
const conformance = JSON.parse(read("conformance.json").toString()) as { protocol: string; fixtures: { name: string; events: unknown[]; outcomes: unknown[]; digest: string }[] };
const fuzz = JSON.parse(read("fuzz.json").toString()) as { protocol: string; logs: { seed: number; events: unknown[]; outcomes: unknown[]; digest: string }[] };

/** V1 implements only `message`; everything else is the typed lifecycle reserved for V2. */
const IMPLEMENTED: readonly string[] = ["message"];
const RESERVED_FOR_V2: readonly string[] = [
  "work.request", "work.accept", "work.decline", "work.result", "work.cancel", "work.resolve",
  "verification.pass", "verification.fail", "human.approve", "human.reject", "clock.tick",
];

describe("protocol fixtures are pinned", () => {
  it.each(["conformance.json", "fuzz.json", "envelope.schema.json"])("%s matches FIXTURES.lock.json", (name) => {
    expect(sha256(read(name))).toBe(lock[name]);
  });
  it("both fixture files describe the same protocol version", () => {
    expect(conformance.protocol).toBe(lock.protocol);
    expect(fuzz.protocol).toBe(lock.protocol);
  });
});

describe("every schema event type is implemented or reserved", () => {
  const types: string[] = schema.properties.type.enum;
  it("has no type outside the two lists", () => {
    expect([...types].sort()).toEqual([...IMPLEMENTED, ...RESERVED_FOR_V2].sort());
  });
  it("V1 messages use the one implemented type", () => {
    expect(IMPLEMENTED).toContain("message");
  });
});

describe("V2 replay conformance", () => {
  // When POST /rooms/{r}/events lands: for each fixture, create a room with `members`, post each
  // event as its actor, assert `accepted`/`code`/`binding` per event, then GET /state and assert
  // the projection digest equals `digest`. The counts below are what the gate will cover.
  it.todo(`replays ${conformance.fixtures.length} conformance scenarios (${conformance.fixtures.reduce((n, f) => n + f.events.length, 0)} events)`);
  it.todo(`replays ${fuzz.logs.length} fuzz logs (${fuzz.logs.reduce((n, l) => n + l.events.length, 0)} events)`);
});
