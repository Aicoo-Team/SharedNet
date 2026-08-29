import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedNetDemoProvider } from "@/src/context/sharednet-demo-context";
import { AppShell } from "./app-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chat",
}));

describe("SharedNet application shell", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the product frame to three destinations and exposes network state", () => {
    render(
      <SharedNetDemoProvider>
        <AppShell>
          <p>Page content</p>
        </AppShell>
      </SharedNetDemoProvider>,
    );

    const navigation = screen.getByRole("navigation", { name: "Primary" });
    expect(navigation.querySelectorAll("a")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(screen.getByRole("link", { name: "Network" })).toHaveAttribute(
      "href",
      "/network",
    );
    expect(screen.getByRole("link", { name: /Decisions/ })).toHaveAttribute(
      "href",
      "/decisions",
    );
    expect(screen.getByText("DEMO NETWORK")).toBeTruthy();
    expect(screen.getByText("2 pending")).toBeTruthy();
    expect(screen.getByText("15.7k tokens")).toBeTruthy();
    expect(screen.getByText("$0.08")).toBeTruthy();
  });
});
