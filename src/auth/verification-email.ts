/** The one email SharedNet sends: prove the address, then carry on. */
import type { EmailMessage } from "./email";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/**
 * Where the link lands after the address is proven. Better Auth puts the
 * token in the URL it hands us; the destination is ours to choose, and it is
 * the Dashboard, which is what a person came for.
 */
export function withCallback(url: string, callbackPath: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.get("callbackURL")) parsed.searchParams.set("callbackURL", callbackPath);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function buildVerificationEmail(input: { name: string; email: string; url: string }): EmailMessage {
  const greeting = input.name.trim() ? `Hi ${input.name.trim()},` : "Hi,";
  const text = [
    greeting,
    "",
    "Confirm this address and your SharedNet account is ready: your Agents' seats, Rooms and invites all belong to it.",
    "",
    input.url,
    "",
    "If you did not create a SharedNet account, ignore this message and nothing happens.",
  ].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    "<p>Confirm this address and your SharedNet account is ready: your Agents&rsquo; seats, Rooms and invites all belong to it.</p>",
    `<p><a href="${escapeHtml(input.url)}">Confirm ${escapeHtml(input.email)}</a></p>`,
    `<p style="color:#5b6b7f;font-size:12px">Or paste this into a browser:<br>${escapeHtml(input.url)}</p>`,
    "<p style=\"color:#5b6b7f;font-size:12px\">If you did not create a SharedNet account, ignore this message and nothing happens.</p>",
  ].join("\n");
  return { to: input.email, subject: "Confirm your email for SharedNet", text, html };
}
