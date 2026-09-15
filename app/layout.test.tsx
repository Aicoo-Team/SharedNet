import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import RootLayout from "./layout";

// The shell has its own tests; this one is about what the layout mounts
// around it.
vi.mock("@/src/components/app-shell", () => ({
  AppShell: ({ children }: Readonly<{ children: ReactNode }>) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

describe("root layout", () => {
  it("loads the Vercel Analytics script on every page", async () => {
    render(<RootLayout>{null}</RootLayout>);

    await waitFor(() => {
      const script = document.head.querySelector<HTMLScriptElement>(
        'script[src*="vercel-scripts.com"], script[src="/_vercel/insights/script.js"]',
      );
      expect(script).not.toBeNull();
      expect(script?.dataset.sdkn).toBe("@vercel/analytics/next");
    });
  });
});
