import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createSharedNetDevServer } from "../packages/server/src/dev-server.ts";
import { MemorySharedNetRepository } from "../packages/server/src/memory-repository.ts";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliRoot = join(repoRoot, "packages", "cli");
const scratch = await mkdtemp(join(tmpdir(), "sharednet-cli-package-"));
// The same rehearsal checks a local build before release and the registry
// artifact afterward: pnpm run test:package:cli --package sharednet@<version>.
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--package"), "usage: cli-package-smoke.mjs [--package <package-spec>]");
const packageSpec = args[1];
const npmEnv = {
  ...process.env,
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_USERCONFIG: join(scratch, "empty-npmrc"),
  NPM_CONFIG_CACHE: join(scratch, "npm-cache"),
};
let server;

try {
  const packed = await execFileAsync(
    "npm",
    ["pack", ...(packageSpec ? [packageSpec] : []), "--json", "--pack-destination", scratch],
    { cwd: cliRoot, env: npmEnv },
  );
  const manifest = JSON.parse(packed.stdout);
  assert.equal(manifest.length, 1, "npm pack must produce exactly one tarball");
  assert.equal(manifest[0].name, "sharednet", "tarball must use the public package name");

  const packageFiles = new Set(manifest[0].files.map((file) => file.path));
  assert(packageFiles.has("bin/sharednet.js"), "tarball must contain the executable");
  assert(packageFiles.has("dist/main.js"), "tarball must contain compiled runtime JavaScript");
  assert(
    [...packageFiles].every(
      (path) => !path.endsWith(".ts") || path.endsWith(".d.ts"),
    ),
    "tarball must not depend on Node loading TypeScript source",
  );
  assert(
    [...packageFiles].every((path) => !path.includes(".test.")),
    "tarball must not contain test files",
  );

  const consumerRoot = join(scratch, "consumer");
  await mkdir(consumerRoot);
  const tarball = join(scratch, manifest[0].filename);
  await execFileAsync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      tarball,
    ],
    { cwd: consumerRoot, env: npmEnv },
  );

  const installedBin = join(
    consumerRoot,
    "node_modules",
    "sharednet",
    "bin",
    "sharednet.js",
  );
  let invocation;
  try {
    await execFileAsync(
      process.execPath,
      ["--no-experimental-strip-types", installedBin, "--json"],
      { cwd: consumerRoot, env: npmEnv },
    );
    assert.fail("an empty command must return the documented CLI usage error");
  } catch (error) {
    invocation = error;
  }

  assert.equal(invocation.code, 2, "installed CLI must run and return its usage exit code");
  assert.equal(invocation.stdout, "", "usage failure must not write to stdout");
  const errorEnvelope = JSON.parse(invocation.stderr);
  assert.equal(errorEnvelope.error.code, "unknown_command");
  assert(!invocation.stderr.includes("ERR_UNKNOWN_FILE_EXTENSION"));

  // The command the join page writes must be one the installed CLI accepts.
  // It cannot redeem the claim (the base URL below answers nothing), but the
  // failure has to come from the network, never from the argument parser:
  // an option the parser refuses would mean the site hands out commands the
  // registry's CLI cannot run.
  let joinAttempt;
  try {
    await execFileAsync(
      process.execPath,
      [
        "--no-experimental-strip-types",
        installedBin,
        "join",
        "ROOM=rom_AbCdEfGhIj TOKEN=rit_" + "t".repeat(43) + " BASE=http://127.0.0.1:9",
        "--claim",
        "clp_" + "c".repeat(43),
        "--json",
      ],
      { cwd: consumerRoot, env: { ...npmEnv, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_STATE_HOME: join(scratch, "state") } },
    );
    assert.fail("a join against a dead base URL must fail");
  } catch (error) {
    joinAttempt = error;
  }
  const joinError = JSON.parse(joinAttempt.stderr).error;
  assert.notEqual(joinError.code, "unknown_option", "installed CLI must accept the join page's --claim command");
  assert.notEqual(joinError.code, "invalid_arguments", "installed CLI must accept the join page's command shape");
  assert.equal(joinError.code, "service_unavailable", "the only thing wrong with the rehearsal command is the dead server");

  // Exercise the installed artifact against the real HTTP handler. A package
  // that predates retrieval must fail here even if the source tree is current.
  const repository = new MemorySharedNetRepository();
  const owner = await repository.mcpSeat("package-smoke-owner", { id: "package-smoke", label: "Package smoke" });
  const { room } = await repository.createRoom(owner.auth, { name: "Package retrieval" });
  const { token: invite } = await repository.createRoomInvite({ roomId: room.id, principalId: owner.principal.id });
  server = createSharedNetDevServer(repository);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const isolatedEnv = {
    ...Object.fromEntries(Object.entries(npmEnv).filter(([key]) => !/^(SHAREDNET|CLAUDE|CLAUDECODE|ANTHROPIC|CODEX|OPENCODE|OPENHANDS|GEMINI_CLI|CURSOR)/.test(key))),
    SHAREDNET_BASE_URL: baseUrl,
    CODEX_SESSION_ID: "package-smoke-reader",
    XDG_CONFIG_HOME: join(scratch, "retrieval-config"),
    XDG_STATE_HOME: join(scratch, "retrieval-state"),
  };
  const runInstalled = async (command) => {
    const output = await execFileAsync(process.execPath, ["--no-experimental-strip-types", installedBin, ...command, "--json"], {
      cwd: consumerRoot,
      env: isolatedEnv,
    });
    assert(!/sni_[A-Za-z0-9_-]{43}/.test(output.stdout + output.stderr), "installed CLI must not expose its member credential");
    return JSON.parse(output.stdout);
  };
  await runInstalled(["join", `ROOM=${room.id} TOKEN=${invite} BASE=${baseUrl}`]);
  for (const content of ["cache owner: Ada", "release: tomorrow", "cache owner: Mira", "colour: blue"]) {
    await repository.postMessage(owner.auth, room.id, { content });
  }
  const latest = await runInstalled(["read", "--grep", "CACHE OWNER", "--from-instance", owner.instance.id, "--from-agent", "default", "--last", "2"]);
  assert.deepEqual(latest.items.map((message) => [message.sequence, message.content]), [[1, "cache owner: Ada"], [3, "cache owner: Mira"]], "latest matching messages must be selected then printed in log order");
  const earlier = await runInstalled(["read", "--grep", "cache owner", "--before", "3", "--order", "desc", "--limit", "1"]);
  assert.deepEqual(earlier.items.map((message) => message.sequence), [1], "before must page backward exclusively");
  const after = await runInstalled(["read", "--after", "2", "--limit", "10"]);
  assert.deepEqual(after.items.map((message) => message.sequence), [3, 4], "after must page forward exclusively");
  const unread = await runInstalled(["wait", "--timeout", "0"]);
  assert.deepEqual(unread.items.map((message) => message.sequence), [1, 2, 3, 4], "history lookups must not consume the wait cursor");

  // Native fetch and real HTTP are essential here: a mocked fetch accepts
  // Unicode headers and cannot expose an adapter that UTF-8-decodes raw bytes.
  const fileName = "研究报告.bin";
  const fileBytes = Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x0a, 0xfe]);
  const digest = createHash("sha256").update(fileBytes).digest("hex");
  await writeFile(join(consumerRoot, fileName), fileBytes);
  const uploaded = await runInstalled(["upload", fileName]);
  assert.equal(uploaded.artifact.filename, fileName);
  assert.equal(uploaded.artifact.size_bytes, fileBytes.length);
  assert.equal(uploaded.artifact.sha256, digest);
  // One kind of file: the same upload is readable by id, as the seat, and by
  // its link, as nobody at all.
  const downloaded = await runInstalled(["download", uploaded.artifact.id, "--out", "room-copy.bin"]);
  assert.equal(downloaded.verified, true);
  assert.deepEqual(await readFile(join(consumerRoot, "room-copy.bin")), fileBytes);
  assert.match(uploaded.url, /\/f\/art_[0-9A-Za-z]{10}\?k=afk_[A-Za-z0-9_-]{43}$/, "every upload answers with its link");
  const linkDownload = await runInstalled(["download", uploaded.url, "--out", "link-copy.bin"]);
  assert.equal(linkDownload.verified, true);
  assert.deepEqual(await readFile(join(consumerRoot, "link-copy.bin")), fileBytes);

  process.stdout.write(
    "CLI package smoke passed (" +
      manifest[0].filename +
      ", " +
      packageFiles.size +
      " files; installed retrieval, wait and Unicode binary files verified over HTTP).\n",
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(scratch, { recursive: true, force: true });
}
