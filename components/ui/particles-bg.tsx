"use client";

import { useCallback, useEffect } from "react";
import Script from "next/script";

const PARTICLE_HOST_ID = "particles-js";
const PARTICLE_SCRIPT_ID = "sharednet-particles-script";
const PARTICLE_SCRIPT_SRC =
  "https://cdn.jsdelivr.net/particles.js/2.0.0/particles.min.js";

type ParticleOptions = {
  particles: Record<string, unknown>;
  interactivity: Record<string, unknown>;
  retina_detect: boolean;
};

type ParticleInstance = {
  pJS?: {
    canvas?: { el?: HTMLCanvasElement };
    fn?: { vendors?: { destroypJS?: () => void } };
  };
};

declare global {
  interface Window {
    particlesJS?: (hostId: string, options: ParticleOptions) => void;
    pJSDom?: ParticleInstance[];
  }
}

function destroyParticles(mountedHost?: HTMLElement | null) {
  if (typeof window === "undefined") return;

  const host = mountedHost ?? document.getElementById(PARTICLE_HOST_ID);
  const remainingInstances: ParticleInstance[] = [];

  for (const instance of window.pJSDom ?? []) {
    const canvas = instance.pJS?.canvas?.el;
    const belongsToHost = Boolean(canvas && host?.contains(canvas));

    if (!belongsToHost) {
      remainingInstances.push(instance);
      continue;
    }

    try {
      instance.pJS?.fn?.vendors?.destroypJS?.();
    } catch {
      canvas?.remove();
    }
  }

  window.pJSDom = remainingInstances;
  host?.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
}

function isDarkTheme(host: HTMLElement) {
  const scopedTheme = host.closest<HTMLElement>("[data-theme]")?.dataset.theme;

  if (scopedTheme) return scopedTheme === "dark";

  const html = document.documentElement;
  return html.classList.contains("dark") || html.dataset.theme === "dark";
}

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function getParticleOptions(
  isDark: boolean,
  reduceMotion: boolean,
): ParticleOptions {
  const colors = isDark
    ? {
        particles: "#00f5ff",
        lines: "#00d9ff",
        accent: "#0096c7",
      }
    : {
        particles: "#0277bd",
        lines: "#0288d1",
        accent: "#039be5",
      };

  return {
    particles: {
      number: {
        value: reduceMotion ? 36 : 140,
        density: { enable: true, value_area: reduceMotion ? 1200 : 800 },
      },
      color: { value: colors.particles },
      shape: {
        type: "circle",
        stroke: { width: 0.5, color: colors.accent },
      },
      opacity: {
        value: reduceMotion ? 0.42 : 0.7,
        random: true,
        anim: {
          enable: !reduceMotion,
          speed: 1,
          opacity_min: 0.3,
        },
      },
      size: {
        value: reduceMotion ? 2 : 3,
        random: true,
        anim: {
          enable: !reduceMotion,
          speed: 2,
          size_min: 1,
        },
      },
      line_linked: {
        enable: true,
        distance: 160,
        color: colors.lines,
        opacity: reduceMotion ? 0.24 : 0.4,
        width: 1.2,
      },
      move: {
        enable: !reduceMotion,
        speed: 2,
        random: true,
        out_mode: "bounce",
      },
    },
    interactivity: {
      detect_on: "canvas",
      events: {
        onhover: { enable: !reduceMotion, mode: "grab" },
        onclick: { enable: !reduceMotion, mode: "push" },
        resize: true,
      },
      modes: {
        grab: { distance: 220, line_linked: { opacity: 0.8 } },
        push: { particles_nb: 4 },
        repulse: { distance: 180, duration: 0.4 },
      },
    },
    retina_detect: true,
  };
}

export default function ParticlesComponent() {
  const initParticles = useCallback(() => {
    const host = document.getElementById(PARTICLE_HOST_ID);

    if (!host || typeof window.particlesJS !== "function") return;

    const reduceMotion = prefersReducedMotion();

    destroyParticles(host);
    window.particlesJS(
      PARTICLE_HOST_ID,
      getParticleOptions(isDarkTheme(host), reduceMotion),
    );
  }, []);

  useEffect(() => {
    const host = document.getElementById(PARTICLE_HOST_ID);
    if (!host) return;

    const observer = new MutationObserver(initParticles);
    const html = document.documentElement;
    const scopedTheme = host.closest<HTMLElement>("[data-theme]");

    observer.observe(html, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    if (scopedTheme && scopedTheme !== html) {
      observer.observe(scopedTheme, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }

    const motionPreference =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    motionPreference?.addEventListener("change", initParticles);

    if (typeof window.particlesJS === "function") initParticles();

    return () => {
      observer.disconnect();
      motionPreference?.removeEventListener("change", initParticles);
      destroyParticles(host);
    };
  }, [initParticles]);

  return (
    <>
      <Script
        id={PARTICLE_SCRIPT_ID}
        onReady={initParticles}
        src={PARTICLE_SCRIPT_SRC}
        strategy="afterInteractive"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 z-0 overflow-hidden bg-gradient-to-tr from-[#e3f2fd] via-[#90caf9] to-[#64b5f6] transition-colors duration-500 dark:from-[#000814] dark:via-[#003566] dark:to-[#0077b6]"
        id={PARTICLE_HOST_ID}
      />
    </>
  );
}
