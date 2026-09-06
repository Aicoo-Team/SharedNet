import type { Metadata } from "next";

import { CliAuthorizeView } from "@/src/components/cli-authorize-view";

export const metadata: Metadata = {
  title: "Authorize a CLI — SharedNet",
  description: "Approve a terminal that ran sharednet login.",
};

export default async function CliAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  const initialCode = Array.isArray(code) ? (code[0] ?? "") : (code ?? "");
  return <CliAuthorizeView initialCode={initialCode} />;
}
