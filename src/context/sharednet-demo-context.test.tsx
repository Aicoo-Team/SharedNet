import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SharedNetDemoProvider,
  useSharedNetDemo,
} from "./sharednet-demo-context";

function StateProbe() {
  const { state } = useSharedNetDemo();
  return <p>{state.principals.map((principal) => principal.handle).join(" ")}</p>;
}

describe("SharedNet demo persistence", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps the canonical demo usable when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    expect(() =>
      render(
        <SharedNetDemoProvider>
          <StateProbe />
        </SharedNetDemoProvider>,
      ),
    ).not.toThrow();
    expect(screen.getByText("@xisen @aicoo")).toBeTruthy();
  });
});
