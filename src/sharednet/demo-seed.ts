import Database from "better-sqlite3";

export type DemoSeedArguments = {
  email: string;
};

export class DemoSeedError extends Error {
  override readonly name = "DemoSeedError";
}

const trustedErrors = new WeakSet<DemoSeedError>();

function trustedError(message: string): DemoSeedError {
  const error = new DemoSeedError(message);
  trustedErrors.add(error);
  return error;
}

export interface AuthUserLookup {
  findUserIdsByEmail(
    normalizedEmail: string,
  ): readonly string[] | Promise<readonly string[]>;
  close(): void;
}

export type DemoSeedFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SeedDemoAccountOptions = {
  apiUrl: string;
  consoleToken: string;
  email: string;
  fetch: DemoSeedFetch;
  lookup: AuthUserLookup;
};

export type DemoSeedResult = {
  connected_agent_ids: string[];
  connected_principal_id: string;
  counts: {
    connected_agents: number;
    owner_agents: number;
    principal_connections: number;
  };
  owner_agent_ids: string[];
  principal_id: string;
};

export type DemoSeedEnvironment = {
  apiUrl: string;
  consoleToken: string;
  databasePath: string;
};

export class SqliteAuthUserLookup implements AuthUserLookup {
  private database: Database.Database | undefined;

  constructor(databasePath: string) {
    try {
      if (!databasePath.trim()) {
        throw new Error("missing database path");
      }
      this.database = new Database(databasePath, {
        fileMustExist: true,
        readonly: true,
      });
    } catch {
      throw trustedError("Better Auth user lookup failed.");
    }
  }

  findUserIdsByEmail(normalizedEmail: string): readonly string[] {
    try {
      if (!this.database) {
        throw new Error("closed database");
      }
      const rows = this.database
        .prepare('SELECT id FROM "user" WHERE email = ? ORDER BY id LIMIT 2')
        .all(normalizedEmail);

      return rows.map((row) => {
        if (!isRecord(row) || typeof row.id !== "string" || !row.id) {
          throw new Error("invalid user row");
        }
        return row.id;
      });
    } catch {
      throw trustedError("Better Auth user lookup failed.");
    }
  }

  close(): void {
    if (!this.database) {
      return;
    }

    const database = this.database;
    this.database = undefined;
    try {
      database.close();
    } catch {
      throw trustedError("Better Auth user lookup failed.");
    }
  }
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedEmail = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)
    ? normalizedEmail
    : undefined;
}

function parseApiOrigin(value: string): string {
  try {
    if (value !== value.trim()) {
      throw new Error("invalid origin");
    }
    const url = new URL(value);

    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid origin");
    }

    return url.origin;
  } catch {
    throw trustedError(
      "SHAREDNET_API_URL must be a credential-free HTTP(S) origin.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isTypedId(value: unknown, prefix: "a" | "p"): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${prefix}_[0-9A-Za-z]{10}$`).test(value)
  );
}

function isTypedIdArray(
  value: unknown,
  prefix: "a" | "p",
): value is string[] {
  return Array.isArray(value) && value.every((item) => isTypedId(item, prefix));
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function parseDemoSeedResult(value: unknown): DemoSeedResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "connected_agent_ids",
      "connected_principal_id",
      "counts",
      "owner_agent_ids",
      "principal_id",
    ]) ||
    !isTypedId(value.principal_id, "p") ||
    !isTypedId(value.connected_principal_id, "p") ||
    !isTypedIdArray(value.owner_agent_ids, "a") ||
    !isTypedIdArray(value.connected_agent_ids, "a") ||
    !isRecord(value.counts) ||
    !hasExactKeys(value.counts, [
      "connected_agents",
      "owner_agents",
      "principal_connections",
    ]) ||
    !isCount(value.counts.owner_agents) ||
    !isCount(value.counts.connected_agents) ||
    !isCount(value.counts.principal_connections) ||
    value.counts.owner_agents !== value.owner_agent_ids.length ||
    value.counts.connected_agents !== value.connected_agent_ids.length
  ) {
    throw trustedError("SharedNet demo seed response was invalid.");
  }

  return {
    connected_agent_ids: [...value.connected_agent_ids],
    connected_principal_id: value.connected_principal_id,
    counts: {
      connected_agents: value.counts.connected_agents,
      owner_agents: value.counts.owner_agents,
      principal_connections: value.counts.principal_connections,
    },
    owner_agent_ids: [...value.owner_agent_ids],
    principal_id: value.principal_id,
  };
}

export function parseDemoSeedArgs(
  arguments_: readonly string[],
): DemoSeedArguments {
  const normalizedEmail = normalizeEmail(arguments_[1]);

  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--email" ||
    !normalizedEmail
  ) {
    throw trustedError("Use --email with one valid email address.");
  }

  return { email: normalizedEmail };
}

export function readDemoSeedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): DemoSeedEnvironment {
  const databasePath = environment.BETTER_AUTH_DATABASE_PATH;
  const apiUrl = environment.SHAREDNET_API_URL;
  const consoleToken = environment.SHAREDNET_CONSOLE_TOKEN;

  if (
    !databasePath?.trim() ||
    !apiUrl?.trim() ||
    !consoleToken?.trim()
  ) {
    throw trustedError(
      "Demo seed requires BETTER_AUTH_DATABASE_PATH, SHAREDNET_API_URL, and SHAREDNET_CONSOLE_TOKEN.",
    );
  }

  return { apiUrl, consoleToken, databasePath };
}

async function seedDemoAccountUnchecked({
  apiUrl,
  consoleToken,
  email,
  fetch,
  lookup,
}: SeedDemoAccountOptions): Promise<DemoSeedResult> {
  const origin = parseApiOrigin(apiUrl);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw trustedError("Use --email with one valid email address.");
  }
  if (!consoleToken.trim()) {
    throw trustedError("SHAREDNET_CONSOLE_TOKEN is required.");
  }

  const userIds = await lookup.findUserIdsByEmail(normalizedEmail);
  const userId = userIds[0];

  if (
    userIds.length !== 1 ||
    typeof userId !== "string" ||
    !userId.trim()
  ) {
    throw trustedError(
      "Expected exactly one Better Auth user for the requested email.",
    );
  }

  const response = await fetch(
    `${origin}/v1/console/accounts/${encodeURIComponent(userId)}/demo-seed`,
    {
      headers: { "x-sharednet-console-token": consoleToken },
      method: "POST",
      redirect: "manual",
    },
  );

  if (!response.ok || response.redirected) {
    throw trustedError("SharedNet demo seed request failed.");
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw trustedError("SharedNet demo seed response was invalid.");
  }

  return parseDemoSeedResult(responseBody);
}

export async function seedDemoAccount(
  options: SeedDemoAccountOptions,
): Promise<DemoSeedResult> {
  try {
    return await seedDemoAccountUnchecked(options);
  } catch (error) {
    if (error instanceof DemoSeedError && trustedErrors.has(error)) {
      throw error;
    }

    throw trustedError("Demo seed failed.");
  }
}
