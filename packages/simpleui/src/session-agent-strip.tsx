import { Users } from 'lucide-react';
import { FinishedAgentsMenu } from './finished-agents-menu.js';
import type { AgentTab } from './lib/agent-model.js';

export function SessionAgentStrip({
  activeAgentId,
  finishedAgentTabs,
  liveAgentTabs,
  onSelectAgent,
}: {
  activeAgentId: string;
  finishedAgentTabs: AgentTab[];
  liveAgentTabs: AgentTab[];
  onSelectAgent: (id: string) => void;
}) {
  return (
    <section className="agent-strip" aria-label="Agent conversations">
      <div className="agent-strip-label">
        <Users size={14} aria-hidden="true" /> AGENTS
      </div>
      <div className="agent-list" role="tablist" aria-label="Agent conversations">
        {liveAgentTabs.map((agent, index) => {
          const selected = activeAgentId === agent.id;
          return (
            <button
              type="button"
              id={`agent-tab-${agent.id}`}
              className={`agent-item${selected ? ' active' : ''}`}
              role="tab"
              aria-selected={selected}
              aria-controls={`agent-panel-${agent.id}`}
              tabIndex={selected ? 0 : -1}
              key={agent.id}
              title={agent.task ?? `${agent.name} · ${agent.status}`}
              onClick={() => onSelectAgent(agent.id)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const direction = event.key === 'ArrowRight' ? 1 : -1;
                const next =
                  liveAgentTabs[(index + direction + liveAgentTabs.length) % liveAgentTabs.length];
                if (!next) return;
                onSelectAgent(next.id);
                requestAnimationFrame(() =>
                  document.getElementById(`agent-tab-${next.id}`)?.focus(),
                );
              }}
            >
              <span className={`agent-dot ${agent.status}`} aria-hidden="true" />
              <strong>{agent.name}</strong>
              <span>{agent.status}</span>
              {agent.task && <small>{agent.task}</small>}
            </button>
          );
        })}
      </div>
      <FinishedAgentsMenu
        agents={finishedAgentTabs}
        activeAgentId={activeAgentId}
        onSelect={onSelectAgent}
      />
    </section>
  );
}
