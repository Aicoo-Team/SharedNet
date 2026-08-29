import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SharedNetLaunch } from "./sharednet-launch";

describe("SharedNet Website Launch", () => {
  beforeEach(() => window.localStorage.clear());

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
    fireEvent.change(screen.getByLabelText("What do you want to launch?"), {
      target: { value: "Build a customer feedback board" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Shape the product" }));

    for (let index = 0; index < 7; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Use a strong default" }));
      fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
    }

    expect(
      screen.getByRole("heading", { name: "Customer Feedback Board" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Form the organization" }));
    expect(
      screen.getByRole("heading", { name: "The smallest useful company is ready." }),
    ).toBeTruthy();
    expect(screen.getByText("7 selected by RAC")).toBeTruthy();
  });
});
