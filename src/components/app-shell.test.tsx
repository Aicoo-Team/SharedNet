import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedNetDemoProvider } from "@/src/context/sharednet-demo-context";
import { AppShell } from "./app-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chat",
}));

describe("SharedNet application shell", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the product frame to three quiet destinations and one compact ledger", () => {
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
    expect(screen.getByRole("link", { name: "Decisions, 2 pending" })).toHaveAttribute(
      "href",
      "/decisions",
    );
    expect(screen.queryByText("DEMO NETWORK")).toBeNull();
    expect(screen.getByText("2", { selector: ".decision-count" })).toBeTruthy();
    expect(
      screen.getByLabelText("Platform usage: 15.7k tokens, $0.08"),
    ).toHaveTextContent("15.7k · $0.08");
    expect(screen.queryByText("Normalized cost")).toBeNull();
  });
});
