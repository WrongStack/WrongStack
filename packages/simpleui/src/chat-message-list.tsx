import { Check, Copy, ListChecks, LoaderCircle } from 'lucide-react';
import { memo } from 'react';
import { MarkdownHooks as ReactMarkdown } from 'react-markdown';
import rehypePrettyCode from 'rehype-pretty-code';
import remarkGfm from 'remark-gfm';
import { projectAssistantMessage } from './lib/message-projection.js';
import type { ChatMessage } from './types.js';

interface ChatMessageListProps {
  messages: ChatMessage[];
  latestAssistantId: string | undefined;
  copiedMessageId: string | null;
  running: boolean;
  activity: string;
  emptyState: React.ReactNode;
  onCopyMessage: (id: string, text: string) => void;
  onSelectNextStep: (text: string) => void;
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
            : message.role === 'thinking'
              ? 'MODEL REASONING'
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
        {projection.text && !message.streaming && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[
              [rehypePrettyCode, { theme: 'github-dark-dimmed', keepBackground: false }],
            ]}
            components={{
              a: ({ children, ...props }) => (
                <a {...props} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
            fallback={null}
          >
            {projection.text}
          </ReactMarkdown>
        )}
        {projection.text && message.streaming && (
          <span className="streaming-text">{projection.text}</span>
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

// ── Container ──────────────────────────────────────────────────────

/**
 * Renders the unified message+tool-call timeline. Each item is a memo'd
 * sub-component so streaming updates to one message don't force a full
 * re-render of the entire conversation.
 */
export function ChatMessageList({
  messages,
  latestAssistantId,
  copiedMessageId,
  running,
  activity,
  emptyState,
  onCopyMessage,
  onSelectNextStep,
}: ChatMessageListProps) {
  return (
    <div className="conversation">
      {messages.length === 0
        ? emptyState
        : messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              isLatestAssistant={message.id === latestAssistantId}
              copiedMessageId={copiedMessageId}
              onCopyMessage={onCopyMessage}
              onSelectNextStep={onSelectNextStep}
            />
          ))}
      {running && activity && (
        <div className="activity-line" role="status" aria-live="polite">
          <LoaderCircle size={14} className="spin" />
          <span>{activity}</span>
        </div>
      )}
    </div>
  );
}
