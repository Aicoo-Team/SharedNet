import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { localError } from "./errors.ts";

type Environment = Record<string, string | undefined>;

export interface StoragePaths {
  configDir: string;
  credentialsFile: string;
  installationFile: string;
  stateDir: string;
  sessionsDir: string;
}

export interface StoredApiCredential {
  schema_version: 1;
  base_url: string;
  principal_id: string;
  api_key_id: string;
  api_key: string;
  installation_secret: string;
  created_at: string;
  expires_at: string | null;
}

export interface StoredSession {
  schema_version: 1;
  base_url: string;
  principal_id: string;
  agent_id: string;
  instance_id: string;
  local_instance_key: string | null;
  instance_token: string;
  created_at: string;
  lease_expires_at: string;
  expires_at: string;
}

export interface LocalSessionScope {
  baseUrl: string;
  principalId: string;
  agentId: string;
}

interface StoredInstallation {
  schema_version: 1;
  installation_secret: string;
}

function unsafeStorage(): never {
  throw localError(
    "unsafe_credential_storage",
    "SharedNet local credential storage is not owner-only.",
  );
}

export function getStoragePaths(env: Environment = process.env): StoragePaths {
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) unsafeStorage();
    const root = join(localAppData, "SharedNet");
    return {
      configDir: root,
      credentialsFile: join(root, "credentials.json"),
      installationFile: join(root, "installation.json"),
      stateDir: root,
      sessionsDir: join(root, "sessions"),
    };
  }

  const home = env.HOME || homedir();
  if (!home) unsafeStorage();
  const configRoot = env.XDG_CONFIG_HOME || join(home, ".config");
  const stateRoot = env.XDG_STATE_HOME || join(home, ".local", "state");
  const configDir = join(configRoot, "sharednet");
  const stateDir = join(stateRoot, "sharednet");
  return {
    configDir,
    credentialsFile: join(configDir, "credentials.json"),
    installationFile: join(configDir, "installation.json"),
    stateDir,
    sessionsDir: join(stateDir, "sessions"),
  };
}

async function ensureSecureDirectory(path: string): Promise<void> {
  if (process.platform === "win32") unsafeStorage();
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    unsafeStorage();
  }
}

async function readSecureFile(path: string): Promise<string | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    unsafeStorage();
  }

  let handle;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== info.dev ||
      openedInfo.ino !== info.ino ||
      openedInfo.uid !== process.getuid?.() ||
      (openedInfo.mode & 0o077) !== 0
    ) {
      unsafeStorage();
    }
    return await handle.readFile("utf8");
  } finally {
    await handle?.close();
  }
}

async function writeSecureJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensureSecureDirectory(parent);

  // Validate an existing target before an atomic replacement. Missing is fine.
  await readSecureFile(path);
  const temp = join(parent, `.sharednet-${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, 0o600);
    await rename(temp, path);
    const directory = await open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function createSecureJsonIfAbsent(path: string, value: unknown): Promise<boolean> {
  const parent = dirname(path);
  await ensureSecureDirectory(parent);
  const temp = join(parent, `.sharednet-${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, 0o600);
    try {
      // link(2) is an atomic create-if-absent operation. Unlike opening the
      // destination with O_EXCL and then writing it, readers can never observe
      // an empty or partially written installation secret.
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    const directory = await open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } finally {
    await handle?.close();
    await unlink(temp).catch(() => undefined);
  }
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw localError("invalid_local_state", `${source} is not valid SharedNet state.`);
  }
}

function requireString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw localError("invalid_local_state", `${source} is not valid SharedNet state.`);
  }
  return value;
}

function parseCredential(raw: string): StoredApiCredential {
  const value = parseJsonObject(raw, "The credential file");
  if (value.schema_version !== 1) {
    throw localError("invalid_local_state", "The credential file has an unsupported version.");
  }
  return {
    schema_version: 1,
    base_url: requireString(value.base_url, "The credential file"),
    principal_id: requireString(value.principal_id, "The credential file"),
    api_key_id: requireString(value.api_key_id, "The credential file"),
    api_key: requireString(value.api_key, "The credential file"),
    installation_secret: requireString(value.installation_secret, "The credential file"),
    created_at: requireString(value.created_at, "The credential file"),
    expires_at:
      value.expires_at === null ? null : requireString(value.expires_at, "The credential file"),
  };
}

