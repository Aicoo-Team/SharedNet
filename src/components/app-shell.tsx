"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";

const navigation = [
  { href: "/chat", label: "Chat" },
  { href: "/network", label: "Network" },
  { href: "/decisions", label: "Decisions" },
];

export function formatTokenCount(value: number): string {
  if (value < 1_000) return `${value}`;
  return `${(value / 1_000).toFixed(1)}k`;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { state } = useSharedNetDemo();
  const pendingCount = state.decisions.filter(
    (decision) => decision.status === "pending",
  ).length;

  if (pathname === "/") return <>{children}</>;

  return (
    <div className="product-window">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <aside className="product-rail">
        <nav aria-label="Primary surfaces">
          {navigation.map((item) => {
            const isActive = pathname === item.href;
            const isDecisions = item.href === "/decisions";
            const accessibleLabel =
              isDecisions && pendingCount > 0
                ? `Decisions, ${pendingCount} pending`
                : item.label;

            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                aria-label={accessibleLabel}
                className="rail-destination"
                data-active={isActive ? "true" : undefined}
                href={item.href}
                key={item.href}
              >
                <span className="rail-dot" aria-hidden="true" />
                <span className="rail-tooltip" aria-hidden="true">
                  {item.label}
                </span>
                {isDecisions && pendingCount > 0 ? (
                  <span className="rail-decision-badge" aria-hidden="true">
                    {pendingCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="product-surface" id="main-content">
        {children}
      </main>
    </div>
  );
}
