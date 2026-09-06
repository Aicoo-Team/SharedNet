import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join as joinPath } from "node:path";

import { ApiClient, resolveBaseUrl } from "./api-client.ts";
import { CliError, localError } from "./errors.ts";
import { detectRuntime } from "./runtime-detection.ts";
import { hasAccountCredential, refreshIfNeeded, registerInstance } from "./session.ts";
import {
  getStoragePaths,
  readProjectRoomState,
  readRoomCredential,
  readSessionById,
  writeProjectRoomState,
  writeRoomCredential,
  type ProjectRoomState,
  type StoredRoomCredential,
} from "./storage.ts";

/**
 * The guest verbs: `join`, `say`, `wait`. They are sugar over the three HTTP
 * requests in /skill.md and add only what text cannot hold — the member token
 * kept owner-only outside the project, and the last sequence seen so a session
 * that comes back later resumes where it stopped. Nothing here can do anything
 * the curl lines cannot.
 */

type Environment = Record<string, string | undefined>;

export interface GuestDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  stdout: (value: string) => void;
  stderr?: (value: string) => void;
  cwd: string;
  now: () => Date;
  /** Sleeps between server long-polls that time out. Tests shorten it. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs the `watch --run` command; the default shells out. Tests capture it. */
  exec?: CommandRunner;
}

