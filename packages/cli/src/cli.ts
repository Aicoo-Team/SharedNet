import { hostname, platform } from "node:os";
import { randomUUID } from "node:crypto";

import { ApiClient, resolveBaseUrl } from "./api-client.ts";
import { CliError, asCliError, localError } from "./errors.ts";
import { isGuestVerb, runGuestVerb } from "./guest.ts";
import { login } from "./login.ts";
import { computeLocalInstanceKey } from "./instance-computation.ts";
import { detectRuntime, isRuntimeKind, runtimeMetadataOf } from "./runtime-detection.ts";
import {
  deleteSession,
  getOrCreateInstallationSecret,
  getStoragePaths,
  listSessions,
  readSessionById,
  readStoredApiCredential,
  writeSession,
  type StoragePaths,
  type StoredSession,
} from "./storage.ts";

const CLI_VERSION = "0.1.0";

type Environment = Record<string, string | undefined>;

export interface CliDependencies {
  env?: Environment;
  fetch?: typeof globalThis.fetch;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  now?: () => Date;
  /** Where per-project Room state lives; defaults to the process working directory. */
  cwd?: string;
  /** Pause between empty long-polls in `wait`; tests shorten it. */
  sleep?: (ms: number) => Promise<void>;
  /** Opens the approve page during `login`; tests capture the URL instead. */
  openBrowser?: (url: string) => Promise<boolean>;
}

interface ResolvedDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  now: () => Date;
  cwd: string;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<boolean>;
}

interface GlobalArguments {
  args: string[];
  json: boolean;
  sessionId?: string;
}

interface ParsedArguments {
  options: Map<string, string | true>;
  positionals: string[];
}

interface AgentShape {
  id: string;
  principal_id?: string;
  handle?: string;
}

interface InstanceShape {
  id: string;
  principal_id: string;
  agent_id: string | null;
  started_at: string;
  lease_expires_at: string;
  token_expires_at?: string;
  expires_at?: string;
  [key: string]: unknown;
}

interface InstanceStartPayload {
  instance: InstanceShape;
  token: string;
  heartbeat_after_seconds: number;
}

interface CurrentInstancePayload {
  principal: unknown;
  agent: AgentShape | null;
  instance: InstanceShape;
}

const optionValueNames = new Set([
  "agent",
  "runtime",
  "name",
  "description",
  "content",
  "reply-to",
  "after",
  "limit",
]);
const booleanOptionNames = new Set(["new"]);

function extractGlobals(argv: string[]): GlobalArguments {
  const args: string[] = [];
  let json = false;
  let sessionId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--api-key" || argument.startsWith("--api-key=")) {
      throw localError(
        "credential_flag_forbidden",
        "API keys are accepted only from SHAREDNET_API_KEY or secure local credentials.",
      );
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--session" || argument.startsWith("--session=")) {
      if (sessionId !== undefined) {
        throw localError("duplicate_option", "The --session option may be supplied only once.");
      }
      const value = argument === "--session" ? argv[++index] : argument.slice("--session=".length);
      if (!value || !/^i_[A-Za-z0-9_-]+$/.test(value)) {
        throw localError("invalid_session_id", "The --session value must be an Instance ID.");
      }
      sessionId = value;
      continue;
    }
    args.push(argument);
  }
  return { args, json, sessionId };
}

function parseArguments(args: string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (options.has(name)) {
      throw localError("duplicate_option", `The --${name} option may be supplied only once.`);
    }
    if (booleanOptionNames.has(name)) {
      if (separator !== -1) {
        throw localError("invalid_option", `The --${name} option does not accept a value.`);
      }
      options.set(name, true);
      continue;
    }
    if (!optionValueNames.has(name)) {
      throw localError("unknown_option", "The command contains an unknown option.");
    }
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) {
      throw localError("missing_option_value", `The --${name} option requires a value.`);
    }
    options.set(name, value);
  }
  return { options, positionals };
}

function option(arguments_: ParsedArguments, name: string): string | undefined {
  const value = arguments_.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredOption(arguments_: ParsedArguments, name: string): string {
  const value = option(arguments_, name);
  if (!value) throw localError("missing_required_option", `The --${name} option is required.`);
  return value;
}

function assertOnlyOptions(arguments_: ParsedArguments, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of arguments_.options.keys()) {
    if (!allowedSet.has(name)) {
      throw localError("unknown_option", `The --${name} option is not valid for this command.`);
    }
  }
}

function assertPositionals(arguments_: ParsedArguments, count: number): void {
  if (arguments_.positionals.length !== count) {
    throw localError("invalid_arguments", "The command received the wrong number of arguments.");
  }
}

function apiKeyAuthenticationError(): CliError {
  return new CliError(
    "authentication_required",
    "Set SHAREDNET_API_KEY or run sharednet login first.",
    3,
  );
}

