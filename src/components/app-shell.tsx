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
          <div className="brand-cluster" aria-label="SharedNet demo">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="brand-name">SharedNet</span>
            <span className="demo-label">DEMO NETWORK</span>
          </div>

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
                      {pendingCount} pending
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <details className="usage-details">
            <summary
              aria-label={`Open platform usage ledger: ${formatTokenCount(usage.totalTokens)} tokens, $${usage.costUsd.toFixed(2)}`}
            >
              <span data-compact={formatTokenCount(usage.totalTokens)}>
                {formatTokenCount(usage.totalTokens)} tokens
              </span>
              <strong>${usage.costUsd.toFixed(2)}</strong>
            </summary>
            <div className="usage-popover">
              <p className="eyebrow">Platform usage · demo</p>
              <dl>
                <div>
                  <dt>Input</dt>
                  <dd>{usage.inputTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{usage.outputTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Cached</dt>
                  <dd>{usage.cachedTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Normalized cost</dt>
                  <dd>${usage.costUsd.toFixed(3)}</dd>
                </div>
              </dl>
            </div>
          </details>
        </div>
      </header>
      <main id="main-content">{children}</main>
    </div>
  );
}