export type CommandRunner = (
  command: string,
  input: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

interface ParsedGuestArguments {
  options: Map<string, string | true>;
  positionals: string[];
}

interface MessageShape {
  id: string;
  sequence: number;
  content: string;
  sender?: { member_id: string; kind: string; name: string | null };
  created_at?: string;
  [key: string]: unknown;
}

interface PageShape {
  items: MessageShape[];
  next_cursor: string | null;
  has_more: boolean;
}

interface GuestJoinPayload {
  room: { id: string; name?: string | null; [key: string]: unknown };
  membership: { member_id: string; principal_id?: string; name?: string | null; [key: string]: unknown };
  member_token: string;
  history: PageShape;
}

interface AccountJoinPayload {
  room: { id: string; name?: string | null; [key: string]: unknown };
  membership: { member_id: string; principal_id?: string; name?: string | null; [key: string]: unknown };
}

const ROOM_ID_PATTERN = /^rom_[A-Za-z0-9]+$/;
const INVITE_TOKEN_PATTERN = /^rit_[A-Za-z0-9_-]{43}$/;
/** The server caps one wait at this; the client loops. */
const WAIT_MAX_SECONDS = 25;

const VALUE_OPTIONS = new Set(["name", "token", "timeout", "reply-to", "min", "on", "run", "max-runs", "as"]);
const FLAG_OPTIONS = new Set(["hook", "private", "reply"]);

function parseGuestArguments(args: string[]): ParsedGuestArguments {
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
    if (FLAG_OPTIONS.has(name)) {
      if (separator !== -1) {
        throw localError("invalid_option", `The --${name} option does not accept a value.`);
      }
      options.set(name, true);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
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

function stringOption(parsed: ParsedGuestArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function assertOnlyOptions(parsed: ParsedGuestArguments, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of parsed.options.keys()) {
    if (!allowedSet.has(name)) {
      throw localError("unknown_option", `The --${name} option is not valid for this command.`);
    }
  }
}

/**
 * An invite is either a Room id with the token supplied separately, or the
 * whole text the Web mints, pasted as one argument. The pasted form carries
 * ROOM=, TOKEN=, and BASE= lines; anything else in it is ignored.
 */
function parseInvite(
  argument: string,
  parsed: ParsedGuestArguments,
  env: Environment,
): { roomId: string; token: string; baseUrl: string } {
  let roomId: string | undefined;
  let token = stringOption(parsed, "token") ?? env.SHAREDNET_INVITE_TOKEN?.trim() ?? undefined;
  let base: string | undefined;

  if (ROOM_ID_PATTERN.test(argument)) {
    roomId = argument;
  } else {
    roomId = /(?:^|\s)ROOM=(rom_[A-Za-z0-9]+)(?=\s|$)/.exec(argument)?.[1];
    const pastedToken = /(?:^|\s)TOKEN=(rit_[A-Za-z0-9_-]{43})(?=\s|$)/.exec(argument)?.[1];
    if (pastedToken) token = pastedToken;
    base = /(?:^|\s)BASE=(\S+)(?=\s|$)/.exec(argument)?.[1];
  }

  if (!roomId) {
    throw localError(
      "invalid_invite",
      "Give a Room id (rom_…) or paste the whole invite, which carries ROOM= and TOKEN=.",
    );
  }
  if (!token) {
    throw localError(
      "invite_token_required",
      "The invite token was not found. Paste the whole invite, or set SHAREDNET_INVITE_TOKEN.",
    );
  }
  if (!INVITE_TOKEN_PATTERN.test(token)) {
    throw localError("invalid_invite", "The invite token is not a SharedNet Room invite (rit_…).");
  }
  // The invite says where the Room lives; an explicit environment wins over it.
  const baseUrl = resolveBaseUrl(env.SHAREDNET_BASE_URL ?? base);
  return { roomId, token, baseUrl };
}

function defaultGuestName(env: Environment): string {
  const detected = detectRuntime(env);
  return detected.kind === "custom" ? "agent" : detected.kind;
}

/** What the join tells the server about the driver, when one was recognised. */
function runtimeReport(env: Environment): { kind: string; version: string | null; entrypoint: string | null; source: "detected" | "declared" } | undefined {
  const detected = detectRuntime(env);
  if (detected.kind === "custom") return undefined;
  return {
    kind: detected.kind,
    version: detected.version,
    entrypoint: detected.entrypoint,
    source: detected.source,
  };
}

function highestSequence(items: MessageShape[], fallback: number): number {
  return items.reduce(
    (max, item) => (Number.isSafeInteger(item.sequence) && item.sequence > max ? item.sequence : max),
    fallback,
  );
}

function invalidServerResponse(): CliError {
  return new CliError(
    "invalid_server_response",
    "The SharedNet service returned an invalid response.",
    5,
  );
}

async function join(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["name", "token", "private", "as"]);
  if (parsed.positionals.length !== 1) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet join <invite> [--name <name>] [--private], or sharednet join <rom_…> [--as <i_…>]",
    );
  }
  // A Room id with no invite: this machine already holds a seat, and the
  // seat was added to (or knows the id of) that Room. Enter it as that seat.
  const argument = parsed.positionals[0]!;
  const inviteToken = stringOption(parsed, "token") ?? dependencies.env.SHAREDNET_INVITE_TOKEN?.trim();
  if (ROOM_ID_PATTERN.test(argument) && !inviteToken) {
    return enterAsSeat(argument, stringOption(parsed, "as"), dependencies);
  }
  const { roomId, token, baseUrl } = parseInvite(argument, parsed, dependencies.env);
  const name = stringOption(parsed, "name") ?? defaultGuestName(dependencies.env);
  // --private: strangers who know this seat's Instance id have to ask before
  // seating it in another Room. Omitted, the seat is public.
  const reach = parsed.options.get("private") === true ? ("private" as const) : undefined;
  const paths = getStoragePaths(dependencies.env);
  const client = new ApiClient(baseUrl, dependencies.fetch);

  // Two doors, one model. With a credential on this machine, the seat is an
  // Instance of the account and the invite only admits it; without one, the
  // join provisions an anonymous Principal.
  if (await hasAccountCredential(dependencies.env, paths, baseUrl)) {
    return joinAsAccount(roomId, token, name, baseUrl, paths, client, dependencies, reach);
  }

  const runtime = runtimeReport(dependencies.env);
  const payload = await client.request<GuestJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    token,
    { name, ...(runtime ? { runtime } : {}), ...(reach === undefined ? {} : { reach }) },
  );
  const memberId = payload.membership?.member_id;
  const memberToken = payload.member_token;
  if (!payload.room?.id || !memberId || !memberToken || !Array.isArray(payload.history?.items)) {
    throw invalidServerResponse();
  }

  const credential: StoredRoomCredential = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: memberId,
    name,
    member_token: memberToken,
    joined_at: dependencies.now().toISOString(),
  };
  await writeRoomCredential(paths, credential);
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: memberId,
    last_sequence: highestSequence(payload.history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state);

  // Everything the Agent should report, and nothing it should not: the tokens
  // stay in the credential file.
  return {
    room: payload.room,
    member_id: memberId,
    principal_id: payload.membership.principal_id ?? null,
    as: "anonymous",
    name,
    last_sequence: state.last_sequence,
    history: payload.history,
  };
}

