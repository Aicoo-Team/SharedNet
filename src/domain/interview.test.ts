import { describe, expect, it } from "vitest";
import {
  INTERVIEW_QUESTIONS,
  calculateReadiness,
  compileProductBrief,
  getNextQuestion,
} from "./interview";

const completeAnswers = {
  user: "Small SaaS teams",
  outcome: "Collect and prioritize customer feedback",
  data: "Ideas, votes, and statuses",
  access: "Public submitters and private moderators",
  style: "Calm editorial interface",
  launch: "Public preview",
  acceptance: "Submit, vote, moderate, and persist after refresh",
} as const;

describe("requirement interview", () => {
  it("waits for material decisions and asks in a deliberate order", () => {
    expect(INTERVIEW_QUESTIONS).toHaveLength(7);
    expect(calculateReadiness({ user: "Small teams" })).toMatchObject({
      ready: false,
      completion: 14,
      clearDimensions: ["user"],
    });
    expect(getNextQuestion({ user: "Small teams" })?.id).toBe("outcome");
  });

  it("does not count whitespace as an answer", () => {
    const readiness = calculateReadiness({ user: "   " });
    expect(readiness.clearDimensions).toEqual([]);
    expect(readiness.missingDimensions[0]).toBe("user");
  });

  it("compiles a buildable data-backed brief", () => {
    expect(calculateReadiness(completeAnswers).ready).toBe(true);

    const brief = compileProductBrief(
      "Build a customer feedback board",
      completeAnswers,
    );

    expect(brief).toMatchObject({
      title: "Customer Feedback Board",
      slug: "customer-feedback-board",
      primaryUser: "Small SaaS teams",
      requiresDatabase: true,
    });
    expect(brief.coreLoop).toHaveLength(3);
    expect(brief.acceptanceCriteria).toContain(
      "Submit, vote, moderate, and persist after refresh",
    );
  });

  it("fails closed when asked to compile an incomplete brief", () => {
    expect(() =>
      compileProductBrief("Build a feedback board", { user: "Small teams" }),
    ).toThrow("Missing product decisions");
  });
});
