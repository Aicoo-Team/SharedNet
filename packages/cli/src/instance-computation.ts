import { createHmac } from "node:crypto";

import { localError } from "./errors.ts";

export type RuntimeKind = "codex" | "claude-code" | "custom";

export interface RuntimeSession {
  runtimeKind: RuntimeKind;
  anchor: string;
}

type Environment = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function detectRuntimeSession(env: Environment): RuntimeSession | null {
  const codexSession = nonEmpty(env.CODEX_SESSION_ID);
  if (codexSession) return { runtimeKind: "codex", anchor: codexSession };

  const claudeSession = nonEmpty(env.CLAUDE_SESSION_ID);
  if (claudeSession) {
    return { runtimeKind: "claude-code", anchor: claudeSession };
  }

  // CODEX_THREAD_ID is deliberately ignored. It is lineage, not the executing
  // runtime session, and would collapse concurrent child sessions.
  return null;
}

export function computeLocalInstanceKey(
  installationSecret: string,
  runtimeKind: RuntimeKind,
  providerSessionAnchor: string,
): string {
  let key: Buffer;
  try {
    key = Buffer.from(installationSecret, "base64url");
  } catch {
    throw localError("invalid_local_state", "The installation secret is invalid.");
  }
  if (key.byteLength !== 32) {
    throw localError("invalid_local_state", "The installation secret is invalid.");
  }
  if (!providerSessionAnchor) {
    throw localError(
      "runtime_session_not_detected",
      "The current runtime session could not be detected.",
    );
  }

  return createHmac("sha256", key)
    .update(`${runtimeKind}\0${providerSessionAnchor}`, "utf8")
    .digest("hex");
}