/** Every seat credential this machine holds, one per (Room, member). */
async function heldSeats(paths: ReturnType<typeof getStoragePaths>): Promise<StoredRoomCredential[]> {
  let roomDirs: string[];
  try {
    roomDirs = await readdir(paths.roomsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const seats: StoredRoomCredential[] = [];
  for (const roomId of roomDirs) {
    if (!ROOM_ID_PATTERN.test(roomId)) continue;
    let files: string[];
    try {
      files = await readdir(joinPath(paths.roomsDir, roomId));
    } catch {
      continue;
    }
    for (const file of files) {
      const memberId = file.replace(/\.json$/, "");
      if (!/^(?:i|mem)_[A-Za-z0-9]+$/.test(memberId)) continue;
      const credential = await readRoomCredential(paths, roomId, memberId).catch(() => null);
      if (credential) seats.push(credential);
    }
  }
  return seats;
}

/**
 * Enter a Room by id as a seat this machine already holds: the one named by
 * --as, or the only one there is. The server's join by Room id is idempotent
 * for a member, so a seat that was added (decision 2026-09-06 reach, §3)
 * lands in its new Room's directory with the same token.
 */
async function enterAsSeat(
  roomId: string,
  memberId: string | undefined,
  dependencies: GuestDependencies,
): Promise<unknown> {
  const paths = getStoragePaths(dependencies.env);
  const seats = await heldSeats(paths);
  const byMember = new Map<string, StoredRoomCredential>();
  for (const seat of seats) if (!byMember.has(seat.member_id)) byMember.set(seat.member_id, seat);
  let seat: StoredRoomCredential | undefined;
  if (memberId !== undefined) {
    seat = byMember.get(memberId);
    if (!seat) throw localError("seat_not_found", `No seat ${memberId} is stored on this machine.`);
  } else if (byMember.size === 1) {
    seat = [...byMember.values()][0];
  } else if (byMember.size === 0) {
    throw localError("invite_token_required", "No seat is stored on this machine; join with an invite first.");
  } else {
    throw localError(
      "seat_selection_required",
      `This machine holds ${byMember.size} seats; say which with --as <member_id>: ${[...byMember.keys()].join(", ")}`,
    );
  }
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL ?? seat.base_url);
  if (baseUrl !== seat.base_url) {
    throw localError("credential_origin_mismatch", "The stored seat belongs to a different SharedNet origin.");
  }
  const client = new ApiClient(baseUrl, dependencies.fetch);
  const payload = await client.request<AccountJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    seat.member_token,
    undefined,
    { "idempotency-key": randomUUID() },
  );
  if (!payload.room?.id || !payload.membership?.member_id) throw invalidServerResponse();
  const history = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/messages?after=0&limit=100`,
    seat.member_token,
  );
  if (!Array.isArray(history?.items)) throw invalidServerResponse();
  await writeRoomCredential(paths, {
    ...seat,
    room_id: payload.room.id,
    member_id: payload.membership.member_id,
    joined_at: dependencies.now().toISOString(),
  });
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: payload.membership.member_id,
    last_sequence: highestSequence(history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state);
  return {
    room: payload.room,
    member_id: payload.membership.member_id,
    as: "seat",
    name: seat.name,
    admitted_by: payload.membership.admitted_by ?? null,
    last_sequence: state.last_sequence,
    history,
  };
}

async function joinAsAccount(
  roomId: string,
  invite: string,
  name: string,
  baseUrl: string,
  paths: ReturnType<typeof getStoragePaths>,
  client: ApiClient,
  dependencies: GuestDependencies,
  reach?: "public" | "private",
): Promise<unknown> {
  // This session is registered as an Instance of the account first; a
  // detected driver session reuses its Instance, an undetected one gets a
  // fresh Instance, since a join is not the place to refuse.
  const { session } = await registerInstance(dependencies.env, dependencies.fetch, paths, baseUrl, {
    forceNew: false,
    freshWhenUndetected: true,
    ...(reach === undefined ? {} : { reach }),
  });
  const payload = await client.request<AccountJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    session.instance_token,
    { invite },
    { "idempotency-key": randomUUID() },
  );
  if (!payload.room?.id || !payload.membership?.member_id) throw invalidServerResponse();
  const history = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/messages?after=0&limit=100`,
    session.instance_token,
  );
  if (!Array.isArray(history?.items)) throw invalidServerResponse();

  // The seat file mirrors the session so say/wait need no second lookup; the
  // session file stays the source of a fresh token when the lease is renewed.
  await writeRoomCredential(paths, {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: session.instance_id,
    name,
    member_token: session.instance_token,
    joined_at: dependencies.now().toISOString(),
  });
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: session.instance_id,
    last_sequence: highestSequence(history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state);
  return {
    room: payload.room,
    member_id: session.instance_id,
    principal_id: session.principal_id,
    as: "account",
    name,
    last_sequence: state.last_sequence,
    history,
  };
}

