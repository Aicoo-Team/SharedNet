import posthog, { type PostHogConfig } from "posthog-js";

import { ANALYTICS_PROXY_PATH, ANALYTICS_UI_HOST } from "./proxy";
import { redactUrl } from "./redact";

/**
 * PostHog answers the question Vercel Web Analytics cannot: of the people who
 * sign up, how many get an Agent connected, and where do the rest stop. See
 * `docs/decisions/2026-09-13-posthog-product-analytics.md` for why it is
 * configured the way it is; the short version is three deliberate choices.
 *
 * **No cookies.** `persistence: "memory"` means an anonymous visitor is a new
 * person on every page load, which costs us the pre-signup funnel and keeps
 * us out of consent-banner territory. Everything after sign-in still stitches,
 * because we identify by Principal id and that is stable across sessions and
 * devices.
 *
 * **No autocapture, no replay.** Autocapture records `$current_url` on every
 * click, and our URLs are capabilities (see `redact.ts`). Session replay would
 * record the contents of Rooms verbatim. Both are off, and named events are
 * sent instead, so what leaves the browser is a list somebody wrote down.
 *
 * **Heatmaps stay on, redacted.** Whether they run is decided server-side
 * when the client says nothing, so turning them off here would be a promise
 * only this file keeps. `redactProperties` cannot see their URLs anyway —
 * see `redactHeatmapData`.
 *
 * **Through our own origin.** `api_host` points at a same-origin path that
 * `next.config.ts` rewrites to PostHog. Blockers filter `*.posthog.com`
 * heavily, and they are most used by exactly the developer audience this
 * product has.
 */

export { ANALYTICS_PROXY_PATH, ANALYTICS_UI_HOST } from "./proxy";

/**
 * Any property holding a URL, a referrer or a path gets redacted, matched by
 * name rather than by a fixed list. PostHog adds properties between releases
 * (`$initial_current_url`, `$session_entry_url`, …) and a fixed list would
 * leak the first time one appeared.
 */
const URLISH_PROPERTY = /(url|referrer|pathname|href)/i;

/** The one payload whose URLs are object keys rather than property values. */
const HEATMAP_PROPERTY = "$heatmap_data";

/**
 * A heatmap arrives as `{ [pageUrl]: [point, …] }`, so the URL is a *key* and
 * the name-matching rule above walks straight past it. Redact the keys instead
 * of switching heatmaps off: `redactUrl` leaves a clean URL byte-identical, so
 * heatmaps keep working on the pages worth heatmapping, while `/join/rit_…`
 * collapses into `/join/[token]`.
 *
 * Buckets are merged, not overwritten. Every visitor to a capability route
 * redacts to the same key, and building this with `Object.fromEntries` would
 * keep only the last one and drop every click before it.
 */
export function redactHeatmapData(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

  const merged: Record<string, unknown[]> = {};
  for (const [url, points] of Object.entries(value as Record<string, unknown>)) {
    const key = redactUrl(url);
    merged[key] = [...(merged[key] ?? []), ...(Array.isArray(points) ? points : [points])];
  }
  return merged;
}

export function redactProperties(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...properties };
  for (const [key, value] of Object.entries(redacted)) {
    if (typeof value === "string" && URLISH_PROPERTY.test(key)) {
      redacted[key] = redactUrl(value);
    }
  }
  if (HEATMAP_PROPERTY in redacted) {
    redacted[HEATMAP_PROPERTY] = redactHeatmapData(redacted[HEATMAP_PROPERTY]);
  }
  return redacted;
}

export function analyticsOptions(): Partial<PostHogConfig> {
  return {
    api_host: ANALYTICS_PROXY_PATH,
    ui_host: ANALYTICS_UI_HOST,
    // Cookieless: nothing of ours is written to the visitor's browser.
    persistence: "memory",
    autocapture: false,
    disable_session_recording: true,
    // A person row only once someone is identified; anonymous browsing stays
    // anonymous, which is the only honest option without persistence anyway.
    person_profiles: "identified_only",
    // `true` captures a pageview only when PostHog starts. The Dashboard is a
    // single-page app — moving between /chat, /network and /decisions never
    // reloads — so that would record the page someone entered on and nothing
    // after it. "history_change" follows client-side navigation.
    capture_pageview: "history_change",
    before_send: (event) => {
      if (!event) return event;
      return { ...event, properties: redactProperties(event.properties ?? {}) };
    },
  };
}

/**
 * Starts PostHog if a key is configured. Without one this does nothing at all,
 * which is the state of every local checkout and every CI run — analytics must
 * never be the reason a build or a test fails.
 */
export function initAnalytics(): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (!key) return;

  try {
    posthog.init(key, analyticsOptions());
  } catch {
    // An analytics library is not worth a blank page.
  }
}
