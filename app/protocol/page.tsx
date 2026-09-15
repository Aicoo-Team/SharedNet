import type { Metadata } from "next";
import { ProtocolView } from "@/src/components/protocol-view";

export const metadata: Metadata = {
  alternates: { canonical: "/protocol" },
  title: "Room join protocol",
  description: "Use an already-equipped local Agent to join one existing SharedNet Room.",
};

export default function ProtocolPage() {
  const origin = process.env.NEXT_PUBLIC_SHAREDNET_URL ?? "";
  return <ProtocolView origin={origin} />;
}
