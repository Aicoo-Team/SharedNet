"use client";

import { useCallback, useEffect, useState } from "react";
import { createHandoffArtifacts } from "@/src/domain/artifacts";
import {
  calculateReadiness,
  compileProductBrief,
} from "@/src/domain/interview";
import {
  advanceMission as advanceRacMission,
  createMission,
} from "@/src/domain/orchestrator";
import type {
  ConnectorManifest,
  InterviewAnswers,
  InterviewDimension,
  Mission,
  ProductBrief,
} from "@/src/domain/types";
import { downloadHandoff as saveHandoff } from "@/src/lib/download";

export type LaunchStage =
  | "describe"
  | "clarify"
  | "confirm"
  | "organize"
  | "build"
  | "handoff";

type ConnectorMode = "demo" | "live";
type LaunchStatus = "idle" | "connecting" | "ready" | "reconciliation" | "error";

export interface LaunchState {
  stage: LaunchStage;
  idea: string;
  answers: InterviewAnswers;
  brief?: ProductBrief;
  mission?: Mission;
  connectorMode: ConnectorMode;
  approvedExternalActions: boolean;
  launchStatus: LaunchStatus;
  launchError?: string;
}

const STORAGE_KEY = "sharednet:website-launch:v1";
const LAUNCH_STAGES: LaunchStage[] = [
  "describe",
  "clarify",
  "confirm",
  "organize",
  "build",
  "handoff",
];

const INITIAL_STATE: LaunchState = {
  stage: "describe",
  idea: "",
  answers: {},
  connectorMode: "demo",
  approvedExternalActions: false,
  launchStatus: "idle",
};

function readStoredState(): LaunchState | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<LaunchState>;
    if (
      typeof parsed.idea !== "string" ||
      typeof parsed.stage !== "string" ||
      !LAUNCH_STAGES.includes(parsed.stage as LaunchStage)
    ) {
      return undefined;
    }
    const stage = parsed.stage as LaunchStage;
    if (stage === "confirm" && !parsed.brief) return undefined;
    if (["organize", "build", "handoff"].includes(stage) && !parsed.mission) {
      return undefined;
    }

    const restored = { ...INITIAL_STATE, ...parsed, stage } as LaunchState;
    if (stage === "build" && restored.launchStatus === "connecting") {
      return {
        ...restored,
        launchStatus: "error",
        launchError: "Connector execution was interrupted. Start over before retrying external work.",
      };
    }
    return restored;
  } catch {
    return undefined;
  }
}

function mapConnectorManifest(value: unknown): ConnectorManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  if (result.provider !== "neon" && result.provider !== "vercel") return undefined;
  if (result.mode !== "demo" && result.mode !== "live") return undefined;

  return {
    provider: result.provider,
    mode: result.mode,
    label: result.label === "LIVE" ? "LIVE" : "SIMULATED",
    resourceName:
      typeof result.resourceName === "string" ? result.resourceName : "unknown",
    status:
      result.status === "created" ||
      result.status === "ready" ||
      result.status === "reconciliation-required"
        ? result.status
        : "planned",
    details:
      result.details && typeof result.details === "object"
        ? (result.details as Record<string, string>)
        : {},
  };
}

