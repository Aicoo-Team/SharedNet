import { NextResponse } from "next/server";
import { getConnectorStatus } from "@/src/connectors";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(getConnectorStatus(process.env));
}
