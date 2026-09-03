import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ParticlesComponent from "./particles-bg";

vi.mock("next/script", () => ({
  default: () => null,
}));

type TestParticleOptions = {
  particles: {
    number: { value: number };
    color: { value: string };
    opacity: { value: number; anim: { enable: boolean } };
    size: { value: number; anim: { enable: boolean } };
    move: { enable: boolean };
  };
  interactivity: {
    events: {
      onhover: { enable: boolean; mode: string };
      onclick: { enable: boolean; mode: string };
    };
  };
};

describe("ParticlesComponent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.pJSDom = [];
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    window.particlesJS = vi.fn((hostId, options) => {
      const host = document.getElementById(hostId);
      if (!host) return;

      const canvas = document.createElement("canvas");
      const destroy = vi.fn(() => canvas.remove());
      host.append(canvas);
      window.pJSDom = [
        ...(window.pJSDom ?? []),
        {
          pJS: {
            canvas: { el: canvas },
            fn: { vendors: { destroypJS: destroy } },
          },
        },
      ];

      void options;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.particlesJS;
    delete window.pJSDom;
  });

  it("destroys its particle instance when a route removes the mounted host", () => {
    const view = render(<ParticlesComponent />);

    expect(window.pJSDom).toHaveLength(1);
    const destroy = window.pJSDom?.[0]?.pJS?.fn?.vendors?.destroypJS;

    view.rerender(<div>Next route</div>);

    expect(destroy).toHaveBeenCalledOnce();
    expect(window.pJSDom).toHaveLength(0);
  });

  it("keeps the supplied 140-particle field animated and interactive", () => {
    render(<ParticlesComponent />);

    const particleLoader = vi.mocked(window.particlesJS!);
    const firstOptions = particleLoader.mock.calls[0]?.[1] as unknown as TestParticleOptions;
    expect(firstOptions.particles.number.value).toBe(140);
    expect(firstOptions.particles.color.value).toBe("#0277bd");
    expect(firstOptions.particles.opacity.value).toBe(0.7);
    expect(firstOptions.particles.opacity.anim.enable).toBe(true);
    expect(firstOptions.particles.size.value).toBe(3);
    expect(firstOptions.particles.size.anim.enable).toBe(true);
    expect(firstOptions.particles.move.enable).toBe(true);
    expect(firstOptions.interactivity.events.onhover).toEqual({
      enable: true,
      mode: "grab",
    });
    expect(firstOptions.interactivity.events.onclick).toEqual({
      enable: true,
      mode: "push",
    });

    act(() => vi.advanceTimersByTime(4_800));

    const latestOptions = particleLoader.mock.lastCall?.[1] as unknown as TestParticleOptions;
    expect(latestOptions.particles.move.enable).toBe(true);
  });
});
