import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliRoot = join(repoRoot, "packages", "cli");
const scratch = await mkdtemp(join(tmpdir(), "sharednet-cli-package-"));
const npmEnv = {
  ...process.env,
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_USERCONFIG: join(scratch, "empty-npmrc"),
};

try {
  const packed = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", scratch],
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

  process.stdout.write(
    "CLI package smoke passed (" +
      manifest[0].filename +
      ", " +
      packageFiles.size +
      " files).\n",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
