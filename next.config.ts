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

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  async rewrites() {
    return WELL_KNOWN_REWRITES;
  },
};

export default nextConfig;
