export type AgentHandle =
  | "@sharednet/product"
  | "@sharednet/research"
  | "@sharednet/architect"
  | "@sharednet/builder"
  | "@sharednet/neon"
  | "@sharednet/vercel"
  | "@sharednet/quality";

export interface OfficialAgent {
  id: string;
  handle: AgentHandle;
  name: string;
  role: string;
  summary: string;
  capabilities: string[];
  official: true;
  providerDisclaimer: string;
  accent: "mint" | "cyan" | "violet" | "amber" | "rose";
  avatarInitials: string;
}

export type InterviewDimension =
  | "user"
  | "outcome"
  | "data"
  | "access"
  | "style"
  | "launch"
  | "acceptance";

export type InterviewAnswers = Partial<Record<InterviewDimension, string>>;

export interface DataEntity {
  name: string;
  purpose: string;
  fields: string[];
}

export interface ProductBrief {
  idea: string;
  title: string;
  slug: string;
  summary: string;
  primaryUser: string;
  outcome: string;
  coreLoop: string[];
  dataModel: DataEntity[];
  accessModel: string;
  visualDirection: string;
  launchTarget: string;
  assumptions: string[];
  deferredDecisions: string[];
  acceptanceCriteria: string[];
  requiresDatabase: boolean;
}

export type MissionTaskKind =
  | "research"
  | "architecture"
  | "database"
  | "build"
  | "deploy"
  | "verify"
  | "handoff";

export type MissionTaskStatus =
  | "queued"
  | "runnable"
  | "running"
  | "completed"
  | "blocked"
  | "failed";

export interface MissionTask {
  id: string;
  kind: MissionTaskKind;
  title: string;
  description: string;
  agentHandle: AgentHandle;
  dependencies: string[];
  status: MissionTaskStatus;
  selectionReason: string;
  durationLabel: string;
  artifactIds: string[];
}

export type MissionEventType =
  | "mission_created"
  | "agent_selected"
  | "task_started"
  | "task_completed"
  | "artifact_created"
  | "mission_completed";

export interface MissionEvent {
  id: string;
  sequence: number;
  type: MissionEventType;
  title: string;
  detail: string;
  timestampLabel: string;
  agentHandle?: AgentHandle;
  taskId?: string;
}

export type ArtifactKind =
  | "brief"
  | "architecture"
  | "schema"
  | "source"
  | "readme"
  | "manifest"
  | "verification";

export interface Artifact {
  id: string;
  name: string;
  kind: ArtifactKind;
  language: string;
  content: string;
  producedBy: AgentHandle;
  redacted: boolean;
}

export interface ConnectorManifest {
  provider: "neon" | "vercel";
  mode: "demo" | "live";
  label: "SIMULATED" | "LIVE";
  resourceName: string;
  status: "planned" | "ready" | "created" | "reconciliation-required";
  details: Record<string, string>;
}

export interface VerificationCheck {
  id: string;
  label: string;
  status: "pending" | "passed" | "failed";
  evidence: string;
}

export interface Mission {
  id: string;
  title: string;
  status: "ready" | "running" | "completed" | "failed";
  brief: ProductBrief;
  selectedAgentHandles: AgentHandle[];
  tasks: MissionTask[];
  events: MissionEvent[];
  artifacts: Artifact[];
  connectors: ConnectorManifest[];
  verificationChecks: VerificationCheck[];
  completedWaves: number;
}
