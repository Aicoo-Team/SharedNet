"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useSharedNet } from "@/src/context/sharednet-context";
import {
  parsePairingId,
  type DecisionId,
  type DecisionProjection,
  type DecisionResolution,
  type PairingId,
} from "@/src/sharednet/contracts";

type Drafts = Partial<Record<DecisionId, string>>;

type MutationState =
  | { decisionId: DecisionId; phase: "pending" }
  | { decisionId: DecisionId; phase: "error" }
  | null;

type PairingState =
  | { phase: "idle" }
  | { phase: "invalid" }
  | { phase: "pending"; retry: boolean }
  | { phase: "error" };

const decisionStatusLabels: Record<DecisionProjection["status"], string> = {
  answered: "Answered",
  approved: "Approved",
  denied: "Denied",
  pending: "Pending",
};

function DecisionStatus({ decision }: { decision: DecisionProjection }) {
  return (
    <span className="decision-status" data-status={decision.status}>
      {decisionStatusLabels[decision.status]}
    </span>
  );
}

function DecisionFacts({ decision }: { decision: DecisionProjection }) {
  return (
    <dl aria-label={`${decision.title} details`} className="decision-facts">
      <div>
        <dt>Created</dt>
        <dd>
          <time dateTime={decision.created_at}>{decision.created_at}</time>
        </dd>
      </div>
      <div>
        <dt>Resolved</dt>
        <dd>
          {decision.resolved_at ? (
            <time dateTime={decision.resolved_at}>{decision.resolved_at}</time>
          ) : (
            "Not resolved"
          )}
        </dd>
      </div>
      <div>
        <dt>Room ID</dt>
        <dd>{decision.room_id ?? "No Room"}</dd>
      </div>
      <div className="decision-response-fact">
        <dt>Response</dt>
        <dd>{decision.response_text ?? "No response yet."}</dd>
      </div>
      {decision.requester ? (
        <>
          <div>
            <dt>Requester Principal</dt>
            <dd>{decision.requester.principal_id}</dd>
          </div>
          <div>
            <dt>Requester Agent</dt>
            <dd>{decision.requester.agent_id}</dd>
          </div>
          <div>
            <dt>Requester Runtime</dt>
            <dd>{decision.requester.runtime_id}</dd>
          </div>
          <div>
            <dt>Requester Instance</dt>
            <dd>{decision.requester.instance_id}</dd>
          </div>
        </>
      ) : (
        <div>
          <dt>Requester</dt>
          <dd>Requester not available</dd>
        </div>
      )}
    </dl>
  );
}

function DecisionHistoryItem({ decision }: { decision: DecisionProjection }) {
  const titleId = `decision-history-${decision.decision_id}`;

  return (
    <article
      aria-labelledby={titleId}
      className="decision-history-item"
      data-status={decision.status}
    >
      <header>
        <h2 id={titleId}>{decision.title}</h2>
        <DecisionStatus decision={decision} />
      </header>
      <p>{decision.description}</p>
      <small>{decision.consequence ?? "No consequence provided."}</small>
      <DecisionFacts decision={decision} />
    </article>
  );
}

function PairingNotice({
  pairingId,
  pairingState,
  retry,
}: {
  pairingId: PairingId | null;
  pairingState: PairingState;
  retry: (pairingId: PairingId) => void;
}) {
  if (pairingState.phase === "idle") return null;
  if (pairingState.phase === "invalid") {
    return (
      <p className="decisions-data-state decisions-data-error" role="alert">
        This pairing link is invalid.
      </p>
    );
  }
  if (pairingState.phase === "error") {
    return (
      <div className="decisions-pairing-state">
        <p className="decisions-data-state decisions-data-error" role="alert">
          Unable to claim this pairing. Try again.
        </p>
        <button
          disabled={pairingId === null}
          onClick={() => {
            if (pairingId) retry(pairingId);
          }}
          type="button"
        >
          Retry pairing
        </button>
      </div>
    );
  }

  return (
    <div className="decisions-pairing-state">
      <p className="decisions-data-state" role="status">
        Claiming pairing…
      </p>
      {pairingState.retry ? (
        <button disabled type="button">
          Retry pairing
        </button>
      ) : null}
    </div>
  );
}

