import { describe, expect, it } from "vitest";

import { resolveOAuthProxy, resolveSocialProviders } from "../../lib/auth.ts";

describe("resolveSocialProviders", () => {
  it("configures Google from an id and a secret", () => {
    const providers = resolveSocialProviders({
      GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "a-secret",
    });

    expect(providers.google).toMatchObject({
      clientId: "1234.apps.googleusercontent.com",
      clientSecret: "a-secret",
    });
  });

  it("asks which Google account, rather than taking the browser's", () => {
    const providers = resolveSocialProviders({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });

    // `socialProviders.google` widens to "config or a function returning one",
    // so this reads the shape rather than the property.
    expect(providers.google).toMatchObject({ prompt: "select_account" });
  });

  it("offers nothing when neither value is set", () => {
    expect(resolveSocialProviders({})).toEqual({});
  });

  it("offers nothing when only one half is set, either half", () => {
    expect(resolveSocialProviders({ GOOGLE_CLIENT_ID: "id" })).toEqual({});
    expect(resolveSocialProviders({ GOOGLE_CLIENT_SECRET: "secret" })).toEqual({});
  });

  it("treats whitespace as absent, so a blank variable is not half a client", () => {
    expect(
      resolveSocialProviders({ GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "secret" }),
    ).toEqual({});
  });

  it("trims the values it does accept", () => {
    const providers = resolveSocialProviders({
      GOOGLE_CLIENT_ID: " id \n",
      GOOGLE_CLIENT_SECRET: " secret ",
    });

    expect(providers.google).toMatchObject({ clientId: "id", clientSecret: "secret" });
  });
});

describe("resolveOAuthProxy", () => {
  it("borrows the canonical origin's redirect URI on a preview", () => {
    expect(resolveOAuthProxy({ VERCEL_ENV: "preview" })).toEqual({
      productionURL: "https://www.sharednet.ai",
    });
  });

  it("stays off in production, where the deployment has its own redirect URI", () => {
    expect(resolveOAuthProxy({ VERCEL_ENV: "production" })).toBeNull();
  });

  it("stays off on a laptop, which would otherwise route through production", () => {
    expect(resolveOAuthProxy({})).toBeNull();
    expect(resolveOAuthProxy({ VERCEL_ENV: "development" })).toBeNull();
  });

  it("accepts a different production origin for a fork or a staging domain", () => {
    expect(
      resolveOAuthProxy({
        VERCEL_ENV: "preview",
        SHAREDNET_OAUTH_PROXY_PRODUCTION_URL: "https://staging.sharednet.ai",
      }),
    ).toEqual({ productionURL: "https://staging.sharednet.ai" });
  });

  it("carries a dedicated proxy secret when one is set, and omits the key when not", () => {
    expect(
      resolveOAuthProxy({ VERCEL_ENV: "preview", SHAREDNET_OAUTH_PROXY_SECRET: "shared" }),
    ).toEqual({ productionURL: "https://www.sharednet.ai", secret: "shared" });

    expect(resolveOAuthProxy({ VERCEL_ENV: "preview" })).not.toHaveProperty("secret");
  });

  it("ignores a blank proxy secret rather than deriving a key from nothing", () => {
    expect(
      resolveOAuthProxy({ VERCEL_ENV: "preview", SHAREDNET_OAUTH_PROXY_SECRET: "   " }),
    ).not.toHaveProperty("secret");
  });
});