async function resolveApiKey(
  env: Environment,
  paths: StoragePaths,
  baseUrl: string,
): Promise<string> {
  const environmentKey = env.SHAREDNET_API_KEY?.trim();
  if (environmentKey) return environmentKey;
  const credential = await readStoredApiCredential(paths);
  if (!credential) throw apiKeyAuthenticationError();
  if (credential.base_url !== baseUrl) {
    throw localError(
      "credential_origin_mismatch",
      "The stored credential belongs to a different SharedNet origin.",
    );
  }
  if (credential.expires_at && Date.parse(credential.expires_at) <= Date.now()) {
    throw new CliError("invalid_credentials", "The stored API key has expired.", 3);
  }
  return credential.api_key;
}

/**
 * Resolves `--agent` to a tag. An `a_` id is fetched; anything else is a
 * handle and is created on first use, the way `git tag` behaves — the server's
 * POST is idempotent by handle, so one call covers both "exists" and "new".
 * `default` names the absence of a tag and resolves to nothing.
 */
async function resolveTag(
  client: ApiClient,
  apiKey: string,
  requested: string,
): Promise<AgentShape | null> {
  const handle = requested.normalize("NFKC").trim().toLowerCase();
  if (handle === "default") return null;
  let agent: AgentShape;
  if (/^a_[A-Za-z0-9]+$/.test(requested)) {
    const payload = await client.request<{ agent: AgentShape }>(
      "GET",
      `/agents/${encodeURIComponent(requested)}`,
      apiKey,
    );
    agent = payload.agent;
  } else {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(handle)) {
      throw localError(
        "invalid_agent",
        "An Agent is an a_ id or a handle matching ^[a-z][a-z0-9-]{0,31}$.",
      );
    }
    const payload = await client.request<{ agent: AgentShape }>("POST", "/agents", apiKey, {
      handle,
    });
    agent = payload.agent;
  }
  if (!agent?.id) {
    throw new CliError(
      "invalid_server_response",
      "The SharedNet service returned an invalid Agent response.",
      5,
    );
  }
  return agent;
}

/**
 * Where this session runs, for humans telling untagged sessions apart. It is
 * shown, never trusted: the server records it as diagnostics and nothing reads
 * it for authorization or grouping.
 *
 * Only the workspace's last path segment is sent. The full path is a map of
 * this machine — home directory, user name, client folders — and none of that
 * is needed to tell "the one in the sharednet folder" from the others.
 */
function runtimeMetadata(env: Environment): Record<string, string> {
  const clean = (value: string | undefined) =>
    (value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 256);
  const metadata: Record<string, string> = {};
  const host = clean(hostname());
  const workspacePath = clean(env.PWD ?? process.cwd());
  const workspace = workspacePath.split(/[\\/]+/).filter(Boolean).at(-1) ?? "";
  if (host) metadata.hostname = host;
  if (workspace) metadata.workspace = workspace;
  metadata.os = platform();
  return metadata;
}

function validateRuntime(value: string): string {
  const kind = value.normalize("NFKC").trim().toLowerCase();
  if (isRuntimeKind(kind)) return kind;
  throw localError("invalid_runtime", "Runtime must be a handle such as claude-code, codex, or opencode.");
}

function storedSessionFromStart(
  baseUrl: string,
  localInstanceKey: string | null,
  payload: InstanceStartPayload,
): StoredSession {
  const { instance, token } = payload;
  if (!instance?.id || !instance.principal_id || !token) {
    throw new CliError(
      "invalid_server_response",
      "The SharedNet service returned an invalid Instance response.",
      5,
    );
  }
  const expiresAt = instance.token_expires_at ?? instance.expires_at;
  if (!expiresAt) {
    throw new CliError(
      "invalid_server_response",
      "The SharedNet service returned an invalid Instance response.",
      5,
    );
  }
  return {
    schema_version: 1,
    base_url: baseUrl,
    principal_id: instance.principal_id,
    agent_id: instance.agent_id ?? null,
    instance_id: instance.id,
    local_instance_key: localInstanceKey,
    instance_token: token,
    created_at: instance.started_at,
    lease_expires_at: instance.lease_expires_at,
    expires_at: expiresAt,
  };
}

async function selectSession(
  paths: StoragePaths,
  baseUrl: string,
  explicitId: string | undefined,
  env: Environment,
): Promise<StoredSession> {
  const selectedId = explicitId || env.SHAREDNET_SESSION?.trim();
  if (selectedId) {
    if (!/^i_[A-Za-z0-9_-]+$/.test(selectedId)) {
      throw localError("invalid_session_id", "SHAREDNET_SESSION must be an Instance ID.");
    }
    const selected = await readSessionById(paths, selectedId);
    if (!selected || selected.base_url !== baseUrl) {
      throw localError("session_not_found", "The selected local SharedNet session was not found.");
    }
    return selected;
  }

  const usable = (await listSessions(paths)).filter(
    (session) => session.base_url === baseUrl && Date.parse(session.expires_at) > Date.now(),
  );
  if (usable.length !== 1) {
    throw localError(
      "session_selection_required",
      "Select a local Instance with --session or SHAREDNET_SESSION.",
    );
  }
  return usable[0]!;
}

