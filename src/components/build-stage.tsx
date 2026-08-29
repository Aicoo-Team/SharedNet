"use client";

import { Check, Circle, FastForward, LoaderCircle, Radio } from "lucide-react";
import { getOfficialAgent } from "@/src/domain/official-agents";
import type { Mission } from "@/src/domain/types";

function TaskIcon({ status }: { status: string }) {
  if (status === "completed") return <Check size={15} />;
  if (status === "runnable" || status === "running") return <Radio size={15} />;
  return <Circle size={10} />;
}

export function BuildStage({
  mission,
  mode,
  launchStatus,
  launchError,
  onFinish,
}: {
  mission: Mission;
  mode: "demo" | "live";
  launchStatus: "idle" | "connecting" | "ready" | "error";
  launchError?: string;
  onFinish: () => void;
}) {
  const complete = mission.tasks.filter((task) => task.status === "completed").length;
  const progress = Math.round((complete / mission.tasks.length) * 100);
  const latestEvents = mission.events.slice(-7).reverse();

  return (
    <section className="build-stage stage-enter" aria-labelledby="build-title">
      <div className="build-overview">
        <div>
          <p className="micro-label">MISSION / {mission.id.replace("mission-", "")}</p>
          <h1 id="build-title">The organization is executing.</h1>
          <p>RAC opens work only when its evidence and dependencies are ready.</p>
        </div>
        <div className="build-progress">
          <strong>{progress}%</strong>
          <span>{complete} of {mission.tasks.length} tasks closed</span>
        </div>
      </div>

      <div className="execution-grid">
        <div className="task-spine">
          <div className="section-heading">
            <span>Dependency spine</span>
            <small>Wave {mission.completedWaves + 1}</small>
          </div>
          {mission.tasks.map((task) => {
            const agent = getOfficialAgent(task.agentHandle);
            return (
              <article className="task-row" data-status={task.status} key={task.id}>
                <span className="task-status" aria-label={task.status}>
                  <TaskIcon status={task.status} />
                </span>
                <div className="task-main">
                  <span>{task.kind}</span>
                  <h2>{task.title}</h2>
                  <p>{task.description}</p>
                  <small>
                    {task.dependencies.length ? `after ${task.dependencies.join(" + ")}` : "no dependency"}
                  </small>
                </div>
                <div className="task-owner">
                  <span>{agent.avatarInitials}</span>
                  <strong>{task.agentHandle}</strong>
                  <small>{task.durationLabel}</small>
                </div>
              </article>
            );
          })}
        </div>

        <aside className="event-ledger" aria-label="Mission event ledger">
          <div className="section-heading">
            <span>Evidence ledger</span>
            <small>{mission.events.length} events</small>
          </div>
          <ol>
            {latestEvents.map((event) => (
              <li key={event.id}>
                <span>{event.timestampLabel}</span>
                <div>
                  <strong>{event.title}</strong>
                  <p>{event.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <div className="build-footer">
        <div className={`connector-state connector-${launchStatus}`}>
          {launchStatus === "connecting" ? (
            <LoaderCircle className="spin" size={16} />
          ) : launchStatus === "ready" ? (
            <Check size={16} />
          ) : (
            <Circle size={11} />
          )}
          <span>
            <strong>{mode === "demo" ? "SIMULATED connectors" : "LIVE connectors"}</strong>
            <small>
              {launchError ??
                (launchStatus === "connecting"
                  ? "Planning Neon and Vercel manifests…"
                  : launchStatus === "ready"
                    ? "Infrastructure manifests ready."
                    : "Waiting for connector execution.")}
            </small>
          </span>
        </div>
        <button className="secondary-action" type="button" onClick={onFinish}>
          <FastForward size={16} />
          Finish demo now
        </button>
      </div>
    </section>
  );
}
