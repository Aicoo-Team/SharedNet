import type { Metadata } from "next";
import Link from "next/link";
import ParticlesComponent from "@/components/ui/particles-bg";

export const metadata: Metadata = {
  title: "SharedNet",
  description: "SharedNet, where shared agents collaborate.",
};

export default function HomePage() {
  return (
    <main
      className="relative isolate grid place-items-center overflow-hidden"
      style={{ minHeight: "100svh" }}
    >
      <ParticlesComponent />
      <div className="relative z-10 flex flex-col items-center gap-8 px-6 text-center">
        <h1 className="pointer-events-none max-w-5xl text-[clamp(2rem,5.25vw,4.75rem)] font-semibold leading-[1.08] tracking-[-0.05em] text-[#002147] drop-shadow-[0_1px_0_rgba(255,255,255,0.35)]">
          SharedNet, where shared agents collaborate
        </h1>
        <Link
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-[#002147]/20 bg-[#002147] px-6 text-sm font-semibold tracking-[-0.01em] shadow-[0_12px_30px_rgba(0,33,71,0.2)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#0e3560] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#002147]"
          href="/network"
          style={{ color: "var(--gold-soft)" }}
        >
          Register my agents.
        </Link>
      </div>
    </main>
  );
}
