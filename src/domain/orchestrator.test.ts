import { describe, expect, it } from "vitest";
import { compileProductBrief } from "./interview";
import {
  advanceMission,
  createMission,
  getRunnableTasks,
} from "./orchestrator";

const brief = compileProductBrief("Build a customer feedback board", {
  user: "Small SaaS teams",
  outcome: "Collect and prioritize customer feedback",
  data: "Ideas, votes, and statuses",
  access: "Public submitters and private moderators",
  style: "Calm editorial interface",
  launch: "Public preview",
  acceptance: "Submit, vote, moderate, and persist after refresh",
});

describe("Website Launch RAC graph", () => {
  it("selects the smallest data-backed official Agent organization", () => {
    const mission = createMission(brief);

    expect(mission.selectedAgentHandles).toContain("@sharednet/neon");
    expect(mission.selectedAgentHandles).toContain("@sharednet/quality");
    expect(mission.tasks.map((task) => task.kind)).toEqual([
      "research",
      "architecture",
      "database",
      "build",
      "deploy",
      "verify",
      "handoff",
    ]);
  });

  it("does not deploy before its dependencies are complete", () => {
    const mission = createMission(brief);

    expect(getRunnableTasks(mission).map((task) => task.kind)).toEqual([
      "research",
    ]);
    expect(getRunnableTasks(mission).map((task) => task.kind)).not.toContain(
      "deploy",
    );

    const afterResearch = advanceMission(mission);
    expect(getRunnableTasks(afterResearch).map((task) => task.kind)).toEqual([
      "architecture",
    ]);
  });

  it("advances dependency waves to a completed, independently verified Mission", () => {
    let mission = createMission(brief);

    while (mission.status !== "completed") {
      mission = advanceMission(mission);
    }

    expect(mission.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(mission.verificationChecks.every((check) => check.status === "passed")).toBe(
      true,
    );
    expect(mission.events.at(-1)?.type).toBe("mission_completed");
  });
});
