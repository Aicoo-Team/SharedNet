import type { NextConfig } from "next";

import {
  ANALYTICS_ASSETS_ORIGIN,
  ANALYTICS_INGESTION_ORIGIN,
  ANALYTICS_PROXY_PATH,
} from "@/src/analytics/proxy";

/**
 * PostHog, served from our own origin. Content blockers filter `*.posthog.com`
 * hard, and the people who run them are disproportionately the developers this
 * product is for — measuring only the visitors without a blocker would be
 * worse than not measuring. A rewrite is a proxy, so the browser sees one
 * origin and the events still reach PostHog's US region.
 *
 * `/static` is split out because PostHog documents a separate asset host for
 * it. Everything else — ingestion, feature flags, and the `/array/<key>`
 * remote config — goes to the regional endpoint, which serves them all.
 */
const ANALYTICS_REWRITES = [
  { source: `${ANALYTICS_PROXY_PATH}/static/:path*`, destination: `${ANALYTICS_ASSETS_ORIGIN}/static/:path*` },
  { source: `${ANALYTICS_PROXY_PATH}/:path*`, destination: `${ANALYTICS_INGESTION_ORIGIN}/:path*` },
];

/**
 * OAuth discovery lives at the origin root by RFC 8414 and RFC 9728, while
 * Better Auth serves it under its own base path. An MCP client asks
 * `/.well-known/oauth-protected-resource/api/mcp` for the resource it was
 * given and `/.well-known/oauth-authorization-server/api/auth` for the issuer
 * it is told about (the issuer is the auth base URL, path included), with the
 * path-less forms as fallbacks. All of them rewrite to Better Auth.
 */
const WELL_KNOWN_REWRITES = [
  { source: "/.well-known/oauth-protected-resource/api/mcp", destination: "/api/auth/.well-known/oauth-protected-resource" },
  { source: "/.well-known/oauth-protected-resource", destination: "/api/auth/.well-known/oauth-protected-resource" },
  { source: "/.well-known/oauth-authorization-server/api/auth", destination: "/api/auth/.well-known/oauth-authorization-server" },
  { source: "/.well-known/oauth-authorization-server", destination: "/api/auth/.well-known/oauth-authorization-server" },
  { source: "/.well-known/openid-configuration/api/auth", destination: "/api/auth/.well-known/openid-configuration" },
  { source: "/.well-known/openid-configuration", destination: "/api/auth/.well-known/openid-configuration" },
];

/**
 * Headers every response carries. None of these change what the site does;
 * they close the gap between "we never intended that" and "the browser will
 * not do that". HSTS was the only one present before.
 */
const SECURITY_HEADERS = [
  { key: "x-content-type-options", value: "nosniff" },
  { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
  // Nothing here asks for a camera, a microphone or a location.
  { key: "permissions-policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "x-frame-options", value: "SAMEORIGIN" },
  { key: "strict-transport-security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  // PostHog's ingestion endpoints care about the trailing slash they were
  // given; Next's own normalising redirect would otherwise lose events.
  skipTrailingSlashRedirect: true,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [...WELL_KNOWN_REWRITES, ...ANALYTICS_REWRITES];
  },
};

export default nextConfig;
