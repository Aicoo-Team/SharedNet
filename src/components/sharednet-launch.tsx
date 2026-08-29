"use client";

import { Check, Circle, LockKeyhole, Network, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { AgentRail } from "./agent-rail";
import { BriefStage } from "./brief-stage";
import { BuildStage } from "./build-stage";
import { DescribeStage } from "./describe-stage";
import { HandoffStage } from "./handoff-stage";
import { InterviewStage } from "./interview-stage";
import { MissionHeader } from "./mission-header";
import { OrganizeStage } from "./organize-stage";
import { useMission, type LaunchState } from "@/src/hooks/use-mission";

function ContextRail({
  stage,
  connectorMode: mode,
  mission,
}: LaunchState) {
  const currentTask = mission?.tasks.find((task) => task.status === "runnable");
  return (
    <aside className="context-rail" aria-label="Mission context">
      <div className="context-section">
        <p className="micro-label">Network contract</p>
        <ul className="contract-list">
          <li>
            <Check size={13} />
            One outcome owns the task graph
          </li>
          <li>
            <Check size={13} />
            Roles remain independently verifiable
          </li>
          <li>
            <Check size={13} />
            External writes require approval
          </li>
        </ul>
      </div>

      <div className="context-section">
        <p className="micro-label">Execution truth</p>
        <div className="truth-explainer">
          {mode === "demo" ? <ShieldCheck size={19} /> : <LockKeyhole size={19} />}
          <strong>{mode === "demo" ? "Demo infrastructure" : "Connected providers"}</strong>
          <p>
            {mode === "demo"
              ? "No provider resources will be created."
              : "Provider calls execute only after server credentials and approval are both present."}
          </p>
        </div>
      </div>

      {mission ? (
        <div className="context-section mission-pulse">
          <p className="micro-label">Mission pulse</p>
          <div>
            <span>Agent identities</span>
            <strong>{mission.selectedAgentHandles.length}</strong>
          </div>
          <div>
            <span>Dependencies closed</span>
            <strong>{mission.tasks.filter((task) => task.status === "completed").length}/{mission.tasks.length}</strong>
          </div>
          <div>
            <span>Current route</span>
            <strong>{currentTask?.agentHandle ?? (stage === "handoff" ? "owner" : "planning")}</strong>
          </div>
        </div>
      ) : null}

      <div className="network-presence">
        <Network size={17} />
        <span>
          <strong>@xisen</strong>
          <small>Principal online · local runtime</small>
        </span>
        <Circle size={8} fill="currentColor" />
      </div>
    </aside>
  );
}

export function SharedNetLaunch() {
  const mission = useMission();
  const { state } = mission;

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [state.stage]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to Mission</a>
      <MissionHeader stage={state.stage} mode={state.connectorMode} onReset={mission.resetMission} />

      <div className="workspace-shell">
        <AgentRail stage={state.stage} mission={state.mission} />

        <main id="main-content" className="mission-main">
          {state.stage === "describe" ? (
            <DescribeStage initialIdea={state.idea} onStart={mission.startIdea} />
          ) : null}
          {state.stage === "clarify" ? (
            <InterviewStage answers={state.answers} onAnswer={mission.answerQuestion} />
          ) : null}
          {state.stage === "confirm" && state.brief ? (
            <BriefStage
              brief={state.brief}
              mode={state.connectorMode}
              approved={state.approvedExternalActions}
              onUpdate={mission.updateBrief}
              onModeChange={mission.setConnectorMode}
              onApprovalChange={mission.setExternalApproval}
              onConfirm={mission.confirmBrief}
            />
          ) : null}
          {state.stage === "organize" && state.mission ? (
            <OrganizeStage
              mission={state.mission}
              mode={state.connectorMode}
              approved={state.approvedExternalActions}
              onStart={mission.startBuild}
            />
          ) : null}
          {state.stage === "build" && state.mission ? (
            <BuildStage
              mission={state.mission}
              mode={state.connectorMode}
              launchStatus={state.launchStatus}
              launchError={state.launchError}
              onFinish={mission.finishBuild}
            />
          ) : null}
          {state.stage === "handoff" && state.mission ? (
            <HandoffStage mission={state.mission} onDownloadAll={mission.downloadHandoff} />
          ) : null}
        </main>

        <ContextRail {...state} />
      </div>
    </div>
  );
}
