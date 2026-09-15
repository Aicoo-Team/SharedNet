/** "2026-09-06 07:34:03 UTC", from the ISO stamp the API sends; the full stamp is the title. */
export function readableTime(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}
