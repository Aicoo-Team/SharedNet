export type PrincipalKind = "self" | "connected";
export type RuntimeKind = "local" | "cloud" | "vpc";
export type AgentStatus = "online" | "idle";
export type DecisionType =
  | "recruitment"
  | "inbound_use"
  | "authorization"
  | "plan";
export type DecisionStatus = "pending" | "approved" | "denied";
export type DecisionResponseMode = "approval" | "text";
export type MessageKind = "user" | "plan" | "coordination" | "work" | "result";

export interface Principal {
  id: string;
  handle: string;
  name: string;
  kind: PrincipalKind;
  summary: string;
}

export interface AgentRuntime {
  kind: RuntimeKind;
  label: string;
  environment: string;
}

export interface Agent {
  id: string;
  principalId: string;
  handle: string;
  name: string;
  role: string;
  summary: string;
  capabilities: string[];
  runtime: AgentRuntime;
  discoverability: "private" | "connections";
  status: AgentStatus;
  official: boolean;
}

export interface PrincipalConnection {
  id: string;
  fromPrincipalId: string;
  toPrincipalId: string;
  status: "connected";
  permission: string;
}

export interface TaskRecruitment {
  id: string;
  taskId: string;
  principalId: string;
  agentIds: string[];
  status: "pending" | "approved" | "denied";
  reason: string;
}

export interface DemoTask {
  id: string;
  prompt: string;
  status: "awaiting_decisions" | "ready";
  selectedAgentIds: string[];
  createdAt: string;
}

