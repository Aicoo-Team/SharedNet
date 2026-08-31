"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { aggregateUsage } from "@/src/domain/network-demo";
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
  const usage = aggregateUsage(state.usage);
  const pendingCount = state.decisions.filter(
    (decision) => decision.status === "pending",
  ).length;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <Link className="brand-name" href="/chat">
            SharedNet
          </Link>

          <nav className="primary-nav" aria-label="Primary">
            {navigation.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  className="nav-link"
                  data-active={isActive ? "true" : undefined}
                  href={item.href}
                  key={item.href}
                  aria-label={
                    item.href === "/decisions" && pendingCount > 0
                      ? `Decisions, ${pendingCount} pending`
                      : undefined
                  }
                  aria-current={isActive ? "page" : undefined}
                >
                  {item.label}
                  {item.href === "/decisions" && pendingCount > 0 ? (
                    <span className="decision-count" data-count={pendingCount}>
                      {pendingCount}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <p
            className="usage-ledger"
            aria-label={`Platform usage: ${formatTokenCount(usage.totalTokens)} tokens, $${usage.costUsd.toFixed(2)}`}
          >
            {formatTokenCount(usage.totalTokens)} · ${usage.costUsd.toFixed(2)}
          </p>
        </div>
      </header>
      <main id="main-content">{children}</main>
    </div>
  );
}