function parseSession(raw: string): StoredSession {
  const value = parseJsonObject(raw, "A session file");
  if (value.schema_version !== 1) {
    throw localError("invalid_local_state", "A session file has an unsupported version.");
  }
  return {
    schema_version: 1,
    base_url: requireString(value.base_url, "A session file"),
    principal_id: requireString(value.principal_id, "A session file"),
    agent_id: requireString(value.agent_id, "A session file"),
    instance_id: requireString(value.instance_id, "A session file"),
    local_instance_key:
      value.local_instance_key === null
        ? null
        : requireString(value.local_instance_key, "A session file"),
    instance_token: requireString(value.instance_token, "A session file"),
    created_at: requireString(value.created_at, "A session file"),
    lease_expires_at: requireString(value.lease_expires_at, "A session file"),
    expires_at: requireString(value.expires_at, "A session file"),
  };
}

export async function readStoredApiCredential(
  paths: StoragePaths,
): Promise<StoredApiCredential | null> {
  const raw = await readSecureFile(paths.credentialsFile);
  return raw === null ? null : parseCredential(raw);
}

export async function getOrCreateInstallationSecret(
  paths: StoragePaths,
): Promise<string> {
  const credential = await readStoredApiCredential(paths);
  if (credential) return credential.installation_secret;

  const raw = await readSecureFile(paths.installationFile);
  if (raw !== null) {
    const value = parseJsonObject(raw, "The installation file");
    if (value.schema_version !== 1) {
      throw localError("invalid_local_state", "The installation file has an unsupported version.");
    }
    return requireString(value.installation_secret, "The installation file");
  }

  const installation: StoredInstallation = {
    schema_version: 1,
    installation_secret: randomBytes(32).toString("base64url"),
  };
  if (await createSecureJsonIfAbsent(paths.installationFile, installation)) {
    return installation.installation_secret;
  }

  const winnerRaw = await readSecureFile(paths.installationFile);
  if (winnerRaw === null) {
    throw localError("invalid_local_state", "The installation secret could not be created.");
  }
  const winner = parseJsonObject(winnerRaw, "The installation file");
  if (winner.schema_version !== 1) {
    throw localError("invalid_local_state", "The installation file has an unsupported version.");
  }
  return requireString(winner.installation_secret, "The installation file");
}

export async function writeSession(
  paths: StoragePaths,
  session: StoredSession,
): Promise<void> {
  if (!/^i_[A-Za-z0-9_-]+$/.test(session.instance_id)) {
    throw localError("invalid_local_state", "The Instance ID is invalid.");
  }
  await writeSecureJson(join(paths.sessionsDir, `${session.instance_id}.json`), session);
}

export async function listSessions(paths: StoragePaths): Promise<StoredSession[]> {
  let entries;
  try {
    await ensureSecureDirectory(paths.sessionsDir);
    entries = await readdir(paths.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sessions: StoredSession[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) unsafeStorage();
    const raw = await readSecureFile(join(paths.sessionsDir, entry.name));
    if (raw !== null) sessions.push(parseSession(raw));
  }
  return sessions;
}

export async function findSessionByLocalKey(
  paths: StoragePaths,
  localInstanceKey: string,
  scope: LocalSessionScope,
): Promise<StoredSession | null> {
  const sessions = await listSessions(paths);
  const matches = sessions.filter(
    (session) =>
      session.local_instance_key === localInstanceKey &&
      session.base_url === scope.baseUrl &&
      session.principal_id === scope.principalId &&
      session.agent_id === scope.agentId &&
      Date.parse(session.expires_at) > Date.now(),
  );
  if (matches.length > 1) {
    throw localError("invalid_local_state", "Duplicate local Instance state was found.");
  }
  return matches[0] ?? null;
}

export async function readSessionById(
  paths: StoragePaths,
  instanceId: string,
): Promise<StoredSession | null> {
  if (!/^i_[A-Za-z0-9_-]+$/.test(instanceId)) {
    throw localError("invalid_session_id", "The Instance ID is invalid.");
  }
  const raw = await readSecureFile(join(paths.sessionsDir, `${instanceId}.json`));
  return raw === null ? null : parseSession(raw);
}

export async function deleteSession(paths: StoragePaths, instanceId: string): Promise<void> {
  if (!/^i_[A-Za-z0-9_-]+$/.test(instanceId)) return;
  const path = join(paths.sessionsDir, `${instanceId}.json`);
  const raw = await readSecureFile(path);
  if (raw === null) return;
  await unlink(path);
}
