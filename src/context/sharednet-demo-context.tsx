"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  createInitialDemoState,
  isDemoState,
  resolveDecision as resolveDecisionInState,
  selectAgent as selectAgentInState,
  submitChatPrompt,
  type DecisionStatus,
  type SharedNetDemoState,
} from "@/src/domain/network-demo";

const STORAGE_KEY = "sharednet:network-console:v3";

function removePersistedState(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The deterministic demo remains fully usable when storage is unavailable.
  }
}

interface SharedNetDemoContextValue {
  state: SharedNetDemoState;
  submitPrompt: (prompt: string) => void;
  resolveDecision: (
    decisionId: string,
    outcome: Exclude<DecisionStatus, "pending">,
    resolutionNote?: string,
  ) => void;
  selectAgent: (agentId: string) => void;
  resetDemo: () => void;
}

const SharedNetDemoContext = createContext<SharedNetDemoContextValue | null>(null);

export function SharedNetDemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(createInitialDemoState);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    try {
      const rawState = window.localStorage.getItem(STORAGE_KEY);
      if (rawState) {
        const parsedState: unknown = JSON.parse(rawState);
        if (isDemoState(parsedState)) {
          setState(parsedState);
        } else {
          removePersistedState();
        }
      }
    } catch {
      removePersistedState();
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Persistence is an enhancement; coordination state still works in memory.
    }
  }, [state, storageReady]);

  const submitPrompt = useCallback((prompt: string) => {
    setState((current) => submitChatPrompt(current, prompt));
  }, []);

  const resolveDecision = useCallback(
    (
      decisionId: string,
      outcome: Exclude<DecisionStatus, "pending">,
      resolutionNote?: string,
    ) => {
      setState((current) =>
        resolveDecisionInState(current, decisionId, outcome, resolutionNote),
      );
    },
    [],
  );

  const selectAgent = useCallback((agentId: string) => {
    setState((current) => selectAgentInState(current, agentId));
  }, []);

  const resetDemo = useCallback(() => {
    setState(createInitialDemoState());
  }, []);

  const value = useMemo(
    () => ({ state, submitPrompt, resolveDecision, selectAgent, resetDemo }),
    [state, submitPrompt, resolveDecision, selectAgent, resetDemo],
  );

  return (
    <SharedNetDemoContext.Provider value={value}>
      {children}
    </SharedNetDemoContext.Provider>
  );
}

export function useSharedNetDemo(): SharedNetDemoContextValue {
  const context = useContext(SharedNetDemoContext);
  if (!context) {
    throw new Error("useSharedNetDemo must be used inside SharedNetDemoProvider");
  }
  return context;
}
