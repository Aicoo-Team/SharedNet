"use client";

import { useEffect, useState } from "react";

/** A SharedNet file link: `/f/art_…?k=afk_…`, on this origin. */
const ARTIFACT_LINK = /^\/f\/(art_[0-9A-Za-z]{10})$/;

export function parseArtifactLink(href: string, origin: string): { artifactId: string } | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  // Only this origin: another deployment's link is somebody else's server, and
  // asking it about a file would be a cross-origin request the browser refuses
  // anyway. Such a link stays a plain link.
  if (url.origin !== origin) return null;
  const match = ARTIFACT_LINK.exec(url.pathname);
  if (!match || !/^afk_[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("k") ?? "")) return null;
  return { artifactId: match[1]! };
}

type Facts = { filename: string; sizeBytes: number | null } | null;

function readableSize(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file somebody pasted into the Room, drawn as the file it is: its name, its
 * size, and the two things anyone actually wants to do with it. The name comes
 * from a HEAD on the link itself — the link is the only credential, so a
 * reader who could not open the file cannot learn its name either.
 *
 * Until the name arrives, and if it never does, the card still works: it is a
 * link and a copy button either way.
 */
export function ArtifactLink({ artifactId, href }: Readonly<{ artifactId: string; href: string }>) {
  const [facts, setFacts] = useState<Facts>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(href, { method: "HEAD" });
        if (cancelled || !response.ok) return;
        const disposition = response.headers.get("content-disposition") ?? "";
        const named = /filename\*=UTF-8''([^;]+)/.exec(disposition);
        if (!named) return;
        const length = Number(response.headers.get("content-length"));
        setFacts({
          filename: decodeURIComponent(named[1]!),
          sizeBytes: Number.isFinite(length) && length > 0 ? length : null,
        });
      } catch {
        // A file that cannot be reached keeps its id as its name.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [href]);

  const size = readableSize(facts?.sizeBytes ?? null);

  return (
    <span className="artifact-link" data-named={facts ? "true" : undefined}>
      {/* The name says what it is; the label says what the click does. */}
      <a
        aria-label={`Download ${facts?.filename ?? artifactId}`}
        className="artifact-link-name"
        download
        href={href}
        title={facts?.filename ?? artifactId}
      >
        <span aria-hidden="true">📎</span>
        <strong>{facts?.filename ?? artifactId}</strong>
        {size ? <span className="artifact-link-size">{size}</span> : null}
      </a>
      <button
        aria-label={`Copy the link to ${facts?.filename ?? artifactId}`}
        className="artifact-link-copy"
        onClick={() => {
          void navigator.clipboard
            .writeText(href)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        type="button"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </span>
  );
}
