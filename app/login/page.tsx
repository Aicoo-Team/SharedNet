import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import ModernLoginSignup from "../../components/ui/modern-login-signup";
import { getAuth, resolveSocialProviders } from "../../lib/auth";
import { safePostAuthPath } from "../../src/auth/redirect";

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

function LoginFallback() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-[oklch(96.8%_0.025_240)] text-[0.82rem] text-[#0e3560]">
      Preparing secure sign in…
    </main>
  );
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: true },
  });

  if (session) {
    const requestedNext = (await searchParams).next;
    redirect(safePostAuthPath(Array.isArray(requestedNext) ? requestedNext[0] : requestedNext));
  }

  // Asked on the server, from the same function the auth config asks, so the
  // button appears exactly when the flow behind it can complete.
  const google = "google" in resolveSocialProviders(process.env);

  return (
    <Suspense fallback={<LoginFallback />}>
      <ModernLoginSignup google={google} />
    </Suspense>
  );
}
