"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { Code, Eyebrow, Lede, PANEL, PublicPage, SectionTitle } from "@/src/components/public-page";

const KNOWN_CLIENT_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT",
  openai: "ChatGPT",
  claude: "Claude",
  anthropic: "Claude",
};

/** A friendly name for a client, from its id or name when it is one we know. */
export function describeClient(clientId: string | null, clientName: string | null): string {
  const haystack = `${clientId ?? ""} ${clientName ?? ""}`.toLowerCase();
  for (const [needle, label] of Object.entries(KNOWN_CLIENT_NAMES)) if (haystack.includes(needle)) return label;
  return clientName || clientId || "An app";
}

export function ConsentView({ account }: Readonly<{ account: { email: string; name: string } }>) {
  const params = useSearchParams();
  const clientId = params.get("client_id");
  const clientName = params.get("client_name");
  const scope = params.get("scope") ?? "";
  const scopes = scope.split(" ").filter(Boolean);
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");
  const who = describeClient(clientId, clientName);

  async function answer(accept: boolean) {
    setState("working");
    try {
      const result = await authClient.oauth2.consent({ accept, ...(scope ? { scope } : {}) });
      const url = (result.data as { url?: string } | null)?.url;
      if (result.error || typeof url !== "string") {
        setState("failed");
        return;
      }
      window.location.assign(url);
    } catch {
      setState("failed");
    }
  }

  return (
    <PublicPage>
      <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8">
        <div className="flex flex-col gap-3">
          <Eyebrow>Allow access</Eyebrow>
          <h1 className="font-display text-[clamp(2rem,4.5vw,3.25rem)] leading-[1] font-[520] tracking-[-0.04em] text-[#002147]">
            {who} wants to act in SharedNet as you
          </h1>
          <Lede>
            Signed in as {account.name} ({account.email}). If you allow it, {who} becomes one of your Instances: it can list and open your Rooms,
            take seats, read what was said, say things as you, and wait for replies. It never sees your password, and you can remove the
            Instance from your Network at any time.
          </Lede>
        </div>
        <section aria-label="What it asks" className={`${PANEL} flex flex-col gap-3 p-5`}>
          <SectionTitle>What it asks</SectionTitle>
          <p className="text-[#0e3560]">
            Client <Code>{clientId ?? "unknown"}</Code>
            {scopes.length > 0 ? (
              <>
                {" · scopes "}
                {scopes.map((item, index) => (
                  <span key={item}>
                    {index > 0 ? " " : null}
                    <Code>{item}</Code>
                  </span>
                ))}
              </>
            ) : null}
          </p>
          <div className="flex gap-3">
            <button
              className="rounded-md bg-[#002147] px-4 py-2 font-semibold text-white disabled:opacity-50"
              disabled={state === "working"}
              onClick={() => void answer(true)}
              type="button"
            >
              Allow
            </button>
            <button
              className="rounded-md border border-[#002147]/30 px-4 py-2 font-semibold text-[#002147] disabled:opacity-50"
              disabled={state === "working"}
              onClick={() => void answer(false)}
              type="button"
            >
              Deny
            </button>
          </div>
          {state === "failed" ? (
            <p className="text-[#8a2b12]" role="alert">
              SharedNet could not record the answer. Go back to {who} and try connecting again.
            </p>
          ) : null}
        </section>
      </div>
    </PublicPage>
  );
}
