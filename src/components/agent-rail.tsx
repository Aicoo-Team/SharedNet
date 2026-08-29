"use client";

import { Check, Circle, Radio } from "lucide-react";
import { OFFICIAL_AGENTS } from "@/src/domain/official-agents";
import type { AgentHandle, Mission } from "@/src/domain/types";
import type { LaunchStage } from "@/src/hooks/use-mission";

function getAgentState(
  handle: AgentHandle,
  stage: LaunchStage,
  mission?: Mission,
): "active" | "complete" | "standby" {
  if (!mission) {
    return handle === "@sharednet/product" && ["clarify", "confirm"].includes(stage)
      ? "active"
      : "standby";
  }
  const tasks = mission.tasks.filter((task) => task.agentHandle === handle);
  if (tasks.some((task) => task.status === "runnable" || task.status === "running")) {
    return "active";
  }
  if (tasks.length && tasks.every((task) => task.status === "completed")) return "complete";
  if (handle === "@sharednet/product" && stage === "organize") return "active";
  return "standby";
}

export function AgentRail({ stage, mission }: { stage: LaunchStage; mission?: Mission }) {
  const selected = mission ? new Set(mission.selectedAgentHandles) : null;
  const agents = selected
    ? OFFICIAL_AGENTS.filter((agent) => selected.has(agent.handle))
    : OFFICIAL_AGENTS;

  return (
    <aside className="agent-rail" aria-label="Official Agent organization">
      <div className="rail-heading">
        <p className="micro-label">Candidate World</p>
        <h2>{mission ? "Mission organization" : "Official bench"}</h2>
        <span>{mission ? `${agents.length} selected by RAC` : `${agents.length} persistent Agents`}</span>
      </div>

      <div className="agent-list">
        {agents.map((agent, index) => {
          const state = getAgentState(agent.handle, stage, mission);
          return (
            <div
              className="agent-row"
              data-state={state}
              data-accent={agent.accent}
              key={agent.handle}
              style={{ "--agent-index": index } as React.CSSProperties}
            >
              <span className="agent-avatar" aria-hidden="true">
                {agent.avatarInitials}
              </span>
              <span className="agent-copy">
                <strong>{agent.handle}</strong>
                <small>{agent.role}</small>
              </span>
              <span className="agent-state" title={state}>
                {state === "complete" ? (
                  <Check size={13} />
                ) : state === "active" ? (
                  <Radio size={13} />
                ) : (
                  <Circle size={10} />
                )}
              </span>
            </div>
          );
        })}
      </div>

      <p className="rail-footnote">
        <span aria-hidden="true">SN</span>
        SharedNet official. Provider-independent.
      </p>
    </aside>
  );
}