async function refreshIfNeeded(
  client: ApiClient,
  paths: StoragePaths,
  session: StoredSession,
  now: Date,
): Promise<StoredSession> {
  if (Date.parse(session.expires_at) <= now.getTime()) {
    await deleteSession(paths, session.instance_id);
    throw new CliError("invalid_credentials", "The local Instance session has expired.", 3);
  }
  if (Date.parse(session.lease_expires_at) - now.getTime() > 30_000) return session;

  try {
    const payload = await client.request<{
      instance: InstanceShape;
      heartbeat_after_seconds: number;
    }>("POST", "/instances/current/heartbeat", session.instance_token, {});
    const refreshed: StoredSession = {
      ...session,
      lease_expires_at: payload.instance.lease_expires_at,
      expires_at:
        payload.instance.token_expires_at ?? payload.instance.expires_at ?? session.expires_at,
    };
    await writeSession(paths, refreshed);
    return refreshed;
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) {
      await deleteSession(paths, session.instance_id);
    }
    throw error;
  }
}

async function withSelectedSession<T>(
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
  callback: (
    client: ApiClient,
    session: StoredSession,
    paths: StoragePaths,
  ) => Promise<T>,
): Promise<T> {
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const client = new ApiClient(baseUrl, dependencies.fetch);
  let session = await selectSession(
    paths,
    baseUrl,
    globals.sessionId,
    dependencies.env,
  );
  session = await refreshIfNeeded(client, paths, session, dependencies.now());
  try {
    return await callback(client, session, paths);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) {
      await deleteSession(paths, session.instance_id);
    }
    throw error;
  }
}

async function startSession(
  commandArgs: string[],
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  assertPositionals(parsed, 0);
  assertOnlyOptions(parsed, ["agent", "runtime", "new"]);

  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const installationSecret = await getOrCreateInstallationSecret(paths);
  // The driver is read off its own environment; --runtime only overrides the name.
  const detected = detectRuntime(dependencies.env);
  const runtimeKind = option(parsed, "runtime")
    ? validateRuntime(option(parsed, "runtime")!)
    : detected.kind;
  const forceNew = parsed.options.get("new") === true;
  let localInstanceKey: string | null = null;

  if (!forceNew) {
    if (detected.anchor === null || (option(parsed, "runtime") && runtimeKind !== detected.kind)) {
      throw localError(
        "runtime_session_not_detected",
        "The current runtime session could not be detected; use --new deliberately.",
      );
    }
    // The key goes to the server, which is the one place that can guarantee
    // one live Instance per runtime session. The raw session id stays here.
    localInstanceKey = computeLocalInstanceKey(
      installationSecret,
      runtimeKind,
      detected.anchor,
    );
  }

  const apiKey = await resolveApiKey(dependencies.env, paths, baseUrl);
  const client = new ApiClient(baseUrl, dependencies.fetch);
  const requestedTag = option(parsed, "agent");
  const tag = requestedTag ? await resolveTag(client, apiKey, requestedTag) : undefined;

  // A same-session re-registration comes back 200 with the existing Instance
  // and a fresh token; a new session comes back 201. Both are a session.
  const payload = await client.request<InstanceStartPayload>("POST", "/instances", apiKey, {
    runtime_kind: runtimeKind,
    cli_version: CLI_VERSION,
    ...(localInstanceKey ? { local_instance_key: localInstanceKey } : {}),
    ...(tag === undefined ? {} : { agent_id: tag?.id ?? null }),
    runtime_metadata: { ...runtimeMetadata(dependencies.env), ...runtimeMetadataOf(detected) },
  });
  const session = storedSessionFromStart(baseUrl, localInstanceKey, payload);
  await writeSession(paths, session);
  return {
    instance: payload.instance,
    session_id: payload.instance.id,
    heartbeat_after_seconds: payload.heartbeat_after_seconds,
  };
}

async function sessionStatus(
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  assertPositionals(parsed, 0);
  assertOnlyOptions(parsed, []);
  return withSelectedSession(globals, dependencies, (client, session) =>
    client.request("GET", "/instances/current", session.instance_token),
  );
}

