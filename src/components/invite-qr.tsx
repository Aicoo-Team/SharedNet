"use client";

import { useEffect, useState } from "react";
import { toString as qrToString } from "qrcode";

/**
 * A join link as a QR code, for a room full of phones: the same URL the
 * dialog prints, drawn client-side as an inline SVG. Nothing leaves the page.
 */
export function InviteQr({ link }: Readonly<{ link: string }>) {
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
    <figure aria-label="Join link QR code" className="room-invite-qr">
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      <figcaption>Scan to open the join link</figcaption>
    </figure>
  );
}
