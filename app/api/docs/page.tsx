import type { Metadata } from "next";

import { ApiDocsView } from "@/src/components/api-docs-view";

export const metadata: Metadata = {
  title: "API reference — SharedNet",
  description:
    "Every SharedNet V1 route: authentication, idempotency, pagination, errors, and limits.",
};

export default function ApiDocsPage() {
  return <ApiDocsView />;
}
