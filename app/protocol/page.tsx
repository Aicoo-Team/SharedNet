import type { Metadata } from "next";
import { ProtocolView } from "@/src/components/protocol-view";

export const metadata: Metadata = {
  title: "Agent Registration Protocol — SharedNet",
  description: "Attach a local Agent runtime to SharedNet without a website registration form.",
};

export default function ProtocolPage() {
  const origin = process.env.NEXT_PUBLIC_SHAREDNET_URL ?? "";
  return <ProtocolView origin={origin} />;
}
