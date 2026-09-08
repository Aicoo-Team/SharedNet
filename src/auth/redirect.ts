const DEFAULT_POST_AUTH_PATH = "/chat";
const TRUSTED_ROUTE_ROOTS = ["/chat", "/network", "/decisions", "/protocol", "/join", "/consent"] as const;

export function safePostAuthPath(candidate: string | null | undefined): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return DEFAULT_POST_AUTH_PATH;
  }

  try {
    const destination = new URL(candidate, "https://sharednet.invalid");
    const isTrustedPath = TRUSTED_ROUTE_ROOTS.some(
      (root) => destination.pathname === root || destination.pathname.startsWith(`${root}/`),
    );

    if (destination.origin !== "https://sharednet.invalid" || !isTrustedPath) {
      return DEFAULT_POST_AUTH_PATH;
    }

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return DEFAULT_POST_AUTH_PATH;
  }
}
