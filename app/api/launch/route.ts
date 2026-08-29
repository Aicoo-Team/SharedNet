import { NextResponse } from "next/server";
import {
  createNeonConnector,
  createVercelConnector,
  getConnectorStatus,
} from "@/src/connectors";

export const runtime = "nodejs";

interface LaunchRequest {
  slug?: unknown;
  mode?: unknown;
  requiresDatabase?: unknown;
  approvedExternalActions?: unknown;
}

function isValidSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 48 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  );
}

export async function POST(request: Request) {
  let body: LaunchRequest;
  try {
    body = (await request.json()) as LaunchRequest;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!isValidSlug(body.slug)) {
    return NextResponse.json(
      { error: "slug must be 1–48 lowercase letters, numbers, or internal hyphens." },
      { status: 400 },
    );
  }

  const mode = body.mode === "live" ? "live" : body.mode === "demo" ? "demo" : null;
  if (!mode) {
    return NextResponse.json({ error: "mode must be demo or live." }, { status: 400 });
  }

  const requiresDatabase = body.requiresDatabase !== false;
  const approved = body.approvedExternalActions === true;
  const connectorEnv = mode === "demo" ? {} : process.env;
  const status = getConnectorStatus(connectorEnv);

  if (mode === "live" && !status.liveExecutionEnabled) {
    return NextResponse.json(
      { error: "Live connectors are disabled by the SharedNet operator." },
      { status: 403 },
    );
  }

  if (
    mode === "live" &&
    (!status.vercel.credentialConfigured ||
      (requiresDatabase && !status.neon.credentialConfigured))
  ) {
    return NextResponse.json(
      { error: "Live launch is unavailable until server-side provider credentials are configured." },
      { status: 409 },
    );
  }

  if (mode === "live" && !approved) {
    return NextResponse.json(
      { error: "Explicit approval is required for external resource creation." },
      { status: 403 },
    );
  }

  try {
    const results = [];
    let databaseUrl: string | undefined;

    if (requiresDatabase) {
      const neon = createNeonConnector(connectorEnv);
      const neonResult = await neon.execute(await neon.plan({ slug: body.slug }), approved);
      databaseUrl = neonResult.details.connectionUri;
      results.push(neon.redact(neonResult));
    }

    const vercel = createVercelConnector(connectorEnv);
    const vercelResult = await vercel.execute(
      await vercel.plan({
        slug: body.slug,
        context: databaseUrl ? { databaseUrl } : {},
      }),
      approved,
    );
    results.push(vercel.redact(vercelResult));

    const reconciliationRequired = results.some(
      (result) => result.status === "reconciliation-required",
    );

    return NextResponse.json(
      {
        mode,
        truthLabel: mode === "demo" ? "SIMULATED" : "LIVE",
        status: reconciliationRequired ? "reconciliation-required" : "ready",
        manifests: results,
      },
      { status: reconciliationRequired ? 202 : 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connector execution failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
