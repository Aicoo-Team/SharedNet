import type { MetadataRoute } from "next";

import { siteUrl } from "@/src/site";

/**
 * Every page worth finding. The signed-in product is not here: it is
 * disallowed in robots.txt and would be a login wall to a crawler.
 *
 * Shared Rooms (`/s/<slug>`) are deliberately absent. They are indexable when
 * an owner publishes one, but they are somebody else's writing, they appear
 * and disappear at that owner's word, and a sitemap is a claim that a URL is
 * worth crawling and will still be there. A shared Room is found the way its
 * owner meant it to be found: by the link they sent.
 */
const PAGES: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/about", priority: 0.8, changeFrequency: "monthly" },
  { path: "/protocol", priority: 0.9, changeFrequency: "monthly" },
  { path: "/skills", priority: 0.8, changeFrequency: "monthly" },
  { path: "/api/docs", priority: 0.9, changeFrequency: "weekly" },
  { path: "/developers", priority: 0.6, changeFrequency: "monthly" },
  // The text surfaces an Agent reads. They are real pages of this site and the
  // only inventory that names them.
  { path: "/skill.md", priority: 0.7, changeFrequency: "monthly" },
  { path: "/skills.md", priority: 0.5, changeFrequency: "monthly" },
  { path: "/llms.txt", priority: 0.6, changeFrequency: "monthly" },
  { path: "/llms-full.txt", priority: 0.6, changeFrequency: "monthly" },
  { path: "/api/v1/openapi.json", priority: 0.5, changeFrequency: "weekly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const lastModified = new Date();
  return PAGES.map(({ path, priority, changeFrequency }) => ({
    url: `${base}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
