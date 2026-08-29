import { createNeonConnector } from "./neon";
import type { ConnectorEnvironment } from "./types";
import { createVercelConnector } from "./vercel";

export { createNeonConnector } from "./neon";
export type * from "./types";
export { createVercelConnector } from "./vercel";

export function getConnectorStatus(env: ConnectorEnvironment) {
  const neon = createNeonConnector(env).inspectCapability();
  const vercel = createVercelConnector(env).inspectCapability();

  return {
    liveExecutionEnabled: env.SHAREDNET_ENABLE_LIVE_CONNECTORS === "true",
    neon: {
      mode: neon.mode,
      available: neon.available,
      credentialConfigured: neon.credentialConfigured,
    },
    vercel: {
      mode: vercel.mode,
      available: vercel.available,
      credentialConfigured: vercel.credentialConfigured,
    },
  };
}
