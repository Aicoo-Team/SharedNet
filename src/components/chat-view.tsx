"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import { aggregateUsage } from "@/src/domain/network-demo";
import { formatTokenCount } from "./app-shell";

function roomNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function ChatView() {
  const { state, submitPrompt } = useSharedNetDemo();
  const [draft, setDraft] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    state.tasks.at(-1)?.id ?? null,
  );

  useEffect(() => {
    if (state.tasks.length === 0) {
      setSelectedTaskId(null);
      return;
    }
    if (!state.tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(state.tasks.at(-1)?.id ?? null);
    }
  }, [selectedTaskId, state.tasks]);

  const selectedTask =
    state.tasks.find((task) => task.id === selectedTaskId) ?? state.tasks.at(-1);
  const selectedAgents = selectedTask
    ? selectedTask.selectedAgentIds
        .map((agentId) => state.agents.find((agent) => agent.id === agentId))
        .filter((agent) => agent !== undefined)
    : [];
  const selectedMessages = selectedTask
    ? state.messages.filter((message) => message.taskId === selectedTask.id)
    : [];
  const workMessage = selectedMessages.find((message) => message.kind === "work");
  const pendingCount = selectedTask
    ? state.decisions.filter(
        (decision) =>
          decision.taskId === selectedTask.id && decision.status === "pending",
      ).length
    : 0;
  const principalCount = new Set(selectedAgents.map((agent) => agent.principalId)).size;
  const usage = useMemo(
    () =>
      aggregateUsage(
        selectedTask
          ? state.usage.filter((entry) => entry.taskId === selectedTask.id)
          : [],
      ),
    [selectedTask, state.usage],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt) return;
    const nextTaskId = `task-network-${state.tasks.length + 1}`;
    submitPrompt(prompt);
    setSelectedTaskId(nextTaskId);
    setDraft("");
  }

  const composer = (
    <form className="room-composer" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor="task-prompt">
        What do you want done?
      </label>
      <textarea
        id="task-prompt"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Type here…"
        rows={3}
        value={draft}
      />
      <button aria-label="Send task" disabled={!draft.trim()} type="submit">
        <span aria-hidden="true">↑</span>
      </button>
    </form>
  );

  if (state.tasks.length === 0) {
    return <section className="chat-room-empty">{composer}</section>;
  }

  return (
    <div className="rooms-workspace">
      <aside className="rooms-sidebar">
        <p>Rooms</p>
        <nav aria-label="Rooms">
          {state.tasks.map((task, index) => (
            <button
              aria-current={task.id === selectedTask?.id ? "true" : undefined}
              aria-label={`Open room ${roomNumber(index)}: ${task.prompt}`}
              key={task.id}
              onClick={() => setSelectedTaskId(task.id)}
              type="button"
            >
              <span>{roomNumber(index)}</span>
              <strong>{task.prompt}</strong>
            </button>
          ))}
        </nav>
      </aside>

      <section className="room-canvas" aria-live="polite">
        {selectedTask ? (
          <>
            <header className="room-heading">
              <div>
                <p>Room {roomNumber(state.tasks.indexOf(selectedTask))}</p>
                <h1>{selectedTask.prompt}</h1>
              </div>
              <p className="room-usage">
                {formatTokenCount(usage.totalTokens)} tokens · ${usage.costUsd.toFixed(2)}
              </p>
            </header>

            <div className="room-center-stage">
              {composer}

              <section
                aria-label="Agents assembled for this room"
                className="room-assembly"
              >
                <p className="assembly-summary">
                  {selectedAgents.length} Agents assembled · {principalCount} Principals
                </p>
                <div className="assembled-principals">
                  {state.principals.map((principal) => {
                    const principalAgents = selectedAgents.filter(
                      (agent) => agent.principalId === principal.id,
                    );
                    if (principalAgents.length === 0) return null;

                    return (
                      <section key={principal.id}>
                        <p>{principal.handle}</p>
                        <ul>
                          {principalAgents.map((agent) => (
                            <li key={agent.id}>{agent.handle}</li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </div>
              </section>
            </div>

            <footer className="room-footer">
              <details>
                <summary>Agent work · {workMessage?.contributions?.length ?? 0}</summary>
                <ol>
                  {(workMessage?.contributions ?? []).map((contribution) => {
                    const agent = state.agents.find(
                      (candidate) => candidate.id === contribution.agentId,
                    );
                    return (
                      <li key={contribution.agentId}>
                        <span>{agent?.handle}</span>
                        <p>{contribution.output}</p>
                      </li>
                    );
                  })}
                </ol>
              </details>
              {pendingCount > 0 ? (
                <Link href="/decisions">{pendingCount} decisions need you →</Link>
              ) : (
                <span>All decisions recorded</span>
              )}
            </footer>
          </>
        ) : null}
      </section>
    </div>
  );
}
