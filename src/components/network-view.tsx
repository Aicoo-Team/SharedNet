"use client";

import { useSharedNetDemo } from "@/src/context/sharednet-demo-context";
import {
  aggregateUsage,
  type Agent,
  type Principal,
  type TaskRecruitment,
} from "@/src/domain/network-demo";
import { formatTokenCount } from "./app-shell";

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
      className="principal-region"
      aria-label={`${isOwn ? "Your" : "Connected"} Principal ${principal.handle}`}
    >
      <header className="principal-header">
        <div>
          <p>{isOwn ? "Your Principal" : "Connected Principal"}</p>
          <h2>{principal.handle}</h2>
        </div>
        <span>{formatTokenCount(usageTokens)} · ${usageCost.toFixed(2)}</span>
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
              key={agent.id}
              onClick={() => onSelect(agent.id)}
            >
              <span className={`agent-presence status-${agent.status}`} aria-hidden="true" />
              <span className="agent-identity">
                <span>
                  <strong>{agent.handle}</strong>
                  {agent.official ? <em>official</em> : null}
                </span>
                <small>{agent.role}</small>
              </span>
              <span className="agent-row-meta">
                {recruitmentLabel ? <strong>{recruitmentLabel}</strong> : null}
                <span>{agent.runtime.kind}</span>
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
  const recruitmentState =
    latestRecruitment?.status === "approved"
      ? "recruited"
      : latestRecruitment?.status === "denied"
        ? "declined"
        : "requested";

  return (
    <div className="network-page page-frame">
      <header className="simple-page-heading">
        <h1>Network</h1>
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
          <span aria-hidden="true" />
          <strong>@xisen ↔ @aicoo</strong>
          {latestRecruitment ? (
            <p>
              {latestRecruitment.agentIds.length} {recruitmentState}
            </p>
          ) : (
            <p>connected</p>
          )}
          <span aria-hidden="true" />
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

      <section className="agent-details" aria-label="Agent details">
        <header>
          <div>
            <p>{selectedPrincipal.handle}</p>
            <h2>{selectedAgent.handle}</h2>
          </div>
          <span>{selectedAgent.status}</span>
        </header>
        <p className="agent-summary">{selectedAgent.summary}</p>

        <dl className="agent-facts">
          <div>
            <dt>Runtime</dt>
            <dd>
              <strong>{selectedAgent.runtime.label}</strong>
              <span>{selectedAgent.runtime.environment}</span>
            </dd>
          </div>
          <div>
            <dt>Discoverability</dt>
            <dd>
              <strong>
                {selectedAgent.discoverability === "connections"
                  ? "Connections can discover"
                  : "Private to Principal"}
              </strong>
              <span>{selectedAgent.official ? "Published by Aicoo" : "Your policy"}</span>
            </dd>
          </div>
          <div>
            <dt>Usage</dt>
            <dd>
              <strong>{formatTokenCount(selectedUsage.totalTokens)} tokens</strong>
              <span>${selectedUsage.costUsd.toFixed(3)}</span>
            </dd>
          </div>
        </dl>

        <p className="agent-capabilities">
          <span>Capabilities</span>
          {selectedAgent.capabilities.join(" · ")}
        </p>
      </section>
    </div>
  );
}
