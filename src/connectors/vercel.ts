import type {
  Connector,
  ConnectorEnvironment,
  ConnectorExecutionResult,
  ConnectorFetcher,
  FetchResponse,
} from "./types";
import {
  isAmbiguousWriteFailure,
  readObject,
  redactSensitiveDetails,
} from "./types";

const VERCEL_API_BASE = "https://api.vercel.com";
const defaultFetcher: ConnectorFetcher = (input, init) => fetch(input, init);

function withTeam(path: string, teamId: string | undefined): string {
  const url = new URL(`${VERCEL_API_BASE}${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

function reconciliationResult(slug: string, stage: string): ConnectorExecutionResult {
  return {
    provider: "vercel",
    mode: "live",
    label: "LIVE",
    resourceName: slug,
    status: "reconciliation-required",
    details: {
      reason: `The ${stage} request may have reached Vercel. Inspect provider state before retrying.`,
    },
  };
}

async function postJson(
  fetcher: ConnectorFetcher,
  url: string,
  token: string,
  body: unknown,
): Promise<FetchResponse> {
  return fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function createVercelConnector(
  env: ConnectorEnvironment,
  fetcher: ConnectorFetcher = defaultFetcher,
): Connector {
  const token = env.VERCEL_TOKEN;
  const mode = token ? "live" : "demo";

  return {
    inspectCapability() {
      return {
        provider: "vercel",
        mode,
        available: true,
        credentialConfigured: Boolean(token),
        externalWrites: mode === "live",
      };
    },

    async plan(input) {
      return {
        provider: "vercel",
        mode,
        slug: input.slug,
        context: input.context ?? {},
        actions:
          mode === "demo"
            ? ["Generate a clearly labeled simulated deployment URL"]
            : [
                "Create or target a Vercel project",
                "Attach server-owned environment configuration",
                "Create a preview deployment",
              ],
      };
    },

    requireApproval(plan) {
      return plan.mode === "live";
    },

    async execute(plan, approvedExternalActions) {
      if (plan.provider !== "vercel" || plan.mode !== mode) {
        throw new Error("Connector plan does not belong to this Vercel adapter.");
      }

      if (mode === "demo") {
        return {
          provider: "vercel",
          mode: "demo",
          label: "SIMULATED",
          resourceName: `demo-vercel/${plan.slug}`,
          status: "ready",
          details: {
            url: `https://${plan.slug}.sharednet-demo.local`,
            target: "preview",
            framework: "nextjs",
          },
        };
      }

      if (!approvedExternalActions) {
        throw new Error("Explicit approval is required before live Vercel resource creation.");
      }

      const teamId = env.VERCEL_TEAM_ID;
      let projectId = env.VERCEL_PROJECT_ID ?? "";

      if (!projectId) {
        let projectResponse;
        try {
          projectResponse = await postJson(
            fetcher,
            withTeam("/v10/projects", teamId),
            token!,
            { name: plan.slug, framework: null },
          );
        } catch {
          return reconciliationResult(plan.slug, "project creation");
        }
        if (!projectResponse.ok) {
          if (isAmbiguousWriteFailure(projectResponse.status)) {
            return reconciliationResult(plan.slug, "project creation");
          }
          throw new Error(
            `Vercel project creation failed with status ${projectResponse.status}.`,
          );
        }
        try {
          const projectBody = readObject(await projectResponse.json());
          projectId =
            typeof projectBody.id === "string"
              ? projectBody.id
              : typeof projectBody.name === "string"
                ? projectBody.name
                : "";
        } catch {
          return reconciliationResult(plan.slug, "project creation");
        }
        if (!projectId) return reconciliationResult(plan.slug, "project creation");
      }

      if (plan.context.databaseUrl) {
        let envResponse;
        try {
          envResponse = await postJson(
            fetcher,
            withTeam(`/v10/projects/${encodeURIComponent(projectId)}/env`, teamId),
            token!,
            {
              key: "DATABASE_URL",
              value: plan.context.databaseUrl,
              type: "encrypted",
              target: ["preview", "production"],
            },
          );
        } catch {
          return reconciliationResult(plan.slug, "environment configuration");
        }
        if (!envResponse.ok) {
          return reconciliationResult(plan.slug, "environment configuration");
        }
      }

      let deploymentResponse;
      try {
        deploymentResponse = await postJson(
          fetcher,
          withTeam("/v13/deployments", teamId),
          token!,
          {
            name: plan.slug,
            project: projectId,
            target: null,
            files: [
              {
                file: "index.html",
                data: `<main><h1>${plan.slug}</h1><p>Launched by SharedNet.</p></main>`,
              },
            ],
            projectSettings: { framework: null },
          },
        );
      } catch {
        return reconciliationResult(plan.slug, "deployment creation");
      }
      if (!deploymentResponse.ok) {
        if (isAmbiguousWriteFailure(deploymentResponse.status)) {
          return reconciliationResult(plan.slug, "deployment creation");
        }
        throw new Error(
          `Vercel deployment failed with status ${deploymentResponse.status}.`,
        );
      }
      let deploymentBody: Record<string, unknown>;
      try {
        deploymentBody = readObject(await deploymentResponse.json());
      } catch {
        return reconciliationResult(plan.slug, "deployment creation");
      }
      const deploymentId =
        typeof deploymentBody.id === "string" ? deploymentBody.id : "unknown";
      const deploymentHost =
        typeof deploymentBody.url === "string" ? deploymentBody.url : "";

      return {
        provider: "vercel",
        mode: "live",
        label: "LIVE",
        resourceName: projectId,
        status: "created",
        details: {
          projectId,
          deploymentId,
          url: deploymentHost ? `https://${deploymentHost}` : "pending",
          target: "preview",
        },
      };
    },

    async verify(result) {
      return {
        passed: result.status === "ready" || result.status === "created",
        evidence:
          result.status === "reconciliation-required"
            ? "Provider state must be reconciled manually."
            : `${result.label} preview deployment is available at ${result.details.url}.`,
      };
    },

    redact(result) {
      return { ...result, details: redactSensitiveDetails(result.details) };
    },
  };
}