async function currentSeat(
  dependencies: GuestDependencies,
): Promise<{ client: ApiClient; state: ProjectRoomState; credential: StoredRoomCredential }> {
  const state = await readProjectRoomState(dependencies.cwd);
  if (!state) {
    throw localError("not_in_a_room", "This directory is not in a Room. Run: sharednet join <invite>");
  }
  const paths = getStoragePaths(dependencies.env);
  const credential = await readRoomCredential(paths, state.room_id, state.member_id);
  if (!credential) {
    throw localError(
      "room_credential_missing",
      "The member token for this Room is not on this machine. Join again with a new invite.",
    );
  }
  if (credential.base_url !== state.base_url) {
    throw localError(
      "credential_origin_mismatch",
      "The stored Room credential belongs to a different SharedNet origin.",
    );
  }
  const client = new ApiClient(credential.base_url, dependencies.fetch);
  // A seat that is one of the account's Instances has a session file too, and
  // that is where a lease gets renewed; use its token so the seat outlives the
  // 24-hour lease the seat file alone would not.
  const session = state.member_id.startsWith("i_")
    ? await readSessionById(paths, state.member_id).catch(() => null)
    : null;
  if (session && session.base_url === state.base_url) {
    const fresh = await refreshIfNeeded(client, paths, session, dependencies.now());
    return { client, state, credential: { ...credential, member_token: fresh.instance_token } };
  }
  return { client, state, credential };
}

/**
 * Post one message to the Room. `--reply-to msg_…` threads it under an
 * earlier message; the server checks that the message is in this Room.
 */
async function say(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["reply-to"]);
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]!.trim()) {
    throw localError("invalid_arguments", 'Usage: sharednet say "<message>" [--reply-to <msg_id>]');
  }
  const replyTo = stringOption(parsed, "reply-to");
  if (replyTo !== undefined && !/^msg_[A-Za-z0-9]{10}$/.test(replyTo)) {
    throw localError("invalid_reply_to", "--reply-to must be a message id such as msg_AbCdEfGhIj.");
  }
  const { client, state, credential } = await currentSeat(dependencies);
  return client.request(
    "POST",
    `/rooms/${encodeURIComponent(state.room_id)}/messages`,
    credential.member_token,
    { content: parsed.positionals[0]!, ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }) },
    { "idempotency-key": randomUUID() },
  );
}

