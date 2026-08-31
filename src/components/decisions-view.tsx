"use client";

import { useEffect, useState } from "react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import { type Decision, type DecisionType } from "@/src/domain/network-demo";

const decisionLabels: Record<DecisionType, string> = {
  recruitment: "Recruitment",
  inbound_use: "Inbound use",
  authorization: "Authorization",
  plan: "Plan choice",
};

function DecisionRow({
  decision,
  onResolve,
}: {
  decision: Decision;
  onResolve: (
    decisionId: string,
    outcome: "approved" | "denied",
  ) => void;
}) {
  const { state } = useSharedNetDemo();
  const requester = state.agents.find(
    (agent) => agent.id === decision.requestedByAgentId,
  );
  const isPending = decision.status === "pending";

  return (
    <article className="decision-row" data-status={decision.status}>
      <div className="decision-content">
        <p className="decision-meta">
          <span>{decisionLabels[decision.type]}</span>
          <span>requested by {requester?.handle}</span>
        </p>
        <h2>{decision.title}</h2>
        <p className="decision-consequence">{decision.consequence}</p>
      </div>

      <div className="decision-resolution">
        {isPending ? (
          <>
            <button
              type="button"
              className="decision-approve"
              onClick={() => onResolve(decision.id, "approved")}
            >
              {decision.approveLabel}
            </button>
            <button
              type="button"
              className="decision-deny"
              onClick={() => onResolve(decision.id, "denied")}
            >
              {decision.denyLabel}
            </button>
          </>
        ) : (
          <div
            className={`resolution-stamp resolution-${decision.status}`}
            id={`decision-resolution-${decision.id}`}
          >
            <strong>{decision.status === "approved" ? "Approved" : "Denied"}</strong>
            <span>Recorded in audit log</span>
          </div>
        )}
      </div>
    </article>
  );
}

export function DecisionsView() {
  const { state, resolveDecision } = useSharedNetDemo();
  const [lastResolvedDecisionId, setLastResolvedDecisionId] = useState<string | null>(
    null,
  );
  const pending = state.decisions.filter((decision) => decision.status === "pending");
  const resolved = state.decisions.filter((decision) => decision.status !== "pending");

  useEffect(() => {
    if (!lastResolvedDecisionId) return;
    const nextPendingAction = document.querySelector<HTMLButtonElement>(
      '[data-decision-list="pending"] .decision-approve',
    );
    const historySummary = document.querySelector<HTMLElement>(
      ".decision-history summary",
    );
    (nextPendingAction ?? historySummary)?.focus();
    setLastResolvedDecisionId(null);
  }, [lastResolvedDecisionId, pending.length]);

  function handleResolve(
    decisionId: string,
    outcome: "approved" | "denied",
  ) {
    setLastResolvedDecisionId(decisionId);
    resolveDecision(decisionId, outcome);
  }

  return (
    <div className="decisions-page page-frame">
      <header className="simple-page-heading decisions-heading">
        <h1>Decisions</h1>
        <span>{pending.length} pending</span>
      </header>

      <section className="decision-section" aria-label="Pending decisions">
        <div className="decision-list" data-decision-list="pending">
          {pending.length > 0 ? (
            pending.map((decision) => (
              <DecisionRow
                key={decision.id}
                decision={decision}
                onResolve={handleResolve}
              />
            ))
          ) : (
            <p className="empty-decisions">Nothing is waiting on you.</p>
          )}
        </div>
      </section>

      <details className="decision-history">
        <summary>
          <span>History</span>
          <span>{resolved.length}</span>
        </summary>
        <section aria-label="Resolved decisions">
          <div className="decision-list">
            {resolved.length > 0 ? (
              resolved.map((decision) => (
                <DecisionRow
                  key={decision.id}
                  decision={decision}
                  onResolve={handleResolve}
                />
              ))
            ) : (
              <p className="empty-decisions">No decisions resolved yet.</p>
            )}
          </div>
        </section>
      </details>
    </div>
  );
}
