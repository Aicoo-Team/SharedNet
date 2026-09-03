import "server-only";

import { createHash } from "node:crypto";
import { constants, promises as fileSystem } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

const ARCHIVE_NAME = "sharednet-local-darwin-arm64.tar.gz";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 512;
const FILE_CHUNK_BYTES = 64 * 1024;
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const SIDECAR_PATTERN = new RegExp(
  `^([0-9a-fA-F]{64})[ \\t]+${ARCHIVE_NAME.replaceAll(".", "\\.")}(?:\\r?\\n)?$`,
);
const UNAVAILABLE_BODY = {
  error: {
    code: "bundle_unavailable",
    message: "SharedNet Local is not available.",
  },
};

export const runtime = "nodejs";

interface OpenRegularFile {
  readonly ctimeMs: number;
  readonly handle: FileHandle;
  readonly mtimeMs: number;
  readonly size: number;
}

function unavailableResponse(): Response {
  return Response.json(UNAVAILABLE_BODY, {
    headers: { "Cache-Control": "private, no-store" },
    status: 503,
  });
}

function configuredArchivePath(): string {
  const archivePath = process.env.SHAREDNET_LOCAL_BUNDLE_PATH;
  if (
    !archivePath ||
    !isAbsolute(archivePath) ||
    basename(archivePath) !== ARCHIVE_NAME
  ) {
    throw new Error("SharedNet Local bundle configuration is invalid");
  }
  return archivePath;
}

async function closeIgnoringErrors(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Preserve the original validation or I/O failure.
  }
}

async function openRegularFile(
  path: string,
  maximumBytes: number,
): Promise<OpenRegularFile> {
  const handle = await fileSystem.open(path, READ_ONLY_NO_FOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > maximumBytes
    ) {
      throw new Error("SharedNet Local bundle file is invalid");
    }
    return {
      ctimeMs: metadata.ctimeMs,
      handle,
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
    };
  } catch (error) {
    await closeIgnoringErrors(handle);
    throw error;
  }
}

async function readChecksumSidecar(path: string): Promise<string> {
  const sidecar = await openRegularFile(path, MAX_SIDECAR_BYTES);
  try {
    const contents = await sidecar.handle.readFile();
    if (contents.byteLength !== sidecar.size) {
      throw new Error("SharedNet Local checksum sidecar changed while reading");
    }
    return contents.toString("utf8");
  } finally {
    await sidecar.handle.close();
  }
}

async function hashArchive(archive: OpenRegularFile): Promise<Buffer> {
  const hash = createHash("sha256");
  let position = 0;

  while (position < archive.size) {
    const chunk = Buffer.allocUnsafe(
      Math.min(FILE_CHUNK_BYTES, archive.size - position),
    );
    const { bytesRead } = await archive.handle.read(
      chunk,
      0,
      chunk.byteLength,
      position,
    );
    if (bytesRead === 0) {
      throw new Error("SharedNet Local bundle ended while hashing");
    }
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }

  const metadata = await archive.handle.stat();
  if (
    !metadata.isFile() ||
    metadata.size !== archive.size ||
    metadata.mtimeMs !== archive.mtimeMs ||
    metadata.ctimeMs !== archive.ctimeMs
  ) {
    throw new Error("SharedNet Local bundle changed while hashing");
  }
  return hash.digest();
}

function streamArchive(
  handle: FileHandle,
  size: number,
): ReadableStream<Uint8Array> {
  let closePromise: Promise<void> | undefined;
  let position = 0;

  function closeOnce(): Promise<void> {
    closePromise ??= handle.close();
    return closePromise;
  }

  return new ReadableStream<Uint8Array>({
    async cancel() {
      await closeOnce();
    },
    async pull(controller) {
      try {
        if (position >= size) {
          await closeOnce();
          controller.close();
          return;
        }

        const chunk = new Uint8Array(
          Math.min(FILE_CHUNK_BYTES, size - position),
        );
        const { bytesRead } = await handle.read(
          chunk,
          0,
          chunk.byteLength,
          position,
        );
        if (bytesRead === 0) {
          throw new Error("SharedNet Local bundle ended while streaming");
        }
        position += bytesRead;
        controller.enqueue(
          bytesRead === chunk.byteLength ? chunk : chunk.slice(0, bytesRead),
        );

        if (position === size) {
          await closeOnce();
          controller.close();
        }
      } catch (error) {
        await closeIgnoringErrors(handle);
        controller.error(error);
      }
    },
  });
}

export async function GET(_request: Request): Promise<Response> {
  let archiveHandle: FileHandle | undefined;
  try {
    const archivePath = configuredArchivePath();
    const sidecarPath = `${archivePath}.sha256`;
    const sidecar = await readChecksumSidecar(sidecarPath);
    const match = SIDECAR_PATTERN.exec(sidecar);
    if (!match) {
      throw new Error("SharedNet Local checksum sidecar is invalid");
    }

    const archive = await openRegularFile(archivePath, MAX_ARCHIVE_BYTES);
    archiveHandle = archive.handle;
    const digest = await hashArchive(archive);
    if (digest.toString("hex") !== match[1].toLowerCase()) {
      throw new Error("SharedNet Local bundle checksum does not match");
    }

    const body = streamArchive(archive.handle, archive.size);
    const response = new Response(body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${ARCHIVE_NAME}"`,
        "Content-Length": String(archive.size),
        "Content-Type": "application/gzip",
        Digest: `sha-256=${digest.toString("base64")}`,
      },
    });
    archiveHandle = undefined;
    return response;
  } catch {
    if (archiveHandle) {
      await closeIgnoringErrors(archiveHandle);
    }
    return unavailableResponse();
  }
}
