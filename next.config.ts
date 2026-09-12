import type { NextConfig } from "next";

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
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return WELL_KNOWN_REWRITES;
  },
};

export default nextConfig;
