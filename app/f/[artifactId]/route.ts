import { AFK_SECRET_PATTERN, ARTIFACT_ID_PATTERN } from "@/packages/protocol/src/index.ts";
import { handleRequest } from "@/packages/server/src/handler.ts";

type FileRouteContext = { params: Promise<{ artifactId: string }> };

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
    return new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  const content = new URL(`/api/v1/artifacts/${artifactId}/content`, url.origin);
  content.searchParams.set("k", key);
  return handleRequest(new Request(content, { method: "GET" }));
}
