import type {
  AgentHandle,
  ConnectorManifest,
  Mission,
  MissionEvent,
  MissionTask,
  MissionTaskKind,
  ProductBrief,
  VerificationCheck,
} from "./types";

interface TaskBlueprint {
  id: string;
  kind: MissionTaskKind;
  title: string;
  description: string;
  agentHandle: AgentHandle;
  dependencies: string[];
  selectionReason: string;
  durationLabel: string;
  artifactIds: string[];
}

const eventTime = (sequence: number) =>
  `T+${String(Math.floor(sequence / 30)).padStart(2, "0")}:${String(
    (sequence * 2) % 60,
  ).padStart(2, "0")}`;

function createEvent(
  sequence: number,
  event: Omit<MissionEvent, "id" | "sequence" | "timestampLabel">,
): MissionEvent {
  return {
    ...event,
    id: `event-${String(sequence).padStart(3, "0")}`,
    sequence,
    timestampLabel: eventTime(sequence),
  };
}

function createTaskBlueprints(brief: ProductBrief): TaskBlueprint[] {
  const databaseTask: TaskBlueprint[] = brief.requiresDatabase
    ? [
        {
          id: "database",
          kind: "database",
          title: "Prepare the Neon data layer",
          description: "Translate the accepted model into schema and a guarded database plan.",
          agentHandle: "@sharednet/neon",
          dependencies: ["architecture"],
          selectionReason: "Persistent product state requires a Postgres specialist.",
          durationLabel: "~22 sec",
          artifactIds: ["schema", "neon-manifest"],
        },
      ]
    : [];

  return [
    {
      id: "research",
      kind: "research",
      title: "Research the product and integrations",
      description: "Check the product pattern and current official integration constraints.",
      agentHandle: "@sharednet/research",
      dependencies: [],
      selectionReason: "The build needs current constraints before architecture is fixed.",
      durationLabel: "~18 sec",
      artifactIds: ["research-notes"],
    },
    {
      id: "architecture",
      kind: "architecture",
      title: "Design the smallest complete system",
      description: "Define boundaries, data contracts, access rules, and failure modes.",
      agentHandle: "@sharednet/architect",
      dependencies: ["research"],
      selectionReason: "Multiple implementation concerns need one explicit system contract.",
      durationLabel: "~16 sec",
      artifactIds: ["architecture"],
    },
    ...databaseTask,
    {
      id: "build",
      kind: "build",
      title: "Build and integrate the product",
      description: "Implement the complete core loop against the accepted architecture.",
      agentHandle: "@sharednet/builder",
      dependencies: brief.requiresDatabase
        ? ["architecture", "database"]
        : ["architecture"],
      selectionReason: "A full-stack worker owns the joined implementation.",
      durationLabel: "~48 sec",
      artifactIds: ["source", "readme"],
    },
    {
      id: "deploy",
      kind: "deploy",
      title: "Package and deploy the preview",
      description: "Create a guarded deployment and collect build-state evidence.",
      agentHandle: "@sharednet/vercel",
      dependencies: ["build"],
      selectionReason: "The requested finish line is a shareable web preview.",
      durationLabel: "~24 sec",
      artifactIds: ["vercel-manifest"],
    },
    {
      id: "verify",
      kind: "verify",
      title: "Verify independently",
      description: "Exercise acceptance criteria without trusting the Builder's own report.",
      agentHandle: "@sharednet/quality",
      dependencies: ["deploy"],
      selectionReason: "Observable acceptance evidence must come from an independent role.",
      durationLabel: "~20 sec",
      artifactIds: ["verification"],
    },
    {
      id: "handoff",
      kind: "handoff",
      title: "Assemble the owner handoff",
      description: "Return source, decisions, manifests, evidence, and the next iteration.",
      agentHandle: "@sharednet/product",
      dependencies: ["verify"],
      selectionReason: "The Product Agent closes the loop against the confirmed brief.",
      durationLabel: "~8 sec",
      artifactIds: [
        "product-brief",
        "architecture",
        "schema",
        "source",
        "readme",
        "infrastructure",
        "verification",
      ],
    },
  ];
}

function createConnectorManifests(brief: ProductBrief): ConnectorManifest[] {
  return [
    ...(brief.requiresDatabase
      ? [
          {
            provider: "neon" as const,
            mode: "demo" as const,
            label: "SIMULATED" as const,
            resourceName: `demo-neon/${brief.slug}`,
            status: "planned" as const,
            details: { region: "aws-us-east-2", role: "app_owner" },
          },
        ]
      : []),
    {
      provider: "vercel",
      mode: "demo",
      label: "SIMULATED",
      resourceName: `demo-vercel/${brief.slug}`,
      status: "planned",
      details: { target: "preview", framework: "nextjs" },
    },
  ];
}

