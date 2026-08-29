import type {
  InterviewAnswers,
  InterviewDimension,
  ProductBrief,
} from "./types";

export interface InterviewQuestion {
  id: InterviewDimension;
  prompt: string;
  reason: string;
  placeholder: string;
  suggestion: string;
}

export interface InterviewReadiness {
  completion: number;
  clearDimensions: InterviewDimension[];
  missingDimensions: InterviewDimension[];
  ready: boolean;
}

export const INTERVIEW_QUESTIONS: readonly InterviewQuestion[] = [
  {
    id: "user",
    prompt: "Who is this for?",
    reason: "The network needs one primary user before it can make product tradeoffs.",
    placeholder: "e.g. small SaaS teams collecting feedback",
    suggestion: "Small teams who need a lightweight way to collect feedback",
  },
  {
    id: "outcome",
    prompt: "What should they be able to accomplish?",
    reason: "An outcome keeps the Agents focused on a usable loop, not a list of pages.",
    placeholder: "e.g. submit, prioritize, and track product ideas",
    suggestion: "Submit an idea, vote on priorities, and see what is planned",
  },
  {
    id: "data",
    prompt: "What information needs to survive a refresh?",
    reason: "This decides whether the Mission recruits a data-layer specialist.",
    placeholder: "e.g. ideas, votes, status, and author",
    suggestion: "Ideas, votes, statuses, and submission time",
  },
  {
    id: "access",
    prompt: "Who can see or change what?",
    reason: "Access boundaries affect both architecture and the first safe demo.",
    placeholder: "e.g. anyone can submit; only the owner can moderate",
    suggestion: "Public visitors can submit and vote; one owner can moderate",
  },
  {
    id: "style",
    prompt: "How should the product feel?",
    reason: "A concrete visual direction helps the Builder make coherent choices.",
    placeholder: "e.g. calm, editorial, high-trust — not a generic dashboard",
    suggestion: "Calm editorial interface with confident typography and warm neutrals",
  },
  {
    id: "launch",
    prompt: "What counts as launched today?",
    reason: "SharedNet needs a finish line for deployment and handoff.",
    placeholder: "e.g. a public preview URL I can share",
    suggestion: "A public preview URL with a local handoff package",
  },
  {
    id: "acceptance",
    prompt: "What must work before you call it done?",
    reason: "The Quality Agent needs observable proof that is independent of the Builder.",
    placeholder: "e.g. submit, vote, moderate, and persist after refresh",
    suggestion: "Submit, vote, moderate, and persist after refresh on mobile and desktop",
  },
] as const;

const DIMENSIONS = INTERVIEW_QUESTIONS.map((question) => question.id);

function hasMaterialAnswer(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

export function calculateReadiness(answers: InterviewAnswers): InterviewReadiness {
  const clearDimensions = DIMENSIONS.filter((dimension) =>
    hasMaterialAnswer(answers[dimension]),
  );
  const missingDimensions = DIMENSIONS.filter(
    (dimension) => !hasMaterialAnswer(answers[dimension]),
  );

  return {
    completion: Math.round((clearDimensions.length / DIMENSIONS.length) * 100),
    clearDimensions,
    missingDimensions,
    ready: missingDimensions.length === 0,
  };
}

export function getNextQuestion(
  answers: InterviewAnswers,
): InterviewQuestion | undefined {
  return INTERVIEW_QUESTIONS.find(
    (question) => !hasMaterialAnswer(answers[question.id]),
  );
}

function toProductTitle(idea: string): string {
  const withoutCommand = idea
    .trim()
    .replace(/^(build|create|make|launch|design)\s+(?:an?\s+|the\s+)?/i, "")
    .replace(/[.!?]+$/, "");
  const title = withoutCommand || "Untitled Product";

  return title
    .split(/\s+/)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function toSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "sharednet-product";
}

function dataIsPersistent(answer: string): boolean {
  return !/^(none|nothing|no data|static only|not needed|无|没有|不需要)$/i.test(
    answer.trim(),
  );
}

function inferDataModel(idea: string, data: string) {
  const productText = `${idea} ${data}`.toLowerCase();

  if (/feedback|idea|vote|反馈|投票/.test(productText)) {
    return [
      {
        name: "Idea",
        purpose: "A suggestion submitted by a visitor.",
        fields: ["id", "title", "detail", "status", "vote_count", "created_at"],
      },
      {
        name: "Vote",
        purpose: "A visitor's support for an idea.",
        fields: ["id", "idea_id", "visitor_key", "created_at"],
      },
    ];
  }

  return [
    {
      name: "Record",
      purpose: data.trim(),
      fields: ["id", "title", "details", "status", "created_at", "updated_at"],
    },
  ];
}

export function compileProductBrief(
  idea: string,
  answers: InterviewAnswers,
): ProductBrief {
  if (!idea.trim()) {
    throw new Error("A product idea is required before compiling a brief.");
  }

  const readiness = calculateReadiness(answers);
  if (!readiness.ready) {
    throw new Error(
      `Missing product decisions: ${readiness.missingDimensions.join(", ")}`,
    );
  }

  const complete = answers as Required<InterviewAnswers>;
  const title = toProductTitle(idea);
  const requiresDatabase = dataIsPersistent(complete.data);

  return {
    idea: idea.trim(),
    title,
    slug: toSlug(title),
    summary: `${complete.user} can ${complete.outcome.toLowerCase()} through a focused, launch-ready web product.`,
    primaryUser: complete.user.trim(),
    outcome: complete.outcome.trim(),
    coreLoop: [
      `Arrive and understand the value for ${complete.user.trim()}.`,
      complete.outcome.trim(),
      requiresDatabase
        ? "Return and see the latest state preserved across sessions."
        : "Complete the action and receive a clear result.",
    ],
    dataModel: requiresDatabase
      ? inferDataModel(idea, complete.data)
      : [],
    accessModel: complete.access.trim(),
    visualDirection: complete.style.trim(),
    launchTarget: complete.launch.trim(),
    assumptions: [
      "V1 optimizes one complete core loop before breadth.",
      "The product is responsive and keyboard accessible.",
      requiresDatabase
        ? "Demo infrastructure is simulated until live credentials and approval are supplied."
        : "V1 can run without a persistent database.",
    ],
    deferredDecisions: [
      "Custom domain and production analytics",
      "Billing, enterprise identity, and advanced roles",
    ],
    acceptanceCriteria: [
      complete.acceptance.trim(),
      `The launch target is available as: ${complete.launch.trim()}.`,
      "The handoff contains source, architecture, run instructions, and verification evidence.",
    ],
    requiresDatabase,
  };
}
