import { buildLlmsIndex } from "@/src/protocol/registration-contract";

export function GET(request: Request) {
  return new Response(buildLlmsIndex(new URL(request.url).origin), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
