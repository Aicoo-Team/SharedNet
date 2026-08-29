"use client";

import { ArrowRight, Check, Sparkles } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  INTERVIEW_QUESTIONS,
  calculateReadiness,
  getNextQuestion,
} from "@/src/domain/interview";
import type { InterviewAnswers, InterviewDimension } from "@/src/domain/types";

export function InterviewStage({
  answers,
  onAnswer,
}: {
  answers: InterviewAnswers;
  onAnswer: (dimension: InterviewDimension, answer: string) => void;
}) {
  const question = getNextQuestion(answers);
  const readiness = calculateReadiness(answers);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setAnswer("");
    setError("");
  }, [question?.id]);

  if (!question) return null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!answer.trim()) {
      setError("Give the Product Agent one concrete decision to continue.");
      return;
    }
    onAnswer(question!.id, answer);
  }

  return (
    <section className="interview-stage stage-enter" aria-labelledby="question-title">
      <div className="stage-annotation">
        <span>PRODUCT INTERVIEW</span>
        <p>{question.reason}</p>
      </div>

      <div className="question-number" aria-hidden="true">
        {String(readiness.clearDimensions.length + 1).padStart(2, "0")}
        <span>/ 07</span>
      </div>
      <h1 id="question-title">{question.prompt}</h1>

      <form className="answer-composer" onSubmit={submit}>
        <label htmlFor={`answer-${question.id}`}>Your decision</label>
        <textarea
          autoFocus
          id={`answer-${question.id}`}
          value={answer}
          onChange={(event) => {
            setAnswer(event.target.value);
            setError("");
          }}
          placeholder={question.placeholder}
          rows={3}
          aria-describedby={error ? "answer-error" : undefined}
        />
        {error ? <p id="answer-error" className="field-error">{error}</p> : null}
        <div className="answer-actions">
          <button
            className="suggestion-action"
            type="button"
            onClick={() => setAnswer(question.suggestion)}
          >
            <Sparkles size={15} />
            Use a strong default
          </button>
          <button className="primary-action" type="submit">
            Save decision
            <ArrowRight size={18} />
          </button>
        </div>
      </form>

      <div className="readiness-block">
        <div className="readiness-heading">
          <span>Requirement readiness</span>
          <strong>{readiness.completion}%</strong>
        </div>
        <div className="readiness-track" aria-label={`${readiness.completion}% complete`}>
          <span style={{ transform: `scaleX(${readiness.completion / 100})` }} />
        </div>
        <ol className="dimension-list">
          {INTERVIEW_QUESTIONS.map((item, index) => {
            const complete = readiness.clearDimensions.includes(item.id);
            const current = item.id === question.id;
            return (
              <li key={item.id} data-state={complete ? "complete" : current ? "current" : "future"}>
                <span>{complete ? <Check size={13} /> : String(index + 1).padStart(2, "0")}</span>
                {item.id}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