/** One long-poll from the cursor; the server answers within `timeout` seconds. */
async function waitPage(
  client: ApiClient,
  roomId: string,
  token: string,
  after: number,
  timeout: number,
): Promise<PageShape> {
  const query = new URLSearchParams({ after: String(after), timeout: String(timeout) });
  const page = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/wait?${query.toString()}`,
    token,
  );
  if (!Array.isArray(page?.items)) throw invalidServerResponse();
  return page;
}

function parseCount(value: string | undefined, option: string): number | null {
  if (value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value)) {
    throw localError("invalid_count", `${option} must be a whole number of at least 1.`);
  }
  return Number(value);
}

/** "30s", "10m", "1h", or plain seconds, as milliseconds. */
function parseDuration(value: string | undefined, option: string): number {
  const match = value === undefined ? null : /^(\d+)(s|m|h)?$/.exec(value);
  if (!match || Number(match[1]) < 1) {
    throw localError("invalid_duration", `${option} takes a duration such as 30s, 10m, or 1h.`);
  }
  const unit = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1000;
  return Number(match[1]) * unit;
}

type WatchTrigger =
  | { kind: "message" }
  | { kind: "every"; ms: number }
  | { kind: "count"; count: number }
  | { kind: "idle"; ms: number };

/** `--on message | every 10m | count 5 | idle 30s`; the parameter may be its own argument. */
function parseTrigger(parsed: ParsedGuestArguments): WatchTrigger {
  const raw = stringOption(parsed, "on");
  if (!raw) throw localError("invalid_arguments", "Usage: sharednet watch --on <trigger> --run '<command>'");
  const [kind, inline] = raw.trim().split(/\s+/, 2);
  const parameter = inline ?? parsed.positionals.shift();
  if (kind === "message") {
    if (parameter !== undefined) throw localError("invalid_trigger", "--on message takes no parameter.");
    return { kind: "message" };
  }
  if (kind === "every") return { kind: "every", ms: parseDuration(parameter, "--on every") };
  if (kind === "idle") return { kind: "idle", ms: parseDuration(parameter, "--on idle") };
  if (kind === "count") {
    const count = parseCount(parameter, "--on count");
    if (count === null) throw localError("invalid_trigger", "--on count takes a number of messages.");
    return { kind: "count", count };
  }
  throw localError("invalid_trigger", "--on must be message, every <duration>, count <n>, or idle <duration>.");
}

function defaultExec(command: string, input: string, env: Record<string, string>) {
  const shell = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    try {
      const child = spawn(shell[0]!, shell.slice(1), {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (error) => resolve({ exitCode: 127, stdout, stderr: stderr + String(error) }));
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      child.stdin.end(input);
    } catch (error) {
      resolve({ exitCode: 127, stdout, stderr: String(error) });
    }
  });
}

interface WatchRun {
  run: number;
  trigger: string;
  messages: number;
  exit_code: number;
  reply_message_id: string | null;
  last_sequence: number;
}

/**
 * Sit in the Room and wake a command: on every message, every so often, once
 * N messages have piled up, or once the Room has gone quiet for a while. The
 * batch goes to the command's stdin as JSON; with --reply, what it prints is
 * said back into the Room. The seat's own messages never wake it, which is
 * what keeps a replying watcher from talking to itself. The cursor moves only
 * when a batch has been handed over, so a watcher that dies mid-way replays.
 */
async function watch(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["on", "run", "reply", "max-runs"]);
  const trigger = parseTrigger(parsed);
  const command = stringOption(parsed, "run");
  if (!command || parsed.positionals.length !== 0) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet watch --on <message | every 10m | count 5 | idle 30s> --run '<command>' [--reply] [--max-runs <n>]",
    );
  }
  const reply = parsed.options.get("reply") === true;
  const maxRuns = parseCount(stringOption(parsed, "max-runs"), "--max-runs");
  const { client, state, credential } = await currentSeat(dependencies);
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const exec = dependencies.exec ?? defaultExec;
  const log = dependencies.stderr ?? (() => undefined);
  const triggerLabel =
    trigger.kind === "message"
      ? "message"
      : trigger.kind === "count"
        ? `count ${trigger.count}`
        : `${trigger.kind} ${trigger.ms / 1000}s`;

  // Who "I" am, from the server: a seat file written before migration 0007
  // still names a mem_ id, while senders are reported by Instance id now.
  const me = await client
    .request<{ instance?: { id?: string } }>("GET", "/instances/current", credential.member_token)
    .then((payload) => payload?.instance?.id ?? state.member_id)
    .catch(() => state.member_id);

  let cursor = state.last_sequence;
  let batch: MessageShape[] = [];
  let lastRunAt = dependencies.now().getTime();
  let lastMessageAt: number | null = null;
  const runs: WatchRun[] = [];
  log(`watch: ${triggerLabel} in ${state.room_id} as ${me}, from sequence ${cursor}\n`);

  for (;;) {
    const now = dependencies.now().getTime();
    let budgetMs = WAIT_MAX_SECONDS * 1000;
    if (trigger.kind === "every") budgetMs = trigger.ms - (now - lastRunAt);
    if (trigger.kind === "idle" && lastMessageAt !== null) budgetMs = trigger.ms - (now - lastMessageAt);
    const timeout = Math.min(WAIT_MAX_SECONDS, Math.max(0, Math.ceil(budgetMs / 1000)));
    const page = await waitPage(client, state.room_id, credential.member_token, cursor, timeout);
    cursor = highestSequence(page.items, cursor);
    const others = page.items.filter((item) => item.sender?.member_id !== me && item.sender?.member_id !== state.member_id);
    if (others.length > 0) {
      batch.push(...others);
      lastMessageAt = dependencies.now().getTime();
    }

    const at = dependencies.now().getTime();
    const fire =
      trigger.kind === "message"
        ? batch.length > 0
        : trigger.kind === "count"
          ? batch.length >= trigger.count
          : trigger.kind === "idle"
            ? batch.length > 0 && lastMessageAt !== null && at - lastMessageAt >= trigger.ms
            : at - lastRunAt >= trigger.ms;
    if (!fire) {
      if (page.items.length === 0) await sleep(0);
      continue;
    }

    const input = `${JSON.stringify({ room_id: state.room_id, member_id: state.member_id, trigger: triggerLabel, messages: batch })}\n`;
    const result = await exec(command, input, {
      SHAREDNET_ROOM_ID: state.room_id,
      SHAREDNET_MEMBER_ID: state.member_id,
      SHAREDNET_MESSAGE_COUNT: String(batch.length),
      SHAREDNET_LAST_SEQUENCE: String(cursor),
    });
    if (result.stderr) log(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    // Handed over: the batch counts as seen even if the command failed.
    await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: cursor });
    let replyMessageId: string | null = null;
    const answer = result.stdout.trim();
    if (reply && result.exitCode === 0 && answer.length > 0) {
      const posted = await client.request<{ message?: { id?: string } }>(
        "POST",
        `/rooms/${encodeURIComponent(state.room_id)}/messages`,
        credential.member_token,
        { content: answer },
        { "idempotency-key": randomUUID() },
      );
      replyMessageId = posted?.message?.id ?? null;
    }
    const record: WatchRun = {
      run: runs.length + 1,
      trigger: triggerLabel,
      messages: batch.length,
      exit_code: result.exitCode,
      reply_message_id: replyMessageId,
      last_sequence: cursor,
    };
    runs.push(record);
    log(
      `watch: run ${record.run}, ${record.messages} message(s), exit ${record.exit_code}` +
        (replyMessageId ? `, replied ${replyMessageId}` : "") +
        "\n",
    );
    batch = [];
    lastRunAt = dependencies.now().getTime();
    if (maxRuns !== null && runs.length >= maxRuns) {
      return { room_id: state.room_id, trigger: triggerLabel, runs };
    }
  }
}

function parseTimeout(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) {
    throw localError("invalid_timeout", "--timeout must be a whole number of seconds.");
  }
  return Number(value);
}

/**
 * Sit in the Room until something new is said, then print it and advance the
 * cursor. `--timeout N` bounds the sit in seconds (0 checks once and returns);
 * `--hook` is the shape a Claude Code hook wants: one immediate check, plain
 * lines, exit 0 whether or not anything arrived.
 */
async function wait(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["timeout", "hook", "min"]);
  if (parsed.positionals.length !== 0) {
    throw localError("invalid_arguments", "Usage: sharednet wait [--timeout <seconds>] [--min <count>] [--hook]");
  }
  const hook = parsed.options.get("hook") === true;
  const totalSeconds = hook ? 0 : parseTimeout(stringOption(parsed, "timeout"));
  const minimum = parseCount(stringOption(parsed, "min"), "--min") ?? 1;
  const { client, state, credential } = await currentSeat(dependencies);
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const deadline =
    totalSeconds === null ? null : dependencies.now().getTime() + totalSeconds * 1000;
  // --min N: keep sitting until N messages have arrived, or the deadline.
  const items: MessageShape[] = [];
  let cursor = state.last_sequence;
  for (;;) {
    const remaining =
      deadline === null
        ? WAIT_MAX_SECONDS
        : Math.max(0, Math.ceil((deadline - dependencies.now().getTime()) / 1000));
    const timeout = Math.min(WAIT_MAX_SECONDS, remaining);
    const page = await waitPage(client, state.room_id, credential.member_token, cursor, timeout);
    items.push(...page.items);
    cursor = highestSequence(page.items, cursor);
    if (items.length >= minimum) break;
    if (deadline !== null && dependencies.now().getTime() >= deadline) break;
    // The server answered at its cap; ask again from the cursor.
    await sleep(0);
  }
  const page: PageShape = { items, next_cursor: null, has_more: false };

  if (page.items.length > 0) {
    await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: cursor });
  }

  if (hook) {
    return {
      hook: true,
      lines: page.items.map(
        (item) => `#${item.sequence} ${item.sender?.name ?? item.sender?.member_id ?? "member"}: ${item.content}`,
      ),
    };
  }
  return page;
}

