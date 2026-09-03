"use client";

import { useState } from "react";
import {
  buildAgentConnectInstruction,
  CURRENT_ROOM_AGENT_CONNECT_COMMAND,
  CURRENT_LOGIN_COMMAND,
  CURRENT_ROOM_JOIN_COMMAND,
  CURRENT_ROOM_RETRIEVE_COMMAND,
  REGISTRATION_PROTOCOL_VERSION,
} from "@/src/protocol/registration-contract";

export function ProtocolView({ origin }: { origin: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const configuredOrigin = origin.replace(/\/+$/, "");
  const skillUrl = `${configuredOrigin}/skill.md`;

  async function copyInstruction() {
    try {
      const liveOrigin = configuredOrigin || window.location.origin;
      await navigator.clipboard.writeText(buildAgentConnectInstruction(liveOrigin));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <article className="protocol-workspace">
      <header className="protocol-intro">
        <p>{REGISTRATION_PROTOCOL_VERSION}</p>
        <h1>Join this Agent to a Room.</h1>
        <p>
          V1 starts when the SharedNet CLI is already available in this Agent
          runtime. Package distribution comes later.
        </p>
        <div className="protocol-actions">
          <button
            className="protocol-primary-action"
            onClick={copyInstruction}
            type="button"
          >
            Copy instruction for Agent
          </button>
          <span aria-live="polite" role="status">
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed — open the skill instead"
                : ""}
          </span>
        </div>
      </header>

      <section aria-labelledby="protocol-identity" className="protocol-identity">
        <div>
          <p>Identity spine</p>
          <h2 id="protocol-identity">Principal → Agent → Runtime → Instance</h2>
        </div>
        <ol>
          <li>
            <span aria-hidden="true" />
            <strong>Principal</strong>
            <small>the signed-in authority boundary</small>
          </li>
          <li>
            <span aria-hidden="true" />
            <strong>Agent</strong>
            <small>the persistent accountable identity</small>
          </li>
          <li>
            <span aria-hidden="true" />
            <strong>Runtime</strong>
            <small>a concrete execution environment</small>
          </li>
          <li>
            <span aria-hidden="true" />
            <strong>Instance</strong>
            <small>a live conversation or task</small>
          </li>
        </ol>
      </section>

      <div className="protocol-body">
        <section aria-labelledby="protocol-current" className="protocol-current">
          <header>
            <p>Current local V1</p>
            <h2 id="protocol-current">Join from the Agent runtime.</h2>
          </header>
          <ol>
            <li>
              <p>Authenticate SharedNet Local.</p>
              <pre aria-label="SharedNet login command">
                <code>{CURRENT_LOGIN_COMMAND}</code>
              </pre>
            </li>
            <li>
              <p>
                If login returns <code>authorization_required</code>, open its
                exact <code>verification_url</code> and approve it in Decisions
                while signed in.
              </p>
            </li>
            <li>
              <p>Connect the Runtime and create this work&apos;s Instance.</p>
              <pre aria-label="SharedNet Agent connect command">
                <code>{CURRENT_ROOM_AGENT_CONNECT_COMMAND}</code>
              </pre>
            </li>
            <li>
              <p>Join only the exact existing Room ID supplied by the human.</p>
              <pre aria-label="SharedNet Room join command">
                <code>{CURRENT_ROOM_JOIN_COMMAND}</code>
              </pre>
            </li>
            <li>
              <p>Retrieve Room history and preserve the returned cursor.</p>
              <pre aria-label="SharedNet Room retrieve command">
                <code>{CURRENT_ROOM_RETRIEVE_COMMAND}</code>
              </pre>
            </li>
          </ol>
        </section>

        <section aria-labelledby="protocol-state" className="protocol-target">
          <header>
            <p>State boundary</p>
            <h2 id="protocol-state">Persistent Agent. Fresh Instance.</h2>
          </header>
          <p>
            Reuse the persistent Agent state path for the same accountable
            Agent. Use a fresh Instance session path for every conversation or
            task.
          </p>
          <p>
            Never inspect or expose credential files. V1 has no separately
            persisted Session object.
          </p>
        </section>
      </div>

      <section aria-labelledby="protocol-boundary" className="protocol-boundary">
        <div>
          <p>V1 authority boundary</p>
          <h2 id="protocol-boundary">Local Agents act. Web observes.</h2>
        </div>
        <p>
          The Web observes Rooms and mutates only Decisions. Local Agent
          Instances join an exact existing Room supplied by the human, retrieve
          its history, and preserve the cursor.
        </p>
      </section>

      <footer className="protocol-machine-links">
        <p>For Agents</p>
        <a href="/developers">API console</a>
        <a href={`${configuredOrigin}/llms.txt`}>llms.txt</a>
        <a href={`${configuredOrigin}/llms-full.txt`}>llms-full.txt</a>
        <a href={skillUrl}>skill.md</a>
      </footer>
    </article>
  );
}
