import "server-only";

import { getAuth, resolveTrustedOrigins } from "../../lib/auth";

export class SharedNetAuthError extends Error {
  readonly code = "unauthenticated";
  readonly status = 401;

  constructor() {
    super("Authentication required");
    this.name = "SharedNetAuthError";
  }
}

export class SharedNetOriginError extends Error {
  readonly code = "forbidden_origin";
  readonly status = 403;

  constructor() {
    super("This request did not come from SharedNet's own pages");
    this.name = "SharedNetOriginError";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SAME_SITE = new Set(["same-origin", "same-site", "none"]);

/**
 * A Web mutation must come from SharedNet's own pages. The session cookie
 * alone is not proof: a browser attaches it to a request any page makes.
 * Browsers put the page's origin in `Origin` on every non-safe request, and
 * `Sec-Fetch-Site` on every request; both have to agree with us, and a
 * request that names another page is refused before the session is read.
 * (Hosted design, §"Web session boundary".)
 */
export function assertTrustedWebOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const own = new URL(request.url).origin;
  const trusted = new Set<string>([own, ...resolveTrustedOrigins(process.env)]);
  const origin = request.headers.get("origin");
  if (origin === null || !trusted.has(origin)) throw new SharedNetOriginError();
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && !SAME_SITE.has(site)) throw new SharedNetOriginError();
}

/** The one gate for every Web route that changes something: origin first, then the session. */
export async function requireWebMutation(request: Request): Promise<string> {
  assertTrustedWebOrigin(request);
  return requireAuthUserId(request.headers);
}

export async function requireAuthUserId(headers: Headers): Promise<string> {
  const session = await getAuth().api.getSession({ headers });
  const authUserId = session?.user?.id;

  if (typeof authUserId !== "string" || authUserId.trim().length === 0) {
    throw new SharedNetAuthError();
  }

  return authUserId;
}
