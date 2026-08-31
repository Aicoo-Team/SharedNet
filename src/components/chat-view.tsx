"use client";

import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import {
  aggregateUsage,
  type TranscriptMessage,
} from "@/src/domain/network-demo";
import { formatTokenCount } from "./app-shell";

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
              <p className="candidate-label">Your Principal</p>
              <ul>
                {involvedAgents
                  .filter((candidate) => candidate.principalId === "principal-xisen")
                  .map((candidate) => (
                    <li key={candidate.id}>{candidate.handle}</li>
                  ))}
              </ul>
            </div>
            <div>
              <p className="candidate-label">Aicoo · requested</p>
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
            <div className="work-ledger-head" aria-hidden="true">
              <span>Agent</span>
              <span>Contribution</span>
              <span>State</span>
            </div>
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
                          ? "yours"
                          : "Aicoo"}
                      </span>
                    </div>
                    <p>{contribution.output}</p>
                    <span className="work-state">simulated</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {message.actionHref && actionLabel ? (
          <Link className="text-action" href={message.actionHref}>
            {actionLabel}
            <span aria-hidden="true">→</span>
          </Link>
        ) : null}
      </div>
    </article>
  );
}

export function ChatView() {
  const { state, submitPrompt, resetDemo } = useSharedNetDemo();
  const [draft, setDraft] = useState("");
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

  const composer = (
    <form className="chat-composer" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="task-prompt">
        What do you want done?
      </label>
      <textarea
        id="task-prompt"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Describe an outcome…"
        rows={4}
      />
      <div className="composer-footer">
        <span>⌘ Enter</span>
        <button type="submit" disabled={!draft.trim()} aria-label="Send task">
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </form>
  );

  if (state.messages.length === 0) {
    return (
      <section className="chat-empty page-frame">
        <div className="chat-empty-inner">
          <h1>What do you want done?</h1>
          {composer}
        </div>
      </section>
    );
  }

  return (
    <section className="chat-thread">
      <header className="thread-heading">
        <h1>{latestTask?.prompt}</h1>
      </header>

      <div className="transcript" aria-live="polite">
        {state.messages.map((message) => (
          <MessageBlock key={message.id} message={message} />
        ))}
      </div>

      {latestTask ? (
        <section className="task-usage" aria-labelledby="task-usage-title">
          <p id="task-usage-title">Task usage</p>
          <div>
            <strong>{formatTokenCount(taskUsage.totalTokens)} tokens</strong>
            <span>${taskUsage.costUsd.toFixed(2)}</span>
          </div>
        </section>
      ) : null}

      <div className="thread-reset-wrap">
        <button type="button" className="text-action" onClick={resetDemo}>
          New task
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  );
}
