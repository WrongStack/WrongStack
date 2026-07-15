import { memo } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, ListChecks, LoaderCircle, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypePrettyCode from 'rehype-pretty-code';
import { projectAssistantMessage } from './lib/message-projection.js';
import type { ChatMessage, ToolCallInfo } from './types.js';

type TimelineItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool_calls'; calls: ToolCallInfo[] };

interface ChatMessageListProps {
  timelineItems: TimelineItem[];
  expandedToolCalls: string[];
  latestAssistantId: string | undefined;
  copiedMessageId: string | null;
  running: boolean;
  activity: string;
  emptyState: React.ReactNode;
  onToggleToolCall: (id: string) => void;
  onCopyMessage: (id: string, text: string) => void;
  onSelectNextStep: (text: string) => void;
}

function safeLine(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  } catch {
    return 'Tool input';
  }
}

// ── Memo'd sub-components ──────────────────────────────────────────

interface MessageItemProps {
  message: ChatMessage;
  isLatestAssistant: boolean;
  copiedMessageId: string | null;
  onCopyMessage: (id: string, text: string) => void;
  onSelectNextStep: (text: string) => void;
}

const MessageItem = memo(function MessageItem({
  message,
  isLatestAssistant,
  copiedMessageId,
  onCopyMessage,
  onSelectNextStep,
}: MessageItemProps) {
  const projection =
    message.role === 'assistant'
      ? projectAssistantMessage(message.text)
      : { text: message.text, nextSteps: [] };
  const nextSteps = isLatestAssistant && !message.streaming ? projection.nextSteps : [];

  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">
        <span>
          {message.role === 'user'
            ? 'YOU'
            : message.role === 'assistant'
              ? 'WRONGSTACK'
              : 'SYSTEM'}
        </span>
        {message.role === 'assistant' && projection.text && !message.streaming && (
          <button
            type="button"
            className={`message-copy${copiedMessageId === message.id ? ' copied' : ''}`}
            aria-label={copiedMessageId === message.id ? 'Response copied' : 'Copy response'}
            title={copiedMessageId === message.id ? 'Copied' : 'Copy response'}
            onClick={() => onCopyMessage(message.id, projection.text)}
          >
            {copiedMessageId === message.id ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <Copy size={12} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      <div className="message-body">
        {projection.text && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypePrettyCode, { theme: 'github-dark-dimmed', keepBackground: false }]]}
            components={{
              a: ({ children, ...props }) => (
                <a {...props} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {projection.text}
          </ReactMarkdown>
        )}
        {message.streaming && (
          <span className="stream-caret" role="status" aria-label="Streaming" aria-busy="true" />
        )}
        {nextSteps.length > 0 && (
          <section className="next-steps" aria-label="Suggested next steps">
            <div className="next-steps-heading">
              <ListChecks size={14} aria-hidden="true" />
              <span>NEXT STEPS</span>
            </div>
            <div className="next-steps-list">
              {nextSteps.map((step) => (
                <button
                  type="button"
                  className="next-step"
                  key={`${step.index}:${step.text}`}
                  onClick={() => onSelectNextStep(step.text)}
                >
                  <span className="next-step-index">{step.index}</span>
                  <span className="next-step-text">{step.text}</span>
                  {step.auto && <span className="next-step-auto">AUTO</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </article>
  );
});

interface ToolCallGroupProps {
  calls: ToolCallInfo[];
  expandedToolCalls: string[];
  onToggleToolCall: (id: string) => void;
}

const ToolCallGroup = memo(function ToolCallGroup({
  calls,
  expandedToolCalls,
  onToggleToolCall,
}: ToolCallGroupProps) {
  return (
    <section className="tool-calls" aria-label="Tool calls">
      {calls.map((tc) => {
        const expanded = expandedToolCalls.includes(tc.id);
        return (
          <div key={tc.id} className={`tool-call ${tc.status}`}>
            <button
              type="button"
              className="tool-call-header"
              onClick={() => onToggleToolCall(tc.id)}
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown size={12} aria-hidden="true" />
              ) : (
                <ChevronRight size={12} aria-hidden="true" />
              )}
              <code className="tool-call-name">{tc.name}</code>
              {tc.status === 'running' ? (
                <LoaderCircle size={12} className="spin" />
              ) : tc.status === 'done' ? (
                <Check size={12} className="tool-call-ok" />
              ) : (
                <X size={12} className="tool-call-err" />
              )}
              <span className="tool-call-status">
                {tc.status === 'running'
                  ? 'Running…'
                  : tc.status === 'done'
                    ? `Done${tc.durationMs != null ? ` · ${tc.durationMs}ms` : ''}`
                    : 'Error'}
              </span>
            </button>
            {expanded && (
              <div className="tool-call-detail">
                {tc.input !== undefined && (
                  <div className="tool-call-section">
                    <span className="tool-call-section-label">Input</span>
                    <pre className="tool-call-pre">{safeLine(tc.input)}</pre>
                  </div>
                )}
                {tc.output !== undefined && (
                  <div className="tool-call-section">
                    <span className="tool-call-section-label">
                      Output{tc.durationMs != null ? ` · ${tc.durationMs}ms` : ''}
                      {tc.ok === false ? ' · Failed' : ''}
                    </span>
                    <pre className="tool-call-pre">{tc.output}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
});

// ── Container ──────────────────────────────────────────────────────

/**
 * Renders the unified message+tool-call timeline. Each item is a memo'd
 * sub-component so streaming updates to one message don't force a full
 * re-render of the entire conversation.
 */
export function ChatMessageList({
  timelineItems,
  expandedToolCalls,
  latestAssistantId,
  copiedMessageId,
  running,
  activity,
  emptyState,
  onToggleToolCall,
  onCopyMessage,
  onSelectNextStep,
}: ChatMessageListProps) {
  return (
    <div className="conversation">
      {timelineItems.length === 0
        ? emptyState
        : timelineItems.map((item, index) => {
            if (item.kind === 'message') {
              return (
                <MessageItem
                  key={item.message.id}
                  message={item.message}
                  isLatestAssistant={item.message.id === latestAssistantId}
                  copiedMessageId={copiedMessageId}
                  onCopyMessage={onCopyMessage}
                  onSelectNextStep={onSelectNextStep}
                />
              );
            }
            return (
              <ToolCallGroup
                key={`tc-${index}`}
                calls={item.calls}
                expandedToolCalls={expandedToolCalls}
                onToggleToolCall={onToggleToolCall}
              />
            );
          })}
      {running && activity && (
        <div className="activity-line" role="status" aria-live="polite">
          <LoaderCircle size={14} className="spin" />
          <span>{activity}</span>
        </div>
      )}
    </div>
  );
}
