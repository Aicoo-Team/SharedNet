"use client";

import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

export function CopyReadCommand({ command }: Readonly<{ command: string }>) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="pointer-events-auto grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center overflow-hidden rounded-xl border border-[#002147]/25 bg-[oklch(98%_0.015_240/0.78)] text-left shadow-[0_18px_50px_rgba(0,33,71,0.12)] backdrop-blur-sm">
      <span
        aria-hidden="true"
        className="px-4 font-mono text-base font-bold text-[#b45309] sm:px-5"
      >
        $
      </span>
      <code className="overflow-hidden py-4 font-mono text-[clamp(0.72rem,1.4vw,0.92rem)] font-medium text-ellipsis whitespace-nowrap text-[#002147]">
        {command}
      </code>
      <button
        className="min-h-12 border-l border-[#002147]/18 bg-[#002147]/5 px-4 text-xs font-semibold tracking-[0.08em] text-[#002147] uppercase transition-colors hover:bg-[#002147]/10 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[#002147] sm:px-6"
        onClick={() => void copyCommand()}
        type="button"
      >
        {copyState === "copied"
          ? "Copied"
          : copyState === "failed"
            ? "Retry"
            : "Copy"}
      </button>
      <span aria-live="polite" className="sr-only" role="status">
        {copyState === "copied"
          ? "Instruction copied to clipboard."
          : copyState === "failed"
            ? "Copy failed. Try again."
            : ""}
      </span>
    </div>
  );
}
