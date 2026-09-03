import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  promises as fsPromises,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "../../app/downloads/sharednet-local/route";

const ARCHIVE_NAME = "sharednet-local-darwin-arm64.tar.gz";
const ARCHIVE_BYTES = Buffer.from("sharednet-local-bundle");
const ARCHIVE_SHA256 =
  "e04571bca797b03329a08579362a878f2ef7d9f408df3cb4cdb53e2301800738";
const ARCHIVE_DIGEST = "sha-256=4EVxvKeXsDMpoIV5NiqHjy732fQI3zy0zbU+IwGABzg=";
const CHECKSUM_WRITER = resolve(
  process.cwd(),
  "scripts/write_bundle_checksum.sh",
);
const FIFO_SUPPORTED =
  typeof fsConstants.O_NONBLOCK === "number" &&
  (spawnSync("mkfifo", [], { stdio: "ignore" }).error as
    | NodeJS.ErrnoException
    | undefined)?.code !== "ENOENT";
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

function writeProducedSidecar(path = archivePath): void {
  execFileSync(CHECKSUM_WRITER, [path], { stdio: "pipe" });
}

function createPrivateProducedBundle(
  contents = ARCHIVE_BYTES,
): { archive: string; sidecar: string } {
  const privateDirectory = join(directory, "private-build");
  mkdirSync(privateDirectory, { recursive: true });
  const privateArchive = join(privateDirectory, ARCHIVE_NAME);
  writeFileSync(privateArchive, contents);
  writeProducedSidecar(privateArchive);
  return { archive: privateArchive, sidecar: `${privateArchive}.sha256` };
}

function publishProducedBundle(bundle: {
  archive: string;
  sidecar: string;
}): void {
  renameSync(bundle.archive, archivePath);
  renameSync(bundle.sidecar, sidecarPath);
}

async function injectOpenHandles(): Promise<{
  archiveHandle: FileHandle;
  sidecarHandle: FileHandle;
}> {
  const sidecarHandle = await fsPromises.open(sidecarPath, "r");
  const archiveHandle = await fsPromises.open(archivePath, "r");
  vi.spyOn(fsPromises, "open")
    .mockResolvedValueOnce(sidecarHandle)
    .mockResolvedValueOnce(archiveHandle);
  return { archiveHandle, sidecarHandle };
}

async function expectHandleClosed(handle: FileHandle): Promise<void> {
  await expect(handle.stat()).rejects.toThrow();
}

async function closeIfOpen(...handles: FileHandle[]): Promise<void> {
  for (const handle of handles) {
    try {
      await handle.close();
    } catch {
      // The route already closed this handle.
    }
  }
}

async function expectUnavailable(
  request = new Request("http://localhost/downloads/sharednet-local"),
): Promise<void> {
  const response = await GET(request);

  expect(response.status).toBe(503);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.text()).toBe(UNAVAILABLE_BODY);
}

async function expectFifoUnavailablePromptly(fifoPath: string): Promise<void> {
  let writerDescriptor: number | undefined;
  const unblockTimer = setTimeout(() => {
    try {
      writerDescriptor = openSync(
        fifoPath,
        fsConstants.O_WRONLY | fsConstants.O_NONBLOCK,
      );
      closeSync(writerDescriptor);
      writerDescriptor = undefined;
    } catch {
      // A nonblocking route has already closed the FIFO before this fallback.
    }
  }, 500);
  const startedAt = performance.now();

  try {
    await expectUnavailable();
    expect(performance.now() - startedAt).toBeLessThan(300);
  } finally {
    clearTimeout(unblockTimer);
    if (writerDescriptor !== undefined) {
      closeSync(writerDescriptor);
    }
  }
}

