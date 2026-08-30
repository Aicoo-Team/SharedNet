"use client";

import { Check, Cloud, Laptop, Network, Server, Zap } from "lucide-react";
import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import {
  aggregateUsage,
  type Agent,
  type Principal,
  type TaskRecruitment,
} from "@/src/domain/network-demo";
import { formatTokenCount } from "./app-shell";

function RuntimeIcon({ kind }: { kind: Agent["runtime"]["kind"] }) {
  if (kind === "local") return <Laptop aria-hidden="true" size={14} />;
  if (kind === "vpc") return <Server aria-hidden="true" size={14} />;
  return <Cloud aria-hidden="true" size={14} />;
}

function PrincipalRegion({
  principal,
  agents,
  selectedAgentId,
  recruitmentAgentIds,
  recruitmentStatus,
  onSelect,
  usageTokens,
  usageCost,
}: {
  principal: Principal;
  agents: Agent[];
  selectedAgentId: string;
  recruitmentAgentIds: Set<string>;
  recruitmentStatus?: TaskRecruitment["status"];
  onSelect: (agentId: string) => void;
  usageTokens: number;
  usageCost: number;
}) {
  const isOwn = principal.kind === "self";

  return (
    <section
      className={`principal-region ${isOwn ? "principal-own" : "principal-connected"}`}
      aria-label={`${isOwn ? "Your" : "Connected"} Principal ${principal.handle}`}
    >
      <header className="principal-header">
        <div>
          <p className="eyebrow">
            {isOwn ? "Your Principal" : "Connected Principal"}
          </p>
          <h2>
            {principal.name} <span>{principal.handle}</span>
          </h2>
          <p>{principal.summary}</p>
        </div>
        <div className="principal-usage" aria-label={`${principal.handle} usage`}>
          <strong>{formatTokenCount(usageTokens)}</strong>
          <span>${usageCost.toFixed(2)}</span>
        </div>
      </header>

      <div className="agent-list">
        {agents.map((agent) => {
          const isSelected = selectedAgentId === agent.id;
          const isInRecruitment = recruitmentAgentIds.has(agent.id);
          const recruitmentLabel = isInRecruitment
            ? recruitmentStatus === "approved"
              ? "RECRUITED"
              : recruitmentStatus === "denied"
                ? "DECLINED"
                : "REQUESTED"
            : null;
          return (
            <button
              type="button"
              className="agent-row"
              aria-label={`Inspect ${agent.handle}`}
              aria-pressed={isSelected}
              data-selected={isSelected ? "true" : undefined}
              data-recruitment={isInRecruitment ? recruitmentStatus : undefined}
              key={agent.id}
              onClick={() => onSelect(agent.id)}
            >
              <span className={`agent-presence status-${agent.status}`} aria-hidden="true" />
              <span className="agent-identity">
                <span>
                  <strong>{agent.handle}</strong>
                  {agent.official ? <em>OFFICIAL</em> : null}
                  {recruitmentLabel ? (
                    <em className="recruitment-label">{recruitmentLabel}</em>
                  ) : null}
                </span>
                <small>{agent.role}</small>
              </span>
              <span className="agent-runtime">
                <RuntimeIcon kind={agent.runtime.kind} />
                {agent.runtime.kind}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function NetworkView() {
  const { state, selectAgent } = useSharedNetDemo();
  const ownPrincipal = state.principals.find(
    (principal) => principal.id === "principal-xisen",
  )!;
  const connectedPrincipal = state.principals.find(
    (principal) => principal.id === "principal-aicoo",
  )!;
  const ownAgents = state.agents.filter(
    (agent) => agent.principalId === ownPrincipal.id,
  );
  const connectedAgents = state.agents.filter(
    (agent) => agent.principalId === connectedPrincipal.id,
  );
  const latestRecruitment = state.recruitments.at(-1);
  const recruitmentAgentIds = new Set(latestRecruitment?.agentIds ?? []);
  const selectedAgent =
    state.agents.find((agent) => agent.id === state.selectedAgentId) ?? state.agents[0];
  const selectedPrincipal = state.principals.find(
    (principal) => principal.id === selectedAgent.principalId,
  )!;
  const selectedUsage = aggregateUsage(
    state.usage.filter((entry) => entry.agentId === selectedAgent.id),
  );
  const ownUsage = aggregateUsage(
    state.usage.filter((entry) => entry.principalId === ownPrincipal.id),
  );
  const connectedUsage = aggregateUsage(
    state.usage.filter((entry) => entry.principalId === connectedPrincipal.id),
  );

  return (
    <div className="network-page page-frame">
      <header className="page-intro network-intro">
        <p className="eyebrow">Principal graph · 2 connected</p>
        <h1>The network around you.</h1>
        <p>
          Your Agents share one identity boundary. A Principal connection lets them
          discover and request specialists without pretending those Agents belong to you.
        </p>
      </header>

      <section className="network-topology" aria-label="SharedNet Principal topology">
        <PrincipalRegion
          principal={ownPrincipal}
          agents={ownAgents}
          selectedAgentId={selectedAgent.id}
          recruitmentAgentIds={recruitmentAgentIds}
          recruitmentStatus={latestRecruitment?.status}
          onSelect={selectAgent}
          usageTokens={ownUsage.totalTokens}
          usageCost={ownUsage.costUsd}
        />

        <div className="principal-bridge" aria-label="Principal connection">
          <span className="bridge-node" aria-hidden="true" />
          <div className="bridge-line" aria-hidden="true">
            <i />
          </div>
          <div className="bridge-copy">
            <p>Principal connection</p>
            <strong>@xisen ↔ @aicoo</strong>
            <span>AgentCards + task requests</span>
          </div>
          <div className="bridge-line bridge-line-right" aria-hidden="true">
            <i />
          </div>
          <span className="bridge-node" aria-hidden="true" />
        </div>

        <PrincipalRegion
          principal={connectedPrincipal}
          agents={connectedAgents}
          selectedAgentId={selectedAgent.id}
          recruitmentAgentIds={recruitmentAgentIds}
          recruitmentStatus={latestRecruitment?.status}
          onSelect={selectAgent}
          usageTokens={connectedUsage.totalTokens}
          usageCost={connectedUsage.costUsd}
        />
      </section>

      <section className="network-legend" aria-label="Network relationship legend">
        <div>
          <span className="legend-boundary" aria-hidden="true" />
          <p>
            <strong>Intra-Principal boundary</strong>
            Persistent Agents governed by the same owner and policy boundary.
          </p>
        </div>
        <div>
          <span className="legend-solid" aria-hidden="true" />
          <p>
            <strong>Cross-Principal connection</strong>
            A durable discovery and messaging relationship between two Principals.
          </p>
        </div>
        <div>
          <span className="legend-dashed" aria-hidden="true" />
          <p>
            <strong>Task recruitment</strong>
            {latestRecruitment
              ? `${latestRecruitment.status[0]?.toUpperCase()}${latestRecruitment.status.slice(1)} · ${latestRecruitment.agentIds.length} Agents`
              : "No task-scoped request yet"}
          </p>
        </div>
      </section>

      <section className="agent-details" aria-label="Agent details">
        <header>
          <div>
            <p className="eyebrow">
              AgentCard · {selectedPrincipal.handle}
            </p>
            <h2>{selectedAgent.handle}</h2>
            <p>{selectedAgent.summary}</p>
          </div>
          <span className={`agent-status agent-status-${selectedAgent.status}`}>
            {selectedAgent.status}
          </span>
        </header>

        <div className="agent-facts">
          <div>
            <p className="fact-label">Execution endpoint</p>
            <strong>
              <RuntimeIcon kind={selectedAgent.runtime.kind} />
              {selectedAgent.runtime.label}
            </strong>
            <span>{selectedAgent.runtime.environment}</span>
          </div>
          <div>
            <p className="fact-label">Discoverability</p>
            <strong>
              <Network aria-hidden="true" size={14} />
              {selectedAgent.discoverability === "connections"
                ? "Connections can discover"
                : "Private to Principal"}
            </strong>
            <span>
              {selectedAgent.official
                ? "Published by the Aicoo Principal"
                : "Governed by your Principal policy"}
            </span>
          </div>
          <div>
            <p className="fact-label">Platform usage</p>
            <strong>
              <Zap aria-hidden="true" size={14} />
              {formatTokenCount(selectedUsage.totalTokens)} tokens
            </strong>
            <span>${selectedUsage.costUsd.toFixed(3)} normalized cost</span>
          </div>
        </div>

        <div className="agent-capabilities">
          <p className="fact-label">Capabilities</p>
          <ul>
            {selectedAgent.capabilities.map((capability) => (
              <li key={capability}>
                <Check aria-hidden="true" size={12} />
                {capability}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
