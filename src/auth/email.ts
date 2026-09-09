/**
 * Sending mail, over Resend's HTTP API.
 *
 * Nothing here throws: an account must not fail to be created because a
 * mail provider is down, and a deployment without a key (a developer's
 * laptop, CI) must still be able to sign up. The caller learns what
 * happened from the result, and the address a verification link carries is
 * printed only when there is no key to send it with, which is the case where
 * a person is looking at their own terminal.
 */
export type EmailMessage = Readonly<{ to: string; subject: string; text: string; html: string }>;

export type SendEmailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: "not_configured" | "rejected" | "unreachable"; detail?: string };

export type EmailEnvironment = Readonly<Record<string, string | undefined>>;

/** Who the mail comes from. Resend accepts only a domain verified in that account. */
export function resolveSender(env: EmailEnvironment): string | null {
  const configured = env.RESEND_FROM_EMAIL?.trim() || env.PULSE_SYSTEM_EMAIL_FROM?.trim();
  return configured && configured.length > 0 ? configured : null;
}

export async function sendEmail(
  message: EmailMessage,
  env: EmailEnvironment = process.env,
  fetchImplementation: typeof fetch = fetch,
  log: (line: string) => void = (line) => console.info(line),
): Promise<SendEmailResult> {
  const key = env.RESEND_API_KEY?.trim();
  const from = resolveSender(env);
  if (!key || !from) {
    log(`SharedNet did not send "${message.subject}" to ${message.to}: no RESEND_API_KEY or sender configured.`);
    return { sent: false, reason: "not_configured" };
  }
  let response: Response;
  try {
    response = await fetchImplementation("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
    });
  } catch (error) {
    return { sent: false, reason: "unreachable", detail: error instanceof Error ? error.message : "network error" };
  }
  const body = (await response.json().catch(() => null)) as { id?: unknown; message?: unknown } | null;
  if (!response.ok) {
    // Resend says why in `message`; it never contains the key.
    return { sent: false, reason: "rejected", detail: typeof body?.message === "string" ? body.message : `HTTP ${response.status}` };
  }
  return { sent: true, id: typeof body?.id === "string" ? body.id : null };
}
