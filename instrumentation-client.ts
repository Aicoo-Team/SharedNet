/**
 * Runs after the document loads and before React hydrates, which is where
 * analytics belongs: it is in place before the first interaction, and it is
 * not a provider wrapped around the tree. Keep this file thin — Next warns if
 * client instrumentation takes longer than 16ms.
 *
 * `initAnalytics` does nothing when `NEXT_PUBLIC_POSTHOG_KEY` is unset, which
 * is every local checkout and every CI run.
 */
import { initAnalytics } from "@/src/analytics/posthog";

initAnalytics();
