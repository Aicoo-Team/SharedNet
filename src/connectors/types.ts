export type ConnectorProvider = "neon" | "vercel";
export type ConnectorMode = "demo" | "live";

export type ConnectorEnvironment = Record<string, string | undefined>;

export interface ConnectorCapability {
  provider: ConnectorProvider;
  mode: ConnectorMode;
  available: boolean;
  credentialConfigured: boolean;
  externalWrites: boolean;
}

export interface ConnectorPlanInput {
  slug: string;
  context?: Record<string, string>;
}

export interface ConnectorPlan {
  provider: ConnectorProvider;
  mode: ConnectorMode;
  slug: string;
  actions: string[];
  context: Record<string, string>;
}

export interface ConnectorExecutionResult {
  provider: ConnectorProvider;
  mode: ConnectorMode;
  label: "SIMULATED" | "LIVE";
  resourceName: string;
  status: "ready" | "created" | "reconciliation-required";
  details: Record<string, string>;
}

export interface ConnectorVerification {
  passed: boolean;
  evidence: string;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type ConnectorFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<FetchResponse>;

export interface Connector {
  inspectCapability(): ConnectorCapability;
  plan(input: ConnectorPlanInput): Promise<ConnectorPlan>;
  requireApproval(plan: ConnectorPlan): boolean;
  execute(
    plan: ConnectorPlan,
    approvedExternalActions: boolean,
  ): Promise<ConnectorExecutionResult>;
  verify(result: ConnectorExecutionResult): Promise<ConnectorVerification>;
  redact(result: ConnectorExecutionResult): ConnectorExecutionResult;
}

export function isAmbiguousWriteFailure(status: number): boolean {
  return status === 423 || status >= 500;
}

export function redactSensitiveDetails(
  details: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      /(secret|token|password|connection.*uri|database.*url)/i.test(key)
        ? "[REDACTED]"
        : value,
    ]),
  );
}

export function readObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
