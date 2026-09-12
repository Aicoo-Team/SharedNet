import { AFK_SECRET_PATTERN, ARTIFACT_ID_PATTERN } from "@/packages/protocol/src/index.ts";
import { handleRequest } from "@/packages/server/src/handler.ts";

type FileRouteContext = { params: Promise<{ artifactId: string }> };

/**
 * A file's link carries its key in the query string. robots.txt asks a
 * crawler not to fetch such a URL, but a URL that somebody links to can be
 * indexed without ever being fetched — and it would be indexed *with the key
 * in it*. This header travels with the response instead of with the policy,
 * The sitewide `Referrer-Policy: strict-origin-when-cross-origin` already
 * keeps the key out of cross-origin referrers, and an attachment renders no
 * page that could make a same-origin request carrying it.
 */
function withCrawlerRefusal(answer: Response): Response {
  const headers = new Headers(answer.headers);
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

/**
 * A file's public link: `/f/art_…?k=afk_…`. The short path exists because
 * this is what an Agent pastes into a Room and a person clicks in a browser;
 * it hands the request to the V1 route that owns the rules, so there is one
 * place that decides who may read a file.
 */
/**
 * The same door, without the bytes. A client that has the link but only wants
 * to know what is behind it — the Room, drawing a card for a pasted link —
 * asks HEAD and reads the name, size and type off the headers the GET would
 * have sent. Same key, same refusal; the body is what is left out, so this
 * grants nothing GET does not.
 */
export async function HEAD(request: Request, context: FileRouteContext): Promise<Response> {
  const answer = await GET(request, context);
  return new Response(null, { status: answer.status, headers: answer.headers });
}

export async function GET(request: Request, { params }: FileRouteContext): Promise<Response> {
  const { artifactId } = await params;
  const url = new URL(request.url);
  const key = url.searchParams.get("k") ?? "";
  if (!ARTIFACT_ID_PATTERN.test(artifactId) || !AFK_SECRET_PATTERN.test(key)) {
    // A malformed link reads exactly like one that opens nothing.
    return withCrawlerRefusal(new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } }));
  }
  const content = new URL(`/api/v1/artifacts/${artifactId}/content`, url.origin);
  content.searchParams.set("k", key);
  const answer = await handleRequest(new Request(content, { method: "GET" }));
  return withCrawlerRefusal(answer);
}
