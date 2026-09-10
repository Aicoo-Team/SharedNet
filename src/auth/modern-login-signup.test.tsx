// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ModernLoginSignup from "../../components/ui/modern-login-signup";

const authClient = vi.hoisted(() => ({
  signIn: { email: vi.fn(), social: vi.fn() },
  signUp: { email: vi.fn() },
}));

const navigation = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("../../lib/auth-client", () => ({ authClient }));
vi.mock("next/script", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: navigation.refresh,
    replace: navigation.replace,
  }),
  useSearchParams: () => navigation.search,
}));
describe("ModernLoginSignup", () => {
  beforeEach(() => {
    navigation.search = new URLSearchParams();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
      }),
      writable: true,
    });
    authClient.signIn.email.mockResolvedValue({
      data: { redirect: false, token: null, url: null, user: null },
      error: null,
    });
    authClient.signUp.email.mockResolvedValue({
      data: { token: null, user: null },
      error: null,
    });
    authClient.signIn.social.mockResolvedValue({
      data: { redirect: true, url: "https://accounts.google.com/o/oauth2/auth" },
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("sets the SharedNet word in the homepage navy display face", () => {
    render(<ModernLoginSignup />);

    const heading = screen.getByRole("heading", { name: "Sign in to SharedNet" });
    const word = within(heading).getByText("SharedNet");
    expect(word).toHaveClass("text-[#002147]");
    expect(word).toHaveClass("font-display");
  });

  it("gives credential fields browser-readable names and email input hints", () => {
    render(<ModernLoginSignup />);

    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("name", "email");
    expect(email).toHaveAttribute("spellcheck", "false");
    expect(email).toHaveAttribute("autocapitalize", "none");
    expect(screen.getByLabelText("Password")).toHaveAttribute("name", "password");

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByLabelText("Name")).toHaveAttribute("name", "name");
  });

  it("reuses the homepage particle field behind a blurred layer that keeps the panel sharp", () => {
    render(<ModernLoginSignup />);

    const main = screen.getByRole("main");
    expect(main).toHaveClass("min-h-screen!");
    expect(main).not.toHaveClass("[color-scheme:dark]");
    expect(document.querySelector("#particles-js")).not.toBeNull();
    expect(document.querySelector(".auth-dot-field")).toBeNull();

    const blur = document.querySelector(".auth-particle-blur");
    expect(blur).toHaveClass("backdrop-blur-[3px]");
    expect(blur).toHaveClass("pointer-events-none");
    expect(screen.getByLabelText("Authentication mode").closest("section")).toHaveClass("z-10");
  });

  it("keeps the submit label legible despite the global button font and color reset", () => {
    render(<ModernLoginSignup />);

    const submit = screen.getByRole("button", { name: "Sign in to SharedNet" });
    expect(submit).toHaveClass("text-white!");
    expect(submit).toHaveClass("font-semibold!");
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveClass("text-[#002147]!");
  });

  it("signs in with email and password, then returns to a safe requested page", async () => {
    navigation.search = new URLSearchParams("next=%2Fdecisions%3Ffocus%3Dmessage_12");
    render(<ModernLoginSignup />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "xisen@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery-staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to SharedNet" }));

    await waitFor(() => {
      expect(authClient.signIn.email).toHaveBeenCalledWith({
        email: "xisen@example.com",
        password: "correct-horse-battery-staple",
      });
    });
    expect(navigation.replace).toHaveBeenCalledWith("/decisions?focus=message_12");
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  it("creates an account with a name, email, and password", async () => {
    render(<ModernLoginSignup />);

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("heading", { name: "Create your SharedNet account" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Xisen  " } });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "  xisen@example.com  " },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery-staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create SharedNet account" }));

    await waitFor(() => {
      expect(authClient.signUp.email).toHaveBeenCalledWith({
        email: "xisen@example.com",
        name: "Xisen",
        password: "correct-horse-battery-staple",
      });
    });
    expect(navigation.replace).toHaveBeenCalledWith("/chat");
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the form in place and explains an authentication failure", async () => {
    authClient.signIn.email.mockResolvedValue({
      data: null,
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
        status: 401,
        statusText: "Unauthorized",
      },
    });
    render(<ModernLoginSignup />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "xisen@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "not-the-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to SharedNet" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email")).toHaveValue("xisen@example.com");
  });

  it("distinguishes an unavailable auth service from incorrect credentials", async () => {
    authClient.signIn.email.mockResolvedValue({
      data: null,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
      },
    });
    render(<ModernLoginSignup />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "xisen@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "not-the-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to SharedNet" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign-in service is unavailable. Try again after the server is ready.",
    );
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("offers no Google button when the deployment has no Google client", () => {
    render(<ModernLoginSignup />);
    expect(screen.queryByRole("button", { name: /google/i })).not.toBeInTheDocument();
  });

  it("sends the requested page through the same guard the password path uses", async () => {
    navigation.search = new URLSearchParams("next=/join/rom_AbCdEfGhIj");
    render(<ModernLoginSignup google />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    await waitFor(() => expect(authClient.signIn.social).toHaveBeenCalledTimes(1));
    expect(authClient.signIn.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/join/rom_AbCdEfGhIj",
      errorCallbackURL: "/login?next=%2Fjoin%2From_AbCdEfGhIj",
    });
  });

  it("comes back to a bare /login when there was nowhere in particular to go", async () => {
    render(<ModernLoginSignup google />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    await waitFor(() => expect(authClient.signIn.social).toHaveBeenCalledTimes(1));
    expect(authClient.signIn.social.mock.calls[0]![0]).toMatchObject({
      callbackURL: "/chat",
      errorCallbackURL: "/login",
    });
  });

  it("explains a Google account already attached to someone else", () => {
    navigation.search = new URLSearchParams("error=account_already_linked_to_different_user");
    render(<ModernLoginSignup google />);

    expect(screen.getByRole("alert")).toHaveTextContent(/already linked to a different/i);
  });

  it("refuses to carry an off-site next through Google, on either leg", async () => {
    navigation.search = new URLSearchParams("next=https://evil.example/steal");
    render(<ModernLoginSignup google />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    await waitFor(() => expect(authClient.signIn.social).toHaveBeenCalledTimes(1));
    expect(authClient.signIn.social.mock.calls[0]![0]).toMatchObject({
      callbackURL: "/chat",
      errorCallbackURL: "/login",
    });
  });

  it("explains a Google round trip that came back unlinked, before anyone clicks", () => {
    navigation.search = new URLSearchParams("error=account_not_linked");
    render(<ModernLoginSignup google />);

    expect(screen.getByRole("alert")).toHaveTextContent(/already uses this email address/i);
  });

  it("explains any other failed Google round trip without naming a code", () => {
    navigation.search = new URLSearchParams("error=state_mismatch");
    render(<ModernLoginSignup google />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/google sign-in did not complete/i);
    expect(alert).not.toHaveTextContent("state_mismatch");
  });

  it("keeps the person on the page when the flow will not even start", async () => {
    authClient.signIn.social.mockResolvedValue({
      data: null,
      error: { message: "Provider not found", status: 400 },
    });
    render(<ModernLoginSignup google />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    // The password path's copy ("check your details") is wrong here: there are
    // no details to check, and the provider's own words are for the log.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/google sign-in did not complete/i),
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("Provider not found");
    expect(screen.getByRole("button", { name: /sign in with google/i })).not.toBeDisabled();
  });

  it("prevents duplicate submissions while authentication is pending", async () => {
    let finishSignIn: ((value: { data: null; error: null }) => void) | undefined;
    authClient.signIn.email.mockImplementation(
      () => new Promise((resolve) => { finishSignIn = resolve; }),
    );
    render(<ModernLoginSignup />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "xisen@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery-staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in to SharedNet" }));

    const pendingButton = await screen.findByRole("button", { name: "Signing in" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(authClient.signIn.email).toHaveBeenCalledTimes(1);

    finishSignIn?.({ data: null, error: null });
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/chat"));
  });
});
