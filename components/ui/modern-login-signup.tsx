"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { authClient } from "../../lib/auth-client";
import { capture } from "../../src/analytics/events";
import { DEFAULT_POST_AUTH_PATH, safePostAuthPath } from "../../src/auth/redirect";
import ParticlesComponent from "./particles-bg";

type AuthMode = "sign-in" | "sign-up";

type ModernLoginSignupProps = {
  /** Whether this deployment has a Google client configured. */
  google?: boolean;
};

/**
 * Google's own four-colour mark. Their sign-in branding guidelines ask for
 * this one, unaltered, rather than a recoloured monochrome stand-in, so it is
 * inlined here instead of coming from the simple-icons set the driver marks
 * use.
 */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="h-[1.125rem] w-[1.125rem] shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

const FIELD_CLASS =
  "h-11 rounded-[6px] border border-[#002147]/25 bg-white/85 px-3 text-[0.9rem] text-[#002147] outline-none transition-colors placeholder:text-[#0e3560]/45 focus:border-[#205f91] focus:ring-1 focus:ring-[#205f91] disabled:cursor-wait disabled:opacity-60";

const LABEL_CLASS = "flex flex-col gap-2 text-[0.78rem] font-medium text-[#0e3560]";

function modeTabClass(active: boolean) {
  return `-mb-px border-x-0 border-t-0 border-b-2 bg-transparent px-0 py-2 text-sm! font-medium! transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#002147] ${
    active
      ? "border-[#002147] text-[#002147]!"
      : "border-transparent text-[#0e3560]/60! hover:text-[#002147]!"
  }`;
}

function errorMessage(error: unknown, mode: AuthMode): string {
  if (error && typeof error === "object") {
    const authError = error as {
      code?: unknown;
      message?: unknown;
      status?: unknown;
    };

    if (
      (typeof authError.status === "number" && authError.status >= 500)
      || authError.code === "INTERNAL_SERVER_ERROR"
    ) {
      return "Sign-in service is unavailable. Try again after the server is ready.";
    }

    if (
      mode === "sign-in"
      && (authError.status === 401 || authError.code === "INVALID_EMAIL_OR_PASSWORD")
    ) {
      return typeof authError.message === "string" && authError.message.trim()
        ? authError.message
        : "Email or password is incorrect.";
    }

    if (typeof authError.message === "string" && authError.message.trim()) {
      return authError.message;
    }
  }

  return mode === "sign-in"
    ? "Unable to sign in. Check your details and try again."
    : "Unable to create the account. Check your details and try again.";
}

const GOOGLE_FALLBACK_MESSAGE =
  "Google sign-in did not complete. Try again, or sign in with your password.";

/**
 * What a failed Google round trip is called when it comes back.
 *
 * Better Auth redirects to `errorCallbackURL` with `?error=<code>` rather than
 * answering the request that started the flow, because by then the browser has
 * been to Google and back. The codes are its own: the OAuth callback's fixed
 * set, plus the account-linking outcomes, whose spaces become underscores on
 * the way into the query string.
 *
 * Only the two a person can act on are named. Everything else — an expired
 * state, a provider that answered strangely, a write that failed — is one
 * sentence, because "invalid_code" tells them nothing they can use and the
 * server has already logged what happened.
 */
function socialErrorMessage(code: string): string {
  switch (code) {
    case "account_not_linked":
      return "An account already uses this email address. Sign in with your password, or verify that address first, then link Google.";
    case "account_already_linked_to_different_user":
      return "That Google account is already linked to a different SharedNet account. Sign in as that account, or use another Google account.";
    default:
      return GOOGLE_FALLBACK_MESSAGE;
  }
}

