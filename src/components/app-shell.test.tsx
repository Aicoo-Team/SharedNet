import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedNetDemoProvider } from "@/src/context/sharednet-demo-context";
import { AppShell } from "./app-shell";

const navigationState = vi.hoisted(() => ({ pathname: "/chat", replace: vi.fn() }));
const authClient = vi.hoisted(() => ({
  signOut: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({ authClient }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({ replace: navigationState.replace }),
}));

describe("SharedNet application shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationState.pathname = "/chat";
    authClient.useSession.mockReturnValue({
      data: {
        session: { id: "session_xisen", userId: "user_xisen" },
        user: {
          email: "xisen.demo@sharednet.local",
          id: "user_xisen",
          image: null,
          name: "Xisen",
        },
      },
      error: null,
      isPending: false,
    });
    authClient.signOut.mockResolvedValue({ data: null, error: null });
    window.localStorage.clear();
  });

  it("keeps the three product surfaces separate from the registration point", () => {
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
    const setup = screen.getByRole("navigation", { name: "Setup" });
    expect(setup.querySelectorAll("a")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Agent registration protocol" }),
    ).toHaveAttribute("href", "/protocol");
    expect(
      screen.getByRole("link", { name: "Agent registration protocol" }),
    ).not.toHaveAttribute("aria-current");
    expect(screen.getByText("2", { selector: ".rail-decision-badge" })).toBeTruthy();
    expect(screen.queryByText("SharedNet")).toBeNull();
    expect(screen.queryByLabelText(/Platform usage/)).toBeNull();
  });

  it("shows the signed-in account in the lower-left rail and signs out", async () => {
    render(
      <SharedNetDemoProvider>
        <AppShell>
          <p>Page content</p>
        </AppShell>
      </SharedNetDemoProvider>,
    );

    const accountButton = screen.getByRole("button", { name: "Open Xisen account" });
    expect(accountButton).toHaveTextContent("X");
    fireEvent.click(accountButton);

    const accountPanel = screen.getByRole("region", { name: "Account" });
    expect(accountPanel).toHaveTextContent("Xisen");
    expect(accountPanel).toHaveTextContent("xisen.demo@sharednet.local");

    fireEvent.click(within(accountPanel).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(authClient.signOut).toHaveBeenCalledTimes(1));
    expect(navigationState.replace).toHaveBeenCalledWith("/login");
  });

  it("redirects an expired session to the 3001 login route", async () => {
    authClient.useSession.mockReturnValue({ data: null, error: null, isPending: false });

    render(
      <SharedNetDemoProvider>
        <AppShell>
          <p>Private chat</p>
        </AppShell>
      </SharedNetDemoProvider>,
    );

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith("/login?next=%2Fchat");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading account");
  });

  it("marks the setup point active without activating a product surface", () => {
    navigationState.pathname = "/protocol";

    render(
      <SharedNetDemoProvider>
        <AppShell>
          <p>Protocol content</p>
        </AppShell>
      </SharedNetDemoProvider>,
    );

    expect(
      screen.getByRole("link", { name: "Agent registration protocol" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("navigation", { name: "Primary surfaces" }).querySelector(
        '[aria-current="page"]',
      ),
    ).toBeNull();
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
    expect(screen.queryByRole("navigation", { name: "Setup" })).toBeNull();
    expect(screen.queryByLabelText(/Platform usage/)).toBeNull();
  });

  it("leaves the login page outside the product frame", () => {
    navigationState.pathname = "/login";

    render(
      <SharedNetDemoProvider>
        <AppShell>
          <h1>Sign in to SharedNet</h1>
        </AppShell>
      </SharedNetDemoProvider>,
    );

    expect(screen.getByRole("heading", { name: "Sign in to SharedNet" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Primary surfaces" })).toBeNull();
    expect(authClient.useSession).not.toHaveBeenCalled();
  });
});
