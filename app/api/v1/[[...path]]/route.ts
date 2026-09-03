import { handleRequest } from "@/packages/server/src/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleRequest(request);
}

export function POST(request: Request) {
  return handleRequest(request);
}

export function PUT(request: Request) {
  return handleRequest(request);
}

export function DELETE(request: Request) {
  return handleRequest(request);
}

export function PATCH(request: Request) {
  return handleRequest(request);
}