export interface TranscriptMessage {
  id: string;
  taskId: string;
  kind: MessageKind;
  title?: string;
  content: string;
  details?: string[];
  agentId?: string;
  agentIds?: string[];
  contributions?: Array<{
    agentId: string;
    output: string;
  }>;
  actionHref?: string;
  actionLabel?: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  taskId?: string;
  recruitmentId?: string;
  type: DecisionType;
  title: string;
  description: string;
  consequence: string;
  requestedByAgentId: string;
  subjectAgentIds: string[];
  status: DecisionStatus;
  responseMode?: DecisionResponseMode;
  approveLabel: string;
  denyLabel: string;
  createdAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface UsageEntry {
  id: string;
  taskId: string;
  principalId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface UsageAggregate {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface DemoEvent {
  id: string;
  type: "decision_requested" | "decision_resolved" | "task_created";
  title: string;
  timestamp: string;
  decisionId?: string;
  taskId?: string;
}

export interface SharedNetDemoState {
  version: 3;
  principals: Principal[];
  agents: Agent[];
  connections: PrincipalConnection[];
  recruitments: TaskRecruitment[];
  tasks: DemoTask[];
  messages: TranscriptMessage[];
  decisions: Decision[];
  usage: UsageEntry[];
  events: DemoEvent[];
  selectedAgentId: string;
}

const OWN_AGENT_IDS = [
  "agent-xisen-planner",
  "agent-xisen-codex",
  "agent-xisen-research",
  "agent-xisen-reviewer",
];

const EXTERNAL_AGENT_IDS = [
  "agent-aicoo-web-builder",
  "agent-aicoo-design-engineer",
  "agent-aicoo-neon",
  "agent-aicoo-vercel",
  "agent-aicoo-quality",
];

const WEBSITE_AGENT_IDS = [...OWN_AGENT_IDS, ...EXTERNAL_AGENT_IDS];

const principals: Principal[] = [
  {
    id: "principal-xisen",
    handle: "@xisen",
    name: "Xisen",
    kind: "self",
    summary: "Your identity, policies, and persistent Agents.",
  },
  {
    id: "principal-aicoo",
    handle: "@aicoo",
    name: "Aicoo",
    kind: "connected",
    summary: "A connected company Principal with discoverable specialist Agents.",
  },
];

const agents: Agent[] = [
  {
    id: "agent-xisen-planner",
    principalId: "principal-xisen",
    handle: "@xisen/planner",
    name: "Planner",
    role: "Planning Agent",
    summary: "Turns outcomes into task graphs and decides when the network helps.",
    capabilities: ["task planning", "candidate selection", "coordination"],
    runtime: {
      kind: "local",
      label: "Codex on Xisen’s Mac",
      environment: "Local SharedOS workspace",
    },
    discoverability: "private",
    status: "online",
    official: false,
  },
  {
    id: "agent-xisen-codex",
    principalId: "principal-xisen",
    handle: "@xisen/codex",
    name: "Codex",
    role: "Implementation Agent",
    summary: "Owns the repository and integrates specialist contributions.",
    capabilities: ["coding", "integration", "tests"],
    runtime: {
      kind: "local",
      label: "Codex runtime",
      environment: "Task workspace · local sandbox",
    },
    discoverability: "connections",
    status: "online",
    official: false,
  },
  {
    id: "agent-xisen-research",
    principalId: "principal-xisen",
    handle: "@xisen/research",
    name: "Research",
    role: "Research Agent",
    summary: "Collects product context and primary implementation evidence.",
    capabilities: ["web research", "API research", "synthesis"],
    runtime: {
      kind: "cloud",
      label: "SharedNet Cloud",
      environment: "Persistent research workspace",
    },
    discoverability: "connections",
    status: "idle",
    official: false,
  },
  {
    id: "agent-xisen-reviewer",
    principalId: "principal-xisen",
    handle: "@xisen/reviewer",
    name: "Reviewer",
    role: "Independent Verifier",
    summary: "Checks evidence without inheriting the builder’s assumptions.",
    capabilities: ["code review", "acceptance tests", "risk checks"],
    runtime: {
      kind: "cloud",
      label: "SharedNet Cloud",
      environment: "Isolated verification sandbox",
    },
    discoverability: "private",
    status: "idle",
    official: false,
  },
  {
    id: "agent-aicoo-web-builder",
    principalId: "principal-aicoo",
    handle: "@aicoo/web-builder",
    name: "Web Builder",
    role: "Website Specialist",
    summary: "Builds production-oriented web products from a concise outcome.",
    capabilities: ["Next.js", "product implementation", "responsive UI"],
    runtime: {
      kind: "cloud",
      label: "Aicoo Cloud",
      environment: "Ephemeral task sandbox",
    },
    discoverability: "connections",
    status: "online",
    official: true,
  },
  {
    id: "agent-aicoo-design-engineer",
    principalId: "principal-aicoo",
    handle: "@aicoo/design-engineer",
    name: "Design Engineer",
    role: "Interface Specialist",
    summary: "Shapes clear interaction systems and production-ready interface code.",
    capabilities: ["interaction design", "design systems", "accessibility"],
    runtime: {
      kind: "cloud",
      label: "Aicoo Cloud",
      environment: "Ephemeral design sandbox",
    },
    discoverability: "connections",
    status: "online",
    official: true,
  },
  {
    id: "agent-aicoo-neon",
    principalId: "principal-aicoo",
    handle: "@aicoo/neon",
    name: "Neon",
    role: "Database Specialist",
    summary: "Designs Neon schemas, migrations, and least-privilege integration plans.",
    capabilities: ["Postgres", "Neon API", "schema design"],
    runtime: {
      kind: "cloud",
      label: "Aicoo Cloud",
      environment: "Provider-isolated sandbox",
    },
    discoverability: "connections",
    status: "online",
    official: true,
  },
  {
    id: "agent-aicoo-vercel",
    principalId: "principal-aicoo",
    handle: "@aicoo/vercel",
    name: "Vercel",
    role: "Deployment Specialist",
    summary: "Prepares Vercel projects, environment bindings, and deployment checks.",
    capabilities: ["Vercel API", "deployments", "environment variables"],
    runtime: {
      kind: "cloud",
      label: "Aicoo Cloud",
      environment: "Provider-isolated sandbox",
    },
    discoverability: "connections",
    status: "online",
    official: true,
  },
  {
    id: "agent-aicoo-quality",
    principalId: "principal-aicoo",
    handle: "@aicoo/quality",
    name: "Quality",
    role: "Launch Verifier",
    summary: "Independently verifies behavior, accessibility, and launch readiness.",
    capabilities: ["browser QA", "accessibility", "release evidence"],
    runtime: {
      kind: "cloud",
      label: "Aicoo Cloud",
      environment: "Independent verification sandbox",
    },
    discoverability: "connections",
    status: "idle",
    official: true,
  },
];

const historicalUsage: UsageEntry[] = [
  {
    id: "usage-history-planner",
    taskId: "task-history-brief",
    principalId: "principal-xisen",
    agentId: "agent-xisen-planner",
    model: "gpt-5.6-terra",
    inputTokens: 3_200,
    outputTokens: 540,
    cachedTokens: 800,
    costUsd: 0.014,
    timestamp: "2026-08-30T09:41:00.000Z",
  },
  {
    id: "usage-history-codex",
    taskId: "task-history-brief",
    principalId: "principal-xisen",
    agentId: "agent-xisen-codex",
    model: "gpt-5.6-sol",
    inputTokens: 7_400,
    outputTokens: 2_100,
    cachedTokens: 1_800,
    costUsd: 0.058,
    timestamp: "2026-08-30T09:45:00.000Z",
  },
  {
    id: "usage-history-quality",
    taskId: "task-history-brief",
    principalId: "principal-aicoo",
    agentId: "agent-aicoo-quality",
    model: "claude-sonnet",
    inputTokens: 1_900,
    outputTokens: 580,
    cachedTokens: 240,
    costUsd: 0.012,
    timestamp: "2026-08-30T09:50:00.000Z",
  },
];

const initialDecisions: Decision[] = [
  {
    id: "decision-inbound-aicoo-research",
    type: "inbound_use",
    title: "Aicoo wants to use your Research Agent",
    description:
      "@aicoo/web-builder requested @xisen/research for a 20-minute API landscape scan.",
    consequence:
      "Approval grants task-scoped access to the Agent, not your other Agents or files.",
    requestedByAgentId: "agent-aicoo-web-builder",
    subjectAgentIds: ["agent-xisen-research"],
    status: "pending",
    responseMode: "approval",
    approveLabel: "Allow once",
    denyLabel: "Decline",
    createdAt: "2026-08-30T10:04:00.000Z",
  },
  {
    id: "decision-plan-background",
    type: "plan",
    title: "Move the verification pass to Cloud?",
    description:
      "@xisen/planner recommends detaching the long browser suite from the local runtime.",
    consequence:
      "Approval wakes an isolated SharedNet Cloud environment; denial keeps the work local.",
    requestedByAgentId: "agent-xisen-planner",
    subjectAgentIds: ["agent-xisen-reviewer"],
    status: "pending",
    responseMode: "text",
    approveLabel: "Run in Cloud",
    denyLabel: "Keep local",
    createdAt: "2026-08-30T10:05:00.000Z",
  },
];

export function createInitialDemoState(): SharedNetDemoState {
  return {
    version: 3,
    principals: structuredClone(principals),
    agents: structuredClone(agents),
    connections: [
      {
        id: "connection-xisen-aicoo",
        fromPrincipalId: "principal-xisen",
        toPrincipalId: "principal-aicoo",
        status: "connected",
        permission: "Discover public AgentCards and request task-scoped recruitment",
      },
    ],
    recruitments: [],
    tasks: [],
    messages: [],
    decisions: structuredClone(initialDecisions),
    usage: structuredClone(historicalUsage),
    events: initialDecisions.map((decision) => ({
      id: `event-${decision.id}`,
      type: "decision_requested" as const,
      title: decision.title,
      timestamp: decision.createdAt,
      decisionId: decision.id,
    })),
    selectedAgentId: "agent-xisen-planner",
  };
}

export function aggregateUsage(entries: UsageEntry[]): UsageAggregate {
  const totals = entries.reduce(
    (aggregate, entry) => ({
      inputTokens: aggregate.inputTokens + entry.inputTokens,
      outputTokens: aggregate.outputTokens + entry.outputTokens,
      cachedTokens: aggregate.cachedTokens + entry.cachedTokens,
      totalTokens: aggregate.totalTokens + entry.inputTokens + entry.outputTokens,
      costUsd: aggregate.costUsd + entry.costUsd,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  );

  return {
    ...totals,
    costUsd: Number(totals.costUsd.toFixed(6)),
  };
}

function timestamp(sequence: number, offset: number): string {
  return new Date(Date.UTC(2026, 7, 30, 10, 10 + sequence * 8 + offset)).toISOString();
}

function createTaskUsage(taskId: string, sequence: number): UsageEntry[] {
  const rows = [
    ["agent-xisen-planner", "principal-xisen", "gpt-5.6-terra", 1_800, 760, 400, 0.011],
    ["agent-xisen-research", "principal-xisen", "gpt-5.6-terra", 1_200, 580, 220, 0.006],
    ["agent-xisen-codex", "principal-xisen", "gpt-5.6-sol", 8_200, 3_200, 2_400, 0.073],
    ["agent-xisen-reviewer", "principal-xisen", "gpt-5.6-terra", 2_600, 820, 900, 0.018],
    ["agent-aicoo-web-builder", "principal-aicoo", "claude-sonnet", 5_200, 2_100, 800, 0.052],
    ["agent-aicoo-design-engineer", "principal-aicoo", "claude-sonnet", 2_400, 900, 300, 0.018],
    ["agent-aicoo-neon", "principal-aicoo", "gpt-5.4", 1_600, 620, 150, 0.009],
    ["agent-aicoo-vercel", "principal-aicoo", "gpt-5.4", 1_300, 440, 100, 0.007],
    ["agent-aicoo-quality", "principal-aicoo", "claude-sonnet", 2_100, 760, 450, 0.013],
  ] as const;

  return rows.map(
    ([agentId, principalId, model, inputTokens, outputTokens, cachedTokens, costUsd], index) => ({
      id: `usage-${sequence}-${index + 1}`,
      taskId,
      principalId,
      agentId,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      timestamp: timestamp(sequence, index),
    }),
  );
}

export function submitChatPrompt(
  state: SharedNetDemoState,
  rawPrompt: string,
): SharedNetDemoState {
  const prompt = rawPrompt.trim();
  if (!prompt) return state;

  const sequence = state.tasks.length + 1;
  const taskId = `task-network-${sequence}`;
  const recruitmentId = `recruitment-aicoo-${sequence}`;
  const recruitmentDecisionId = `decision-recruitment-${sequence}`;
  const authorizationDecisionId = `decision-authorization-${sequence}`;
  const createdAt = timestamp(sequence, 0);

  const task: DemoTask = {
    id: taskId,
    prompt,
    status: "awaiting_decisions",
    selectedAgentIds: WEBSITE_AGENT_IDS,
    createdAt,
  };

  const recruitment: TaskRecruitment = {
    id: recruitmentId,
    taskId,
    principalId: "principal-aicoo",
    agentIds: EXTERNAL_AGENT_IDS,
    status: "pending",
    reason: "Website, design, database, deployment, and independent launch expertise",
  };

  const taskDecisions: Decision[] = [
    {
      id: recruitmentDecisionId,
      taskId,
      recruitmentId,
      type: "recruitment",
      title: "Recruit five Aicoo specialists?",
      description:
        "@xisen/planner selected Aicoo’s Website, Design, Neon, Vercel, and Quality Agents for this task.",
      consequence:
        "Approval creates task-scoped access and shares only this prompt and its task workspace.",
      requestedByAgentId: "agent-xisen-planner",
      subjectAgentIds: EXTERNAL_AGENT_IDS,
      status: "pending",
      responseMode: "approval",
      approveLabel: "Recruit Agents",
      denyLabel: "Use mine only",
      createdAt: timestamp(sequence, 2),
    },
    {
      id: authorizationDecisionId,
      taskId,
      type: "authorization",
      title: "Connect Neon and Vercel for launch?",
      description:
        "The provider Agents need scoped project access before they can create resources or deploy.",
      consequence:
        "Demo approval records the intended scopes only. No provider resources are created in this prototype.",
      requestedByAgentId: "agent-xisen-planner",
      subjectAgentIds: ["agent-aicoo-neon", "agent-aicoo-vercel"],
      status: "pending",
      responseMode: "approval",
      approveLabel: "Approve demo scopes",
      denyLabel: "Keep as preview",
      createdAt: timestamp(sequence, 3),
    },
  ];

  const taskMessages: TranscriptMessage[] = [
    {
      id: `message-user-${sequence}`,
      taskId,
      kind: "user",
      content: prompt,
      createdAt,
    },
    {
      id: `message-plan-${sequence}`,
      taskId,
      kind: "plan",
      title: "I’ll organize this as one launch task.",
      content:
        "I’ll keep product context and implementation with your Agents, then recruit specialists only where the network adds a real advantage.",
      details: [
        "Research the product and define a shippable scope",
        "Build the application and Neon data model in one task workspace",
        "Prepare a Vercel launch path",
        "Verify the result independently before handoff",
      ],
      agentId: "agent-xisen-planner",
      createdAt: timestamp(sequence, 1),
    },
    {
      id: `message-coordination-${sequence}`,
      taskId,
      kind: "coordination",
      title: "Candidate world formed",
      content:
        "Four of your persistent Agents stay accountable. Five specialist Agents are available through the Aicoo connection.",
      agentId: "agent-xisen-planner",
      agentIds: WEBSITE_AGENT_IDS,
      actionHref: "/network",
      actionLabel: "See the organization",
      createdAt: timestamp(sequence, 2),
    },
    {
      id: `message-work-${sequence}`,
      taskId,
      kind: "work",
      title: "The network prepared the launch package",
      content:
        "The demo run combines product research, interface implementation, a Neon schema, a Vercel manifest, and an independent release check.",
      details: [
        "Responsive Next.js product surface",
        "Feedback, votes, and moderation schema",
        "Scoped provider integration plan",
        "Accessibility and launch evidence",
      ],
      agentIds: WEBSITE_AGENT_IDS.slice(1),
      contributions: [
        {
          agentId: "agent-xisen-research",
          output: "Product scope and primary API evidence",
        },
        {
          agentId: "agent-aicoo-design-engineer",
          output: "Interaction direction and visual system",
        },
        {
          agentId: "agent-aicoo-web-builder",
          output: "Responsive product implementation",
        },
        {
          agentId: "agent-aicoo-neon",
          output: "Database schema and migration plan",
        },
        {
          agentId: "agent-aicoo-vercel",
          output: "Deployment manifest and environment plan",
        },
        {
          agentId: "agent-xisen-codex",
          output: "Canonical integration in the task workspace",
        },
        {
          agentId: "agent-xisen-reviewer",
          output: "Repository and acceptance review",
        },
        {
          agentId: "agent-aicoo-quality",
          output: "Independent browser and launch evidence",
        },
      ],
      createdAt: timestamp(sequence, 4),
    },
    {
      id: `message-result-${sequence}`,
      taskId,
      kind: "result",
      title: "A launch-ready preview is assembled.",
      content:
        "The implementation package is ready to review. Two authority decisions remain before SharedNet could recruit external runtimes and touch provider accounts.",
      details: [
        "Product brief and interaction direction",
        "Application source and database schema",
        "Deployment manifest and verification report",
      ],
      agentId: "agent-xisen-codex",
      actionHref: "/decisions",
      actionLabel: "Review 2 decisions",
      createdAt: timestamp(sequence, 5),
    },
  ];

  return {
    ...state,
    recruitments: [...state.recruitments, recruitment],
    tasks: [...state.tasks, task],
    messages: [...state.messages, ...taskMessages],
    decisions: [...taskDecisions, ...state.decisions],
    usage: [...state.usage, ...createTaskUsage(taskId, sequence)],
    events: [
      ...state.events,
      {
        id: `event-task-${sequence}`,
        type: "task_created",
        title: "Planning Agent formed a task organization",
        timestamp: createdAt,
        taskId,
      },
      ...taskDecisions.map((decision) => ({
        id: `event-${decision.id}`,
        type: "decision_requested" as const,
        title: decision.title,
        timestamp: decision.createdAt,
        decisionId: decision.id,
        taskId,
      })),
    ],
  };
}

export function resolveDecision(
  state: SharedNetDemoState,
  decisionId: string,
  outcome: Exclude<DecisionStatus, "pending">,
  resolutionNote?: string,
): SharedNetDemoState {
  const decision = state.decisions.find((candidate) => candidate.id === decisionId);
  if (!decision || decision.status !== "pending") return state;

  const resolvedAt = new Date(
    new Date(decision.createdAt).getTime() + 60_000,
  ).toISOString();
  const decisions = state.decisions.map((candidate) =>
    candidate.id === decisionId
      ? {
          ...candidate,
          status: outcome,
          resolvedAt,
          ...(resolutionNote?.trim()
            ? { resolutionNote: resolutionNote.trim() }
            : {}),
        }
      : candidate,
  );

  return {
    ...state,
    decisions,
    recruitments: state.recruitments.map((recruitment) =>
      recruitment.id === decision.recruitmentId
        ? { ...recruitment, status: outcome }
        : recruitment,
    ),
    tasks: state.tasks.map((task) => {
      if (task.id !== decision.taskId) return task;
      const taskDecisions = decisions.filter(
        (candidate) => candidate.taskId === task.id,
      );
      return {
        ...task,
        status:
          taskDecisions.length > 0 &&
          taskDecisions.every((candidate) => candidate.status !== "pending")
            ? "ready"
            : "awaiting_decisions",
      };
    }),
    events: [
      ...state.events,
      {
        id: `event-resolved-${decisionId}`,
        type: "decision_resolved",
        title: `${decision.title} · ${outcome}`,
        timestamp: resolvedAt,
        decisionId,
        taskId: decision.taskId,
      },
    ],
  };
}

export function getDecisionResponseMode(
  decision: Decision,
): DecisionResponseMode {
  return decision.responseMode ?? (decision.type === "plan" ? "text" : "approval");
}

export function selectAgent(
  state: SharedNetDemoState,
  agentId: string,
): SharedNetDemoState {
  if (!state.agents.some((agent) => agent.id === agentId)) return state;
  return { ...state, selectedAgentId: agentId };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNumber(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function hasOptionalString(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}

function isPrincipal(value: unknown): value is Principal {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "handle") &&
    hasString(value, "name") &&
    isOneOf(value.kind, ["self", "connected"]) &&
    hasString(value, "summary")
  );
}

function isRuntime(value: unknown): value is AgentRuntime {
  return (
    isRecord(value) &&
    isOneOf(value.kind, ["local", "cloud", "vpc"]) &&
    hasString(value, "label") &&
    hasString(value, "environment")
  );
}

function isAgent(value: unknown): value is Agent {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "principalId") &&
    hasString(value, "handle") &&
    hasString(value, "name") &&
    hasString(value, "role") &&
    hasString(value, "summary") &&
    isStringArray(value.capabilities) &&
    isRuntime(value.runtime) &&
    isOneOf(value.discoverability, ["private", "connections"]) &&
    isOneOf(value.status, ["online", "idle"]) &&
    typeof value.official === "boolean"
  );
}

function isConnection(value: unknown): value is PrincipalConnection {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "fromPrincipalId") &&
    hasString(value, "toPrincipalId") &&
    value.status === "connected" &&
    hasString(value, "permission")
  );
}

function isRecruitment(value: unknown): value is TaskRecruitment {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "taskId") &&
    hasString(value, "principalId") &&
    isStringArray(value.agentIds) &&
    isOneOf(value.status, ["pending", "approved", "denied"]) &&
    hasString(value, "reason")
  );
}

