// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows } = vi.hoisted(() => ({ rows: { value: [] as Array<Record<string, unknown>> } }));

vi.mock("@/packages/db/src/client.ts", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => rows.value }),
      }),
    }),
  }),
}));

import { GET } from "../../app/a/[avatarId]/route";

const AVATAR_ID = "ava_AbCdEfGhIj";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function request(id: string) {
  return GET(new Request(`https://www.sharednet.ai/a/${id}`), { params: Promise.resolve({ avatarId: id }) });
}

describe("a stored avatar, served from this origin", () => {
  beforeEach(() => {
    rows.value = [{ bytes: PNG, contentType: "image/png", sha256: "a".repeat(64) }];
  });

  it("renders inline, as the one type it was stored as, and says so twice", async () => {
    const response = await request(AVATAR_ID);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get("content-type")).toBe("image/png");
    // Inline is only safe because of these: the bytes were recognised before
    // being stored, the column allows three raster types, and the headers
    // refuse to let a page happen even if a row somehow disagreed.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-disposition")).toBeNull();
    // A picture at an id never changes, so it can be cached for good.
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
  });

  it("is not found when the id is not one, and when nobody has that picture", async () => {
    for (const notAnId of ["ava_short", "art_AbCdEfGhIj", "../../etc/passwd", ""]) {
      expect((await request(notAnId)).status, notAnId).toBe(404);
    }
    rows.value = [];
    expect((await request(AVATAR_ID)).status).toBe(404);
  });
});
