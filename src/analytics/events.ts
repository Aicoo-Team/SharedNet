import posthog from "posthog-js";

/**
 * The events this product actually asks a question of. The list is short on
 * purpose: autocapture is off (see `posthog.ts`), so everything PostHog knows
 * is something written down here, and adding to it is a decision rather than
 * a side effect of someone adding a button.
 *
 * They trace the one gap worth closing — of the people who sign up, how many
 * get an Agent talking. On 2026-09-12 that was 33 signed up, 30 signed in and
 * 20 with an Instance registered, and nothing said where the other 13 went.
 *
 * The Agent-side half of that funnel (`instance_registered`, `room_created`,
 * `message_posted`) never touches a browser — it arrives over `/api/v1` from a
 * CLI — so it needs server-side capture and is deliberately not here yet.
 */
export type AnalyticsEvent = "signed_up" | "signed_in" | "api_key_created";

type EventProperties = Readonly<Record<string, string | number | boolean>>;

/**
 * Records an event, or does nothing. Analytics is never allowed to be the
 * reason a flow breaks, and with no key configured — every local checkout,
 * every CI run — PostHog is not initialized at all.
 */
export function capture(event: AnalyticsEvent, properties?: EventProperties): void {
  try {
    if (!posthog.__loaded) return;
    posthog.capture(event, properties);
  } catch {
    // Deliberately silent: see above.
  }
}

/**
 * Ties everything this browser does to a Principal — the account's identity in
 * SharedNet, and the same id the Agent-side events will carry when they land.
 * Never the email: `docs/decisions/2026-09-04-identity-model.md` makes the
 * Principal the identity, and an email in a vendor's person record is a
 * liability the Principal id is not.
 */
export function identifyPrincipal(principalId: string): void {
  try {
    if (!posthog.__loaded) return;
    if (posthog.get_distinct_id() === principalId) return;
    posthog.identify(principalId);
  } catch {
    // Deliberately silent: see above.
  }
}
