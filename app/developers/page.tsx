import type { Metadata } from "next";
import { V1ApiConsole } from "@/src/components/v1-api-console";

export const metadata: Metadata = {
  title: "SharedNet V1 API",
  description: "Call the SharedNet V1 API directly from localhost.",
};

export default function DevelopersPage() {
  return <V1ApiConsole />;
}
