import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSharedNet } from "@/src/context/sharednet-context";

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

const NOW = "2026-09-03T05:00:00+00:00";
const PRINCIPAL_ID = "p_7CPHtWFsFn";
const SECOND_PRINCIPAL_ID = "p_V80npHhNlU";

const principal = {
  created_at: NOW,
  diagnostic_label: "Xisen",
  kind: "human",
  principal_id: PRINCIPAL_ID,
  summary: "SharedNet account Principal",
};

const network = {
  agents: [],
  connected_principals: [],
  edges: [],
  instances: [],
  principal,
};

const pendingDecision = {
  consequence: "The deploy remains paused",
  created_at: NOW,
  decision_id: "decision_launch",
  description: "Approve the production launch",
  requester: null,
  resolved_at: null,
  response_mode: "approval",
  response_text: null,
  room_id: null,
  status: "pending",
  target_principal_id: PRINCIPAL_ID,
  title: "Production launch",
};

const approvedDecision = {
  ...pendingDecision,
  decision_id: "decision_reviewed",
  resolved_at: NOW,
  response_text: "Approved after review",
  status: "approved",
  title: "Reviewed launch",
};

function dashboardFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input);
  if (path === "/api/sharednet/bootstrap") {
    return Promise.resolve(Response.json({ principal_id: PRINCIPAL_ID }));
  }
  if (path === "/api/sharednet/rooms") {
    return Promise.resolve(Response.json({ rooms: [] }));
  }
  if (path === "/api/sharednet/network") {
    return Promise.resolve(Response.json(network));
  }
  if (path === "/api/sharednet/decisions") {
    return Promise.resolve(
      Response.json({ decisions: [pendingDecision, approvedDecision] }),
    );
  }
  return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
}

