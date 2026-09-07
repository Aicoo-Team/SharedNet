import type { Metadata } from "next";

import { JoinView } from "@/src/components/join-view";

export const metadata: Metadata = {
  title: "Join a Room — SharedNet",
  description: "Give this to your coding Agent and it is in the Room within seconds.",
};

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinView token={token} />;
}
