import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MessageContent, parseBlocks, splitTypedPayload } from "./message-content";

afterEach(cleanup);

describe("message content", () => {
  it("splits a trailing sharednet-typed line off the text and keeps anything else whole", () => {
    const content = 'RAC optimization started. Budget=8.\n\nsharednet-typed: {"baseline_score":0.1,"type":"optimization.started"}';
    const { text, typed } = splitTypedPayload(content);
    expect(text).toBe("RAC optimization started. Budget=8.");
    expect(typed).toEqual({ type: "optimization.started", fields: { baseline_score: 0.1, type: "optimization.started" } });
    expect(splitTypedPayload("sharednet-typed: not json")).toEqual({ text: "sharednet-typed: not json", typed: null });
    expect(splitTypedPayload("plain").typed).toBeNull();
  });

  it("parses headings, lists, code fences, and paragraphs", () => {
    const blocks = parseBlocks("@planner hop 1\n\n## Objective\nImprove the packing.\n- first\n- second\n1. one\n2) two\n```\nx = 1\n```\n");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "@planner hop 1" },
      { kind: "heading", level: 2, text: "Objective" },
      { kind: "paragraph", text: "Improve the packing." },
      { kind: "list", ordered: false, items: ["first", "second"] },
      { kind: "list", ordered: true, items: ["one", "two"] },
      { kind: "code", text: "x = 1" },
    ]);
  });

  it("renders Markdown as elements and never as HTML, with the typed payload folded away", () => {
    render(
      <MessageContent content={'## Objective\nUse **bold** and `code`, see https://sharednet.ai/skills <img src=x onerror=alert(1)>\n\nsharednet-typed: {"type":"optimization.started","budget":8}'} />,
    );
    expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent("Objective");
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: "https://sharednet.ai/skills" })).toHaveAttribute("rel", "noopener noreferrer");
    // The img tag is text, not markup.
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeVisible();
    const typed = screen.getByText("typed · optimization.started");
    expect(typed.tagName).toBe("SUMMARY");
    expect(typed.closest("details")).toHaveTextContent('"budget": 8');
  });
});
