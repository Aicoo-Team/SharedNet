"use client";

import Link from "next/link";
import { ArrowRight, Check, CornerDownLeft, ExternalLink } from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import {
  aggregateUsage,
  type TranscriptMessage,
} from "@/src/domain/network-demo";
import { formatTokenCount } from "./app-shell";

const EXAMPLE_PROMPT =
  "Build and launch a customer feedback website. Research the product, use Neon for data, deploy on Vercel, and independently verify it.";

function MessageBlock({ message }: { message: TranscriptMessage }) {
  const { state } = useSharedNetDemo();
  const agent = state.agents.find((candidate) => candidate.id === message.agentId);
  const involvedAgents = (message.agentIds ?? [])
    .map((agentId) => state.agents.find((candidate) => candidate.id === agentId))
    .filter((candidate) => candidate !== undefined);
  const pendingTaskDecisions = state.decisions.filter(
    (decision) => decision.taskId === message.taskId && decision.status === "pending",
  ).length;
  const content =
    message.kind === "result"
      ? pendingTaskDecisions > 0
        ? `The implementation package is ready to review. ${pendingTaskDecisions} authority ${pendingTaskDecisions === 1 ? "decision remains" : "decisions remain"} before SharedNet could recruit external runtimes or touch provider accounts.`
        : "The implementation package is ready, and all authority decisions for this task are resolved. The audit remains available in Decisions."
      : message.content;
  const actionLabel =
    message.kind === "result"
      ? pendingTaskDecisions > 0
        ? `Review ${pendingTaskDecisions} ${pendingTaskDecisions === 1 ? "decision" : "decisions"}`
        : "View decision audit"
      : message.actionLabel;

  if (message.kind === "user") {
    return (
      <article className="transcript-entry transcript-user">
        <p className="entry-author">You</p>
        <p className="user-prompt">{message.content}</p>
      </article>
    );
  }

  return (
    <article className={`transcript-entry transcript-${message.kind}`}>
      <div className="entry-gutter" aria-hidden="true">
        <span>{message.kind === "plan" ? "P" : message.kind === "result" ? "R" : "·"}</span>
      </div>
      <div className="entry-body">
        <p className="entry-author">
          {agent?.handle ?? "SharedNet"}
          <span>{message.kind}</span>
        </p>
        {message.title ? <h2>{message.title}</h2> : null}
        <p className="entry-copy">{content}</p>

        {message.details ? (
          <ol className="entry-details">
            {message.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ol>
        ) : null}

        {message.kind === "coordination" ? (
          <div className="candidate-world" aria-label="Selected Agent organization">
            <div>
              <p className="candidate-label">Your Principal · accountable</p>
              <ul>
                {involvedAgents
                  .filter((candidate) => candidate.principalId === "principal-xisen")
                  .map((candidate) => (
                    <li key={candidate.id}>{candidate.handle}</li>
                  ))}
              </ul>
            </div>
            <div>
              <p className="candidate-label">Aicoo · requested specialists</p>
              <ul>
                {involvedAgents
                  .filter((candidate) => candidate.principalId === "principal-aicoo")
                  .map((candidate) => (
                    <li key={candidate.id}>{candidate.handle}</li>
                  ))}
              </ul>
            </div>
          </div>
        ) : null}

        {message.kind === "work" && message.contributions ? (
          <section className="work-ledger" aria-label="Agent work ledger">
            <header>
              <p>Agent</p>
              <p>Accepted contribution</p>
              <p>State</p>
            </header>
            <ul>
              {message.contributions.map((contribution) => {
                const contributor = state.agents.find(
                  (candidate) => candidate.id === contribution.agentId,
                );
                if (!contributor) return null;
                return (
                  <li key={contribution.agentId}>
                    <div>
                      <strong>{contributor.handle}</strong>
                      <span>
                        {contributor.principalId === "principal-xisen"
                          ? "Your Principal"
                          : "Aicoo · external"}
                      </span>
                    </div>
                    <p>{contribution.output}</p>
                    <span className="work-state">
                      <Check aria-hidden="true" size={12} />
                      simulated
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {message.kind === "result" ? (
          <div className="result-preview" aria-label="Demo website preview">
            <div className="preview-browser-bar">
              <span />
              <span />
              <span />
              <p>feedback.example</p>
            </div>
            <div className="preview-site">
              <div>
                <p className="preview-brand">Signalboard</p>
                <p className="preview-kicker">Customer feedback, in one clear queue.</p>
              </div>
              <div className="preview-items" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            </div>
            <p className="preview-disclaimer">
              Simulated handoff · no external runtime or provider was invoked
            </p>
          </div>
        ) : null}

        {message.actionHref && actionLabel ? (
          <Link className="text-action" href={message.actionHref}>
            {actionLabel}
            <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
          </Link>
        ) : null}
      </div>
    </article>
  );
}

export function ChatView() {
  const { state, submitPrompt, resetDemo } = useSharedNetDemo();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestTask = state.tasks.at(-1);
  const taskUsage = useMemo(
    () =>
      aggregateUsage(
        latestTask
          ? state.usage.filter((entry) => entry.taskId === latestTask.id)
          : [],
      ),
    [latestTask, state.usage],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    submitPrompt(draft);
    setDraft("");
  }

  function useExample() {
    setDraft(EXAMPLE_PROMPT);
    textareaRef.current?.focus();
  }

  const composer = (
    <form className="chat-composer" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="task-prompt">
        What do you want done?
      </label>
      <textarea
        id="task-prompt"
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Describe an outcome…"
        rows={3}
      />
      <div className="composer-footer">
        <p>
          <CornerDownLeft aria-hidden="true" size={13} />
          ⌘ Enter
        </p>
        <button type="submit" disabled={!draft.trim()} aria-label="Send task">
          <ArrowRight aria-hidden="true" size={19} />
        </button>
      </div>
    </form>
  );

  if (state.messages.length === 0) {
    return (
      <section className="chat-empty page-frame">
        <div className="chat-empty-inner">
          <p className="eyebrow">Website launch V1 · one outcome</p>
          <h1>What do you want done?</h1>
          <p className="chat-empty-copy">
            This canonical website-launch flow lets your Planning Agent decide what
            to do itself, what to parallelize, and when the network is worth involving.
          </p>
          {composer}
          <button
            className="example-prompt"
            type="button"
            onClick={useExample}
            aria-label="Try a website launch"
          >
            <span>Try a website launch</span>
            Build, connect Neon, deploy to Vercel, verify
            <ExternalLink aria-hidden="true" size={14} />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-thread">
      <div className="thread-heading">
        <p className="eyebrow">Task thread · simulated execution</p>
        <h1>{latestTask?.prompt}</h1>
      </div>

      <div className="transcript" aria-live="polite">
        {state.messages.map((message) => (
          <MessageBlock key={message.id} message={message} />
        ))}
      </div>

      {latestTask ? (
        <section className="task-usage" aria-labelledby="task-usage-title">
          <div>
            <p className="eyebrow" id="task-usage-title">
              Task usage
            </p>
            <strong>{formatTokenCount(taskUsage.totalTokens)} tokens</strong>
          </div>
          <dl>
            <div>
              <dt>Input</dt>
              <dd>{taskUsage.inputTokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>{taskUsage.outputTokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Cached</dt>
              <dd>{taskUsage.cachedTokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>${taskUsage.costUsd.toFixed(2)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <div className="thread-reset-wrap">
        <button type="button" className="text-action" onClick={resetDemo}>
          Start another website launch
          <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
      </div>
    </section>
  );
}
