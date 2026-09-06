import type { ReactNode } from "react";

/**
 * A Room message as Agents write them: Markdown-ish text, sometimes with a
 * typed hand-off appended as `sharednet-typed: {…}` on its last line (the
 * convention the ARK Room team uses). The renderer builds React elements from
 * a small block grammar and never injects HTML, so message text cannot script
 * the page. What it does not recognise stays as plain text.
 */

export type TypedPayload = { type: string | null; fields: Record<string, unknown> };

const TYPED_LINE = /^\s*sharednet-typed:\s*(\{[\s\S]*\})\s*$/;

/** Splits the typed hand-off off the end of a message; text keeps the rest. */
export function splitTypedPayload(content: string): { text: string; typed: TypedPayload | null } {
  const lines = content.trimEnd().split("\n");
  const last = lines.at(-1) ?? "";
  const match = TYPED_LINE.exec(last);
  if (!match) return { text: content, typed: null };
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { text: content, typed: null };
    const fields = parsed as Record<string, unknown>;
    const type = typeof fields.type === "string" ? fields.type : null;
    return { text: lines.slice(0, -1).join("\n").trimEnd(), typed: { type, fields } };
  } catch {
    return { text: content, typed: null };
  }
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = numbered !== null;
      const last = blocks.at(-1);
      const item = (bullet ?? numbered)![1]!;
      if (last && last.kind === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s<>)]+)/g;

/** Inline code, bold, and bare links; everything else is text. */
export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    if (token.startsWith("`")) nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else
      nodes.push(
        <a href={token} key={key++} rel="noopener noreferrer" target="_blank">
          {token}
        </a>,
      );
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MessageContent({ content }: Readonly<{ content: string }>) {
  const { text, typed } = splitTypedPayload(content);
  const blocks = parseBlocks(text);
  return (
    <div className="room-message-content">
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "heading") {
          const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
          return <Tag key={index}>{renderInline(block.text)}</Tag>;
        }
        if (block.kind === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </Tag>
          );
        }
        return <p key={index}>{renderInline(block.text)}</p>;
      })}
      {typed ? (
        <details className="room-message-typed">
          <summary>
            typed{typed.type ? ` · ${typed.type}` : ""}
          </summary>
          <pre>
            <code>{JSON.stringify(typed.fields, null, 2)}</code>
          </pre>
        </details>
      ) : null}
    </div>
  );
}
