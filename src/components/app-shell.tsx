"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { authClient } from "@/lib/auth-client";
import {
  SharedNetProvider,
  useSharedNet,
} from "@/src/context/sharednet-context";

const navigation = [
  { href: "/chat", label: "Rooms" },
  { href: "/network", label: "Network" },
  { href: "/decisions", label: "Decisions" },
];

type Account = Readonly<{
  email: string;
  id: string;
  image?: string | null;
  name: string;
}>;

function AccountControl({ account }: Readonly<{ account: Account }>) {
  const router = useRouter();
  const { principal, status } = useSharedNet();
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const displayName = account.name.trim() || account.email.trim();
  const initial = (displayName || "?").charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);

    try {
      const result = await authClient.signOut();
      if (result.error) {
        setSignOutError(result.error.message || "Unable to sign out. Try again.");
        return;
      }
      router.replace("/login");
    } catch (error) {
      setSignOutError(
        error instanceof Error ? error.message : "Unable to sign out. Try again.",
      );
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="rail-account" ref={controlRef}>
      {open ? (
        <section
          aria-label="Account"
          className="rail-account-panel"
          id="sharednet-account-panel"
          role="region"
        >
          <div>
            <strong>{displayName}</strong>
            <span>{account.email}</span>
          </div>
          <p>
            {principal
              ? `Principal · ${principal.principal_id}`
              : status === "loading"
                ? "Principal loading…"
                : "Principal unavailable"}
          </p>
          {signOutError ? <p className="rail-account-error" role="alert">{signOutError}</p> : null}
          <button disabled={signingOut} onClick={() => void signOut()} type="button">
            {signingOut ? "Signing out" : "Sign out"}
          </button>
        </section>
      ) : null}
      <button
        aria-controls="sharednet-account-panel"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`${open ? "Close" : "Open"} ${displayName} account`}
        className="rail-account-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        {account.image ? <img alt="" src={account.image} /> : <span aria-hidden="true">{initial}</span>}
      </button>
    </div>
  );
}

export function formatTokenCount(value: number): string {
  if (value < 1_000) return `${value}`;
  return `${(value / 1_000).toFixed(1)}k`;
}

function ProductShell({ account, children }: { account: Account; children: ReactNode }) {
  const pathname = usePathname();
  const { decisions } = useSharedNet();
  const pendingCount = decisions.filter(
    (decision) => decision.status === "pending",
  ).length;

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
        <nav aria-label="Setup" className="rail-setup">
          <Link
            aria-current={pathname === "/protocol" ? "page" : undefined}
            aria-label="Agent registration protocol"
            className="rail-destination"
            data-active={pathname === "/protocol" ? "true" : undefined}
            href="/protocol"
          >
            <span className="rail-dot" aria-hidden="true" />
            <span className="rail-tooltip" aria-hidden="true">
              Protocol
            </span>
          </Link>
        </nav>
        <AccountControl account={account} />
      </aside>

      <main className="product-surface" id="main-content">
        {children}
      </main>
    </div>
  );
}

function AuthenticatedProductShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data, isPending } = authClient.useSession();
  const redirectStarted = useRef(false);
  const redirectToLogin = useCallback(() => {
    if (redirectStarted.current) return;
    redirectStarted.current = true;
    const browserSuffix = typeof window === "undefined"
      ? ""
      : `${window.location.search}${window.location.hash}`;
    router.replace(`/login?next=${encodeURIComponent(`${pathname}${browserSuffix}`)}`);
  }, [pathname, router]);

  useEffect(() => {
    if (!isPending && !data) redirectToLogin();
  }, [data, isPending, redirectToLogin]);

  if (isPending || !data) {
    return <main className="account-loading" role="status">Loading account…</main>;
  }

  return (
    <SharedNetProvider key={data.user.id}>
      <ProductShell account={data.user}>{children}</ProductShell>
    </SharedNetProvider>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/" || pathname === "/login") return <>{children}</>;
  return <AuthenticatedProductShell>{children}</AuthenticatedProductShell>;
}
