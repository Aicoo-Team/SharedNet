"use client";

import { ArrowRight, Check, Database, Globe2, ShieldCheck } from "lucide-react";
import type { ProductBrief } from "@/src/domain/types";

export function BriefStage({
  brief,
  mode,
  approved,
  onUpdate,
  onModeChange,
  onApprovalChange,
  onConfirm,
}: {
  brief: ProductBrief;
  mode: "demo" | "live";
  approved: boolean;
  onUpdate: (updates: Partial<ProductBrief>) => void;
  onModeChange: (mode: "demo" | "live") => void;
  onApprovalChange: (approved: boolean) => void;
  onConfirm: () => void;
}) {
  const canConfirm = mode === "demo" || approved;

  return (
    <section className="brief-stage stage-enter" aria-labelledby="brief-title">
      <div className="stage-annotation">
        <span>CONFIRMED SCOPE</span>
        <p>Edit the compact contract now. RAC will organize against this exact boundary.</p>
      </div>
      <p className="micro-label">Product Brief / {brief.slug}</p>
      <h1 id="brief-title">{brief.title}</h1>

      <label className="brief-summary-label" htmlFor="brief-summary">
        Outcome statement
      </label>
      <textarea
        id="brief-summary"
        className="brief-summary"
        value={brief.summary}
        onChange={(event) => onUpdate({ summary: event.target.value })}
        rows={3}
      />

      <div className="brief-facts">
        <div>
          <span>Primary user</span>
          <strong>{brief.primaryUser}</strong>
        </div>
        <div>
          <span>Core outcome</span>
          <strong>{brief.outcome}</strong>
        </div>
        <div>
          <span>Access boundary</span>
          <strong>{brief.accessModel}</strong>
        </div>
        <div>
          <span>Visual direction</span>
          <strong>{brief.visualDirection}</strong>
        </div>
      </div>

      <div className="brief-columns">
        <div className="brief-list">
          <h2>Acceptance boundary</h2>
          <ul>
            {brief.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>
                <Check size={15} />
                {criterion}
              </li>
            ))}
          </ul>
        </div>
        <div className="brief-list">
          <h2>System implications</h2>
          <ul>
            <li>
              <Database size={15} />
              {brief.requiresDatabase ? "Persistent Postgres data layer" : "No database required"}
            </li>
            <li>
              <Globe2 size={15} />
              {brief.launchTarget}
            </li>
            <li>
              <ShieldCheck size={15} />
              Independent acceptance verification
            </li>
          </ul>
        </div>
      </div>

      <fieldset className="runtime-choice">
        <legend>Infrastructure mode</legend>
        <label data-selected={mode === "demo"}>
          <input
            type="radio"
            name="connector-mode"
            value="demo"
            checked={mode === "demo"}
            onChange={() => onModeChange("demo")}
          />
          <span>
            <strong>Demo infrastructure</strong>
            <small>Real orchestration and artifacts; simulated provider resources.</small>
          </span>
          <em>SIMULATED</em>
        </label>
        <label data-selected={mode === "live"}>
          <input
            type="radio"
            name="connector-mode"
            value="live"
            checked={mode === "live"}
            onChange={() => onModeChange("live")}
          />
          <span>
            <strong>Connected providers</strong>
            <small>Requires server credentials and can create Neon/Vercel resources.</small>
          </span>
          <em>LIVE</em>
        </label>
      </fieldset>

      {mode === "live" ? (
        <label className="approval-row">
          <input
            type="checkbox"
            checked={approved}
            onChange={(event) => onApprovalChange(event.target.checked)}
          />
          <span>
            <strong>Approve external project creation</strong>
            <small>SharedNet may create provider resources. Credentials stay server-side.</small>
          </span>
        </label>
      ) : (
        <p className="truth-note">
          <ShieldCheck size={16} />
          No provider resources will be created.
        </p>
      )}

      <div className="stage-footer">
        <p>{brief.assumptions.length} assumptions · {brief.deferredDecisions.length} deferred decisions</p>
        <button className="primary-action" type="button" onClick={onConfirm} disabled={!canConfirm}>
          Form the organization
          <ArrowRight size={18} />
        </button>
      </div>
    </section>
  );
}