function isTask(value: unknown): value is DemoTask {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "prompt") &&
    isOneOf(value.status, ["awaiting_decisions", "ready"]) &&
    isStringArray(value.selectedAgentIds) &&
    hasString(value, "createdAt")
  );
}

function isContribution(value: unknown): boolean {
  return isRecord(value) && hasString(value, "agentId") && hasString(value, "output");
}

function isMessage(value: unknown): value is TranscriptMessage {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "taskId") &&
    isOneOf(value.kind, ["user", "plan", "coordination", "work", "result"]) &&
    hasString(value, "content") &&
    hasOptionalString(value, "title") &&
    (value.details === undefined || isStringArray(value.details)) &&
    hasOptionalString(value, "agentId") &&
    (value.agentIds === undefined || isStringArray(value.agentIds)) &&
    (value.contributions === undefined ||
      (Array.isArray(value.contributions) && value.contributions.every(isContribution))) &&
    hasOptionalString(value, "actionHref") &&
    hasOptionalString(value, "actionLabel") &&
    hasString(value, "createdAt")
  );
}

function isDecision(value: unknown): value is Decision {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasOptionalString(value, "taskId") &&
    hasOptionalString(value, "recruitmentId") &&
    isOneOf(value.type, ["recruitment", "inbound_use", "authorization", "plan"]) &&
    hasString(value, "title") &&
    hasString(value, "description") &&
    hasString(value, "consequence") &&
    hasString(value, "requestedByAgentId") &&
    isStringArray(value.subjectAgentIds) &&
    isOneOf(value.status, ["pending", "approved", "denied"]) &&
    (value.responseMode === undefined ||
      isOneOf(value.responseMode, ["approval", "text"])) &&
    hasString(value, "approveLabel") &&
    hasString(value, "denyLabel") &&
    hasString(value, "createdAt") &&
    hasOptionalString(value, "resolvedAt") &&
    hasOptionalString(value, "resolutionNote")
  );
}