export default function ModernLoginSignup({ google = false }: ModernLoginSignupProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const socialError = searchParams.get("error");
  const [error, setError] = useState<string | null>(
    socialError ? socialErrorMessage(socialError) : null,
  );

  const switchMode = (nextMode: AuthMode) => {
    if (pending || nextMode === mode) return;
    setMode(nextMode);
    setPassword("");
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      const result = mode === "sign-in"
        ? await authClient.signIn.email({ email: email.trim(), password })
        : await authClient.signUp.email({ email: email.trim(), name: name.trim(), password });

      if (result.error) {
        setError(errorMessage(result.error, mode));
        return;
      }

      capture(mode === "sign-in" ? "signed_in" : "signed_up");

      // Sent here by an MCP client (ChatGPT, Claude) mid-authorization: the
      // server answers the sign-in with where to resume, and the browser goes
      // there rather than to the Dashboard.
      const resume = result.data as { redirect?: boolean; url?: string } | null;
      if (resume?.redirect && typeof resume.url === "string") {
        window.location.assign(resume.url);
        return;
      }

      router.replace(safePostAuthPath(searchParams.get("next")));
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, mode));
    } finally {
      setPending(false);
    }
  };

  const withGoogle = async () => {
    if (pending) return;
    setPending(true);
    setError(null);

    // Where the round trip lands, either way. Both go through the guard the
    // password path uses, so an off-site `next` cannot be carried to Google
    // and back. A refusal returns to this page still holding the destination,
    // so signing in with a password afterwards still arrives where the person
    // was going.
    const destination = safePostAuthPath(searchParams.get("next"));
    const errorCallbackURL =
      destination === DEFAULT_POST_AUTH_PATH
        ? "/login"
        : `/login?next=${encodeURIComponent(destination)}`;

    try {
      // The browser leaves for Google, so on the happy path nothing after
      // this resolves. An MCP authorization a connector may be mid-way
      // through resumes on its own: the OAuth provider plugin carries the
      // signed `oauth_query` this page was opened with into
      // `/sign-in/social` and restores it server-side.
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: destination,
        errorCallbackURL,
      });

      // Only a refusal to start the flow arrives here — a missing provider, an
      // unreachable server. Anything that fails after Google has the person
      // comes back through `errorCallbackURL` instead.
      if (result.error) {
        setError(GOOGLE_FALLBACK_MESSAGE);
        setPending(false);
      }
    } catch {
      setError(GOOGLE_FALLBACK_MESSAGE);
      setPending(false);
    }
  };

  const isSignIn = mode === "sign-in";

  return (
    <main className="relative isolate flex min-h-screen! w-full items-center justify-center overflow-hidden bg-[oklch(96.8%_0.025_240)] px-4 py-8 text-[#002147] sm:px-6">
      <ParticlesComponent />
      <div
        aria-hidden="true"
        className="auth-particle-blur pointer-events-none absolute inset-0 z-[1] bg-[oklch(98%_0.015_240/0.08)] backdrop-blur-[3px]"
      />

      <section
        aria-labelledby="auth-heading"
        className="relative z-10 w-full max-w-[25rem] rounded-xl border border-[#002147]/25 bg-[oklch(98.5%_0.012_240/0.86)] px-6 py-7 shadow-[0_18px_50px_rgba(0,33,71,0.14)] backdrop-blur-md sm:px-8 sm:py-8"
      >
        <div className="mb-8 flex items-center justify-between gap-6 border-b border-[#002147]/15 pb-3 text-[0.72rem] leading-none font-semibold tracking-[0.16em] text-[#0e3560]/70 uppercase">
          <span>SharedNet</span>
          <span>Account access</span>
        </div>

        <div className="mb-7">
          <h1 id="auth-heading" className="text-[1.5rem] leading-[1.2] font-semibold tracking-[-0.025em] text-[#002147]">
            {isSignIn ? (
              <>
                Sign in to{" "}
                <span className="font-display font-extrabold tracking-[-0.05em] text-[#002147]">
                  SharedNet
                </span>
              </>
            ) : (
              "Create your SharedNet account"
            )}
          </h1>
          <p className="mt-2 max-w-[34ch] text-[0.9rem] leading-[1.55] text-[#0e3560]/80">
            {isSignIn
              ? "Continue to the SharedNet Rooms available in this deployment."
              : "Create an account for your SharedNet workspace."}
          </p>
        </div>

        <div className="mb-6 flex gap-6 border-b border-[#002147]/15" aria-label="Authentication mode">
          <button
            type="button"
            aria-pressed={isSignIn}
            className={modeTabClass(isSignIn)}
            disabled={pending}
            onClick={() => switchMode("sign-in")}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-pressed={!isSignIn}
            className={modeTabClass(!isSignIn)}
            disabled={pending}
            onClick={() => switchMode("sign-up")}
          >
            Create account
          </button>
        </div>

        {google ? (
          <>
            <button
              type="button"
              className="flex h-11 w-full items-center justify-center gap-2.5 rounded-[6px] border border-[#002147]/25 bg-white px-4 text-[0.875rem]! font-medium! text-[#002147]! transition-colors hover:border-[#002147]/45 hover:bg-[#f6f8fb] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#002147] disabled:cursor-wait disabled:opacity-60"
              disabled={pending}
              onClick={withGoogle}
            >
              <GoogleMark />
              {isSignIn ? "Sign in with Google" : "Continue with Google"}
            </button>

            <div
              aria-hidden="true"
              className="my-5 flex items-center gap-3 text-[0.7rem] tracking-[0.14em] text-[#0e3560]/45 uppercase"
            >
              <span className="h-px flex-1 bg-[#002147]/15" />
              or
              <span className="h-px flex-1 bg-[#002147]/15" />
            </div>
          </>
        ) : null}

        <form className="flex flex-col gap-4" onSubmit={submit}>
          {!isSignIn ? (
            <label className={LABEL_CLASS}>
              Name
              <input
                type="text"
                autoComplete="name"
                name="name"
                className={FIELD_CLASS}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
                required
                value={name}
              />
            </label>
          ) : null}

          <label className={LABEL_CLASS}>
            Email
            <input
              type="email"
              autoCapitalize="none"
              autoComplete="email"
              name="email"
              spellCheck={false}
              className={FIELD_CLASS}
              disabled={pending}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@work-email.com"
              required
              value={email}
            />
          </label>

          <label className={LABEL_CLASS}>
            Password
            <input
              type="password"
              autoComplete={isSignIn ? "current-password" : "new-password"}
              name="password"
              className={FIELD_CLASS}
              disabled={pending}
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              required
              value={password}
            />
          </label>

          {error ? (
            <p role="alert" className="rounded-[6px] border border-[#b91c1c]/35 bg-[#fef2f2]/90 px-3 py-2.5 text-[0.82rem] leading-[1.45] text-[#991b1b]">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="mt-2 flex h-11 items-center justify-center rounded-[6px] border border-[#002147] bg-[#002147] px-4 text-[0.875rem]! font-semibold! text-white! transition-colors hover:border-[#0e3560] hover:bg-[#0e3560] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#002147] disabled:cursor-wait disabled:border-[#002147]/40 disabled:bg-[#002147]/40 disabled:text-white/85!"
            disabled={pending}
          >
            {pending
              ? isSignIn ? "Signing in" : "Creating account"
              : isSignIn ? "Sign in to SharedNet" : "Create SharedNet account"}
          </button>
        </form>

        <p className="mt-6 border-t border-[#002147]/15 pt-4 text-[0.72rem] leading-[1.5] text-[#0e3560]/65">
          Account identity and connected agent runtime identity remain separately attributable.
        </p>
      </section>
    </main>
  );
}
