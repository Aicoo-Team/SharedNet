import { apiKeyClient } from "@better-auth/api-key/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

/**
 * The OAuth provider client does two things for the pages an MCP client sends
 * a person through: it carries the signed `oauth_query` from the login page's
 * URL into the sign-in request so the authorization resumes after login, and
 * it exposes `oauth2.consent` for the consent page.
 */
export const authClient = createAuthClient({
  plugins: [apiKeyClient(), oauthProviderClient()],
});
