import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedNetLaunch } from "./sharednet-launch";

function reachOrganization() {
  fireEvent.change(screen.getByLabelText("What do you want to launch?"), {
    target: { value: "Build a customer feedback board" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Shape the product" }));

  for (let index = 0; index < 7; index += 1) {
    fireEvent.click(screen.getByRole("button", { name: "Use a strong default" }));
    fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
  }

  fireEvent.click(screen.getByRole("button", { name: "Form the organization" }));
}

describe("SharedNet Website Launch", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts requirement discovery from a rough idea", () => {
    render(<SharedNetLaunch />);

    fireEvent.change(screen.getByLabelText("What do you want to launch?"), {
      target: { value: "Build a customer feedback board" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Shape the product" }));

    expect(screen.getByRole("heading", { name: "Who is this for?" })).toBeTruthy();
    expect(screen.getByText("Requirement readiness")).toBeTruthy();
    expect(screen.getByText("@sharednet/product")).toBeTruthy();
  });

  it("labels demo infrastructure before any work begins", () => {
    render(<SharedNetLaunch />);

    expect(screen.getByText("SIMULATED")).toBeTruthy();
    expect(screen.getByText("No provider resources will be created.")).toBeTruthy();
  });

  it("turns seven material decisions into a RAC organization", () => {
    render(<SharedNetLaunch />);
    reachOrganization();

    expect(
      screen.getByRole("heading", { name: "The smallest useful company is ready." }),
    ).toBeTruthy();
    expect(screen.getByText("7 selected by RAC")).toBeTruthy();
  });

  it("does not advance Mission work while connector execution is unresolved", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<SharedNetLaunch />);
    reachOrganization();

    fireEvent.click(screen.getByRole("button", { name: "Run the Mission" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText("0 of 7 tasks closed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finish demo now" })).toBeDisabled();
  });

  it("stops for reconciliation instead of presenting a successful handoff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: async () => ({
          status: "reconciliation-required",
          manifests: [
            {
              provider: "vercel",
              mode: "live",
              label: "LIVE",
              resourceName: "project-1",
              status: "reconciliation-required",
              details: { reason: "Inspect provider state before retrying." },
            },
          ],
        }),
      } satisfies Partial<Response>),
    );
    render(<SharedNetLaunch />);
    reachOrganization();

    fireEvent.click(screen.getByRole("button", { name: "Run the Mission" }));

    expect(
      await screen.findByText(
        "Provider state requires reconciliation before this Mission can continue.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("MISSION COMPLETE / EVIDENCE ATTACHED")).toBeNull();
    expect(screen.getByRole("button", { name: "Finish demo now" })).toBeDisabled();
  });

  it("discards corrupt persisted stages instead of rendering a blank workspace", () => {
    window.localStorage.setItem(
      "sharednet:website-launch:v1",
      JSON.stringify({ stage: "unknown-stage", idea: "stale" }),
    );

    render(<SharedNetLaunch />);

    expect(screen.getByLabelText("What do you want to launch?")).toBeTruthy();
  });
});
