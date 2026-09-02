import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ParticlesComponent from "./particles-bg";

type LegacyParticleWindow = Window & {
  particlesJS?: (hostId: string) => void;
};

afterEach(() => {
  delete (window as LegacyParticleWindow).particlesJS;
  vi.restoreAllMocks();
});

describe("ParticlesComponent", () => {
  it("renders a static atmospheric field without allocating scripts or canvases", () => {
    const createElement = vi.spyOn(document, "createElement");
    (window as LegacyParticleWindow).particlesJS = (hostId) => {
      document.getElementById(hostId)?.append(document.createElement("canvas"));
    };

    const { container } = render(<ParticlesComponent />);
    const background = container.querySelector("#particles-js");
    const allocatedTags = createElement.mock.calls.map(([tagName]) =>
      tagName.toLowerCase(),
    );

    expect(background).not.toBeNull();
    expect(background).toHaveAttribute("aria-hidden", "true");
    expect(background).toHaveClass("absolute", "inset-0", "overflow-hidden");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(allocatedTags).not.toContain("script");
    expect(allocatedTags).not.toContain("canvas");
  });
});
