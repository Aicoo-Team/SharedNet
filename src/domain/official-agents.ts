import type { AgentHandle, OfficialAgent } from "./types";

const SHAREDNET_DISCLAIMER =
  "SharedNet-maintained Agent. No affiliation with or endorsement by the named provider is implied.";

export const OFFICIAL_AGENTS: readonly OfficialAgent[] = [
  {
    id: "product",
    handle: "@sharednet/product",
    name: "Product",
    role: "Requirement lead",
    summary: "Turns an idea into decisions that a build team can execute.",
    capabilities: ["requirement interview", "scope control", "acceptance criteria"],
    official: true,
    providerDisclaimer: SHAREDNET_DISCLAIMER,
    accent: "mint",
    avatarInitials: "PR",
  },
  {
    id: "research",
    handle: "@sharednet/research",
    name: "Research",
    role: "Evidence scout",
    summary: "Finds product patterns, constraints, and current integration facts.",
    capabilities: ["market scan", "official documentation", "constraint discovery"],
    official: true,
    providerDisclaimer: SHAREDNET_DISCLAIMER,
    accent: "cyan",
    avatarInitials: "RS",
  },
  {
    id: "architect",
    handle: "@sharednet/architect",
    name: "Architect",
    role: "System designer",
    summary: "Chooses the smallest reliable architecture and defines task boundaries.",
    capabilities: ["system design", "data contracts", "dependency planning"],
    official: true,
    providerDisclaimer: SHAREDNET_DISCLAIMER,
    accent: "violet",
    avatarInitials: "AR",
  },
  {
    id: "builder",
    handle: "@sharednet/builder",
    name: "Builder",
    role: "Implementation worker",
    summary: "Builds the product surface and joins the work produced by specialists.",
    capabilities: ["Next.js", "interaction design", "implementation"],
    official: true,
    providerDisclaimer: SHAREDNET_DISCLAIMER,
    accent: "mint",
    avatarInitials: "BU",
  },
  {
    id: "neon",
    handle: "@sharednet/neon",
    name: "Neon",
    role: "Data-layer specialist",
    summary: "Plans a Postgres schema and provisions a guarded Neon data layer.",
    capabilities: ["Postgres schema", "Neon API", "connection safety"],
    official: true,
    providerDisclaimer: SHAREDNET_DISCLAIMER,
    accent: "cyan",
    avatarInitials: "NE",
  },
  {
    id: "vercel",
    handle: "@sharednet/vercel",
    name: "Vercel",
    role: "Deployment specialist",
    summary: "Packages, configures, and deploys a verified web preview.",
    capabilities: ["Vercel API", "environment variables", "deployment checks"],
    official: true,
    providerDisclaimer: SHAREDNET_DISCLAIMER,
    accent: "amber",
    avatarInitials: "VE",
  },
  {
    id: "quality",
    handle: "@sharednet/quality",
    name: "Quality",
    role: "Independent verifier",
    summary: "Tests the result against acceptance criteria independently of the builder.",
    capabilities: ["functional verification", "risk review", "handoff evidence"],
    official: true,
    providerDisclaimer: SHAREDNET_DISCLAIMER,
    accent: "rose",
    avatarInitials: "QA",
  },
] as const;

export function getOfficialAgent(handle: AgentHandle | string): OfficialAgent {
  const agent = OFFICIAL_AGENTS.find((candidate) => candidate.handle === handle);

  if (!agent) {
    throw new Error(`Unknown official Agent: ${handle}`);
  }

  return agent;
}
