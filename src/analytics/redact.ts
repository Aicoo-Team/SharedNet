/**
 * What a URL is allowed to say once it leaves this machine.
 *
 * SharedNet puts capabilities in paths. `/s/shr_…` reads a Room and
 * `/join/rit_…` joins one: holding the URL *is* the permission, so a URL sent
 * to an analytics vendor is a working key sitting in someone else's log. The
 * same is true of `/cli/authorize?code=…`, where the secret is in the query.
 *
 * So nothing here tries to decide which URLs are sensitive. Every path is
 * reduced to its route template and every query string is dropped, which is
 * also the shape a funnel wants: `/s/[token]` counts share-link views as one
 * step instead of scattering them across one row per token.
 *
 * The named routes below are for readability. The generic rule underneath
 * them is the one that matters: any segment shaped like a server-minted
 * identifier or secret becomes `[id]`, so a capability route added next month
 * is redacted before anyone remembers this file exists.
 */

const NAMED_ROUTES: ReadonlyArray<Readonly<{ head: string; template: string }>> = [
  { head: "s", template: "/s/[token]" },
  { head: "join", template: "/join/[token]" },
  { head: "f", template: "/f/[artifactId]" },
  { head: "a", template: "/a/[avatarId]" },
];

/**
 * Identifiers are a short type prefix and a Base62 body: `p_7CPHtWFsFn` is ten
 * characters, `rit_…`/`shr_…` secrets are forty-three. Ten is the floor, so
 * both shapes match and an ordinary word such as `docs` or `authorize` does
 * not.
 */
const SERVER_MINTED = /^[a-z]{1,6}_[A-Za-z0-9_-]{10,}$/;

export const REDACTED_SEGMENT = "[id]";

/** A pathname with every identifying segment replaced. Never throws. */
export function redactPathname(pathname: string): string {
  if (!pathname.startsWith("/")) return pathname;

  const segments = pathname.split("/").slice(1);
  const [head, ...rest] = segments;

  const named = NAMED_ROUTES.find((route) => route.head === head);
  if (named && rest.length > 0 && rest[0] !== "") {
    // Keep anything nested under the capability, still redacted.
    const tail = rest.slice(1).map(redactSegment);
    return [named.template, ...tail].join("/");
  }

  return `/${segments.map(redactSegment).join("/")}`;
}

function redactSegment(segment: string): string {
  return SERVER_MINTED.test(segment) ? REDACTED_SEGMENT : segment;
}

/**
 * A full URL reduced to origin plus redacted path. The query string and
 * fragment are dropped whole rather than filtered: `/cli/authorize?code=…`
 * carries a login code, and an allowlist would only be as good as the last
 * person to update it.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not absolute — treat it as a path, which is what `$pathname` gives us.
    return redactPathname(url.split(/[?#]/)[0] ?? url);
  }
  return `${parsed.origin}${redactPathname(parsed.pathname)}`;
}
