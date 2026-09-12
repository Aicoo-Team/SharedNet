import { describe, expect, it } from "vitest";

import robots from "../app/robots";
import sitemap from "../app/sitemap";
import { CANONICAL_ORIGIN, siteUrl } from "./site";

describe("what a crawler is told", () => {
  it("names one hostname, and it is the one the apex redirects to", () => {
    expect(CANONICAL_ORIGIN).toBe("https://www.sharednet.ai");
    expect(siteUrl()).toMatch(/^https:\/\/[^/]+$/);
    expect(siteUrl().endsWith("/")).toBe(false);
  });

  it("keeps crawlers out of file links and out of the signed-in product", () => {
    const rules = robots().rules;
    const listed = Array.isArray(rules) ? rules : [rules];
    // The wildcard and every named AI crawler get the same rule; saying it
    // explicitly is the difference between a policy and an accident.
    expect(listed.length).toBeGreaterThan(10);
    expect(listed.map((rule) => rule.userAgent)).toContain("*");
    for (const agent of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) {
      expect(listed.map((rule) => rule.userAgent)).toContain(agent);
    }
    for (const rule of listed) {
      expect(rule.allow).toBe("/");
      const disallow = rule.disallow as string[];
      // A file link carries its key in the URL.
      expect(disallow).toContain("/f/");
      // The signed-in product is a login wall to anyone who is not signed in.
      for (const path of ["/login", "/chat", "/network", "/decisions", "/credits"]) {
        expect(disallow).toContain(path);
      }
      // A shared Room is the one user-generated thing that is meant to be read.
      expect(disallow).not.toContain("/s/");
    }
    expect(robots().sitemap).toBe(`${siteUrl()}/sitemap.xml`);
  });

  it("lists the pages worth finding, including the ones only an Agent reads", () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const path of ["/", "/about", "/protocol", "/skills", "/api/docs", "/developers"]) {
      expect(urls).toContain(`${siteUrl()}${path}`);
    }
    // The text surfaces are real pages of this site and nothing else names them.
    for (const path of ["/skill.md", "/skills.md", "/llms.txt", "/llms-full.txt", "/api/v1/openapi.json"]) {
      expect(urls).toContain(`${siteUrl()}${path}`);
    }
    // Nothing behind the login, and no shared Room: a sitemap is a claim that
    // a URL will still be there, and a Room is its owner's to unpublish.
    for (const url of urls) {
      expect(url).not.toMatch(/\/(login|chat|network|decisions|credits|s|f)\//);
    }
    expect(new Set(urls).size).toBe(urls.length);
    expect(sitemap().every((entry) => (entry.priority ?? 0) > 0 && entry.lastModified instanceof Date)).toBe(true);
  });
});