function DecisionsLoading() {
  return (
    <div className="decisions-workspace">
      <header className="decisions-titlebar">
        <h1>Decisions</h1>
      </header>
      <div className="decisions-notices" />
      <section aria-label="Pending decisions" className="pending-decisions">
        <p className="decisions-clear" role="status">
          Loading decisions…
        </p>
      </section>
    </div>
  );
}

function DecisionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { claimPairing, decisions, error, resolveDecision, status } = useSharedNet();
  const pending = useMemo(
    () => decisions.filter((decision) => decision.status === "pending"),
    [decisions],
  );
  const resolved = useMemo(
    () => decisions.filter((decision) => decision.status !== "pending"),
    [decisions],
  );
  const pairingQuery = searchParams.get("pairing");
  const pairingId = parsePairingId(pairingQuery);
  const [selectedDecisionId, setSelectedDecisionId] = useState<DecisionId | null>(
    pending[0]?.decision_id ?? null,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [mutationState, setMutationState] = useState<MutationState>(null);
  const [pairingState, setPairingState] = useState<PairingState>({ phase: "idle" });
  const mountedRef = useRef(false);
  const mutationInFlightRef = useRef(false);
  const automaticPairingRef = useRef<string | null>(null);
  const pairingRevisionRef = useRef(0);
  const selectedDecision =
    pending.find((decision) => decision.decision_id === selectedDecisionId) ??
    pending[0] ??
    null;
  const selectedDraft = selectedDecision
    ? (drafts[selectedDecision.decision_id] ?? "")
    : "";
  const mutationPending = mutationState?.phase === "pending";
  const selectedMutationFailed =
    mutationState?.phase === "error" &&
    mutationState.decisionId === selectedDecision?.decision_id;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setSelectedDecisionId((current) => {
      if (pending.length === 0) return null;
      if (current && pending.some((decision) => decision.decision_id === current)) {
        return current;
      }
      return pending[0].decision_id;
    });
  }, [pending]);

  const attemptPairing = useCallback(
    async (nextPairingId: PairingId, retry = false) => {
      const revision = pairingRevisionRef.current + 1;
      pairingRevisionRef.current = revision;
      setPairingState({ phase: "pending", retry });

      try {
        await claimPairing(nextPairingId);
        if (!mountedRef.current || pairingRevisionRef.current !== revision) return;
        setPairingState({ phase: "idle" });
        router.replace("/decisions");
      } catch {
        if (!mountedRef.current || pairingRevisionRef.current !== revision) return;
        setPairingState({ phase: "error" });
      }
    },
    [claimPairing, router],
  );

  useEffect(() => {
    if (pairingQuery === null) {
      if (automaticPairingRef.current !== null) {
        automaticPairingRef.current = null;
        pairingRevisionRef.current += 1;
        setPairingState({ phase: "idle" });
      }
      return;
    }
    if (automaticPairingRef.current === pairingQuery) return;

    automaticPairingRef.current = pairingQuery;
    if (pairingId === null) {
      pairingRevisionRef.current += 1;
      setPairingState({ phase: "invalid" });
      return;
    }
    void attemptPairing(pairingId);
  }, [attemptPairing, pairingId, pairingQuery]);

  function updateSelectedDraft(value: string) {
    if (!selectedDecision) return;
    setDrafts((current) => ({
      ...current,
      [selectedDecision.decision_id]: value,
    }));
  }

  async function submitResolution(resolution: DecisionResolution) {
    if (!selectedDecision || mutationInFlightRef.current) return;
    const decisionId = selectedDecision.decision_id;
    mutationInFlightRef.current = true;
    setMutationState({ decisionId, phase: "pending" });

    try {
      await resolveDecision(decisionId, resolution);
      if (!mountedRef.current) return;
      setDrafts((current) => {
        if (current[decisionId] === undefined) return current;
        const next = { ...current };
        delete next[decisionId];
        return next;
      });
      setMutationState(null);
    } catch {
      if (mountedRef.current) {
        setMutationState({ decisionId, phase: "error" });
      }
    } finally {
      mutationInFlightRef.current = false;
    }
  }

  function submitApproval(outcome: "approved" | "denied") {
    if (!selectedDecision || selectedDecision.response_mode !== "approval") return;
    const responseText = selectedDraft.trim();
    void submitResolution({
      outcome,
      ...(responseText ? { responseText } : {}),
    });
  }

  function submitAnswer() {
    if (!selectedDecision || selectedDecision.response_mode !== "text") return;
    const responseText = selectedDraft.trim();
    if (!responseText) return;
    void submitResolution({ outcome: "answered", responseText });
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

      <div className="decisions-notices">
        {status === "stale" ? (
          <p className="decisions-data-state decisions-data-error" role="alert">
            {error ?? "SharedNet data may be out of date."}
          </p>
        ) : null}
        <PairingNotice
          pairingId={pairingId}
          pairingState={pairingState}
          retry={(nextPairingId) => void attemptPairing(nextPairingId, true)}
        />
      </div>

      <section aria-label="Pending decisions" className="pending-decisions">
        {pending.length > 0 && selectedDecision ? (
          <>
            <nav aria-label="Decision queue" className="decision-queue">
              {pending.map((decision, index) => (
                <button
                  aria-current={
                    decision.decision_id === selectedDecision.decision_id
                      ? "true"
                      : undefined
                  }
                  aria-label={`Open decision ${index + 1}: ${decision.title}`}
                  disabled={mutationPending}
                  key={decision.decision_id}
                  onClick={() => setSelectedDecisionId(decision.decision_id)}
                  type="button"
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{decision.title}</strong>
                </button>
              ))}
            </nav>

            <article
              aria-labelledby={`decision-title-${selectedDecision.decision_id}`}
              className="decision-workbench"
            >
              <div className="decision-question">
                <div className="decision-kicker">
                  <p>{selectedDecision.response_mode}</p>
                  <DecisionStatus decision={selectedDecision} />
                </div>
                <h2 id={`decision-title-${selectedDecision.decision_id}`}>
                  {selectedDecision.title}
                </h2>
                <p>{selectedDecision.description}</p>
                <small>
                  {selectedDecision.consequence ?? "No consequence provided."}
                </small>
              </div>

              <DecisionFacts decision={selectedDecision} />

              {selectedDecision.response_mode === "approval" ? (
                <>
                  <div className="decision-controls">
                    <button
                      aria-label="Deny"
                      className="decision-control decision-control-deny"
                      disabled={mutationPending}
                      onClick={() => submitApproval("denied")}
                      type="button"
                    >
                      <span aria-hidden="true" />
                      Deny
                    </button>
                    <button
                      aria-label="Approve"
                      className="decision-control decision-control-once"
                      disabled={mutationPending}
                      onClick={() => submitApproval("approved")}
                      type="button"
                    >
                      <span aria-hidden="true" />
                      Approve
                    </button>
                  </div>

                  <div className="decision-instruction">
                    <label className="sr-only" htmlFor="decision-note">
                      Optional note
                    </label>
                    <input
                      disabled={mutationPending}
                      id="decision-note"
                      onChange={(event) => updateSelectedDraft(event.target.value)}
                      placeholder="Optional note…"
                      value={selectedDraft}
                    />
                  </div>
                </>
              ) : (
                <div className="decision-text-answer">
                  <label htmlFor="decision-answer">Your answer</label>
                  <div>
                    <textarea
                      disabled={mutationPending}
                      id="decision-answer"
                      onChange={(event) => updateSelectedDraft(event.target.value)}
                      placeholder="Write your answer…"
                      rows={4}
                      value={selectedDraft}
                    />
                    <button
                      aria-label="Submit answer"
                      disabled={mutationPending || !selectedDraft.trim()}
                      onClick={submitAnswer}
                      type="button"
                    >
                      Submit answer
                    </button>
                  </div>
                </div>
              )}

              {selectedMutationFailed ? (
                <p className="decision-mutation-error" role="alert">
                  Unable to save this decision. Try again.
                </p>
              ) : null}
            </article>
          </>
        ) : status === "loading" ? (
          <p className="decisions-clear" role="status">
            Loading decisions…
          </p>
        ) : status === "stale" ? (
          <p className="decisions-clear decisions-unavailable" role="status">
            Decisions unavailable while SharedNet data is stale.
          </p>
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
              <DecisionHistoryItem decision={decision} key={decision.decision_id} />
            ))
          ) : (
            <p>No past decisions.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

export function DecisionsView() {
  return (
    <Suspense fallback={<DecisionsLoading />}>
      <DecisionsContent />
    </Suspense>
  );
}
