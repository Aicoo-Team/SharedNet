"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { authClient } from "../../lib/auth-client";
import { safePostAuthPath } from "../../src/auth/redirect";
import ParticlesComponent from "./particles-bg";

type AuthMode = "sign-in" | "sign-up";

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

export default function ModernLoginSignup() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      router.replace(safePostAuthPath(searchParams.get("next")));
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught, mode));
    } finally {
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
