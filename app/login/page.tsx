import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import ModernLoginSignup from "../../components/ui/modern-login-signup";
import { getAuth } from "../../lib/auth";
import { safePostAuthPath } from "../../src/auth/redirect";

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

function LoginFallback() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-[oklch(0.115_0.005_250)] text-[0.82rem] text-[oklch(0.69_0.01_250)]">
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

  return (
    <Suspense fallback={<LoginFallback />}>
      <ModernLoginSignup />
    </Suspense>
  );
}