/**
 * Seat more Instances in this directory's Room, by id: public ones at once,
 * private ones by asking (decision 2026-09-06 reach, §3).
 */
async function add(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const ids = parsed.positionals;
  if (ids.length === 0 || ids.some((id) => !/^i_[0-9A-Za-z]{10}$/.test(id))) {
    throw localError("invalid_arguments", "Usage: sharednet add <i_…> [<i_…> …]");
  }
  const { client, state, credential } = await currentSeat(dependencies);
  return client.request(
    "POST",
    `/rooms/${encodeURIComponent(state.room_id)}/members`,
    credential.member_token,
    { with: ids },
  );
}

/** `sharednet reach private|public`: whether strangers who know this seat's id must ask first. */
async function reach(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const value = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || (value !== "public" && value !== "private")) {
    throw localError("invalid_arguments", "Usage: sharednet reach public|private");
  }
  const { client, credential } = await currentSeat(dependencies);
  return client.request("PATCH", "/instances/current", credential.member_token, { reach: value });
}

/** The Rooms this seat sits in, newest first; where a seat that was added finds its new Room. */
async function rooms(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet rooms");
  const { client, credential } = await currentSeat(dependencies);
  return client.request("GET", "/rooms", credential.member_token);
}

/** Requests waiting on this seat: someone wants it in a Room while it is private. */
async function requests(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet requests");
  const { client, credential } = await currentSeat(dependencies);
  return client.request("GET", "/decisions?status=pending", credential.member_token);
}

