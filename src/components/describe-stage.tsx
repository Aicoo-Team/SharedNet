"use client";

import { ArrowRight, CornerDownLeft } from "lucide-react";
import { FormEvent, useState } from "react";

const EXAMPLES = [
  "Build a customer feedback board",
  "Launch a waitlist for a research product",
  "Create a public directory for climate tools",
];

export function DescribeStage({
  initialIdea,
  onStart,
}: {
  initialIdea: string;
  onStart: (idea: string) => boolean;
}) {
  const [idea, setIdea] = useState(initialIdea);
  const [error, setError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!onStart(idea)) {
      setError("Describe the outcome you want SharedNet to launch.");
    }
  }

  return (
    <section className="describe-stage stage-enter" aria-labelledby="describe-title">
      <div className="describe-kicker">
        <span>01</span>
        <p>Outcome in. Organization out.</p>
      </div>
      <h1 id="describe-title">
        Bring the outcome.
        <span>SharedNet forms the company around it.</span>
      </h1>
      <p className="stage-lead">
        One Mission interviews you, recruits the smallest useful Agent team, builds the product,
        verifies it independently, and hands back the work.
      </p>

      <form className="idea-composer" onSubmit={submit}>
        <label htmlFor="launch-idea">What do you want to launch?</label>
        <textarea
          id="launch-idea"
          value={idea}
          onChange={(event) => {
            setIdea(event.target.value);
            setError("");
          }}
          placeholder="A website where customers submit and vote on product ideas…"
          aria-describedby={error ? "idea-error" : "idea-help"}
          rows={3}
        />
        <div className="composer-footer">
          <p id={error ? "idea-error" : "idea-help"} className={error ? "field-error" : "field-help"}>
            {error || "Rough is fine. The Product Agent will find the decisions that matter."}
          </p>
          <button className="primary-action" type="submit">
            Shape the product
            <ArrowRight size={18} />
          </button>
        </div>
      </form>

      <div className="example-strip" aria-label="Example Missions">
        <span>Try an outcome</span>
        {EXAMPLES.map((example) => (
          <button type="button" key={example} onClick={() => setIdea(example)}>
            {example}
          </button>
        ))}
      </div>

      <div className="cli-cue" aria-label="Command line entry point">
        <span>$</span>
        <code>npx sharednet launch</code>
        <span className="cli-spacer" />
        <CornerDownLeft size={14} />
        <small>same Mission, local runtimes eligible</small>
      </div>
    </section>
  );
}
