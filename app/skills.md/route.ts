import { buildSkillsIndex } from "@/src/protocol/skills-index";

export function GET(request: Request) {
  return new Response(buildSkillsIndex(new URL(request.url).origin), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
