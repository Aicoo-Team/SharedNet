import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import { ANALYTICS_PROXY_PATH, analyticsOptions, redactProperties } from "./posthog";

const SHARE_TOKEN = `shr_${"C".repeat(43)}`;

describe("what PostHog is allowed to do", () => {
  it("writes nothing to the visitor's browser", () => {
    expect(analyticsOptions().persistence).toBe("memory");
  });

  it("records no click it was not asked to record", () => {
    expect(analyticsOptions().autocapture).toBe(false);
  });

  it("never records the contents of a Room", () => {
    expect(analyticsOptions().disable_session_recording).toBe(true);
  });

  it("creates a person only for someone who identified", () => {
    expect(analyticsOptions().person_profiles).toBe("identified_only");
  });

  it("sends through our own origin, not posthog.com", () => {
    expect(analyticsOptions().api_host).toBe(ANALYTICS_PROXY_PATH);
    expect(analyticsOptions().api_host).not.toContain("posthog.com");
  });
});

describe("what leaves the browser with an event", () => {
  it("strips a share token out of every property that holds a URL", () => {
    const redacted = redactProperties({
      $current_url: `https://www.sharednet.ai/s/${SHARE_TOKEN}?utm_source=x`,
      $pathname: `/s/${SHARE_TOKEN}`,
      $referrer: `https://www.sharednet.ai/join/rit_${"D".repeat(43)}`,
    });

    expect(redacted.$current_url).toBe("https://www.sharednet.ai/s/[token]");
    expect(redacted.$pathname).toBe("/s/[token]");
    expect(redacted.$referrer).toBe("https://www.sharednet.ai/join/[token]");
    expect(JSON.stringify(redacted)).not.toContain(SHARE_TOKEN);
  });

  it("redacts a URL property that did not exist when this was written", () => {
    // PostHog adds properties between releases; the rule matches on the name.
    const redacted = redactProperties({ $session_entry_url: `https://www.sharednet.ai/s/${SHARE_TOKEN}` });

    expect(redacted.$session_entry_url).toBe("https://www.sharednet.ai/s/[token]");
  });

  it("leaves properties that are not URLs untouched", () => {
    expect(redactProperties({ $browser: "Chrome", count: 3, ok: true })).toEqual({
      $browser: "Chrome",
      count: 3,
      ok: true,
    });
  });

  it("passes every event through the redactor before it is sent", () => {
    const beforeSend = analyticsOptions().before_send;
    expect(beforeSend).toBeTypeOf("function");

    const sent = (Array.isArray(beforeSend) ? beforeSend[0] : beforeSend)?.({
      event: "$pageview",
      properties: { $current_url: `https://www.sharednet.ai/s/${SHARE_TOKEN}` },
    } as never);

    expect(JSON.stringify(sent)).not.toContain(SHARE_TOKEN);
  });
});

describe("the analytics proxy", () => {
  it("is rewritten to PostHog's US region, keeping assets and ingestion apart", async () => {
    const rewrites = await nextConfig.rewrites?.();
    const list = Array.isArray(rewrites) ? rewrites : [];

    expect(list).toContainEqual({
      source: `${ANALYTICS_PROXY_PATH}/static/:path*`,
      destination: "https://us-assets.i.posthog.com/static/:path*",
    });
    expect(list).toContainEqual({
      source: `${ANALYTICS_PROXY_PATH}/:path*`,
      destination: "https://us.i.posthog.com/:path*",
    });
  });

  it("puts the catch-all last, so /static is not swallowed by it", async () => {
    const rewrites = await nextConfig.rewrites?.();
    const list = Array.isArray(rewrites) ? rewrites : [];
    const assets = list.findIndex((rule) => rule.source === `${ANALYTICS_PROXY_PATH}/static/:path*`);
    const catchAll = list.findIndex((rule) => rule.source === `${ANALYTICS_PROXY_PATH}/:path*`);

    expect(assets).toBeGreaterThanOrEqual(0);
    expect(assets).toBeLessThan(catchAll);
  });

  it("keeps the OAuth discovery rewrites that were already there", async () => {
    const rewrites = await nextConfig.rewrites?.();
    const list = Array.isArray(rewrites) ? rewrites : [];

    expect(list.some((rule) => rule.source === "/.well-known/oauth-authorization-server")).toBe(true);
  });

  it("does not let Next's trailing-slash redirect eat an event", () => {
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);
  });
});
