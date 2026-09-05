// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SplitHandle, useSplitWidth } from "./split-handle";

const STORAGE_KEY = "test.split-width";

function Workspace() {
  const split = useSplitWidth({
    defaultWidth: 178,
    maxWidth: 360,
    minWidth: 128,
    storageKey: STORAGE_KEY,
  });

  return (
    <div data-testid="workspace" style={split.style}>
      <SplitHandle label="Resize Rooms sidebar" split={split} />
    </div>
  );
}

function currentWidth() {
  return screen.getByTestId("workspace").style.getPropertyValue("--split-width");
}

describe("SplitHandle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("exposes a keyboard-operable vertical separator with its range", () => {
    render(<Workspace />);

    const handle = screen.getByRole("separator", { name: "Resize Rooms sidebar" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", "128");
    expect(handle).toHaveAttribute("aria-valuemax", "360");
    expect(handle).toHaveAttribute("aria-valuenow", "178");
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(currentWidth()).toBe("178px");
  });

  it("follows a pointer drag, clamped to the allowed range, and remembers the width", () => {
    render(<Workspace />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { button: 0, clientX: 200, pointerId: 1 });
    expect(handle).toHaveAttribute("data-dragging", "true");
    fireEvent.pointerMove(handle, { clientX: 260, pointerId: 1 });
    expect(currentWidth()).toBe("238px");

    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    expect(currentWidth()).toBe("360px");
    fireEvent.pointerUp(handle, { clientX: 900, pointerId: 1 });
    expect(handle).not.toHaveAttribute("data-dragging");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("360");
  });

  it("ignores pointer moves that were not started on the handle", () => {
    render(<Workspace />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 3 });
    expect(currentWidth()).toBe("178px");
  });

  it("nudges with the arrow keys, jumps with Home/End, and resets on Enter or double-click", () => {
    render(<Workspace />);
    const handle = screen.getByRole("separator");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(currentWidth()).toBe("194px");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(currentWidth()).toBe("130px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(currentWidth()).toBe("128px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(currentWidth()).toBe("360px");

    fireEvent.keyDown(handle, { key: "Enter" });
    expect(currentWidth()).toBe("178px");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.doubleClick(handle);
    expect(currentWidth()).toBe("178px");
  });

  it("restores a remembered width on mount, clamped to the range", () => {
    window.localStorage.setItem(STORAGE_KEY, "1000");
    render(<Workspace />);

    expect(currentWidth()).toBe("360px");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "360");
  });
});
