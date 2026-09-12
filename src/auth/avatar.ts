import { createHash } from "node:crypto";

import { generatePublicId } from "../../packages/protocol/src/index.ts";

/**
 * A person's picture, taken once at sign-in and kept here (decision
 * 2026-09-12). Google answers with a `googleusercontent.com` URL. Pointing an
 * `<img>` at it makes every page view a request to Google, the URL rotates
 * when Google decides, and on a network that cannot reach Google the person
 * simply has no face.
 */

/** Half a mebibyte. A profile picture that is larger is not a profile picture. */
export const MAX_AVATAR_BYTES = 512 * 1024;
/** Long enough for a slow CDN, short enough that sign-in never waits on it. */
export const AVATAR_FETCH_TIMEOUT_MS = 5_000;

/**
 * Where a picture may be fetched from. The URL arrives inside an OAuth profile
 * — data this server did not choose — so fetching whatever it names would be a
 * request forgery primitive pointed at our own network. Only the host the
 * provider actually serves pictures from is allowed.
 */
const ALLOWED_AVATAR_HOSTS = [/^([a-z0-9-]+\.)*googleusercontent\.com$/];

/**
 * The three raster types an `<img>` needs, each recognised by its own bytes
 * rather than by the `Content-Type` the far end claimed. SVG is deliberately
 * absent: it is a script container, and this is the one route on the origin
 * that serves somebody else's bytes inline.
 */
export type AvatarContentType = "image/png" | "image/jpeg" | "image/webp";

export function sniffAvatarType(bytes: Uint8Array): AvatarContentType | null {
  if (bytes.length < 12) return null;
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  const ascii = (offset: number, text: string) =>
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

export function isFetchableAvatarUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_AVATAR_HOSTS.some((host) => host.test(url.hostname));
}

export type FetchedAvatar = {
  avatarId: `ava_${string}`;
  bytes: Uint8Array;
  contentType: AvatarContentType;
  sha256: string;
  sizeBytes: number;
  sourceUrl: string;
};

/**
 * Fetches a picture, or answers null. Null is the whole error contract: a
 * refusal, a timeout, a file that is too large, and a file that is not one of
 * the three types are all "this person has no stored picture", because none of
 * them is worth failing a sign-in over.
 */
export async function fetchAvatar(
  sourceUrl: string,
  dependencies: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<FetchedAvatar | null> {
  if (!isFetchableAvatarUrl(sourceUrl)) return null;
  const doFetch = dependencies.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? AVATAR_FETCH_TIMEOUT_MS);
  try {
    const response = await doFetch(sourceUrl, { redirect: "follow", signal: controller.signal });
    if (!response.ok) return null;
    // The declared length is a hint, not a promise, so the body is measured too.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) return null;
    const contentType = sniffAvatarType(bytes);
    if (contentType === null) return null;
    return {
      avatarId: generatePublicId("ava"),
      bytes,
      contentType,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      sourceUrl,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
