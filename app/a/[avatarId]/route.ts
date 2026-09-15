import { eq } from "drizzle-orm";

import { getDatabase } from "@/packages/db/src/client.ts";
import { userAvatars } from "@/packages/db/src/schema.ts";
import { AVATAR_ID_PATTERN } from "@/packages/protocol/src/index.ts";

type AvatarRouteContext = { params: Promise<{ avatarId: string }> };

const NOT_FOUND = new Response("Not found", {
  status: 404,
  headers: { "cache-control": "public, max-age=60" },
});

/**
 * A person's picture, served from this origin so no page view reaches the
 * provider that supplied it. The id is opaque and is not the account's, so the
 * URL names nobody.
 *
 * This is the one route that serves stored bytes **inline** rather than as an
 * attachment, because an avatar has to render in an `<img>`. That is safe only
 * because of what is behind it: the bytes were recognised as PNG, JPEG or WebP
 * by their own signature before being stored, the column refuses any other
 * type, and SVG — the one image format that carries script — is not among
 * them. The headers say the same thing again, so a stored row that somehow
 * disagreed still could not become a page.
 */
export async function GET(_request: Request, { params }: AvatarRouteContext): Promise<Response> {
  const { avatarId } = await params;
  if (!AVATAR_ID_PATTERN.test(avatarId)) return NOT_FOUND.clone();

  const [row] = await getDatabase()
    .select({ bytes: userAvatars.bytes, contentType: userAvatars.contentType, sha256: userAvatars.sha256 })
    .from(userAvatars)
    .where(eq(userAvatars.avatarId, avatarId))
    .limit(1);
  if (!row) return NOT_FOUND.clone();

  return new Response(new Uint8Array(row.bytes) as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": row.contentType,
      "content-length": String(row.bytes.byteLength),
      // The picture at an id never changes: a new picture gets a new id.
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${row.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
