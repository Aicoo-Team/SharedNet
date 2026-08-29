"use client";

import { Network, RotateCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LaunchStage } from "@/src/hooks/use-mission";

const STAGES: { id: LaunchStage; label: string }[] = [
  { id: "describe", label: "Describe" },
  { id: "clarify", label: "Clarify" },
  { id: "confirm", label: "Confirm" },
  { id: "organize", label: "Organize" },
  { id: "build", label: "Build" },
  { id: "handoff", label: "Handoff" },
];

export function MissionHeader({
  stage,
  mode,
  onReset,
}: {
  stage: LaunchStage;
  mode: "demo" | "live";
  onReset: () => void;
}) {
  const currentIndex = STAGES.findIndex((item) => item.id === stage);
  const currentStageRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    currentStageRef.current?.scrollIntoView?.({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [stage]);

  return (
    <header className="mission-header">
      <a className="brand" href="#main-content" aria-label="SharedNet Website Launch">
        <span className="brand-mark" aria-hidden="true">
          <Network size={17} strokeWidth={2.2} />
        </span>
        <span>SharedNet</span>
        <span className="brand-product">Website Launch</span>
      </a>

      <nav className="stage-nav" aria-label="Mission progress">
        <ol>
          {STAGES.map((item, index) => (
            <li
              key={item.id}
              ref={index === currentIndex ? currentStageRef : undefined}
              data-state={
                index < currentIndex ? "complete" : index === currentIndex ? "current" : "future"
              }
              aria-current={index === currentIndex ? "step" : undefined}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {item.label}
            </li>
          ))}
        </ol>
      </nav>

      <div className="header-actions">
        <span className={`truth-badge truth-${mode}`}>
          <span className="status-pip" aria-hidden="true" />
          {mode === "demo" ? "SIMULATED" : "LIVE"}
        </span>
        {stage !== "describe" ? (
          <button className="icon-action" type="button" onClick={onReset} aria-label="Start over">
            <RotateCcw size={16} />
          </button>
        ) : null}
      </div>
    </header>
  );
}
