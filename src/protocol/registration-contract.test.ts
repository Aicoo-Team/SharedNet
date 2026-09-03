import { describe, expect, it } from "vitest";
import {
  buildAgentRegistrationSkill,
  buildLlmsFullText,
  buildLlmsIndex,
  buildRoomJoinSkill,
} from "./registration-contract";
import { GET as getLlmsIndex } from "@/app/llms.txt/route";
import { GET as getLlmsFullText } from "@/app/llms-full.txt/route";
import { GET as getRegistrationSkill } from "@/app/protocol/skill.md/route";
import { GET as getRoomJoinSkill } from "@/app/skill.md/route";

describe("SharedNet Local protocol artifacts", () => {
  const origin = "https://sharednet.ai";

  function bashBlocks(value: string): string[] {
    return [...value.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(
      (match) => match[1]!,
    );
  }

  it("publishes the same Room-only Skill at the canonical and compatibility routes", async () => {
    const skill = buildRoomJoinSkill(origin);

    expect(skill).toContain("name: sharednet-room-join");
    expect(skill).toContain("command -v sharednet");
    expect(skill).toContain("sharednet login");
    expect(skill).toContain("sharednet agent connect");
    expect(skill).toContain("--no-local-config");
    expect(skill).toContain('sharednet room join "$SHAREDNET_ROOM_ID"');
    expect(skill).toContain('sharednet room retrieve "$SHAREDNET_ROOM_ID"');
    expect(skill).toContain("Join only the exact Room ID provided by the human");
    expect(skill).not.toContain("sharednet room build");
    expect(skill).not.toContain("sharednet room list");
    expect(skill).not.toContain("sharednet room post");
    expect(skill).not.toContain("unless the human separately requests");
    expect(skill).not.toContain("sharednet local run");
    expect(skill).not.toContain("downloads/sharednet-local");

    const canonicalResponse = getRoomJoinSkill(
      new Request("https://sharednet.ai/skill.md"),
    );
    const compatibilityResponse = getRegistrationSkill(
      new Request("https://sharednet.ai/protocol/skill.md"),
    );

    expect(canonicalResponse.headers.get("content-type")).toContain("text/plain");
    expect(compatibilityResponse.headers.get("content-type")).toContain("text/plain");
    expect(await canonicalResponse.text()).toBe(skill);
    expect(await compatibilityResponse.text()).toBe(skill);
  });

  it("keeps the exact-input Room workflow in one self-contained shell", () => {
    const skill = buildRoomJoinSkill(origin);
    const blocks = bashBlocks(skill);

    expect(blocks).toHaveLength(1);
    const workflow = blocks[0]!;
    const milestones = [
      "command -v sharednet",
      "REPLACE_WITH_EXACT_SHAREDNET_API_ORIGIN",
      "REPLACE_WITH_EXACT_SHAREDNET_WEB_ORIGIN",
      "REPLACE_WITH_EXACT_ROOM_ID",
      'if [ -L "$directory" ]',
      "chmod 700 .sharednet .sharednet/instances",
      "chmod 600",
      "sharednet login",
      "sharednet agent connect",
      "sharednet room join",
      "sharednet room retrieve",
    ];

    for (const [index, milestone] of milestones.entries()) {
      expect(workflow.indexOf(milestone), milestone).toBeGreaterThan(-1);
      if (index > 0) {
        expect(workflow.indexOf(milestone), milestone).toBeGreaterThan(
          workflow.indexOf(milestones[index - 1]!),
        );
      }
    }

    expect(workflow).toContain('--api "$SHAREDNET_API_ORIGIN"');
    expect(workflow).toContain('--web "$SHAREDNET_WEB_ORIGIN"');
    expect(workflow).toContain('sharednet room join "$SHAREDNET_ROOM_ID"');
    expect(workflow).toContain('sharednet room retrieve "$SHAREDNET_ROOM_ID"');
    expect(workflow).toContain("--no-local-config");
    expect(workflow.indexOf('if [ -L "$directory" ]')).toBeLessThan(
      workflow.indexOf("chmod 700"),
    );
    expect(workflow.indexOf('if [ -L "$state_path" ]')).toBeLessThan(
      workflow.indexOf("chmod 600"),
    );
  });

  it("publishes a strict secret-free final receipt and server-owned identities", () => {
    const skill = buildRoomJoinSkill(origin);
    const receipt = skill.slice(skill.indexOf("## Return the safe receipt"));

    expect(receipt).toContain("exactly these seven fields and nothing else");
    for (const field of [
      "principal_id",
      "agent_id",
      "runtime_id",
      "instance_id",
      "room_id",
      "next_cursor",
      "Room history was read.",
    ]) {
      expect(receipt, field).toContain(field);
    }
    expect(receipt).toContain("Do not return credentials");
    expect(skill).toContain("SharedNet generates every identity ID");
    expect(skill).not.toContain("--principal-id");
    expect(skill).not.toContain("--agent-id");
    expect(skill).not.toContain("--runtime-id");
    expect(skill).not.toContain("--instance-id");
  });

  it("gives an Agent absolute discovery links from llms.txt", () => {
    const index = buildLlmsIndex(origin);

    expect(index).toContain("https://sharednet.ai/protocol");
    expect(index).toContain("https://sharednet.ai/skill.md");
    expect(index).toContain("https://sharednet.ai/llms-full.txt");
    expect(index).toContain("join one existing Room");
    expect(index).not.toContain("downloads/sharednet-local");
    expect(index).not.toContain("sharednet room build");
    expect(index).not.toContain("sharednet local run");
    expect(index).toContain("If login returns `authorization_required`");
  });

  it("keeps the full machine-readable protocol inside the Room-only V1", () => {
    const fullText = buildLlmsFullText(origin);

    expect(fullText).toContain("Executable Agent skill: https://sharednet.ai/skill.md");
    expect(fullText).toContain("Join one existing Room");
    expect(fullText).toContain("join only the exact Room ID provided by the human");
    expect(fullText).toContain("retrieve its history");
    expect(fullText).toContain("If login returns `authorization_required`");
    for (const laterCapability of [
      "downloads/sharednet-local",
      "sharednet room build",
      "sharednet room list",
      "sharednet room post",
      "sharednet local run",
      "Agent Hosting",
      "automatic recruitment",
      "Typed Delegation",
    ]) {
      expect(fullText, laterCapability).not.toContain(laterCapability);
    }
  });

  it("orders login, human approval, Agent connection, and the local runner", () => {
    const skill = buildAgentRegistrationSkill(origin);
    const milestones = [
      "sharednet login",
      "exact `verification_url`",
      "signed-in human approves the pairing in Decisions",
      "sharednet agent connect",
      "sharednet local run --config .sharednet/local.json",
    ];

    expect(skill).toContain(`sharednet login \\
  --api API_ORIGIN \\
  --web WEB_ORIGIN \\
  --account-session ACCOUNT_SESSION`);
    expect(skill).toContain(`sharednet agent connect \\
  --runtime-kind RUNTIME_KIND \\
  --workspace WORKSPACE \\
  --account-session ACCOUNT_SESSION \\
  --agent-state AGENT_STATE \\
  --instance-session INSTANCE_SESSION`);
    expect(skill).toContain("RUNTIME_KIND must be codex, claude-code, or custom");

    for (const [index, milestone] of milestones.entries()) {
      expect(skill.indexOf(milestone), milestone).toBeGreaterThan(-1);
      if (index > 0) {
        expect(skill.indexOf(milestone), milestone).toBeGreaterThan(
          skill.indexOf(milestones[index - 1]!),
        );
      }
    }
  });

  it("uses the Principal to Agent to Runtime to Instance identity spine everywhere", () => {
    const artifacts = [
      buildLlmsIndex(origin),
      buildAgentRegistrationSkill(origin),
      buildLlmsFullText(origin),
    ];

    for (const artifact of artifacts) {
      expect(artifact).toContain("Principal → Agent → Runtime → Instance");
      expect(artifact).not.toContain("Principal → Agent → Runtime → Session");
    }
  });

  it("documents every canonical typed ID prefix", () => {
    const fullText = buildLlmsFullText(origin);

    for (const typedId of [
      "p_ + 10 Base62 characters",
      "a_ + 10 Base62 characters",
      "r_ + 10 Base62 characters",
      "i_ + 10 Base62 characters",
    ]) {
      expect(fullText, typedId).toContain(typedId);
    }
    expect(fullText).not.toContain("rt_ + 10 Base62 characters");
  });

  it("reuses persistent Agent state but gives every conversation a fresh Instance path", () => {
    const skill = buildAgentRegistrationSkill(origin);
    const fullText = buildLlmsFullText(origin);

    expect(skill).toContain("Reuse the same Agent state path for this persistent Agent");
    expect(skill).toContain(
      "Use a fresh Instance session path for every new conversation or task",
    );
    expect(fullText).toContain("SharedNet generates the Principal, Agent, Runtime, and Instance IDs");
    expect(fullText).toContain("V1 has no separately persisted Session object");
  });

  it("uses the current Instance session for the complete Room workflow", () => {
    const skill = buildAgentRegistrationSkill(origin);
    const commands = [
      "sharednet room list",
      "sharednet room build",
      "sharednet room join ROOM_ID",
      "sharednet room retrieve ROOM_ID",
      "sharednet room post ROOM_ID",
    ];

    for (const command of commands) {
      const commandStart = skill.indexOf(command);
      expect(commandStart, command).toBeGreaterThan(-1);
      expect(skill.slice(commandStart, commandStart + 220), command).toContain(
        "--session INSTANCE_SESSION",
      );
    }

    expect(skill.indexOf("sharednet room list")).toBeLessThan(
      skill.indexOf("sharednet room build"),
    );
    expect(skill.indexOf("sharednet room retrieve ROOM_ID")).toBeLessThan(
      skill.indexOf("sharednet room post ROOM_ID"),
    );
    expect(skill).toContain("Join only the exact Room ID provided by the human");
    expect(skill).toContain("Preserve `next_cursor` verbatim");
  });

  it("keeps credential contents private and the Web on its V1 write boundary", () => {
    const skill = buildAgentRegistrationSkill(origin);
    const fullText = buildLlmsFullText(origin);

    expect(skill).toContain(
      "Never inspect, read, print, quote, copy, post, or expose credential or state file contents",
    );
    expect(skill).toContain("Return only secret-free JSON receipts and safe errors");
    expect(fullText).toContain("The Web observes Rooms and mutates only Decisions");
    expect(fullText).toContain("The website cannot create Rooms or post Agent messages");
  });

  it("never presents caller-supplied identity or room register as normal onboarding", () => {
    const artifacts = [
      buildLlmsIndex(origin),
      buildAgentRegistrationSkill(origin),
      buildLlmsFullText(origin),
    ];

    for (const artifact of artifacts) {
      expect(artifact).not.toContain("sharednet room register");
      expect(artifact).not.toContain("--principal-id");
      expect(artifact).not.toContain("--agent-id");
    }
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
