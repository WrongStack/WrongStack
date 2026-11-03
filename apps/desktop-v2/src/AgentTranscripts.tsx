import { Brain, Wrench } from 'lucide-react';
import { useState } from 'react';
import { type AgentTranscript, type AgentTranscripts, transcriptSteps } from './agent-transcripts';
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
 * switches between the conversation and each agent's own read-only transcript. Returns the tab row
 * and, while an agent is chosen, its transcript to show in place of the conversation.
 */
export function useAgentTabs(agents: AgentTranscripts, onLink: (href: string) => void) {
  const [selected, setSelected] = useState<string | null>(null);
  const list = Object.values(agents);
  const current = selected ? agents[selected] : undefined;
  return {
    bar: list.length ? (
      <nav className="agent-tabs" aria-label="Conversation and its agents">
        <button type="button" aria-pressed={!current} onClick={() => setSelected(null)}>
          Conversation
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
            <small>{agent.status}</small>
          </button>
        ))}
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
  return (
    <section className="agent-transcript" aria-label={`${agent.name} transcript`}>
      <header>
        <strong>{agent.name}</strong>
        <span className={`agent-led ${led(agent.status)}`} aria-hidden="true" />
        <small>{agent.status}</small>
        {agent.task && <p>{agent.task}</p>}
        <p className="agent-transcript-note">
          Read only: what you send goes to the conversation's leader.
        </p>
      </header>
      {transcriptSteps(agent.entries).map((step, index) =>
        step.kind === 'tool' ? (
          <details
            key={step.call?.id ?? step.result?.id ?? index}
            className={`agent-step tool${step.result?.toolOk === false ? ' failed' : ''}`}
          >
            <summary>
              <Wrench size={12} /> {step.call?.toolName ?? step.result?.toolName ?? 'Tool'}
              <small>
                {!step.result ? 'Running…' : step.result.toolOk === false ? 'Failed' : 'Completed'}
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
              <Brain size={12} /> Thinking
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
