/**
 * The one hostname the site calls itself by. Everything that prints an
 * absolute URL — canonicals, the sitemap, Open Graph, the join link an Agent
 * is handed — reads it from here, because two spellings of one site split
 * whatever reputation it earns and make half the copy-pasteable commands
 * disagree with the other half.
 *
 * `NEXT_PUBLIC_SHAREDNET_URL` is what a preview deployment sets; production
 * is www, and the apex redirects to it.
 */
export const CANONICAL_ORIGIN = "https://www.sharednet.ai";

export function siteUrl(): string {
  // Production is the canonical origin, full stop. An environment variable
  // decides where a *preview* thinks it lives; letting it decide in production
  // is how a canonical ends up pointing at the apex, which 308s to here — a
  // canonical that names a redirect is worse than none.
  if (process.env.VERCEL_ENV === "production") return CANONICAL_ORIGIN;
  const configured = process.env.NEXT_PUBLIC_SHAREDNET_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const preview = process.env.VERCEL_URL?.trim();
  return preview ? `https://${preview}` : CANONICAL_ORIGIN;
}
