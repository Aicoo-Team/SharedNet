import { describe, expect, it } from "vitest";
import { createHandoffArtifacts, isHandoffComplete } from "./artifacts";
import { compileProductBrief } from "./interview";
import { advanceMission, createMission } from "./orchestrator";

const brief = compileProductBrief("Build a customer feedback board", {
  user: "Small SaaS teams",
  outcome: "Collect and prioritize customer feedback",
  data: "Ideas, votes, and statuses",
  access: "Public submitters and private moderators",
  style: "Calm editorial interface",
  launch: "Public preview",
  acceptance: "Submit, vote, moderate, and persist after refresh",
});

describe("Mission handoff", () => {
  it("generates a real, downloadable source and evidence package", () => {
    const artifacts = createHandoffArtifacts(createMission(brief));
    const names = artifacts.map((artifact) => artifact.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "PRODUCT_BRIEF.md",
        "ARCHITECTURE.md",
        "schema.sql",
        "app/page.tsx",
        "README.md",
        "infrastructure.json",
        "VERIFICATION.md",
      ]),
    );
    expect(artifacts.find((artifact) => artifact.name === "app/page.tsx")?.content)
      .toContain("Customer Feedback Board");
    expect(artifacts.map((artifact) => artifact.content).join("\n")).not.toMatch(
      /postgres(?:ql)?:\/\/[^*\s]+@/i,
    );
  });

  it("only marks a completed and evidenced Mission ready for handoff", () => {
    let mission = createMission(brief);
    mission = { ...mission, artifacts: createHandoffArtifacts(mission) };
    expect(isHandoffComplete(mission)).toBe(false);

    while (mission.status !== "completed") {
      mission = advanceMission(mission);
    }
    expect(isHandoffComplete(mission)).toBe(true);
  });
});
