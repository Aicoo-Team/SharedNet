import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageContent } from "./message-content";
import { parseArtifactLink } from "./artifact-link";

const ORIGIN = "http://localhost:3000";
const ARTIFACT = "art_hhlcs88aXE";
const KEY = `afk_${"P".repeat(43)}`;
const LINK = `${ORIGIN}/f/${ARTIFACT}?k=${KEY}`;

function headOf(headers: Record<string, string>) {
  return vi.fn(async () => new Response(null, { status: 200, headers }));
}

describe("a file pasted into a Room", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", headOf({ "content-disposition": "attachment; filename*=UTF-8''%E6%91%98%E8%A6%81.pdf", "content-length": "20480" }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("recognises only this origin's file links", () => {
    expect(parseArtifactLink(LINK, ORIGIN)).toEqual({ artifactId: ARTIFACT });
    for (const notOurs of [
      `https://elsewhere.example/f/${ARTIFACT}?k=${KEY}`,
      `${ORIGIN}/f/${ARTIFACT}`,
      `${ORIGIN}/f/${ARTIFACT}?k=nonsense`,
      `${ORIGIN}/s/shr_${"s".repeat(43)}`,
      "https://www.google.com",
      "not a url",
    ]) {
      expect(parseArtifactLink(notOurs, ORIGIN), notOurs).toBeNull();
    }
  });

  it("shows the file's name and size, and offers the two things anyone does with it", async () => {
    render(<MessageContent content={`摘要在这里：${LINK}`} />);

    // Until the name arrives the id stands in, so the card is never empty.
    const download = screen.getByRole("link", { name: /Download/ });
    expect(download).toHaveAttribute("href", LINK);
    expect(download).toHaveAttribute("download");

    await waitFor(() => expect(screen.getByText("摘要.pdf")).toBeVisible());
    expect(screen.getByText("20 KB")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy the link to 摘要.pdf" })).toBeVisible();
    // The 90-character URL is not in the sentence any more.
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("keeps the id, and stays usable, when the file will not say what it is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    render(<MessageContent content={LINK} />);

    await waitFor(() => expect(screen.getByText(ARTIFACT)).toBeVisible());
    expect(screen.getByRole("link", { name: `Download ${ARTIFACT}` })).toHaveAttribute("href", LINK);
    expect(screen.getByRole("button", { name: `Copy the link to ${ARTIFACT}` })).toBeVisible();
  });

  it("leaves an ordinary link alone", () => {
    render(<MessageContent content="see https://www.sharednet.ai/protocol for the rules" />);
    const link = screen.getByRole("link", { name: "https://www.sharednet.ai/protocol" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("button", { name: /Copy the link/ })).toBeNull();
  });
});
