"use client";

import {
  ArrowDownToLine,
  GitFork,
  KeyRound,
  ShieldCheck,
  UserRoundPlus,
} from "lucide-react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import { type Decision, type DecisionType } from "@/src/domain/network-demo";

const decisionLabels: Record<DecisionType, string> = {
  recruitment: "Recruitment",
  inbound_use: "Inbound use",
  authorization: "Authorization",
  plan: "Plan choice",
};

function DecisionIcon({ type }: { type: DecisionType }) {
  if (type === "recruitment") return <UserRoundPlus aria-hidden="true" size={17} />;
  if (type === "inbound_use") return <ArrowDownToLine aria-hidden="true" size={17} />;
  if (type === "authorization") return <KeyRound aria-hidden="true" size={17} />;
  return <GitFork aria-hidden="true" size={17} />;
}

function DecisionRow({ decision }: { decision: Decision }) {
  const { state, resolveDecision } = useSharedNetDemo();
  const requester = state.agents.find(
    (agent) => agent.id === decision.requestedByAgentId,
  );
  const subjects = decision.subjectAgentIds
    .map((agentId) => state.agents.find((agent) => agent.id === agentId))
    .filter((agent) => agent !== undefined);
  const isPending = decision.status === "pending";

  return (
    <article className="decision-row" data-status={decision.status}>
      <div className="decision-type">
        <DecisionIcon type={decision.type} />
        <span>{decisionLabels[decision.type]}</span>
      </div>

      <div className="decision-content">
        <p className="decision-requester">Requested by {requester?.handle}</p>
        <h2>{decision.title}</h2>
        <p className="decision-description">{decision.description}</p>

        <div className="decision-subjects" aria-label="Agents in scope">
          {subjects.map((agent) => (
            <span key={agent.id}>{agent.handle}</span>
          ))}
        </div>

        <p className="decision-consequence">
          <strong>What changes</strong>
          {decision.consequence}
        </p>
      </div>

      <div className="decision-resolution">
        {isPending ? (
          <>
            <button
              type="button"
              className="decision-approve"
              onClick={() => resolveDecision(decision.id, "approved")}
            >
              {decision.approveLabel}
            </button>
            <button
              type="button"
              className="decision-deny"
              onClick={() => resolveDecision(decision.id, "denied")}
            >
              {decision.denyLabel}
            </button>
          </>
        ) : (
          <div className={`resolution-stamp resolution-${decision.status}`}>
            <ShieldCheck aria-hidden="true" size={16} />
            <strong>
              {decision.status === "approved" ? "Approved" : "Denied"}
            </strong>
            <span>Recorded in audit log</span>
          </div>
        )}
      </div>
    </article>
  );
}

export function DecisionsView() {
  const { state } = useSharedNetDemo();
  const pending = state.decisions.filter((decision) => decision.status === "pending");
  const resolved = state.decisions.filter((decision) => decision.status !== "pending");

  return (
    <div className="decisions-page page-frame">
      <header className="page-intro decisions-intro">
        <p className="eyebrow">Authority inbox</p>
        <h1>Only the decisions that need you.</h1>
        <p>
          Agents coordinate routine work themselves. SharedNet stops here when another
          Principal, a provider, or a material plan change needs your authority.
        </p>
      </header>

      <div className="decision-summary-line" aria-live="polite">
        <p>
          <strong>{pending.length}</strong> moments need your authority
        </p>
        <span aria-hidden="true" />
        <p>
          <strong>{resolved.length}</strong> resolved and retained
        </p>
      </div>

      <section className="decision-section" aria-label="Pending decisions">
        <header className="section-heading">
          <div>
            <p className="eyebrow">Pending</p>
            <h2>Needs a human boundary</h2>
          </div>
          <span>{pending.length}</span>
        </header>
        <div className="decision-list">
          {pending.length > 0 ? (
            pending.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} />
            ))
          ) : (
            <p className="empty-decisions">Nothing is waiting on you.</p>
          )}
        </div>
      </section>

      <section
        className="decision-section resolved-section"
        aria-label="Resolved decisions"
      >
        <header className="section-heading">
          <div>
            <p className="eyebrow">Resolved</p>
            <h2>Decision audit</h2>
          </div>
          <span>{resolved.length}</span>
        </header>
        <div className="decision-list">
          {resolved.length > 0 ? (
            resolved.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} />
            ))
          ) : (
            <p className="empty-decisions">
              Resolutions stay here with their original scope and rationale.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