async function roomCommand(
  action: string | undefined,
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  if (action === "create") {
    assertPositionals(parsed, 0);
    assertOnlyOptions(parsed, ["name", "description"]);
    const name = requiredOption(parsed, "name");
    const description = option(parsed, "description");
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("POST", "/rooms", session.instance_token, {
        name,
        ...(description === undefined ? {} : { description }),
      }, { "idempotency-key": randomUUID() }),
    );
  }

  if (action === "join") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, []);
    const roomId = parsed.positionals[0]!;
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "POST",
        `/rooms/${encodeURIComponent(roomId)}/join`,
        session.instance_token,
        undefined,
        { "idempotency-key": randomUUID() },
      ),
    );
  }

  if (action === "post") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, ["content", "reply-to"]);
    const roomId = parsed.positionals[0]!;
    const content = requiredOption(parsed, "content");
    const replyTo = option(parsed, "reply-to");
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "POST",
        `/rooms/${encodeURIComponent(roomId)}/messages`,
        session.instance_token,
        {
          content,
          ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
        },
        { "idempotency-key": randomUUID() },
      ),
    );
  }

  if (action === "messages") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, ["after", "limit"]);
    const roomId = parsed.positionals[0]!;
    const parameters = new URLSearchParams();
    const after = option(parsed, "after");
    const limit = option(parsed, "limit");
    if (after !== undefined) parameters.set("after", after);
    if (limit !== undefined) {
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
        throw localError("invalid_limit", "--limit must be an integer from 1 to 100.");
      }
      parameters.set("limit", limit);
    }
    const query = parameters.size ? `?${parameters.toString()}` : "";
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "GET",
        `/rooms/${encodeURIComponent(roomId)}/messages${query}`,
        session.instance_token,
      ),
    );
  }

  throw localError("unknown_command", "Unknown room command.");
}

async function execute(
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const [resource, action, ...commandArgs] = globals.args;
  if (resource === "login") {
    if (globals.sessionId !== undefined) {
      throw localError("invalid_option", "The --session option is not valid for sharednet login.");
    }
    return login(globals.args.slice(1), dependencies);
  }
  if (isGuestVerb(resource)) {
    if (globals.sessionId !== undefined) {
      throw localError("invalid_option", `The --session option is not valid for sharednet ${resource}.`);
    }
    return runGuestVerb(resource, globals.args.slice(1), dependencies);
  }
  if (resource === "session" && action === "start") {
    return startSession(commandArgs, dependencies);
  }
  if (resource === "session" && action === "status") {
    return sessionStatus(commandArgs, globals, dependencies);
  }
  if (resource === "room") {
    return roomCommand(action, commandArgs, globals, dependencies);
  }
  throw localError(
    "unknown_command",
    "Use login, join/say/wait, or session start/status and room create/join/post/messages.",
  );
}

function isHookOutput(payload: unknown): payload is { hook: true; lines: string[] } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { hook?: unknown }).hook === true &&
    Array.isArray((payload as { lines?: unknown }).lines)
  );
}

function writeSuccess(
  payload: unknown,
  json: boolean,
  dependencies: ResolvedDependencies,
): void {
  // A hook's stdout goes straight into an Agent's context: plain lines, and
  // nothing at all when the Room was quiet.
  if (!json && isHookOutput(payload)) {
    if (payload.lines.length > 0) dependencies.stdout(`${payload.lines.join("\n")}\n`);
    return;
  }
  dependencies.stdout(`${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
}

function writeFailure(
  error: CliError,
  json: boolean,
  dependencies: ResolvedDependencies,
): void {
  if (json) {
    dependencies.stderr(
      `${JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(error.requestId ? { request_id: error.requestId } : {}),
        },
      })}\n`,
    );
    return;
  }
  const requestSuffix = error.requestId ? ` (${error.requestId})` : "";
  dependencies.stderr(`${error.code}: ${error.message}${requestSuffix}\n`);
}

export async function runCli(
  argv: string[],
  supplied: CliDependencies = {},
): Promise<number> {
  const dependencies: ResolvedDependencies = {
    env: supplied.env ?? process.env,
    fetch: supplied.fetch ?? globalThis.fetch,
    stdout: supplied.stdout ?? ((value) => process.stdout.write(value)),
    stderr: supplied.stderr ?? ((value) => process.stderr.write(value)),
    now: supplied.now ?? (() => new Date()),
    cwd: supplied.cwd ?? process.cwd(),
    ...(supplied.sleep ? { sleep: supplied.sleep } : {}),
    ...(supplied.openBrowser ? { openBrowser: supplied.openBrowser } : {}),
  };
  let json = argv.includes("--json");
  try {
    const globals = extractGlobals(argv);
    json = globals.json;
    const payload = await execute(globals, dependencies);
    writeSuccess(payload, globals.json, dependencies);
    return 0;
  } catch (error) {
    const cliError = asCliError(error);
    writeFailure(cliError, json, dependencies);
    return cliError.exitCode;
  }
}
