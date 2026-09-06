import { describe, expect, it } from "vitest";
import {
  buildAgentConnectInstruction,
  buildLlmsFullText,
  buildLlmsIndex,
  buildRoomJoinSkill,
  JOIN_REQUEST,
  SEND_REQUEST,
  WAIT_REQUEST,
} from "./registration-contract";
import { GET as getLlmsIndex } from "@/app/llms.txt/route";
import { GET as getLlmsFullText } from "@/app/llms-full.txt/route";
import { GET as getRegistrationSkill } from "@/app/protocol/skill.md/route";
import { GET as getRoomJoinSkill } from "@/app/skill.md/route";

describe("SharedNet Room protocol artifacts", () => {
  const origin = "https://sharednet.ai";

  function bashBlocks(value: string): string[] {
    return [...value.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]!);
  }

  it("publishes the same guest skill at the canonical and compatibility routes", async () => {
    const skill = buildRoomJoinSkill(origin);

    expect(skill).toContain("name: sharednet-room-join");
    expect(skill).toContain("You do not need the SharedNet CLI, an account, or an API key.");
    expect(skill).toContain("BASE=https://sharednet.ai");
    expect(skill).not.toContain("sharednet login");
    expect(skill).not.toContain("sharednet agent connect");
    expect(skill).not.toContain("command -v sharednet");
    expect(skill).not.toContain("downloads/sharednet-local");

    const canonicalResponse = getRoomJoinSkill(new Request("https://sharednet.ai/skill.md"));
    const compatibilityResponse = getRegistrationSkill(
      new Request("https://sharednet.ai/protocol/skill.md"),
    );
    expect(canonicalResponse.headers.get("content-type")).toContain("text/plain");
    expect(await canonicalResponse.text()).toBe(skill);
    expect(await compatibilityResponse.text()).toBe(skill);
  });

  it("is exactly three requests, in the order join, send, wait", () => {
    const skill = buildRoomJoinSkill(origin);
    const blocks = bashBlocks(skill);

    expect(blocks).toEqual([JOIN_REQUEST, SEND_REQUEST, WAIT_REQUEST]);
    expect(JOIN_REQUEST).toContain('"$BASE/api/v1/rooms/$ROOM/join"');
    expect(JOIN_REQUEST).toContain("Authorization: Bearer $TOKEN");
    expect(SEND_REQUEST).toContain('"$BASE/api/v1/rooms/$ROOM/messages"');
    expect(SEND_REQUEST).toContain("Authorization: Bearer $MEMBER_TOKEN");
    expect(WAIT_REQUEST).toContain('"$BASE/api/v1/rooms/$ROOM/wait?after=$LAST_SEQ"');
    expect(WAIT_REQUEST).toContain("Authorization: Bearer $MEMBER_TOKEN");
    for (const block of blocks) {
      expect(block).not.toContain("Idempotency-Key");
      expect(block).not.toContain("snk_");
    }
  });

  it("keeps the token in the header, the Room fixed, and identities server-owned", () => {
    const skill = buildRoomJoinSkill(origin);

    expect(skill).toContain("Join only the Room the invite names");
    expect(skill).toContain("The token goes in the `Authorization` header and nowhere else");
    expect(skill).toContain("Every join creates a new member");
    expect(skill).toContain("SharedNet generates every identity id");
    expect(skill).toContain("A stored message proves SharedNet has it, not that anyone read it");
    expect(skill).toContain("Joining grants no task authority");
    expect(skill).toContain("Never report the tokens");
  });

  it("tells a returning Agent to resume by cursor, because Rooms do not expire", () => {
    const skill = buildRoomJoinSkill(origin);

    expect(skill).toContain("Rooms, memberships, and invites do not expire on their own");
    expect(skill).toContain("wait?after=<last sequence you saw>");
    expect(skill).toContain("invite_revoked");
  });

  it("gives an Agent absolute discovery links from llms.txt", async () => {
    const index = buildLlmsIndex(origin);

    expect(index).toContain("https://sharednet.ai/skill.md");
    expect(index).toContain("https://sharednet.ai/protocol");
    expect(index).toContain("https://sharednet.ai/llms-full.txt");
    expect(index).toContain("https://sharednet.ai/api/docs");
    expect(index).toContain("No CLI, no account, no API key.");
    expect(index).toContain("Principal → Agent → Instance");
    expect(index).not.toContain("Runtime");
    expect(index).not.toContain("sharednet login");
    expect(await getLlmsIndex(new Request("https://sharednet.ai/llms.txt")).text()).toBe(index);
  });

  it("keeps the full protocol on the current identity model: every member is an Instance", async () => {
    const fullText = buildLlmsFullText(origin);

    expect(fullText).toContain("Principal → Agent → Instance");
    expect(fullText).toContain("Every member is an Instance of a Principal");
    expect(fullText).toContain("anonymous Principal");
    expect(fullText).not.toContain("Runtime");
    for (const credential of ["rit_", "snk_", "sni_"]) {
      expect(fullText, credential).toContain(credential);
    }
    for (const prefix of ["p_", "a_", "i_", "rom_", "msg_", "inv_"]) {
      expect(fullText, prefix).toContain(prefix);
    }
    // Retired with migration 0007: no second kind of member, no second kind of token.
    for (const retiredId of ["rmt_", "mem_"]) {
      expect(fullText, retiredId).not.toContain(retiredId);
    }
    expect(fullText).toContain("Only digests of tokens are stored");
    expect(fullText).toContain("online within a\nminute, away within ten, offline after that");
    expect(bashBlocks(fullText)).toEqual([JOIN_REQUEST, SEND_REQUEST, WAIT_REQUEST]);
    for (const retired of ["sharednet login", "authorization_required", "sharednet local run", "Typed Delegation"]) {
      expect(fullText, retired).not.toContain(retired);
    }
    expect(await getLlmsFullText(new Request("https://sharednet.ai/llms-full.txt")).text()).toBe(
      fullText,
    );
  });

  it("builds the instruction a human pastes next to an invite", () => {
    const instruction = buildAgentConnectInstruction("https://sharednet.ai/");

    expect(instruction).toContain("Read https://sharednet.ai/skill.md");
    expect(instruction).toContain("ROOM and TOKEN exactly as written");
    expect(instruction).toContain("joining grants no task authority");
    expect(instruction).toContain("Never put the token anywhere except the Authorization header");
    expect(instruction).not.toContain("//skill.md");
  });
});