export function useMission() {
  const [state, setState] = useState<LaunchState>(INITIAL_STATE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = readStoredState();
    if (stored) setState(stored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [hydrated, state]);

  const startIdea = useCallback((idea: string) => {
    const nextIdea = idea.trim();
    if (!nextIdea) return false;
    setState((current) => ({
      ...current,
      idea: nextIdea,
      answers: {},
      brief: undefined,
      mission: undefined,
      stage: "clarify",
      launchStatus: "idle",
      launchError: undefined,
    }));
    return true;
  }, []);

  const answerQuestion = useCallback(
    (dimension: InterviewDimension, answer: string) => {
      setState((current) => {
        const answers = { ...current.answers, [dimension]: answer.trim() };
        if (!calculateReadiness(answers).ready) {
          return { ...current, answers };
        }
        return {
          ...current,
          answers,
          brief: compileProductBrief(current.idea, answers),
          stage: "confirm",
        };
      });
    },
    [],
  );

  const updateBrief = useCallback((updates: Partial<ProductBrief>) => {
    setState((current) =>
      current.brief ? { ...current, brief: { ...current.brief, ...updates } } : current,
    );
  }, []);

  const confirmBrief = useCallback(() => {
    setState((current) => {
      if (!current.brief) return current;
      return {
        ...current,
        mission: createMission(current.brief),
        stage: "organize",
      };
    });
  }, []);

  const setConnectorMode = useCallback((connectorMode: ConnectorMode) => {
    setState((current) => ({
      ...current,
      connectorMode,
      approvedExternalActions:
        connectorMode === "demo" ? false : current.approvedExternalActions,
    }));
  }, []);

  const setExternalApproval = useCallback((approvedExternalActions: boolean) => {
    setState((current) => ({ ...current, approvedExternalActions }));
  }, []);

  const startBuild = useCallback(async () => {
    const snapshot = state;
    if (!snapshot.mission) return;
    setState((current) => ({
      ...current,
      stage: "build",
      launchStatus: "connecting",
      launchError: undefined,
    }));

    try {
      const response = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: snapshot.mission.brief.slug,
          mode: snapshot.connectorMode,
          requiresDatabase: snapshot.mission.brief.requiresDatabase,
          approvedExternalActions: snapshot.approvedExternalActions,
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        manifests?: unknown[];
        status?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "The connector run did not complete.");
      }
      const connectors = (payload.manifests ?? [])
        .map(mapConnectorManifest)
        .filter((value): value is ConnectorManifest => Boolean(value));

      if (payload.status === "reconciliation-required") {
        setState((current) => ({
          ...current,
          launchStatus: "reconciliation",
          launchError:
            "Provider state requires reconciliation before this Mission can continue.",
          mission: current.mission
            ? {
                ...current.mission,
                connectors: connectors.length
                  ? connectors
                  : current.mission.connectors,
              }
            : current.mission,
        }));
        return;
      }
      if (!connectors.length) {
        throw new Error("The connector route returned no infrastructure manifest.");
      }

      setState((current) => ({
        ...current,
        launchStatus: "ready",
        mission: current.mission
          ? { ...current.mission, connectors: connectors.length ? connectors : current.mission.connectors }
          : current.mission,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        launchStatus: "error",
        launchError:
          error instanceof Error
            ? error.message
            : "SharedNet could not reach the connector route. The Mission remains paused.",
      }));
    }
  }, [state]);

  const advanceBuild = useCallback(() => {
    setState((current) => {
      if (!current.mission || current.mission.status === "completed") return current;
      return { ...current, mission: advanceRacMission(current.mission) };
    });
  }, []);

  const finishBuild = useCallback(() => {
    setState((current) => {
      if (!current.mission || current.launchStatus !== "ready") return current;
      let mission = current.mission;
      let guard = 0;
      while (mission.status !== "completed" && guard < 12) {
        mission = advanceRacMission(mission);
        guard += 1;
      }
      mission = { ...mission, artifacts: createHandoffArtifacts(mission) };
      return { ...current, mission, stage: "handoff" };
    });
  }, []);

  useEffect(() => {
    if (
      state.stage !== "build" ||
      !state.mission ||
      state.launchStatus !== "ready"
    ) {
      return;
    }
    const mission = state.mission;
    const timer = window.setTimeout(() => {
      if (mission.status === "completed") {
        setState((current) => {
          if (!current.mission || current.stage !== "build") return current;
          const completed = {
            ...current.mission,
            artifacts: createHandoffArtifacts(current.mission),
          };
          return { ...current, mission: completed, stage: "handoff" };
        });
      } else {
        advanceBuild();
      }
    }, mission.status === "completed" ? 500 : 950);

    return () => window.clearTimeout(timer);
  }, [advanceBuild, state.launchStatus, state.mission, state.stage]);

  const resetMission = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setState(INITIAL_STATE);
  }, []);

  const downloadHandoff = useCallback(() => {
    if (!state.mission?.artifacts.length) return;
    saveHandoff(state.mission.artifacts, state.mission.title);
  }, [state.mission]);

  return {
    state,
    hydrated,
    startIdea,
    answerQuestion,
    updateBrief,
    confirmBrief,
    setConnectorMode,
    setExternalApproval,
    startBuild,
    advanceBuild,
    finishBuild,
    resetMission,
    downloadHandoff,
  };
}
