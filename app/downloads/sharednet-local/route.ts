import "server-only";

import { createHash } from "node:crypto";
import { constants, promises as fileSystem } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

const ARCHIVE_NAME = "sharednet-local-darwin-arm64.tar.gz";
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 512;
const FILE_CHUNK_BYTES = 64 * 1024;
const READ_ONLY_NO_FOLLOW_NONBLOCKING =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
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

interface VerifiedSnapshot {
  readonly bytes: Uint8Array;
  readonly digest: Buffer;
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

async function readVerifiedSnapshot(
  path: string,
  maximumBytes: number,
): Promise<VerifiedSnapshot> {
  const handle: FileHandle = await fileSystem.open(
    path,
    READ_ONLY_NO_FOLLOW_NONBLOCKING,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > maximumBytes
    ) {
      throw new Error("SharedNet Local bundle file is invalid");
    }

    const bytes = new Uint8Array(before.size);
    const hash = createHash("sha256");
    let position = 0;
    while (position < bytes.byteLength) {
      const length = Math.min(FILE_CHUNK_BYTES, bytes.byteLength - position);
      const { bytesRead } = await handle.read(
        bytes,
        position,
        length,
        position,
      );
      if (bytesRead === 0) {
        throw new Error("SharedNet Local bundle ended while reading");
      }
      hash.update(bytes.subarray(position, position + bytesRead));
      position += bytesRead;
    }

    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("SharedNet Local bundle changed while reading");
    }
    return { bytes, digest: hash.digest() };
  } finally {
    await handle.close();
  }
}

function streamSnapshot(
  snapshot: Uint8Array,
): ReadableStream<Uint8Array> {
  let position = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position >= snapshot.byteLength) {
        controller.close();
        return;
      }

      const end = Math.min(position + FILE_CHUNK_BYTES, snapshot.byteLength);
      controller.enqueue(snapshot.subarray(position, end));
      position = end;
      if (position === snapshot.byteLength) {
        controller.close();
      }
    },
  });
}

export async function GET(_request: Request): Promise<Response> {
  try {
    const archivePath = configuredArchivePath();
    const sidecarPath = `${archivePath}.sha256`;
    const sidecar = await readVerifiedSnapshot(sidecarPath, MAX_SIDECAR_BYTES);
    const match = SIDECAR_PATTERN.exec(
      Buffer.from(
        sidecar.bytes.buffer,
        sidecar.bytes.byteOffset,
        sidecar.bytes.byteLength,
      ).toString("utf8"),
    );
    if (!match) {
      throw new Error("SharedNet Local checksum sidecar is invalid");
    }

    const archive = await readVerifiedSnapshot(archivePath, MAX_ARCHIVE_BYTES);
    if (archive.digest.toString("hex") !== match[1].toLowerCase()) {
      throw new Error("SharedNet Local bundle checksum does not match");
    }

    return new Response(streamSnapshot(archive.bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${ARCHIVE_NAME}"`,
        "Content-Length": String(archive.bytes.byteLength),
        "Content-Type": "application/gzip",
        Digest: `sha-256=${archive.digest.toString("base64")}`,
      },
    });
  } catch {
    return unavailableResponse();
  }
}
