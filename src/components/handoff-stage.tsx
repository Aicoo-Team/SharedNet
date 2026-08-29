"use client";

import {
  Check,
  Download,
  ExternalLink,
  FileCode2,
  ShieldCheck,
} from "lucide-react";
import { downloadArtifact } from "@/src/lib/download";
import type { Mission } from "@/src/domain/types";
import { ProductPreview } from "./product-preview";

export function HandoffStage({
  mission,
  onDownloadAll,
}: {
  mission: Mission;
  onDownloadAll: () => void;
}) {
  const deployment = mission.connectors.find((connector) => connector.provider === "vercel");
  const previewUrl = deployment?.details.url ?? `${mission.brief.slug}.sharednet-demo.local`;
  const checksPassed = mission.verificationChecks.filter((check) => check.status === "passed").length;

  return (
    <section className="handoff-stage stage-enter" aria-labelledby="handoff-title">
      <div className="handoff-hero">
        <div className="completion-seal" aria-hidden="true">
          <Check size={27} />
        </div>
        <div>
          <p className="micro-label">MISSION COMPLETE / EVIDENCE ATTACHED</p>
          <h1 id="handoff-title">{mission.title} is ready to own.</h1>
          <p>
            The organization dissolved. The source, decisions, infrastructure truth, and
            independent verification remain with you.
          </p>
        </div>
        <button className="primary-action" type="button" onClick={onDownloadAll}>
          <Download size={17} />
          Download handoff
        </button>
      </div>

      <div className="outcome-strip">
        <div>
          <span>Preview</span>
          <strong>{previewUrl.replace(/^https?:\/\//, "")}</strong>
          <small>{deployment?.label ?? "SIMULATED"} · interactive below</small>
        </div>
        <div>
          <span>Organization</span>
          <strong>{mission.selectedAgentHandles.length} Agents</strong>
          <small>{mission.completedWaves} dependency waves</small>
        </div>
        <div>
          <span>Verification</span>
          <strong>{checksPassed}/{mission.verificationChecks.length} passed</strong>
          <small>independent Quality Agent</small>
        </div>
        <div>
          <span>Artifacts</span>
          <strong>{mission.artifacts.length} files</strong>
          <small>source + decisions + evidence</small>
        </div>
      </div>

      <div className="preview-heading">
        <div>
          <p className="micro-label">APPLICATION PREVIEW</p>
          <h2>The delivered product, not a screenshot.</h2>
        </div>
        <span className={`truth-badge truth-${deployment?.mode ?? "demo"}`}>
          <span className="status-pip" />
          {deployment?.label ?? "SIMULATED"}
        </span>
      </div>
      <ProductPreview brief={mission.brief} />

      <div className="handoff-grid">
        <div className="artifact-section">
          <div className="section-heading">
            <span>Owner package</span>
            <small>{mission.artifacts.length} files</small>
          </div>
          <div className="artifact-list">
            {mission.artifacts.map((artifact) => (
              <button type="button" key={artifact.id} onClick={() => downloadArtifact(artifact)}>
                <FileCode2 size={17} />
                <span>
                  <strong>{artifact.name}</strong>
                  <small>{artifact.language} · {artifact.producedBy}</small>
                </span>
                {artifact.redacted ? <em>REDACTED</em> : null}
                <Download size={15} />
              </button>
            ))}
          </div>
        </div>

        <div className="verification-section">
          <div className="section-heading">
            <span>Independent evidence</span>
            <ShieldCheck size={17} />
          </div>
          <ul>
            {mission.verificationChecks.map((check) => (
              <li key={check.id}>
                <Check size={14} />
                <span>
                  <strong>{check.label}</strong>
                  <small>{check.evidence}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="next-iteration">
        <span>NEXT ITERATION / 01</span>
        <p>Connect real credentials, promote the preview, then recruit persistent domain Agents from another Principal.</p>
        <button type="button">
          Plan the next Mission
          <ExternalLink size={15} />
        </button>
      </div>
    </section>
  );
}