describe("GET /downloads/sharednet-local", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "sharednet-local-download-"));
    archivePath = join(directory, ARCHIVE_NAME);
    sidecarPath = `${archivePath}.sha256`;
    vi.stubEnv("SHAREDNET_LOCAL_BUNDLE_PATH", archivePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { force: true, recursive: true });
  });

  it("writes the canonical checksum sidecar for the fixed archive basename", () => {
    const bundle = createPrivateProducedBundle();

    expect(readFileSync(bundle.sidecar, "utf8")).toBe(
      `${ARCHIVE_SHA256}  ${ARCHIVE_NAME}\n`,
    );
  });

  it("refuses to write a checksum for any other archive basename", () => {
    const wrongArchive = join(directory, "sharednet-local-other.tar.gz");
    writeFileSync(wrongArchive, ARCHIVE_BYTES);

    expect(() => writeProducedSidecar(wrongArchive)).toThrow();
    expect(existsSync(`${wrongArchive}.sha256`)).toBe(false);
  });

  it("streams a privately produced snapshot after closing both handles", async () => {
    publishProducedBundle(createPrivateProducedBundle());
    const { archiveHandle, sidecarHandle } = await injectOpenHandles();

    try {
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
      await expectHandleClosed(sidecarHandle);
      await expectHandleClosed(archiveHandle);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(ARCHIVE_BYTES);
    } finally {
      await closeIfOpen(sidecarHandle, archiveHandle);
    }
  });

  it("accepts an uppercase checksum entry", async () => {
    writeAvailableBundle(`${ARCHIVE_SHA256.toUpperCase()}  ${ARCHIVE_NAME}\n`);

    const response = await GET(
      new Request("http://localhost/downloads/sharednet-local"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("digest")).toBe(ARCHIVE_DIGEST);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ARCHIVE_BYTES);
  });

  it("streams fixed-size views from one snapshot after filesystem closure", async () => {
    writeFileSync(archivePath, Buffer.alloc(1024 * 1024, 0x61));
    writeProducedSidecar();
    const { archiveHandle, sidecarHandle } = await injectOpenHandles();

    try {
      const response = await GET(
        new Request("http://localhost/downloads/sharednet-local"),
      );

      expect(response.status).toBe(200);
      await expectHandleClosed(sidecarHandle);
      await expectHandleClosed(archiveHandle);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      const second = await reader!.read();
      expect(first.done).toBe(false);
      expect(second.done).toBe(false);
      expect(second.value?.buffer).toBe(first.value?.buffer);
      await reader!.cancel("test cancellation");
    } finally {
      await closeIfOpen(sidecarHandle, archiveHandle);
    }
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

  it.skipIf(!FIFO_SUPPORTED)(
    "rejects a FIFO archive without blocking",
    async () => {
      execFileSync("mkfifo", [archivePath]);
      writeSidecar();

      await expectFifoUnavailablePromptly(archivePath);
    },
  );

  it.skipIf(!FIFO_SUPPORTED)(
    "rejects a FIFO checksum sidecar without blocking",
    async () => {
      writeArchive();
      execFileSync("mkfifo", [sidecarPath]);

      await expectFifoUnavailablePromptly(sidecarPath);
    },
  );

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

  it("returns the safe unavailable response when opening a leaf fails", async () => {
    writeAvailableBundle();
    vi.spyOn(fsPromises, "open").mockRejectedValueOnce(
      new Error("injected open failure"),
    );

    await expectUnavailable();
  });

  it("closes the sidecar handle when its read fails before headers", async () => {
    writeAvailableBundle();
    const sidecarHandle = await fsPromises.open(sidecarPath, "r");
    vi.spyOn(sidecarHandle, "read").mockRejectedValueOnce(
      new Error("injected sidecar read failure"),
    );
    vi.spyOn(fsPromises, "open").mockResolvedValueOnce(sidecarHandle);

    try {
      await expectUnavailable();
      await expectHandleClosed(sidecarHandle);
    } finally {
      await closeIfOpen(sidecarHandle);
    }
  });

  it("closes both handles when archive hashing fails before headers", async () => {
    writeAvailableBundle();
    const { archiveHandle, sidecarHandle } = await injectOpenHandles();
    vi.spyOn(archiveHandle, "read").mockRejectedValueOnce(
      new Error("injected archive read failure"),
    );

    try {
      await expectUnavailable();
      await expectHandleClosed(sidecarHandle);
      await expectHandleClosed(archiveHandle);
    } finally {
      await closeIfOpen(sidecarHandle, archiveHandle);
    }
  });
});
