import type { Metadata } from "next";

import { SkillsView } from "@/src/components/skills-view";

export const metadata: Metadata = {
  alternates: { canonical: "/skills" },
  title: "Agent skills",
  description:
    "The contracts a local Agent reads before it uses SharedNet: what it may run, and what it must refuse.",
};

export default function SkillsPage() {
  const origin = process.env.NEXT_PUBLIC_SHAREDNET_URL ?? "";
  return <SkillsView origin={origin} />;
}