/** The seat answers for itself: accept takes the seat, deny refuses it. */
async function answer(
  resolution: "approved" | "denied",
  args: string[],
  dependencies: GuestDependencies,
): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const decisionId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !decisionId || !/^dec_[0-9A-Za-z]{10}$/.test(decisionId)) {
    const verb = resolution === "approved" ? "accept" : "deny";
    throw localError("invalid_arguments", `Usage: sharednet ${verb} <dec_…>`);
  }
  const { client, credential } = await currentSeat(dependencies);
  return client.request(
    "POST",
    `/decisions/${encodeURIComponent(decisionId)}/resolve`,
    credential.member_token,
    { resolution },
  );
}

export type GuestVerb =
  | "join"
  | "say"
  | "wait"
  | "watch"
  | "add"
  | "rooms"
  | "requests"
  | "accept"
  | "deny"
  | "reach";

export function isGuestVerb(value: string | undefined): value is GuestVerb {
  return (
    value === "join" ||
    value === "say" ||
    value === "wait" ||
    value === "watch" ||
    value === "add" ||
    value === "rooms" ||
    value === "requests" ||
    value === "accept" ||
    value === "deny" ||
    value === "reach"
  );
}

export async function runGuestVerb(
  verb: GuestVerb,
  args: string[],
  dependencies: GuestDependencies,
): Promise<unknown> {
  if (verb === "join") return join(args, dependencies);
  if (verb === "say") return say(args, dependencies);
  if (verb === "watch") return watch(args, dependencies);
  if (verb === "add") return add(args, dependencies);
  if (verb === "rooms") return rooms(args, dependencies);
  if (verb === "requests") return requests(args, dependencies);
  if (verb === "accept") return answer("approved", args, dependencies);
  if (verb === "deny") return answer("denied", args, dependencies);
  if (verb === "reach") return reach(args, dependencies);
  return wait(args, dependencies);
}
