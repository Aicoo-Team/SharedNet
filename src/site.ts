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
  const configured = process.env.NEXT_PUBLIC_SHAREDNET_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_ENV === "production" ? null : process.env.VERCEL_URL?.trim();
  return vercel ? `https://${vercel}` : CANONICAL_ORIGIN;
}
