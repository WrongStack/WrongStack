import type { FleetFold } from '@wrongstack/project-surfaces/office/fleet-fold';
import { Brain, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  type AgentTranscript,
  type AgentTranscripts,
  agentTabList,
  transcriptSteps,
} from './agent-transcripts';
import { useDesktopText } from './desktop-i18n';
import type { FleetGauge } from './fleet-gauge';
import { MarkdownContent } from './MarkdownContent';
import './agent-transcripts.css';

const led = (status: string) =>
  status === 'running'
    ? 'running'
    : status === 'completed'
      ? 'done'
      : status === 'failed' || status === 'timeout'
        ? 'failed'
        : 'stopped';

/**
 * The WebUI's agent tabs: once a conversation has subagents, a row of tabs over the transcript
 * switches between the conversation and each agent's own read-only transcript. Every subagent the
 * fleet roster knows gets a tab, as in the WebUI, not only those that sent transcript frames.
 * Returns the tab row and, while an agent is chosen, its transcript to show in place of the
 * conversation.
 */
export function useAgentTabs(
  {
    agents: transcripts,
    fleet,
    fleetGauge: gauge,
  }: {
    agents: AgentTranscripts;
    fleet: Pick<FleetFold, 'agents' | 'leaderId' | 'agentTranscripts'>;
    fleetGauge?: FleetGauge | undefined;
  },
  onLink: (href: string) => void,
) {
  const { t } = useDesktopText();
  const [selected, setSelected] = useState<string | null>(null);
  const agents = useMemo(() => agentTabList(transcripts, fleet), [transcripts, fleet]);
  const list = Object.values(agents);
  const current = selected ? agents[selected] : undefined;
  return {
    bar: list.length ? (
      <nav className="agent-tabs" aria-label={t('agentTabs.label')}>
        <button type="button" aria-pressed={!current} onClick={() => setSelected(null)}>
          {t('agentTabs.conversation')}
        </button>
        {list.map((agent) => (
          <button
            type="button"
            key={agent.id}
            aria-pressed={current?.id === agent.id}
            title={agent.task ? `${agent.name}: ${agent.task}` : agent.name}
            onClick={() => setSelected(agent.id)}
          >
            <span className={`agent-led ${led(agent.status)}`} aria-hidden="true" />
            {agent.name}
            <small>{t(`agentTabs.status.${agent.status}`, { defaultValue: agent.status })}</small>
          </button>
        ))}
        {gauge && (
          <span className="agent-gauge">
            {t('agentTabs.gauge', { active: gauge.active, max: gauge.max })}
            {gauge.remainingSpawns !== undefined &&
              ` · ${t('agentTabs.spawnsLeft', { remaining: gauge.remainingSpawns, max: gauge.maxSpawns })}`}
          </span>
        )}
      </nav>
    ) : null,
    view: current ? <AgentTranscriptView agent={current} onLink={onLink} /> : null,
  };
}

function AgentTranscriptView({
  agent,
  onLink,
}: {
  agent: AgentTranscript;
  onLink: (href: string) => void;
}) {
  const { t } = useDesktopText();
  return (
    <section
      className="agent-transcript"
      aria-label={t('agentTabs.transcript', { name: agent.name })}
    >
      <header>
        <strong>{agent.name}</strong>
        <span className={`agent-led ${led(agent.status)}`} aria-hidden="true" />
        <small>{t(`agentTabs.status.${agent.status}`, { defaultValue: agent.status })}</small>
        {agent.task && <p>{agent.task}</p>}
        <p className="agent-transcript-note">{t('agentTabs.readOnly')}</p>
      </header>
      {transcriptSteps(agent.entries).map((step, index) =>
        step.kind === 'tool' ? (
          <details
            key={step.call?.id ?? step.result?.id ?? index}
            className={`agent-step tool${step.result?.toolOk === false ? ' failed' : ''}`}
          >
            <summary>
              <Wrench size={12} />{' '}
              {step.call?.toolName ?? step.result?.toolName ?? t('agentTabs.tool')}
              <small>
                {!step.result
                  ? t('agentTabs.running')
                  : step.result.toolOk === false
                    ? t('agentTabs.failed')
                    : t('agentTabs.completed')}
              </small>
            </summary>
            {step.call?.content && <pre>{step.call.content}</pre>}
            {step.result?.content && <pre>{step.result.content}</pre>}
          </details>
        ) : step.entry.kind === 'text' ? (
          <div key={step.entry.id} className="agent-step text">
            <MarkdownContent text={step.entry.content} onLink={onLink} />
          </div>
        ) : step.entry.kind === 'thinking' ? (
          <details key={step.entry.id} className="agent-step thinking">
            <summary>
              <Brain size={12} /> {t('agentTabs.thinking')}
            </summary>
            <pre>{step.entry.content}</pre>
          </details>
        ) : (
          <p key={step.entry.id} className={`agent-step ${step.entry.kind}`}>
            {step.entry.content}
          </p>
        ),
      )}
    </section>
  );
}
