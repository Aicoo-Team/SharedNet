import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "../../app/downloads/sharednet-local/route";

const ARCHIVE_NAME = "sharednet-local-darwin-arm64.tar.gz";
const ARCHIVE_BYTES = Buffer.from("sharednet-local-bundle");
const ARCHIVE_SHA256 =
  "e04571bca797b03329a08579362a878f2ef7d9f408df3cb4cdb53e2301800738";
const ARCHIVE_DIGEST = "sha-256=4EVxvKeXsDMpoIV5NiqHjy732fQI3zy0zbU+IwGABzg=";
const UNAVAILABLE_BODY =
  '{"error":{"code":"bundle_unavailable","message":"SharedNet Local is not available."}}';

let directory: string;
let archivePath: string;
let sidecarPath: string;

function writeArchive(): void {
  writeFileSync(archivePath, ARCHIVE_BYTES);
}

function writeSidecar(
  contents = `${ARCHIVE_SHA256}  ${ARCHIVE_NAME}\n`,
): void {
  writeFileSync(sidecarPath, contents);
}

function writeAvailableBundle(
  contents = `${ARCHIVE_SHA256}  ${ARCHIVE_NAME}\n`,
): void {
  writeArchive();
  writeSidecar(contents);
}

async function expectUnavailable(
  request = new Request("http://localhost/downloads/sharednet-local"),
): Promise<void> {
  const response = await GET(request);

  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.text()).toBe(UNAVAILABLE_BODY);
}

describe("GET /downloads/sharednet-local", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "sharednet-local-download-"));
    archivePath = join(directory, ARCHIVE_NAME);
    sidecarPath = `${archivePath}.sha256`;
    vi.stubEnv("SHAREDNET_LOCAL_BUNDLE_PATH", archivePath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { force: true, recursive: true });
  });

  it("serves the verified archive bytes with fixed private download metadata", async () => {
    writeAvailableBundle(`${ARCHIVE_SHA256.toUpperCase()}  ${ARCHIVE_NAME}\n`);

    const response = await GET(
      new Request(
        "http://localhost/downloads/sharednet-local?path=/etc/passwd&filename=forged.tar.gz",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${ARCHIVE_NAME}"`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("digest")).toBe(ARCHIVE_DIGEST);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ARCHIVE_BYTES);
  });

  it("rejects a missing server-only path even when a caller supplies one", async () => {
    writeAvailableBundle();
    delete process.env.SHAREDNET_LOCAL_BUNDLE_PATH;

    await expectUnavailable(
      new Request(
        `http://localhost/downloads/sharednet-local?path=${encodeURIComponent(archivePath)}`,
      ),
    );
  });

  it.each([
    ["blank", ""],
    ["relative", ARCHIVE_NAME],
    ["wrong filename", join(tmpdir(), "sharednet-local-other.tar.gz")],
  ])("rejects a %s configured path", async (_name, configuredPath) => {
    vi.stubEnv("SHAREDNET_LOCAL_BUNDLE_PATH", configuredPath);

    await expectUnavailable();
  });

  it("rejects a missing archive", async () => {
    writeSidecar();

    await expectUnavailable();
  });

  it("rejects a missing checksum sidecar", async () => {
    writeArchive();

    await expectUnavailable();
  });

  it("rejects an archive that is not a regular file", async () => {
    mkdirSync(archivePath);
    writeSidecar();

    await expectUnavailable();
  });

  it("rejects a checksum sidecar that is not a regular file", async () => {
    writeArchive();
    mkdirSync(sidecarPath);

    await expectUnavailable();
  });

  it("rejects a symlinked archive", async () => {
    const target = join(directory, "archive-target");
    writeFileSync(target, ARCHIVE_BYTES);
    symlinkSync(target, archivePath);
    writeSidecar();

    await expectUnavailable();
  });

  it("rejects a symlinked checksum sidecar", async () => {
    const target = join(directory, "sidecar-target");
    writeArchive();
    writeFileSync(target, `${ARCHIVE_SHA256}  ${ARCHIVE_NAME}\n`);
    symlinkSync(target, sidecarPath);

    await expectUnavailable();
  });

  it.each([
    ["a short hash", `abcd  ${ARCHIVE_NAME}\n`],
    ["a non-hex hash", `${"g".repeat(64)}  ${ARCHIVE_NAME}\n`],
    ["a traversal filename", `${ARCHIVE_SHA256}  ../${ARCHIVE_NAME}\n`],
    ["a different filename", `${ARCHIVE_SHA256}  other.tar.gz\n`],
    [
      "an absolute filename",
      `${ARCHIVE_SHA256}  /tmp/${ARCHIVE_NAME}\n`,
    ],
    [
      "an additional entry",
      `${ARCHIVE_SHA256}  ${ARCHIVE_NAME}\n${ARCHIVE_SHA256}  other.tar.gz\n`,
    ],
    ["trailing content", `${ARCHIVE_SHA256}  ${ARCHIVE_NAME} extra\n`],
  ])("rejects a checksum sidecar containing %s", async (_name, contents) => {
    writeAvailableBundle(contents);

    await expectUnavailable();
  });

  it("rejects a checksum that does not match the archive bytes", async () => {
    writeAvailableBundle(`${"0".repeat(64)}  ${ARCHIVE_NAME}\n`);

    await expectUnavailable();
  });

  it("returns the safe unavailable response when the archive read fails", async () => {
    writeAvailableBundle();
    chmodSync(archivePath, 0o000);

    try {
      await expectUnavailable();
    } finally {
      chmodSync(archivePath, 0o600);
    }
  });

  it("returns the safe unavailable response when the sidecar read fails", async () => {
    writeAvailableBundle();
    chmodSync(sidecarPath, 0o000);

    try {
      await expectUnavailable();
    } finally {
      chmodSync(sidecarPath, 0o600);
    }
  });
});
