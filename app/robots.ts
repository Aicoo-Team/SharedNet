import type { MetadataRoute } from "next";

import { siteUrl } from "@/src/site";

/**
 * What a crawler may fetch. Nothing was blocked before this file existed —
 * a 404 on robots.txt reads as "crawl everything" — so this is less about
 * closing doors than about saying which ones are doors.
 *
 * Two things are closed. `/f/` is a file download whose link key rides in the
 * query string: a crawler that fetched one would put the key in its logs and,
 * if the URL were ever linked, in an index. `/login`, `/chat`, `/network`,
 * `/decisions` and `/credits` are the signed-in product, which is either a
 * redirect to a login wall or a page nobody can read.
 *
 * The AI crawlers are named rather than left to the wildcard. The rule they
 * get is the same one, and saying it explicitly is the difference between a
 * policy and an accident.
 */
const AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "meta-externalagent",
] as const;

const DISALLOW = ["/f/", "/login", "/chat", "/network", "/decisions", "/credits", "/cli/", "/consent", "/api/sharednet/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      ...AGENTS.map((userAgent) => ({ userAgent, allow: "/", disallow: DISALLOW })),
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
