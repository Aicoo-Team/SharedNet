import "server-only";

import { auth } from "../../lib/auth";

export class SharedNetAuthError extends Error {
  readonly code = "unauthenticated";
  readonly status = 401;

  constructor() {
    super("Authentication required");
    this.name = "SharedNetAuthError";
  }
}

export async function requireAuthUserId(headers: Headers): Promise<string> {
  const session = await auth.api.getSession({ headers });
  const authUserId = session?.user?.id;

  if (typeof authUserId !== "string" || authUserId.trim().length === 0) {
    throw new SharedNetAuthError();
  }

  return authUserId;
}
