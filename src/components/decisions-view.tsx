"use client";

import { useEffect, useState } from "react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import type { Decision } from "@/src/domain/network-demo";

function DecisionHistoryItem({ decision }: { decision: Decision }) {
  return (
    <article className="decision-history-item">
      <div>
        <h2>{decision.title}</h2>
        <p>{decision.description}</p>
        {decision.resolutionNote ? (
          <blockquote>{decision.resolutionNote}</blockquote>
        ) : null}
      </div>
      <span data-status={decision.status}>
        {decision.status === "approved" ? "Approved" : "Denied"}
      </span>
    </article>
  );
}

export function DecisionsView() {
  const { state, resolveDecision } = useSharedNetDemo();
  const pending = state.decisions.filter((decision) => decision.status === "pending");
  const resolved = state.decisions.filter((decision) => decision.status !== "pending");
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(
    pending[0]?.id ?? null,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const selectedDecision =
    pending.find((decision) => decision.id === selectedDecisionId) ?? pending[0];

  useEffect(() => {
    if (pending.length === 0) {
      setSelectedDecisionId(null);
      return;
    }
    if (!pending.some((decision) => decision.id === selectedDecisionId)) {
      setSelectedDecisionId(pending[0].id);
    }
  }, [pending, selectedDecisionId]);

  function resolveSelected(outcome: "approved" | "denied") {
    if (!selectedDecision) return;
    resolveDecision(selectedDecision.id, outcome);
  }

  function applyInstruction() {
    if (!selectedDecision || !instruction.trim()) return;
    resolveDecision(selectedDecision.id, "approved", instruction);
    setInstruction("");
  }

  function approveAll() {
    pending.forEach((decision) => resolveDecision(decision.id, "approved"));
  }

  return (
    <div className="decisions-workspace">
      <header className="decisions-titlebar">
        <h1>Decisions</h1>
        <button
          aria-expanded={historyOpen}
          aria-label={historyOpen ? "Hide past decisions" : "Show past decisions"}
          onClick={() => setHistoryOpen((open) => !open)}
          type="button"
        >
          ···
        </button>
      </header>

      <section aria-label="Pending decisions" className="pending-decisions">
        {pending.length > 0 && selectedDecision ? (
          <>
            <nav aria-label="Decision queue" className="decision-queue">
              {pending.map((decision, index) => (
                <button
                  aria-current={decision.id === selectedDecision.id ? "true" : undefined}
                  aria-label={`Open decision ${index + 1}: ${decision.title}`}
                  key={decision.id}
                  onClick={() => setSelectedDecisionId(decision.id)}
                  type="button"
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{decision.title}</strong>
                </button>
              ))}
            </nav>

            <article className="decision-workbench">
              <div className="decision-question">
                <p>{selectedDecision.type.replace("_", " ")}</p>
                <h2>{selectedDecision.title}</h2>
                <p>{selectedDecision.description}</p>
                <small>{selectedDecision.consequence}</small>
              </div>

              <div className="decision-controls">
                <button
                  aria-label="Deny"
                  className="decision-control decision-control-deny"
                  onClick={() => resolveSelected("denied")}
                  type="button"
                >
                  <span aria-hidden="true" />
                  Deny
                </button>
                <button
                  aria-label="Approve once"
                  className="decision-control decision-control-once"
                  onClick={() => resolveSelected("approved")}
                  type="button"
                >
                  <span aria-hidden="true" />
                  Approve once
                </button>
                <button
                  aria-label="Approve all pending"
                  className="decision-control decision-control-all"
                  onClick={approveAll}
                  type="button"
                >
                  <span aria-hidden="true" />
                  Approve all
                </button>
              </div>

              <div className="decision-instruction">
                <label className="sr-only" htmlFor="decision-instruction">
                  Give SharedNet an instruction before continuing
                </label>
                <input
                  id="decision-instruction"
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyInstruction();
                  }}
                  placeholder="Work on A first…"
                  value={instruction}
                />
                <button
                  aria-label="Apply instruction"
                  disabled={!instruction.trim()}
                  onClick={applyInstruction}
                  type="button"
                >
                  →
                </button>
              </div>
            </article>
          </>
        ) : (
          <p className="decisions-clear">No decisions need you.</p>
        )}
      </section>

      {historyOpen ? (
        <section aria-label="Resolved decisions" className="resolved-decisions">
          <header>
            <p>Past decisions</p>
            <span>{resolved.length}</span>
          </header>
          {resolved.length > 0 ? (
            resolved.map((decision) => (
              <DecisionHistoryItem decision={decision} key={decision.id} />
            ))
          ) : (
            <p>No past decisions.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
