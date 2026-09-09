// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { resolveSender, sendEmail } from "./email";
import { buildVerificationEmail, withCallback } from "./verification-email";

const KEY = "re_test_key_never_real";
const ENV = { RESEND_API_KEY: KEY, RESEND_FROM_EMAIL: "SharedNet <notifications@aicoo.io>" };
const MESSAGE = { to: "someone@example.test", subject: "Confirm your email for SharedNet", text: "hello", html: "<p>hello</p>" };

describe("sending mail", () => {
  it("posts the message to Resend and reports the id it gets back", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await sendEmail(MESSAGE, ENV, fetchMock as unknown as typeof fetch);

    expect(result).toEqual({ sent: true, id: "email_123" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      from: "SharedNet <notifications@aicoo.io>",
      to: ["someone@example.test"],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  it("does nothing but say so when no key or sender is configured, and never throws", async () => {
    const fetchMock = vi.fn();
    const lines: string[] = [];
    const result = await sendEmail(MESSAGE, {}, fetchMock as unknown as typeof fetch, (line) => lines.push(line));

    expect(result).toEqual({ sent: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines.join(" ")).toContain("no RESEND_API_KEY");
    // A key with no sender is just as unconfigured: Resend refuses an unverified domain anyway.
    expect(await sendEmail(MESSAGE, { RESEND_API_KEY: KEY }, fetchMock as unknown as typeof fetch, () => {})).toEqual({ sent: false, reason: "not_configured" });
    expect(resolveSender({ PULSE_SYSTEM_EMAIL_FROM: "Aicoo <notifications@aicoo.io>" })).toBe("Aicoo <notifications@aicoo.io>");
  });

  it("reports a refusal and an unreachable provider without throwing, and never repeats the key", async () => {
    const refused = await sendEmail(
      MESSAGE,
      ENV,
      (async () => new Response(JSON.stringify({ message: "The example.test domain is not verified" }), { status: 403, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    );
    expect(refused).toEqual({ sent: false, reason: "rejected", detail: "The example.test domain is not verified" });

    const down = await sendEmail(MESSAGE, ENV, (async () => { throw new Error("getaddrinfo EAI_AGAIN api.resend.com"); }) as unknown as typeof fetch);
    expect(down).toMatchObject({ sent: false, reason: "unreachable" });
    expect(JSON.stringify([refused, down])).not.toContain(KEY);
  });
});

describe("the verification email", () => {
  const url = "https://www.sharednet.ai/api/auth/verify-email?token=abc123";

  it("carries the link, names the address, and escapes what a person typed", () => {
    const message = buildVerificationEmail({ name: 'Xisen <script>alert("x")</script>', email: "xisen@example.test", url });

    expect(message.to).toBe("xisen@example.test");
    expect(message.subject).toBe("Confirm your email for SharedNet");
    expect(message.text).toContain(url);
    expect(message.html).toContain(url);
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.text).toContain("If you did not create a SharedNet account");
    expect(buildVerificationEmail({ name: "  ", email: "x@example.test", url }).text.startsWith("Hi,")).toBe(true);
  });

  it("sends the person to the Dashboard afterwards, and leaves a destination that was already chosen", () => {
    expect(withCallback(url, "https://www.sharednet.ai/chat?verified=1")).toContain("callbackURL=https%3A%2F%2Fwww.sharednet.ai%2Fchat%3Fverified%3D1");
    const chosen = `${url}&callbackURL=/decisions`;
    expect(withCallback(chosen, "https://www.sharednet.ai/chat")).toBe(chosen);
    expect(withCallback("not a url", "/chat")).toBe("not a url");
  });
});
