import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedNetDemoProvider } from "@/src/context/sharednet-demo-context";
import { AppShell } from "./app-shell";

const navigationState = vi.hoisted(() => ({ pathname: "/chat" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
}));

describe("SharedNet application shell", () => {
  beforeEach(() => {
    navigationState.pathname = "/chat";
    window.localStorage.clear();
  });

  it("uses the three-dot rail as the entire product navigation", () => {
    render(
      <SharedNetDemoProvider>
        <AppShell>
          <p>Page content</p>
        </AppShell>
      </SharedNetDemoProvider>,
    );

    const navigation = screen.getByRole("navigation", { name: "Primary surfaces" });
    expect(navigation.querySelectorAll("a")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Network" })).toHaveAttribute(
      "href",
      "/network",
    );
    expect(screen.getByRole("link", { name: "Decisions, 2 pending" })).toHaveAttribute(
      "href",
      "/decisions",
    );
    expect(navigation.querySelectorAll(".rail-dot")).toHaveLength(3);
    expect(screen.getByText("2", { selector: ".rail-decision-badge" })).toBeTruthy();
    expect(screen.queryByText("SharedNet")).toBeNull();
    expect(screen.queryByLabelText(/Platform usage/)).toBeNull();
  });

  it("leaves the public homepage outside the authenticated product frame", () => {
    navigationState.pathname = "/";

    render(
      <SharedNetDemoProvider>
        <AppShell>
          <p>Standalone marketing page</p>
        </AppShell>
      </SharedNetDemoProvider>,
    );

    expect(screen.getByText("Standalone marketing page")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Primary surfaces" })).toBeNull();
    expect(screen.queryByLabelText(/Platform usage/)).toBeNull();
  });
});
