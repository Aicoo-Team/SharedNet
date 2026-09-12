// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { fetchAvatar, isFetchableAvatarUrl, MAX_AVATAR_BYTES, sniffAvatarType } from "./avatar";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
const SVG = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
const GOOGLE = "https://lh3.googleusercontent.com/a/picture=s96-c";

function answer(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(bytes as unknown as BodyInit, { status: 200, headers }));
}

describe("a person's picture, taken once at sign-in", () => {
  it("only fetches from where the provider actually serves pictures", () => {
    expect(isFetchableAvatarUrl(GOOGLE)).toBe(true);
    expect(isFetchableAvatarUrl("https://googleusercontent.com/x")).toBe(true);
    // A URL arrives inside a profile this server did not write, so anything
    // else would make sign-in a request-forgery primitive aimed at our network.
    for (const hostile of [
      "http://lh3.googleusercontent.com/a",
      "https://evil.example/a.png",
      "https://googleusercontent.com.evil.example/a",
      "http://169.254.169.254/latest/meta-data/",
      "https://localhost/a.png",
      "file:///etc/passwd",
      "not a url",
      "",
      null,
      undefined,
    ]) {
      expect(isFetchableAvatarUrl(hostile as string), String(hostile)).toBe(false);
    }
  });

  it("recognises the three raster types by their own bytes, and nothing else", () => {
    expect(sniffAvatarType(PNG)).toBe("image/png");
    expect(sniffAvatarType(JPEG)).toBe("image/jpeg");
    expect(sniffAvatarType(WEBP)).toBe("image/webp");
    // SVG carries script, and this is the one thing served inline on the origin.
    expect(sniffAvatarType(SVG)).toBeNull();
    expect(sniffAvatarType(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("stores what it fetched, with a digest and an opaque id", async () => {
    const fetch = answer(PNG, { "content-type": "image/png" });
    const avatar = await fetchAvatar(GOOGLE, { fetch });

    expect(avatar).toMatchObject({ contentType: "image/png", sizeBytes: PNG.byteLength, sourceUrl: GOOGLE });
    expect(avatar!.avatarId).toMatch(/^ava_[0-9A-Za-z]{10}$/);
    expect(avatar!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetch).toHaveBeenCalledWith(GOOGLE, expect.objectContaining({ redirect: "follow" }));
  });

  it("believes the bytes, not the Content-Type the far end claimed", async () => {
    // An SVG announced as a PNG is still an SVG, and is refused.
    expect(await fetchAvatar(GOOGLE, { fetch: answer(SVG, { "content-type": "image/png" }) })).toBeNull();
    // A PNG announced as something odd is still a PNG, and is kept.
    expect(await fetchAvatar(GOOGLE, { fetch: answer(PNG, { "content-type": "application/octet-stream" }) })).toMatchObject({
      contentType: "image/png",
    });
  });

  it("answers null for everything that could go wrong, because none of it may fail a sign-up", async () => {
    const oversized = new Uint8Array(MAX_AVATAR_BYTES + 1);
    oversized.set(PNG);
    const cases: Array<[string, typeof globalThis.fetch]> = [
      ["a refusal", vi.fn(async () => new Response("no", { status: 403 }))],
      ["an empty body", answer(new Uint8Array())],
      ["a body over the cap", answer(oversized)],
      ["a declared length over the cap", answer(PNG, { "content-length": String(MAX_AVATAR_BYTES + 1) })],
      ["a connection that failed", vi.fn(async () => { throw new Error("ECONNREFUSED"); })],
      ["a host we do not fetch from", answer(PNG)],
    ];
    for (const [what, fetch] of cases) {
      const url = what === "a host we do not fetch from" ? "https://evil.example/a.png" : GOOGLE;
      expect(await fetchAvatar(url, { fetch }), what).toBeNull();
    }
  });

  it("gives up rather than making a sign-in wait", async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof globalThis.fetch;

    expect(await fetchAvatar(GOOGLE, { fetch, timeoutMs: 10 })).toBeNull();
  });
});
