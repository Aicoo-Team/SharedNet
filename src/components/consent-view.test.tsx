import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentView, describeClient } from "./consent-view";

const consent = vi.hoisted(() => vi.fn());
const params = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock("@/lib/auth-client", () => ({ authClient: { oauth2: { consent } } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => params.current }));

const ACCOUNT = { email: "xisen@example.test", name: "Xisen" };

describe("the consent page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    params.current = new URLSearchParams("client_id=client_abc&client_name=ChatGPT&scope=openid%20profile%20offline_access");
    Object.defineProperty(window, "location", { configurable: true, value: { assign: vi.fn() } });
  });
  afterEach(cleanup);

  it("names the client, the account, and what it asks, and sends the browser on when allowed", async () => {
    consent.mockResolvedValue({ data: { url: "https://chatgpt.example/callback?code=x" }, error: null });
    render(<ConsentView account={ACCOUNT} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("ChatGPT wants to act in SharedNet as you");
    expect(screen.getByText(/Signed in as Xisen \(xisen@example.test\)/)).toBeVisible();
    const asks = screen.getByRole("region", { name: "What it asks" });
    expect(within(asks).getByText("client_abc")).toBeVisible();
    for (const scope of ["openid", "profile", "offline_access"]) expect(within(asks).getByText(scope)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(consent).toHaveBeenCalledWith({ accept: true, scope: "openid profile offline_access" }));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("https://chatgpt.example/callback?code=x"));
  });

  it("denies without leaving the decision ambiguous, and says so when SharedNet could not record it", async () => {
    consent.mockResolvedValueOnce({ data: { url: "https://chatgpt.example/callback?error=access_denied" }, error: null });
    render(<ConsentView account={ACCOUNT} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(consent).toHaveBeenCalledWith({ accept: false, scope: "openid profile offline_access" }));

    cleanup();
    consent.mockResolvedValueOnce({ data: null, error: { message: "nope" } });
    render(<ConsentView account={ACCOUNT} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SharedNet could not record the answer");
  });

  it("names a client it knows, and falls back to what the request carries", () => {
    expect(describeClient("client_abc", "ChatGPT Connector")).toBe("ChatGPT");
    expect(describeClient("openai-client", null)).toBe("ChatGPT");
    expect(describeClient("client_xyz", "Claude")).toBe("Claude");
    expect(describeClient("client_xyz", "Cowork")).toBe("Cowork");
    expect(describeClient("client_xyz", null)).toBe("client_xyz");
    expect(describeClient(null, null)).toBe("An app");
  });
});