function createVerificationChecks(brief: ProductBrief): VerificationCheck[] {
  return [
    ...brief.acceptanceCriteria.map((criterion, index) => ({
      id: `acceptance-${index + 1}`,
      label: criterion,
      status: "pending" as const,
      evidence: "Waiting for the independent verification task.",
    })),
    {
      id: "build-integrity",
      label: "Production build completes without type or bundle errors.",
      status: "pending",
      evidence: "Waiting for the independent verification task.",
    },
  ];
}

export function createMission(brief: ProductBrief): Mission {
  const blueprints = createTaskBlueprints(brief);
  const tasks: MissionTask[] = blueprints.map((task) => ({
    ...task,
    status: task.dependencies.length === 0 ? "runnable" : "queued",
  }));
  const selectedAgentHandles: AgentHandle[] = [
    "@sharednet/product",
    "@sharednet/research",
    "@sharednet/architect",
    ...(brief.requiresDatabase ? (["@sharednet/neon"] as AgentHandle[]) : []),
    "@sharednet/builder",
    "@sharednet/vercel",
    "@sharednet/quality",
  ];

  const events = [
    createEvent(1, {
      type: "mission_created",
      title: "Mission created from confirmed brief",
      detail: `${brief.title} has a buildable outcome and acceptance boundary.`,
      agentHandle: "@sharednet/product",
    }),
    ...selectedAgentHandles.map((agentHandle, index) =>
      createEvent(index + 2, {
        type: "agent_selected",
        title: `${agentHandle} joined the Mission`,
        detail:
          blueprints.find((task) => task.agentHandle === agentHandle)?.selectionReason ??
          "Owns requirement continuity and final outcome alignment.",
        agentHandle,
      }),
    ),
  ];

  return {
    id: `mission-${brief.slug}`,
    title: brief.title,
    status: "ready",
    brief,
    selectedAgentHandles,
    tasks,
    events,
    artifacts: [],
    connectors: createConnectorManifests(brief),
    verificationChecks: createVerificationChecks(brief),
    completedWaves: 0,
  };
}

export function getRunnableTasks(mission: Mission): MissionTask[] {
  return mission.tasks.filter((task) => task.status === "runnable");
}

function openDependentTasks(tasks: MissionTask[]): MissionTask[] {
  const completedIds = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );

  return tasks.map((task) => {
    if (
      task.status === "queued" &&
      task.dependencies.every((dependency) => completedIds.has(dependency))
    ) {
      return { ...task, status: "runnable" as const };
    }
    return task;
  });
}

export function advanceMission(mission: Mission): Mission {
  if (mission.status === "completed") {
    return mission;
  }

  const runnableTasks = getRunnableTasks(mission);
  if (runnableTasks.length === 0) {
    throw new Error("Mission is blocked: no runnable tasks remain.");
  }

  const runnableIds = new Set(runnableTasks.map((task) => task.id));
  const completedTasks = mission.tasks.map((task) =>
    runnableIds.has(task.id) ? { ...task, status: "completed" as const } : task,
  );
  const tasks = openDependentTasks(completedTasks);
  let nextSequence = mission.events.length + 1;
  const waveEvents = runnableTasks.flatMap((task) => {
    const started = createEvent(nextSequence++, {
      type: "task_started",
      title: task.title,
      detail: `${task.agentHandle} accepted the runnable task.`,
      agentHandle: task.agentHandle,
      taskId: task.id,
    });
    const completed = createEvent(nextSequence++, {
      type: "task_completed",
      title: `${task.title} complete`,
      detail: `${task.artifactIds.length} deliverable${task.artifactIds.length === 1 ? "" : "s"} returned to the Mission.`,
      agentHandle: task.agentHandle,
      taskId: task.id,
    });
    return [started, completed];
  });
  const didVerify = runnableTasks.some((task) => task.kind === "verify");
  const verificationChecks = didVerify
    ? mission.verificationChecks.map((check) => ({
        ...check,
        status: "passed" as const,
        evidence: "Observed by @sharednet/quality in the deterministic V1 verification run.",
      }))
    : mission.verificationChecks;
  const isComplete = tasks.every((task) => task.status === "completed");
  const completionEvent = isComplete
    ? [
        createEvent(nextSequence, {
          type: "mission_completed",
          title: "Mission ready for handoff",
          detail: "Every dependency and independent verification check is complete.",
          agentHandle: "@sharednet/product",
        }),
      ]
    : [];

  return {
    ...mission,
    status: isComplete ? "completed" : "running",
    tasks,
    events: [...mission.events, ...waveEvents, ...completionEvent],
    verificationChecks,
    completedWaves: mission.completedWaves + 1,
  };
}
