import { describe, expect, it } from "vitest";

import { redactPathname, redactUrl } from "./redact";

// Real shapes, as the validators mint them: ten Base62 characters for an
// identifier, forty-three for a secret.
const SHARE_TOKEN = `shr_${"C".repeat(43)}`;
const INVITE_TOKEN = `rit_${"D".repeat(43)}`;
const ARTIFACT_ID = "art_XHEYHw3zh8";
const ROOM_ID = "rom_7CPHtWFsFn";

describe("what a URL may say once it leaves the browser", () => {
  it("reduces a share link to its route, keeping no part of the token", () => {
    const redacted = redactPathname(`/s/${SHARE_TOKEN}`);

    expect(redacted).toBe("/s/[token]");
    expect(redacted).not.toContain(SHARE_TOKEN);
  });

  it("reduces an invite link to its route, keeping no part of the token", () => {
    const redacted = redactPathname(`/join/${INVITE_TOKEN}`);

    expect(redacted).toBe("/join/[token]");
    expect(redacted).not.toContain(INVITE_TOKEN);
  });

  it("redacts an identifier on a route nobody thought to name", () => {
    // The point of the generic rule: this route is not in NAMED_ROUTES.
    expect(redactPathname(`/rooms/${ROOM_ID}/settings`)).toBe("/rooms/[id]/settings");
  });

  it("leaves ordinary words alone", () => {
    expect(redactPathname("/api/docs")).toBe("/api/docs");
    expect(redactPathname("/cli/authorize")).toBe("/cli/authorize");
    expect(redactPathname("/")).toBe("/");
    expect(redactPathname("/about")).toBe("/about");
  });

  it("drops the query string, where the CLI login code lives", () => {
    const redacted = redactUrl("https://www.sharednet.ai/cli/authorize?code=abcdef123456");

    expect(redacted).toBe("https://www.sharednet.ai/cli/authorize");
    expect(redacted).not.toContain("abcdef123456");
  });

  it("drops the fragment as well as the query", () => {
    expect(redactUrl(`https://www.sharednet.ai/s/${SHARE_TOKEN}?utm_source=x#top`)).toBe(
      "https://www.sharednet.ai/s/[token]",
    );
  });

  it("keeps the origin, so first-party and referred traffic stay distinguishable", () => {
    expect(redactUrl("https://www.sharednet.ai/about")).toBe("https://www.sharednet.ai/about");
  });

  it("redacts a bare pathname, which is what $pathname arrives as", () => {
    expect(redactUrl(`/f/${ARTIFACT_ID}`)).toBe("/f/[artifactId]");
  });

  it("returns something harmless for input that is not a URL at all", () => {
    expect(redactUrl("")).toBe("");
    expect(redactUrl("not a url")).toBe("not a url");
  });
});
