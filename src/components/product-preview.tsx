"use client";

import { ArrowUp, Plus } from "lucide-react";
import { FormEvent, useState } from "react";
import type { ProductBrief } from "@/src/domain/types";

interface PreviewIdea {
  id: number;
  title: string;
  detail: string;
  votes: number;
  status: "Planned" | "Reviewing" | "New";
}

const SEED: PreviewIdea[] = [
  {
    id: 1,
    title: "A clearer first-run experience",
    detail: "Show teams the one action that unlocks value in their first minute.",
    votes: 24,
    status: "Planned",
  },
  {
    id: 2,
    title: "Weekly progress digest",
    detail: "Send a compact summary of what moved and what needs a decision.",
    votes: 17,
    status: "Reviewing",
  },
];

export function ProductPreview({ brief }: { brief: ProductBrief }) {
  const [ideas, setIdeas] = useState(SEED);
  const [title, setTitle] = useState("");

  function addIdea(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setIdeas((current) => [
      {
        id: Date.now(),
        title: title.trim(),
        detail: "Submitted through the SharedNet interactive handoff preview.",
        votes: 1,
        status: "New",
      },
      ...current,
    ]);
    setTitle("");
  }

  function vote(id: number) {
    setIdeas((current) =>
      current.map((idea) => (idea.id === id ? { ...idea, votes: idea.votes + 1 } : idea)),
    );
  }

  return (
    <div className="product-preview">
      <header>
        <span className="preview-logo">{brief.title.charAt(0)}</span>
        <strong>{brief.title}</strong>
        <nav aria-label="Preview navigation">
          <span>Ideas</span>
          <span>Roadmap</span>
        </nav>
        <span className="preview-owner">XB</span>
      </header>

      <main>
        <div className="preview-hero">
          <span>PUBLIC FEEDBACK BOARD</span>
          <h2>Help us decide what deserves to exist next.</h2>
          <p>{brief.outcome}. Vote for what matters or propose something sharper.</p>
        </div>

        <form onSubmit={addIdea}>
          <label htmlFor="preview-idea">Add an idea</label>
          <div>
            <input
              id="preview-idea"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What should we improve?"
            />
            <button type="submit" aria-label="Publish idea">
              <Plus size={17} />
            </button>
          </div>
        </form>

        <div className="preview-list">
          {ideas.map((idea) => (
            <article key={idea.id}>
              <button type="button" onClick={() => vote(idea.id)} aria-label={`Vote for ${idea.title}`}>
                <ArrowUp size={13} />
                {idea.votes}
              </button>
              <div>
                <strong>{idea.title}</strong>
                <p>{idea.detail}</p>
              </div>
              <span data-status={idea.status.toLowerCase()}>{idea.status}</span>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
