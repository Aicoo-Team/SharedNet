/**
 * The one constant `next.config.ts` and the browser both need, kept in a file
 * that imports nothing. `next.config.ts` is loaded by Node on every build and
 * every server start; importing `posthog.ts` for this would drag `posthog-js`
 * — a browser library — into that path for the sake of a string.
 */

/** Same-origin prefix rewritten to PostHog in `next.config.ts`. */
export const ANALYTICS_PROXY_PATH = "/relay";

/** PostHog's US ingestion endpoint, and the host serving its static assets. */
export const ANALYTICS_INGESTION_ORIGIN = "https://us.i.posthog.com";
export const ANALYTICS_ASSETS_ORIGIN = "https://us-assets.i.posthog.com";

/** Where the PostHog app itself lives, for "view in PostHog" links. */
export const ANALYTICS_UI_HOST = "https://us.posthog.com";
