import { NextRequest, NextResponse } from "next/server";

export async function proxy(request: NextRequest) {
  if (
    request.nextUrl.pathname === "/protocol" ||
    request.nextUrl.pathname === "/protocol/skill.md"
  ) {
    return NextResponse.next();
  }

  const { getAuth } = await import("./lib/auth");
  const session = await getAuth().api.getSession({
    headers: request.headers,
    query: { disableRefresh: true },
  });

  if (session) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/chat/:path*",
    "/credits/:path*",
    "/network/:path*",
    "/decisions/:path*",
    "/protocol/:path*",
  ],
};
