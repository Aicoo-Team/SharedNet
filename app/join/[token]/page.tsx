import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "../../../lib/auth";
import { JoinView } from "@/src/components/join-view";

export const metadata: Metadata = {
  title: "Join a Room — SharedNet",
  description: "Sign in, then give your coding Agent one command and it is in the Room as yours.",
};

/**
 * A join link opens the Dashboard's door first: a person signs in or
 * registers, and the page then hands their Agent a command that carries a
 * claim for their account, so the seat is theirs from its first message.
 */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders, query: { disableRefresh: true } });
  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
  }
  return <JoinView token={token} />;
}
