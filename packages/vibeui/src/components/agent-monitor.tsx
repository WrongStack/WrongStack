'use client';

import { agentRuntimeLabel, isAcpProvider } from '@wrongstack/webui-protocol';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { isActiveAgent as active, hasAgentWork } from '../lib/agent-state';
import type { AgentEntry } from '../lib/session';
import { ContentView } from './content-view';
import { Modal } from './dialogs';
import { MarkdownContent } from './markdown-content';
import { usePresentation } from './presentation-mode';
import { EmptyArtwork, RunSignal } from './vibe-visuals';

export function AgentMonitor({ agents, connected }: { agents: AgentEntry[]; connected: boolean }) {
  const { mode } = usePresentation();
  const [selected, setSelected] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const activeCount = agents.filter((item) => active(item.status)).length;
  const finished = agents.filter((item) => !active(item.status) && hasAgentWork(item));
  const visible = showInactive
    ? agents
    : activeCount
      ? agents.filter((item) => active(item.status))
      : finished.slice(-3);
  const agent = agents.find((item) => item.id === selected);
  const lastOutput =
    (agent && !active(agent.status)
      ? agent.entries.filter((entry) => ['result', 'error'].includes(entry.kind)).at(-1)?.content
      : '') ||
    agent?.partialText ||
    agent?.entries.filter((entry) => ['text', 'result', 'error'].includes(entry.kind)).at(-1)
      ?.content;
  return (
    <section className="agent-monitor" aria-label="Subagents">
      <div className="panel-section-heading">
        <h2>Agents</h2>
        <span>{activeCount} active</span>
      </div>
      {connected && !activeCount && finished.length > 0 && (
        <p className="agent-finished-summary" role="status">
          All agents finished. Showing recent results.
        </p>
      )}
      <label className="inactive-toggle">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(event) => setShowInactive(event.target.checked)}
        />
        Show inactive ({agents.filter((item) => !active(item.status)).length})
      </label>
      {!visible.length && (
        <div className="panel-empty">
          <EmptyArtwork kind="agents" />
          <h3>No active agents</h3>
          <p>Delegated work will appear here when a task needs another pair of hands.</p>
        </div>
      )}
      {visible.map((item) => (
        <button
          type="button"
          className="agent-card"
          key={item.id}
          onClick={() => setSelected(item.id)}
        >
          <span className="agent-identity" aria-hidden="true">
            {item.name.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>{item.name}</strong>
            {isAcpProvider(item.provider) && (
              <span className="acp-runtime-badge">ACP subagent</span>
            )}
            <small>{item.task || item.currentTool || 'Waiting for task details'}</small>
            <small>{agentRuntimeLabel(item.provider, item.model) || 'Model not reported'}</small>
          </span>
          <span
            className={`agent-state ${active(item.status) ? 'agent-state-active' : ['failed', 'error'].includes(item.status) ? 'agent-state-error' : ''}`}
          >
            {active(item.status) && <RunSignal />}
            <small>{item.status}</small>
          </span>
        </button>
      ))}
      <Modal
        open={Boolean(agent)}
        onOpenChange={(open) => {
          if (!open) setSelected('');
        }}
        title={agent?.name || 'Agent'}
        icon={<Users size={20} />}
        description="Task, model and latest activity for this session."
        wide
        detailToggle
      >
        {agent && (
          <div className="agent-detail">
            {!connected && <p role="status">Disconnected - displayed activity may be stale.</p>}
            <div className="agent-summary">
              <span className={`status-dot ${active(agent.status) ? 'busy' : ''}`} />
              <small>{agent.status}</small>
              <strong>
                {agentRuntimeLabel(agent.provider, agent.model) || 'Model not reported'}
              </strong>
              {agent.provider && <small>{agent.provider}</small>}
            </div>
            <div className="agent-task">
              <small>Task</small>
              <p>{agent.task || 'No task description reported.'}</p>
            </div>
            <section
              className="agent-work-stats"
              data-detail={mode}
              aria-label="Agent work summary"
            >
              <div>
                <strong>{agent.iterations.toLocaleString()}</strong>
                <small>Iterations</small>
              </div>
              <div>
                <strong>{agent.toolCalls.toLocaleString()}</strong>
                <small>Tool calls</small>
              </div>
              <div>
                <strong>{agent.tokens.toLocaleString()}</strong>
                <small>Reported tokens</small>
              </div>
            </section>
            {mode === 'extended' && (
              <dl className="agent-technical">
                <dt>Agent ID</dt>
                <dd>{agent.id}</dd>
                <dt>Context capacity</dt>
                <dd>
                  {agent.maxContext > 0
                    ? `${agent.maxContext.toLocaleString()} tokens`
                    : 'Not reported'}
                </dd>
                <dt>Reported cost</dt>
                <dd>${agent.costUsd.toFixed(4)}</dd>
              </dl>
            )}
            <div className="agent-latest">
              <small>Latest output</small>
              {lastOutput ? (
                <>
                  <MarkdownContent
                    text={mode === 'extended' ? lastOutput : lastOutput.slice(-2500)}
                  />
                  {mode === 'simple' && lastOutput.length > 2500 && (
                    <p className="fine-print">
                      Latest excerpt. Extended shows the full reported output.
                    </p>
                  )}
                </>
              ) : (
                <p className="panel-hint">Waiting for activity from this agent.</p>
              )}
            </div>
            <details className="agent-deeper" key={mode} open={mode === 'extended'}>
              <summary>Detailed activity ({agent.entries.length})</summary>
              <p className="fine-print">
                {agent.iterations} iterations / {agent.toolCalls} tool calls. Older activity may be
                unavailable after reconnecting.
              </p>
              <div className="agent-transcript">
                {agent.entries.map((entry) => (
                  <details key={entry.id}>
                    <summary>
                      {entry.kind}
                      {entry.toolName ? ` - ${entry.toolName}` : ''}
                      {entry.ts && <time>{new Date(entry.ts).toLocaleTimeString()}</time>}
                    </summary>
                    <ContentView label={entry.toolName || entry.kind} value={entry.content} />
                  </details>
                ))}
              </div>
            </details>
          </div>
        )}
      </Modal>
    </section>
  );
}
