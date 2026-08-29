import type {
  Connector,
  ConnectorEnvironment,
  ConnectorExecutionResult,
  ConnectorFetcher,
} from "./types";
import {
  isAmbiguousWriteFailure,
  readObject,
  redactSensitiveDetails,
} from "./types";

const NEON_API_BASE = "https://console.neon.tech/api/v2";

const defaultFetcher: ConnectorFetcher = (input, init) => fetch(input, init);

function reconciliationResult(slug: string): ConnectorExecutionResult {
  return {
    provider: "neon",
    mode: "live",
    label: "LIVE",
    resourceName: slug,
    status: "reconciliation-required",
    details: {
      reason: "The create request may have reached Neon. Inspect provider state before retrying.",
    },
  };
}

export function createNeonConnector(
  env: ConnectorEnvironment,
  fetcher: ConnectorFetcher = defaultFetcher,
): Connector {
  const apiKey = env.NEON_API_KEY;
  const mode = apiKey ? "live" : "demo";

  return {
    inspectCapability() {
      return {
        provider: "neon",
        mode,
        available: true,
        credentialConfigured: Boolean(apiKey),
        externalWrites: mode === "live",
      };
    },

    async plan(input) {
      return {
        provider: "neon",
        mode,
        slug: input.slug,
        context: input.context ?? {},
        actions:
          mode === "demo"
            ? ["Generate a clearly labeled simulated Neon project manifest"]
            : [
                "Create a Neon project",
                "Resolve its connection URI server-side",
                "Return only a redacted manifest to the browser",
              ],
      };
    },

    requireApproval(plan) {
      return plan.mode === "live";
    },

    async execute(plan, approvedExternalActions) {
      if (plan.provider !== "neon" || plan.mode !== mode) {
        throw new Error("Connector plan does not belong to this Neon adapter.");
      }

      if (mode === "demo") {
        return {
          provider: "neon",
          mode: "demo",
          label: "SIMULATED",
          resourceName: `demo-neon/${plan.slug}`,
          status: "ready",
          details: {
            namespace: `demo-neon/${plan.slug}`,
            host: "demo-neon.sharednet.invalid",
            region: "aws-us-east-2",
          },
        };
      }

      if (!approvedExternalActions) {
        throw new Error("Explicit approval is required before live Neon resource creation.");
      }

      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };

      let createResponse;
      try {
        createResponse = await fetcher(`${NEON_API_BASE}/projects`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            project: {
              name: plan.slug,
              region_id: env.NEON_REGION ?? "aws-us-east-2",
            },
          }),
        });
      } catch {
        return reconciliationResult(plan.slug);
      }

      if (!createResponse.ok) {
        if (isAmbiguousWriteFailure(createResponse.status)) {
          return reconciliationResult(plan.slug);
        }
        throw new Error(`Neon project creation failed with status ${createResponse.status}.`);
      }

      const createBody = readObject(await createResponse.json());
      const project = readObject(createBody.project);
      const projectId = typeof project.id === "string" ? project.id : "";
      if (!projectId) {
        return reconciliationResult(plan.slug);
      }

      const uriResponse = await fetcher(
        `${NEON_API_BASE}/projects/${encodeURIComponent(projectId)}/connection_uri`,
        { method: "GET", headers },
      );
      if (!uriResponse.ok) {
        return reconciliationResult(plan.slug);
      }
      const uriBody = readObject(await uriResponse.json());
      const connectionUri = typeof uriBody.uri === "string" ? uriBody.uri : "";

      return {
        provider: "neon",
        mode: "live",
        label: "LIVE",
        resourceName: projectId,
        status: "created",
        details: {
          projectId,
          region: env.NEON_REGION ?? "aws-us-east-2",
          connectionUri,
        },
      };
    },

    async verify(result) {
      return {
        passed: result.status === "ready" || result.status === "created",
        evidence:
          result.status === "reconciliation-required"
            ? "Provider state must be reconciled manually."
            : `${result.label} Neon data layer is ready.`,
      };
    },

    redact(result) {
      return { ...result, details: redactSensitiveDetails(result.details) };
    },
  };
}
