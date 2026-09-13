# PostHog for the sign-up funnel, without cookies — 2026-09-13

**Decision.** SharedNet sends a short list of named events to PostHog's **US**
cloud, from the browser only, with **no cookies**, **no autocapture**, **no
session replay**, and **every URL redacted to its route template** before it is
sent. It is proxied through our own origin. Vercel Web Analytics (2026-09-12,
PR #107) stays where it is and keeps counting page views.

**Why.** On 2026-09-12 production held 33 real accounts: 30 had signed in, 20
had an Instance registered, 18 had posted a message. Nothing said where the
other 13 went. Vercel Web Analytics cannot answer that — it counts page views,
not people moving through steps — and it was never going to. PostHog is the
smallest thing that does.

**What follows from it.**

- **Cookieless, so no consent banner.** `persistence: "memory"` means nothing
  of ours is written to a visitor's browser and an anonymous visitor is a new
  person on every page load. That costs the pre-signup funnel: we cannot tell
  that whoever read `/about` is whoever signed up, and PostHog's unique-visitor
  count will be inflated and should be ignored in favour of Vercel's. It costs
  nothing after sign-in, because we `identify()` by **Principal id**, which is
  stable across sessions and devices. The funnel we actually wanted is the half
  that survives. Experience was preferred over completeness deliberately; if a
  banner ever arrives for another reason, this can be revisited.
- **Principal id, never email.** `docs/decisions/2026-09-04-identity-model.md`
  makes the Principal the identity. An email sitting in a vendor's person
  record is a liability that a `p_…` id is not, and the Principal id is also
  what server-side events will carry, so the two halves stitch.
- **URLs are redacted, because ours are capabilities.** `/s/shr_…` reads a Room
  and `/join/rit_…` joins one: the URL *is* the permission. `/cli/authorize`
  carries a login code in its query. `src/analytics/redact.ts` reduces every
  path to its route template and drops every query string, and does it by
  *shape* — any segment matching a server-minted id or secret — so a capability
  route added later is redacted before anyone remembers the file exists.
  `src/analytics/redact.test.ts` and `posthog.test.ts` fail if that stops
  being true.
- **Autocapture and replay are off.** Autocapture records `$current_url` on
  every click, which is the risk above on every interaction. Replay would
  record the contents of Rooms verbatim. What leaves the browser is a list
  somebody wrote down, in `src/analytics/events.ts`, and adding to it is a
  decision rather than a side effect of adding a button.
- **Proxied through our own origin.** `/relay/*` rewrites to PostHog's US
  region in `next.config.ts`. Blockers filter `*.posthog.com` heavily and are
  most used by exactly the developer audience this product has, so the
  un-proxied numbers would be biased, not merely smaller. `skipTrailingSlashRedirect`
  is on because PostHog's endpoints care about the trailing slash they are given.
- **US, not EU.** The maintainer and the current users are not in the EU, and
  US is PostHog's default region. Cookieless collection lowers, but does not
  remove, obligations towards EU visitors — IP is still personal data under
  GDPR. If the product is ever marketed into the EU this needs a real legal
  read, and region migration is not trivial after the fact.
- **Nothing runs without a key.** Without `NEXT_PUBLIC_POSTHOG_KEY` (a public,
  client-side project key) PostHog is never initialized: every local checkout,
  every CI run, and production until the key is set. Analytics is never the
  reason a build, a test, or a page fails.

**What was rejected.** Rolling our own with `useReportWebVitals` and a
collector route: more code, another public endpoint, another table, and charts
to build. Server-side capture of the Agent-side funnel
(`instance_registered`, `room_created`, `message_posted`) is **deferred, not
rejected** — those events arrive over `/api/v1` from a CLI and never touch a
browser, so they need `posthog-node` in the handler. That is the more valuable
half and it should follow once the browser half proves it gets looked at.
