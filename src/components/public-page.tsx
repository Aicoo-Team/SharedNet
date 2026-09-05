import Link from "next/link";
import type { ReactNode } from "react";

import ParticlesComponent from "@/components/ui/particles-bg";

/**
 * The one look every public page shares with the homepage and the login page:
 * the particle field, softly blurred, with content on frosted paper in the
 * homepage navy. Pages differ only in what they put inside.
 */

const NAV = [
  { href: "/protocol", label: "Protocol" },
  { href: "/skills", label: "Skills" },
  { href: "/developers", label: "Developers" },
  { href: "/api/docs", label: "API" },
] as const;

const NAV_LINK =
  "rounded-sm px-1 py-2 text-sm font-semibold tracking-[-0.01em] transition-colors hover:text-[#205f91] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#002147] sm:text-base";

export const PANEL =
  "rounded-xl border border-[#002147]/20 bg-[oklch(98.5%_0.012_240/0.86)] shadow-[0_18px_50px_rgba(0,33,71,0.14)] backdrop-blur-md";
export const TEXT_LINK =
  "underline underline-offset-4 decoration-[#002147]/40 transition-colors hover:text-[#205f91] hover:decoration-[#205f91]";
export const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-[8px] border border-[#002147] bg-[#002147] px-4 text-[0.875rem]! font-semibold! text-white! transition-colors hover:border-[#0e3560] hover:bg-[#0e3560] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#002147] disabled:cursor-not-allowed disabled:border-[#002147]/40 disabled:bg-[#002147]/40";
export const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-[8px] border border-[#002147]/30 bg-white/70 px-4 text-[0.875rem]! font-semibold! text-[#002147]! transition-colors hover:border-[#002147] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#002147] disabled:cursor-not-allowed disabled:opacity-50";
export const FIELD =
  "h-11 w-full rounded-[8px] border border-[#002147]/25 bg-white/85 px-3 text-[0.9rem] text-[#002147] outline-none transition-colors placeholder:text-[#0e3560]/45 focus:border-[#205f91] focus:ring-1 focus:ring-[#205f91] disabled:cursor-wait disabled:opacity-60";

export function Eyebrow({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="font-mono text-[0.7rem] font-semibold tracking-[0.16em] text-[#0e3560]/75 uppercase">
      {children}
    </p>
  );
}

export function PageTitle({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <h1 className="font-display text-[clamp(2.25rem,5vw,4.25rem)] leading-[0.98] font-[520] tracking-[-0.05em] text-[#002147]">
      {children}
    </h1>
  );
}

export function Lede({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="max-w-[62ch] text-base leading-7 text-[#0e3560] sm:text-lg sm:leading-8">
      {children}
    </p>
  );
}

export function SectionTitle({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <h2 className="mt-3 text-[clamp(1.35rem,2.4vw,1.9rem)] leading-[1.15] font-[600] tracking-[-0.03em] text-[#002147]">
      {children}
    </h2>
  );
}

export function Code({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <code className="rounded bg-[#002147]/8 px-1.5 py-0.5 font-mono text-[0.85em] text-[#002147]">
      {children}
    </code>
  );
}

export function Pre({
  children,
  label,
}: Readonly<{ children: ReactNode; label?: string }>) {
  return (
    <pre
      aria-label={label}
      className="overflow-x-auto rounded-[8px] border border-[#002147] bg-[#002147] p-4 font-mono text-[0.78rem] leading-6 text-[oklch(96%_0.018_240)]"
    >
      {children}
    </pre>
  );
}

export function Panel({
  children,
  className = "",
  ...rest
}: Readonly<{ children: ReactNode; className?: string } & Record<string, unknown>>) {
  return (
    <section className={`${PANEL} p-6 sm:p-8 ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function PublicPage({
  children,
  current,
  wide = false,
}: Readonly<{ children: ReactNode; current?: (typeof NAV)[number]["href"]; wide?: boolean }>) {
  return (
    <main className="relative isolate min-h-screen! overflow-x-hidden bg-[oklch(96.8%_0.025_240)] text-[#002147]">
      <ParticlesComponent />
      <div
        aria-hidden="true"
        className="public-particle-blur pointer-events-none absolute inset-0 z-[1] bg-[oklch(98%_0.015_240/0.08)] backdrop-blur-[3px]"
      />

      <header className="relative z-20">
        <div className="mx-auto flex w-full max-w-[90rem] items-center justify-between px-5 py-6 sm:px-8 sm:py-8 lg:px-12">
          <Link
            className="font-display text-xl font-extrabold tracking-[-0.05em] text-[#002147] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#002147]"
            href="/"
          >
            SharedNet
          </Link>
          <nav aria-label="Public pages" className="flex items-center gap-4 sm:gap-7">
            {NAV.map((item) => (
              <Link
                aria-current={item.href === current ? "page" : undefined}
                className={`${NAV_LINK} ${item.href === current ? "text-[#205f91]" : ""}`}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            ))}
            <Link className={NAV_LINK} href="/chat" prefetch={false}>
              Dashboard
            </Link>
          </nav>
        </div>
      </header>

      <div
        className={`relative z-10 mx-auto w-full ${wide ? "max-w-[90rem]" : "max-w-[78rem]"} px-5 pt-4 pb-24 sm:px-8 lg:px-12`}
      >
        {children}
      </div>
    </main>
  );
}