function isUsage(value: unknown): value is UsageEntry {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "taskId") &&
    hasString(value, "principalId") &&
    hasString(value, "agentId") &&
    hasString(value, "model") &&
    hasNumber(value, "inputTokens") &&
    hasNumber(value, "outputTokens") &&
    hasNumber(value, "cachedTokens") &&
    hasNumber(value, "costUsd") &&
    hasString(value, "timestamp")
  );
}

function isEvent(value: unknown): value is DemoEvent {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    isOneOf(value.type, ["decision_requested", "decision_resolved", "task_created"]) &&
    hasString(value, "title") &&
    hasString(value, "timestamp") &&
    hasOptionalString(value, "decisionId") &&
    hasOptionalString(value, "taskId")
  );
}

export function isDemoState(value: unknown): value is SharedNetDemoState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SharedNetDemoState>;
  if (
    candidate.version !== 3 ||
    !Array.isArray(candidate.principals) ||
    !candidate.principals.every(isPrincipal) ||
    !Array.isArray(candidate.agents) ||
    !candidate.agents.every(isAgent) ||
    !Array.isArray(candidate.connections) ||
    !candidate.connections.every(isConnection) ||
    !Array.isArray(candidate.recruitments) ||
    !candidate.recruitments.every(isRecruitment) ||
    !Array.isArray(candidate.tasks) ||
    !candidate.tasks.every(isTask) ||
    !Array.isArray(candidate.messages) ||
    !candidate.messages.every(isMessage) ||
    !Array.isArray(candidate.decisions) ||
    !candidate.decisions.every(isDecision) ||
    !Array.isArray(candidate.usage) ||
    !candidate.usage.every(isUsage) ||
    !Array.isArray(candidate.events) ||
    !candidate.events.every(isEvent) ||
    typeof candidate.selectedAgentId !== "string"
  ) {
    return false;
  }

  const principalIds = new Set(candidate.principals.map((principal) => principal.id));
  const agentIds = new Set(candidate.agents.map((agent) => agent.id));
  return (
    principalIds.has("principal-xisen") &&
    principalIds.has("principal-aicoo") &&
    candidate.agents.every((agent) => principalIds.has(agent.principalId)) &&
    agentIds.has(candidate.selectedAgentId) &&
    candidate.connections.every(
      (connection) =>
        principalIds.has(connection.fromPrincipalId) &&
        principalIds.has(connection.toPrincipalId),
    ) &&
    candidate.recruitments.every(
      (recruitment) =>
        principalIds.has(recruitment.principalId) &&
        recruitment.agentIds.every((agentId) => agentIds.has(agentId)),
    ) &&
    candidate.tasks.every((task) =>
      task.selectedAgentIds.every((agentId) => agentIds.has(agentId)),
    ) &&
    candidate.decisions.every(
      (decision) =>
        agentIds.has(decision.requestedByAgentId) &&
        decision.subjectAgentIds.every((agentId) => agentIds.has(agentId)),
    ) &&
    candidate.usage.every(
      (entry) =>
        principalIds.has(entry.principalId) && agentIds.has(entry.agentId),
    )
  );
}
