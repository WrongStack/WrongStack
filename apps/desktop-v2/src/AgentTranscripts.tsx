import { Brain, ChevronRight, Trash2, Undo2, Users, Wrench, X } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isInactiveAgent, useAgentCleanup } from './agent-cleanup';
import { type AgentFacts, agentFacts, fleetSummary } from './agent-facts';
import { type AgentTranscript, agentTabList, transcriptSteps } from './agent-transcripts';
import { useDesktopText } from './desktop-i18n';
import type { EngineState } from './engine-state';
import { MarkdownContent } from './MarkdownContent';
import { surfaceI18n } from './surface-i18n';
import { TranscriptTimestamp } from './TranscriptTimestamp';
import './agent-transcripts.css';

const led = (status: string) =>
  status === 'running'
    ? 'running'
    : status === 'completed'
      ? 'done'
      : status === 'failed' || status === 'timeout'
        ? 'failed'
        : 'stopped';

type RailState = Pick<
  EngineState,
  | 'sessionId'
  | 'agents'
  | 'fleet'
  | 'fleetGauge'
  | 'running'
  | 'connected'
  | 'hydrating'
  | 'messages'
>;

/** Session-local inspection only: selection never replaces the leader or changes input routing. */
export function SessionAgentRail({
  state,
  onLink,
  embedded = false,
  showThinkingLogs = true,
}: {
  state: RailState;
  onLink: (href: string) => void;
  embedded?: boolean;
  showThinkingLogs?: boolean;
}) {
  const { t } = useDesktopText();
  const { t: words } = useTranslation('sessionAgents', { i18n: surfaceI18n });
  const titleId = useId();
  const transcriptId = useId();
  const leaderButton = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<{ session: string; agent: string } | null>(null);
  const agents = useMemo(
    () => agentTabList(state.agents, state.fleet),
    [state.agents, state.fleet],
  );
  const cleanup = useAgentCleanup(state.sessionId);
  const all = Object.values(agents);
  const list = all.filter((agent) => !cleanup.hidden(agent));
  const inactive = list.filter(isInactiveAgent);
  const clearedCount = all.length - list.length;
  const current =
    selection?.session === state.sessionId
      ? list.find((agent) => agent.id === selection.agent)
      : undefined;
  const gauge = state.fleetGauge;
  const summary = fleetSummary(
    state.fleet.agents.values(),
    state.fleet.leaderId,
    state.fleet.fleetTokensIn,
    state.fleet.fleetTokensOut,
  );
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
    const index = event.target instanceof HTMLButtonElement ? buttons.indexOf(event.target) : -1;
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus();
  };
  return (
    <aside className="session-agent-rail" aria-labelledby={titleId} data-embedded={embedded}>
      <div className="session-agent-toolbar">
        <header className="session-agent-heading">
          <Users size={15} aria-hidden="true" />
          <h2 id={titleId}>{words('title')}</h2>
          <span className="session-agent-count" title={words('title')}>
            {list.length + 1}
          </span>
        </header>
        {!embedded && <p className="session-agent-destination">{words('destination')}</p>}
        <div className="session-agent-cleanup">
          <button
            type="button"
            disabled={!state.sessionId || state.hydrating || !inactive.length}
            title={words('cleanupHint')}
            onClick={() => {
              if (cleanup.clear(inactive) && current && isInactiveAgent(current)) {
                setSelection(null);
                leaderButton.current?.focus();
              }
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
            {words('clearInactive', { count: inactive.length })}
          </button>
          {clearedCount > 0 && (
            <button
              type="button"
              onClick={() => {
                if (cleanup.restore()) leaderButton.current?.focus();
              }}
            >
              <Undo2 size={13} aria-hidden="true" />
              {words('undoCleanup', { count: clearedCount })}
            </button>
          )}
        </div>
      </div>
      {cleanup.problem && (
        <p className="session-agent-cleanup-error" role="alert">
          {words('cleanupError')}
        </p>
      )}
      <nav className="agent-tabs" aria-label={t('agentTabs.label')} onKeyDown={navigate}>
        <button
          ref={leaderButton}
          type="button"
          aria-pressed={!current}
          onClick={() => setSelection(null)}
        >
          <span
            className={`agent-led ${state.running ? 'running' : 'stopped'}`}
            aria-hidden="true"
          />
          <span className="agent-row-copy">
            <span className="agent-row-heading">
              <strong>{words('leader')}</strong>
              <small>
                {state.running
                  ? t('agentTabs.status.running')
                  : words(state.connected ? 'ready' : 'offline')}
              </small>
            </span>
            <span className="agent-row-preview">
              {state.messages
                .findLast((message) => message.role === 'assistant')
                ?.text.slice(0, 240) || t('agentTabs.conversation')}
            </span>
          </span>
        </button>
        {list.map((agent) => (
          <button
            type="button"
            key={agent.id}
            aria-pressed={current?.id === agent.id}
            aria-controls={current?.id === agent.id ? transcriptId : undefined}
            title={agent.task ? `${agent.name}: ${agent.task}` : agent.name}
            onClick={() => setSelection({ session: state.sessionId, agent: agent.id })}
          >
            <span className={`agent-led ${led(agent.status)}`} aria-hidden="true" />
            <span className="agent-row-copy">
              <span className="agent-row-heading">
                <strong>{agent.name}</strong>
                <small>
                  {t(`agentTabs.status.${agent.status}`, { defaultValue: agent.status })}
                </small>
              </span>
              {agent.task && <span className="agent-row-task">{agent.task}</span>}
              <AgentFactsLine facts={agentFacts(state.fleet.agents.get(agent.id))} />
              <span className="agent-row-preview">
                {agent.entries
                  .findLast((entry) => entry.kind === 'text' || entry.kind === 'error')
                  ?.content.slice(0, 240) || words('waiting')}
              </span>
            </span>
            <ChevronRight size={12} aria-hidden="true" />
          </button>
        ))}
      </nav>
      {summary.working + summary.settled > 0 && (
        <p className="agent-summary">
          <span className={summary.working ? 'is-working' : undefined}>
            {t('agentTabs.working', { count: summary.working })}
          </span>
          <span>{t('agentTabs.settled', { count: summary.settled })}</span>
          {summary.tokens && <span>Σ {t('agentTabs.tokens', { value: summary.tokens })}</span>}
        </p>
      )}
      {gauge && (
        <span className="agent-gauge">
          {t('agentTabs.gauge', { active: gauge.active, max: gauge.max })}
          {gauge.remainingSpawns !== undefined &&
            ` · ${t('agentTabs.spawnsLeft', { remaining: gauge.remainingSpawns, max: gauge.maxSpawns })}`}
        </span>
      )}
      {current ? (
        <div className="session-agent-detail" id={transcriptId}>
          <div className="session-agent-detail-heading">
            <strong>{current.name}</strong>
            <button
              type="button"
              className="icon-button"
              aria-label={words('close')}
              onClick={() => {
                setSelection(null);
                leaderButton.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </div>
          <AgentTranscriptView
            key={`${state.sessionId}:${current.id}`}
            agent={current}
            onLink={onLink}
            showThinkingLogs={showThinkingLogs}
          />
        </div>
      ) : (
        <p className="session-agent-empty" role="status">
          {state.hydrating
            ? t('chatView.loading')
            : embedded && list.length
              ? words('destination')
              : list.length
                ? words('choose')
                : words('empty')}
        </p>
      )}
    </aside>
  );
}

function AgentTranscriptView({
  agent,
  onLink,
  showThinkingLogs,
}: {
  agent: AgentTranscript;
  onLink: (href: string) => void;
  showThinkingLogs: boolean;
}) {
  const { t } = useDesktopText();
  const { t: words } = useTranslation('sessionAgents', { i18n: surfaceI18n });
  return (
    <section
      className="agent-transcript"
      aria-label={t('agentTabs.transcript', { name: agent.name })}
    >
      <header>
        <span className={`agent-led ${led(agent.status)}`} aria-hidden="true" />
        <small>{t(`agentTabs.status.${agent.status}`, { defaultValue: agent.status })}</small>
        {agent.task && <p>{agent.task}</p>}
        <p className="agent-transcript-note">{t('agentTabs.readOnly')}</p>
      </header>
      {!agent.entries.length && (
        <p className="agent-step status" role="status">
          {words('waiting')}
        </p>
      )}
      {transcriptSteps(agent.entries).map((step, index) =>
        step.kind === 'tool' ? (
          <details
            key={step.call?.id ?? step.result?.id ?? index}
            className={`agent-step tool${step.result?.toolOk === false ? ' failed' : ''}`}
          >
            <summary>
              <Wrench size={12} />
              {step.call?.toolName ?? step.result?.toolName ?? t('agentTabs.tool')}
              <small>
                {!step.result
                  ? t('agentTabs.running')
                  : step.result.toolOk === false
                    ? t('agentTabs.failed')
                    : t('agentTabs.completed')}
              </small>
              <TranscriptTimestamp value={step.call?.ts || step.result?.ts} />
            </summary>
            {step.call?.content && <pre>{step.call.content}</pre>}
            {step.result?.content && <pre>{step.result.content}</pre>}
          </details>
        ) : step.entry.kind === 'text' ? (
          <div key={step.entry.id} className="agent-step text">
            <TranscriptTimestamp value={step.entry.ts} />
            <MarkdownContent text={step.entry.content} onLink={onLink} />
          </div>
        ) : step.entry.kind === 'thinking' ? (
          showThinkingLogs && (
            <details key={step.entry.id} className="agent-step thinking">
              <summary>
                <Brain size={12} />
                {t('agentTabs.thinking')}
                <TranscriptTimestamp value={step.entry.ts} />
              </summary>
              <pre>{step.entry.content}</pre>
            </details>
          )
        ) : (
          <p key={step.entry.id} className={`agent-step ${step.entry.kind}`}>
            <TranscriptTimestamp value={step.entry.ts} />
            {step.entry.content}
          </p>
        ),
      )}
    </section>
  );
}

/** Model, tokens and tool calls under an agent's name, then how full its context window is. */
function AgentFactsLine({ facts }: { facts: AgentFacts | undefined }) {
  const { t } = useDesktopText();
  if (!facts) return null;
  const parts = [
    facts.model,
    facts.tokens && t('agentTabs.tokens', { value: facts.tokens }),
    facts.tools > 0 && t('agentTabs.tools', { count: facts.tools }),
  ].filter(Boolean);
  if (!parts.length && facts.context === undefined) return null;
  return (
    <span className="agent-row-facts">
      {parts.length > 0 && <span>{parts.join(' · ')}</span>}
      {facts.context !== undefined && (
        <span
          className="agent-row-context"
          role="img"
          aria-label={t('agentTabs.context', { percent: facts.context })}
        >
          <i style={{ inlineSize: `${facts.context}%` }} />
        </span>
      )}
    </span>
  );
}
