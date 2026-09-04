import { describe, expect, it } from "vitest";

import { buildSkillsIndex } from "./skills-index";

describe("buildSkillsIndex", () => {
  it("resolves every published link against the requesting origin", () => {
    const index = buildSkillsIndex("https://sharednet.ai");

    expect(index).toContain("https://sharednet.ai/skills");
    expect(index).toContain("https://sharednet.ai/skill.md");
    expect(index).toContain("https://sharednet.ai/api/docs");
    expect(index).toContain("export SHAREDNET_BASE_URL=https://sharednet.ai");
  });

  it("never emits a double slash from a trailing-slash origin", () => {
    const index = buildSkillsIndex("http://127.0.0.1:3001/");

    expect(index).not.toMatch(/[^:]\/\//);
    expect(index).toContain("http://127.0.0.1:3001/skill.md");
  });

  it("states the CLI-only and no-credential-on-argv boundary", () => {
    const index = buildSkillsIndex("https://sharednet.ai");

    expect(index).toContain("Never call the API with `curl`");
    expect(index).toContain("never pass an API key or Instance");
  });
});
