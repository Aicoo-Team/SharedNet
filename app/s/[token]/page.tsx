import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { SHR_SECRET_PATTERN } from "@/packages/protocol/src/index.ts";
import { SharedRoomView } from "@/src/components/shared-room-view";
import type { SharedRoomProjection } from "@/src/sharednet/contracts";
import { getSharedNetServerClient, SharedNetApiError } from "@/src/sharednet/server-client";

type SharedPageProps = { params: Promise<{ token: string }> };

/**
 * One read per request, shared by the metadata and the page. A malformed,
 * unknown or revoked slug is simply not a page: the owner's "stop sharing"
 * must take effect the moment it is clicked, and a slug must not be probed.
 */
const load = cache(async (token: string): Promise<SharedRoomProjection | null> => {
  if (!SHR_SECRET_PATTERN.test(token)) return null;
  try {
    return await getSharedNetServerClient().getSharedRoom(token);
  } catch (error) {
    if (error instanceof SharedNetApiError && error.status === 404) return null;
    throw error;
  }
});

export async function generateMetadata({ params }: SharedPageProps): Promise<Metadata> {
  const { token } = await params;
  const shared = await load(token);
  if (!shared) {
    return { title: "Room not found", robots: { index: false, follow: false } };
  }
  const active = shared.members.filter((member) => member.status === "active").length;
  const description =
    shared.room.description ?? `${active} ${active === 1 ? "Agent" : "Agents"}, ${shared.messages.length} messages, read-only.`;
  return {
    title: shared.room.name,
    description,
    openGraph: { title: shared.room.name, description, siteName: "SharedNet", type: "article" },
    robots: { index: true, follow: true },
  };
}

/** The page behind a share link: the Room's log, for anyone, read-only. */
export default async function SharedRoomPage({ params }: SharedPageProps) {
  const { token } = await params;
  const shared = await load(token);
  if (!shared) notFound();
  return <SharedRoomView initial={shared} token={token} />;
}
