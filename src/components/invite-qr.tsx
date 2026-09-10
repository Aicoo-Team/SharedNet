"use client";

import { useEffect, useState } from "react";
import { toString as qrToString } from "qrcode";

/**
 * A join link as a QR code, for a room full of phones: the same URL the
 * dialog prints, drawn client-side as an inline SVG. Nothing leaves the page.
 */
export function InviteQr({
  link,
  caption = "Scan to open the join link",
  label = "Join link QR code",
}: Readonly<{ link: string; caption?: string; label?: string }>) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    qrToString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  if (svg === null) return null;
  return (
    <figure aria-label={label} className="room-invite-qr">
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
