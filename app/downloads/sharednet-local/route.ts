import "server-only";

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

const ARCHIVE_NAME = "sharednet-local-darwin-arm64.tar.gz";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 512;
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

async function readRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error("SharedNet Local bundle file is invalid");
  }

  const contents = await readFile(path);
  if (
    contents.byteLength > maximumBytes ||
    contents.byteLength !== metadata.size
  ) {
    throw new Error("SharedNet Local bundle file changed while reading");
  }
  return contents;
}

export async function GET(_request: Request): Promise<Response> {
  try {
    const archivePath = configuredArchivePath();
    const sidecarPath = `${archivePath}.sha256`;
    const sidecar = await readRegularFile(sidecarPath, MAX_SIDECAR_BYTES);
    const match = SIDECAR_PATTERN.exec(sidecar.toString("utf8"));
    if (!match) {
      throw new Error("SharedNet Local checksum sidecar is invalid");
    }

    const archive = await readRegularFile(archivePath, MAX_ARCHIVE_BYTES);
    const digest = createHash("sha256").update(archive).digest();
    if (digest.toString("hex") !== match[1].toLowerCase()) {
      throw new Error("SharedNet Local bundle checksum does not match");
    }

    return new Response(new Uint8Array(archive), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${ARCHIVE_NAME}"`,
        "Content-Type": "application/gzip",
        Digest: `sha-256=${digest.toString("base64")}`,
      },
    });
  } catch {
    return unavailableResponse();
  }
}