function signedInSession(userId = "user_xisen") {
  return {
    data: {
      session: { id: `session_${userId}`, userId },
      user: {
        email: "xisen.demo@sharednet.local",
        id: userId,
        image: null,
        name: "Xisen",
      },
    },
    error: null,
    isPending: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function PrincipalProbe() {
  const { principal: livePrincipal, status } = useSharedNet();
  return (
    <output data-testid="shell-principal">
      {status}:{livePrincipal?.principal_id ?? "none"}
    </output>
  );
}

describe("SharedNet application shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationState.pathname = "/chat";
    authClient.useSession.mockReturnValue(signedInSession());
    authClient.signOut.mockResolvedValue({ data: null, error: null });
    vi.stubGlobal("fetch", vi.fn(dashboardFetch));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the three product surfaces separate from the registration point", async () => {
    render(
      <AppShell>
        <p>Page content</p>
      </AppShell>,
    );

    const navigation = screen.getByRole("navigation", { name: "Primary surfaces" });
    expect(navigation.querySelectorAll("a")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Rooms" })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(screen.getByRole("link", { name: "Rooms" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Network" })).toHaveAttribute(
      "href",
      "/network",
    );
    expect(
      await screen.findByRole("link", { name: "Decisions, 1 pending" }),
    ).toHaveAttribute("href", "/decisions");
    expect(navigation.querySelectorAll(".rail-dot")).toHaveLength(3);
    const setup = screen.getByRole("navigation", { name: "Setup" });
    expect(setup.querySelectorAll("a")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Room join protocol" }),
    ).toHaveAttribute("href", "/protocol");
    expect(
      screen.getByRole("link", { name: "Room join protocol" }),
    ).not.toHaveAttribute("aria-current");
    expect(screen.getByText("1", { selector: ".rail-decision-badge" })).toBeTruthy();
    expect(screen.queryByText("SharedNet")).toBeNull();
    expect(screen.queryByLabelText(/Platform usage/)).toBeNull();
  });

  it("shows the live SharedNet principal in the account panel and signs out", async () => {
    const fetchMock = vi.mocked(fetch);
    render(
      <AppShell>
        <p>Page content</p>
      </AppShell>,
    );

    const accountButton = screen.getByRole("button", { name: "Open Xisen account" });
    expect(accountButton).toHaveTextContent("X");
    fireEvent.click(accountButton);

    const accountPanel = screen.getByRole("region", { name: "Account" });
    expect(accountPanel).toHaveTextContent("Xisen");
    expect(accountPanel).toHaveTextContent("xisen.demo@sharednet.local");
    await waitFor(() => expect(accountPanel).toHaveTextContent(PRINCIPAL_ID));
    expect(accountPanel).not.toHaveTextContent("user_xisen");
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("user_xisen")))
      .toBe(true);

    fireEvent.click(within(accountPanel).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(authClient.signOut).toHaveBeenCalledTimes(1));
    expect(navigationState.replace).toHaveBeenCalledWith("/login");
  });

  it("shows a neutral principal label when the live projection is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/sharednet/network") {
          return Promise.resolve(Response.json({ error: "offline" }, { status: 503 }));
        }
        return dashboardFetch(input);
      }),
    );

    render(
      <AppShell>
        <p>Page content</p>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Xisen account" }));
    const accountPanel = screen.getByRole("region", { name: "Account" });

    await waitFor(() => expect(accountPanel).toHaveTextContent("Principal unavailable"));
    expect(accountPanel).not.toHaveTextContent("user_xisen");
  });

  it("redirects an expired session without mounting the live provider", async () => {
    authClient.useSession.mockReturnValue({ data: null, error: null, isPending: false });
    const fetchMock = vi.mocked(fetch);

    render(
      <AppShell>
        <p>Private chat</p>
      </AppShell>,
    );

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith("/login?next=%2Fchat");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading account");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mounts fresh live state when the Better Auth account changes", async () => {
    let account = 1;
    let bootstrapCalls = 0;
    const secondNetwork = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === "/api/sharednet/bootstrap") {
        bootstrapCalls += 1;
        return Promise.resolve(
          Response.json({
            principal_id: account === 1 ? PRINCIPAL_ID : SECOND_PRINCIPAL_ID,
          }),
        );
      }
      if (path === "/api/sharednet/rooms") {
        return Promise.resolve(Response.json({ rooms: [] }));
      }
      if (path === "/api/sharednet/decisions") {
        return Promise.resolve(Response.json({ decisions: [] }));
      }
      if (path === "/api/sharednet/network") {
        return account === 1 ? Promise.resolve(Response.json(network)) : secondNetwork.promise;
      }
      return Promise.reject(new Error(`Unexpected Dashboard request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <AppShell>
        <PrincipalProbe />
      </AppShell>,
    );
    expect(await screen.findByText(`ready:${PRINCIPAL_ID}`)).toBeVisible();

    account = 2;
    authClient.useSession.mockReturnValue(signedInSession("user_second"));
    view.rerender(
      <AppShell>
        <PrincipalProbe />
      </AppShell>,
    );

    expect(screen.getByTestId("shell-principal")).toHaveTextContent("loading:none");
    expect(screen.getByTestId("shell-principal")).not.toHaveTextContent(PRINCIPAL_ID);
    await waitFor(() => expect(bootstrapCalls).toBe(2));

    secondNetwork.resolve(
      Response.json({
        ...network,
        principal: {
          ...principal,
          diagnostic_label: "Second account",
          principal_id: SECOND_PRINCIPAL_ID,
        },
      }),
    );
    expect(await screen.findByText(`ready:${SECOND_PRINCIPAL_ID}`)).toBeVisible();
  });

  it("leaves the public protocol outside the authenticated product frame", () => {
    navigationState.pathname = "/protocol";

    render(
      <AppShell>
        <p>Protocol content</p>
      </AppShell>,
    );

    expect(screen.getByText("Protocol content")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Primary surfaces" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Setup" })).toBeNull();
    expect(authClient.useSession).not.toHaveBeenCalled();
  });

  it("leaves the public homepage outside the authenticated product frame", () => {
    navigationState.pathname = "/";

    render(
      <AppShell>
        <p>Standalone marketing page</p>
      </AppShell>,
    );

    expect(screen.getByText("Standalone marketing page")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Primary surfaces" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Setup" })).toBeNull();
    expect(screen.queryByLabelText(/Platform usage/)).toBeNull();
  });

  it("leaves the public About page outside the authenticated product frame", () => {
    navigationState.pathname = "/about";

    render(
      <AppShell>
        <p>About SharedNet</p>
      </AppShell>,
    );

    expect(screen.getByText("About SharedNet")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Primary surfaces" })).toBeNull();
    expect(authClient.useSession).not.toHaveBeenCalled();
  });

  it("leaves the login page outside the product frame", () => {
    navigationState.pathname = "/login";

    render(
      <AppShell>
        <h1>Sign in to SharedNet</h1>
      </AppShell>,
    );

    expect(screen.getByRole("heading", { name: "Sign in to SharedNet" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Primary surfaces" })).toBeNull();
    expect(authClient.useSession).not.toHaveBeenCalled();
  });
});
