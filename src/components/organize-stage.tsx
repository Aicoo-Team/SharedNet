"use client";

import { ArrowRight, GitBranch, ShieldCheck } from "lucide-react";
import { getOfficialAgent } from "@/src/domain/official-agents";
import type { Mission } from "@/src/domain/types";

export function OrganizeStage({
  mission,
  mode,
  approved,
  onStart,
}: {
  mission: Mission;
  mode: "demo" | "live";
  approved: boolean;
  onStart: () => void;
}) {
  return (
    <section className="organize-stage stage-enter" aria-labelledby="organize-title">
      <div className="stage-annotation">
        <span>RAC DECISION</span>
        <p>The user gave an outcome. SharedNet chose the organization and execution order.</p>
      </div>
      <div className="organize-title-row">
        <div>
          <p className="micro-label">Candidate World → Mission</p>
          <h1 id="organize-title">The smallest useful company is ready.</h1>
        </div>
        <div className="organization-count">
          <strong>{mission.selectedAgentHandles.length}</strong>
          <span>persistent Agents</span>
        </div>
      </div>

      <div className="rac-graph" aria-label="RAC dependency graph">
        {mission.tasks.map((task, index) => {
          const agent = getOfficialAgent(task.agentHandle);
          return (
            <div className="graph-node" key={task.id}>
              <div className="graph-index">
                <span>{String(index + 1).padStart(2, "0")}</span>
                {index < mission.tasks.length - 1 ? <i aria-hidden="true" /> : null}
              </div>
              <div className="graph-body">
                <span className="graph-kind">{task.kind}</span>
                <h2>{task.title}</h2>
                <p>{task.selectionReason}</p>
                <div>
                  <span className="mini-avatar">{agent.avatarInitials}</span>
                  <strong>{task.agentHandle}</strong>
                  <small>
                    {task.dependencies.length
                      ? `waits for ${task.dependencies.join(" + ")}`
                      : "opens immediately"}
                  </small>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="organization-rationale">
        <GitBranch size={18} />
        <p>
          <strong>Why this shape?</strong> Research constrains architecture. The data layer and
          build join before deployment. Quality verifies after the Builder is done, so self-review
          is never treated as evidence.
        </p>
      </div>

      <div className="stage-footer">
        <p className="truth-note compact">
          <ShieldCheck size={15} />
          {mode === "demo"
            ? "Provider actions remain simulated."
            : approved
              ? "User approval recorded; server-side gates still apply."
              : "Live actions require approval."}
        </p>
        <button className="primary-action" type="button" onClick={onStart}>
          Run the Mission
          <ArrowRight size={18} />
        </button>
      </div>
    </section>
  );
}
