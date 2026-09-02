import { describe, expect, it } from "vitest";
import {
  buildAgentRegistrationSkill,
  buildLlmsFullText,
  buildLlmsIndex,
  CURRENT_LOCAL_REGISTER_COMMAND,
} from "./registration-contract";
import { GET as getLlmsIndex } from "@/app/llms.txt/route";
import { GET as getLlmsFullText } from "@/app/llms-full.txt/route";
import { GET as getRegistrationSkill } from "@/app/protocol/skill.md/route";

describe("SharedNet agent registration artifacts", () => {
  const origin = "https://sharednet.ai";

  it("gives an Agent absolute discovery links from llms.txt", () => {
    const index = buildLlmsIndex(origin);

    expect(index).toContain("https://sharednet.ai/protocol");
    expect(index).toContain("https://sharednet.ai/protocol/skill.md");
    expect(index).toContain("https://sharednet.ai/llms-full.txt");
  });

  it("keeps runtime attachment separate from Room authority in the executable skill", () => {
    const skill = buildAgentRegistrationSkill(origin);

    expect(skill).toContain("sharednet room register");
    expect(skill).toContain("Registering does not join a Room");
    expect(skill).toContain("Do not join any Room without an exact Room ID");
    expect(skill).toContain("Never read, print, quote, copy, post, or commit the credential file");
    expect(skill).not.toContain("runtime_token=<");
  });

  it("gives an attached Agent an executable create-and-join Room workflow", () => {
    const skill = buildAgentRegistrationSkill(origin);

    expect(skill).toContain("sharednet room list");
    expect(skill).toContain("sharednet room build");
    expect(skill).toContain("--access-policy anyone_with_id");
    expect(skill).toContain("sharednet room join <exact-room-id>");
    expect(skill).toContain("sharednet room retrieve <exact-room-id>");
    expect(skill).toContain("The creator is already an active Room member");
    expect(skill).toContain("Read the exact `room_id` from the build JSON");
  });

  it("explains how first local registration materializes an account in SQLite", () => {
    const fullText = buildLlmsFullText(origin);

    expect(fullText).toContain(
      "the first registration transaction creates the Principal row, Agent row, and Runtime registration",
    );
    expect(fullText).toContain(
      "The Principal row is the local V1 account and authority boundary",
    );
  });

  it("has SharedNet mint the Runtime ID during ordinary registration", () => {
    const skill = buildAgentRegistrationSkill(origin);

    expect(CURRENT_LOCAL_REGISTER_COMMAND).not.toContain("--runtime-id");
    expect(skill).not.toContain("- Runtime ID\n");
    expect(skill).toContain("SharedNet generates the Runtime ID");
    expect(skill).toContain("same local session file");
  });

  it("gives every work session its own Session ID without conflating it with Runtime", () => {
    const fullText = buildLlmsFullText(origin);

    expect(fullText).toContain("Principal → Agent → Runtime → Session");
    expect(fullText).toContain("Every new work session receives a new session_id");
    expect(fullText).toContain("one Runtime may host several Sessions");
    expect(fullText).toContain("new runtime_id only for a new runtime incarnation");
  });

  it("labels the unauthenticated V1 command separately from the target pairing flow", () => {
    const fullText = buildLlmsFullText(origin);

    expect(fullText).toContain("Current local V1");
    expect(fullText).toContain("Target account-bound pairing");
    expect(fullText).toContain("The authenticated account mints a short-lived pairing grant");
    expect(fullText).toContain("The website is a read model, not an Agent registration form");
  });

  it("fails closed when a registered Runtime has lost its local credential", () => {
    const skill = buildAgentRegistrationSkill(origin);
    const fullText = buildLlmsFullText(origin);

    expect(skill).toContain("runtime_id_conflict");
    expect(skill).toContain("Do not delete the registration or choose a replacement Runtime ID");
    expect(fullText).toContain("Orphaned Runtime recovery");
    expect(fullText).toContain("revokes the old token hash");
    expect(fullText).toContain("increments credential_version");
    expect(fullText).toContain("Replayed grants and old credentials fail");
    expect(fullText).toContain("same durable endpoint");
    expect(fullText).toContain("replaced_by");
    expect(fullText).toContain("records an audit event");
  });

  it("serves all Agent-facing artifacts as plain text from the requesting origin", async () => {
    const request = new Request("https://sharednet.ai/llms.txt");
    const responses = await Promise.all([
      getLlmsIndex(request),
      getLlmsFullText(request),
      getRegistrationSkill(request),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toContain("https://sharednet.ai/protocol");
    }
  });
});
