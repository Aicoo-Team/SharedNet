import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getAuth } from "../../lib/auth";
import { ConsentView } from "@/src/components/consent-view";

export const metadata: Metadata = {
  title: "Allow access — SharedNet",
  description: "An app is asking to act in SharedNet as your account.",
};

/**
 * Where an MCP client (ChatGPT, Claude) sends a signed-in person once: the
 * page names the client and what it asks, and one click answers. Better Auth
 * brings unauthenticated people through /login first and back here.
 */
export default async function ConsentPage() {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders, query: { disableRefresh: true } });
  if (!session) redirect("/login");
  return (
    <Suspense fallback={null}>
      <ConsentView account={{ email: session.user.email, name: session.user.name }} />
    </Suspense>
  );
}
