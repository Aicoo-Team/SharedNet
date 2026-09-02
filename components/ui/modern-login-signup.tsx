"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { authClient } from "../../lib/auth-client";
import { safePostAuthPath } from "../../src/auth/redirect";

type AuthMode = "sign-in" | "sign-up";

function DottedField() {
  return <div aria-hidden="true" className="auth-dot-field absolute inset-0" />;
}

function errorMessage(error: unknown, mode: AuthMode): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
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
    <main className="relative isolate flex min-h-screen w-full items-center justify-center overflow-hidden bg-[oklch(0.115_0.005_250)] px-4 py-8 text-[oklch(0.965_0.004_250)] [color-scheme:dark] sm:px-6">
      <DottedField />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_center,oklch(0.115_0.005_250/0.28)_0%,oklch(0.115_0.005_250/0.78)_72%,oklch(0.09_0.004_250)_100%)]"
      />

      <section
        aria-labelledby="auth-heading"
        className="relative z-10 w-full max-w-[25rem] rounded-[6px] border border-[oklch(0.31_0.008_250)] bg-[oklch(0.155_0.006_250/0.97)] px-6 py-7 sm:px-8 sm:py-8"
      >
        <div className="mb-8 flex items-center justify-between gap-6 border-b border-[oklch(0.29_0.007_250)] pb-3 text-[0.72rem] leading-none tracking-[0.16em] text-[oklch(0.66_0.012_250)] uppercase">
          <span>SharedNet</span>
          <span>Account access</span>
        </div>

        <div className="mb-7">
          <h1 id="auth-heading" className="text-[1.5rem] leading-[1.2] font-semibold tracking-[-0.025em]">
            {isSignIn ? (
              <>
                Sign in to <span className="text-[#B9D9EB]">SharedNet</span>
              </>
            ) : (
              "Create your SharedNet account"
            )}
          </h1>
          <p className="mt-2 max-w-[34ch] text-[0.9rem] leading-[1.55] text-[oklch(0.69_0.01_250)]">
            {isSignIn
              ? "Continue to the SharedNet Rooms available in this deployment."
              : "Create an account for your SharedNet workspace."}
          </p>
        </div>

        <div className="mb-6 flex gap-6 border-b border-[oklch(0.29_0.007_250)]" aria-label="Authentication mode">
          <button
            type="button"
            aria-pressed={isSignIn}
            className={`-mb-px border-x-0 border-t-0 border-b bg-transparent px-0 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[oklch(0.72_0.1_245)] ${
              isSignIn
                ? "border-[oklch(0.9_0.006_250)] text-[oklch(0.96_0.004_250)]"
                : "border-transparent text-[oklch(0.61_0.01_250)] hover:text-[oklch(0.85_0.008_250)]"
            }`}
            disabled={pending}
            onClick={() => switchMode("sign-in")}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-pressed={!isSignIn}
            className={`-mb-px border-x-0 border-t-0 border-b bg-transparent px-0 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[oklch(0.72_0.1_245)] ${
              !isSignIn
                ? "border-[oklch(0.9_0.006_250)] text-[oklch(0.96_0.004_250)]"
                : "border-transparent text-[oklch(0.61_0.01_250)] hover:text-[oklch(0.85_0.008_250)]"
            }`}
            disabled={pending}
            onClick={() => switchMode("sign-up")}
          >
            Create account
          </button>
        </div>

        <form className="flex flex-col gap-4" onSubmit={submit}>
          {!isSignIn ? (
            <label className="flex flex-col gap-2 text-[0.78rem] font-medium text-[oklch(0.76_0.008_250)]">
              Name
              <input
                type="text"
                autoComplete="name"
                name="name"
                className="h-11 rounded-[4px] border border-[oklch(0.33_0.008_250)] bg-[oklch(0.115_0.005_250)] px-3 text-[0.9rem] text-[oklch(0.96_0.004_250)] outline-none transition-colors placeholder:text-[oklch(0.48_0.009_250)] focus:border-[oklch(0.68_0.08_245)] focus:ring-1 focus:ring-[oklch(0.68_0.08_245)] disabled:cursor-wait disabled:opacity-60"
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
                required
                value={name}
              />
            </label>
          ) : null}

          <label className="flex flex-col gap-2 text-[0.78rem] font-medium text-[oklch(0.76_0.008_250)]">
            Email
            <input
              type="email"
              autoCapitalize="none"
              autoComplete="email"
              name="email"
              spellCheck={false}
              className="h-11 rounded-[4px] border border-[oklch(0.33_0.008_250)] bg-[oklch(0.115_0.005_250)] px-3 text-[0.9rem] text-[oklch(0.96_0.004_250)] outline-none transition-colors placeholder:text-[oklch(0.48_0.009_250)] focus:border-[oklch(0.68_0.08_245)] focus:ring-1 focus:ring-[oklch(0.68_0.08_245)] disabled:cursor-wait disabled:opacity-60"
              disabled={pending}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@work-email.com"
              required
              value={email}
            />
          </label>

          <label className="flex flex-col gap-2 text-[0.78rem] font-medium text-[oklch(0.76_0.008_250)]">
            Password
            <input
              type="password"
              autoComplete={isSignIn ? "current-password" : "new-password"}
              name="password"
              className="h-11 rounded-[4px] border border-[oklch(0.33_0.008_250)] bg-[oklch(0.115_0.005_250)] px-3 text-[0.9rem] text-[oklch(0.96_0.004_250)] outline-none transition-colors placeholder:text-[oklch(0.48_0.009_250)] focus:border-[oklch(0.68_0.08_245)] focus:ring-1 focus:ring-[oklch(0.68_0.08_245)] disabled:cursor-wait disabled:opacity-60"
              disabled={pending}
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              required
              value={password}
            />
          </label>

          {error ? (
            <p role="alert" className="rounded-[4px] border border-[oklch(0.48_0.09_25)] bg-[oklch(0.2_0.035_25)] px-3 py-2.5 text-[0.82rem] leading-[1.45] text-[oklch(0.84_0.055_25)]">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="mt-2 flex h-11 items-center justify-center rounded-[4px] border border-[oklch(0.91_0.005_250)] bg-[oklch(0.93_0.005_250)] px-4 text-[0.875rem] font-semibold text-[oklch(0.16_0.006_250)] transition-colors hover:bg-[oklch(0.86_0.006_250)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.72_0.1_245)] disabled:cursor-wait disabled:border-[oklch(0.45_0.006_250)] disabled:bg-[oklch(0.35_0.006_250)] disabled:text-[oklch(0.72_0.006_250)]"
            disabled={pending}
          >
            {pending
              ? isSignIn ? "Signing in" : "Creating account"
              : isSignIn ? "Sign in to SharedNet" : "Create SharedNet account"}
          </button>
        </form>

        <p className="mt-6 border-t border-[oklch(0.29_0.007_250)] pt-4 text-[0.72rem] leading-[1.5] text-[oklch(0.57_0.009_250)]">
          Account identity and connected agent runtime identity remain separately attributable.
        </p>
      </section>
    </main>
  );
}
