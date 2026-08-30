import { Check, Copy, ListChecks, LoaderCircle } from 'lucide-react';
import { memo, useMemo } from 'react';
import { MarkdownHooks as ReactMarkdown } from 'react-markdown';
import { FileEditEntry } from './file-edit-entry.js';
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
} from './lib/markdown-config.js';
import { projectAssistantMessage } from './lib/message-projection.js';
import { buildTimeline } from './lib/timeline-model.js';
import { ToolCallEntry } from './tool-call-entry.js';
import type { ChatMessage, FileEditMeta, ResumeProgressInfo, ToolCallInfo } from './types.js';

interface ChatMessageListProps {
  messages: ChatMessage[];
  /** Tool calls to show at their canonical position in the chat timeline. */
  toolCalls?: ToolCallInfo[] | undefined;
  /** File edits to show as inline widgets in the chat timeline. */
  fileEdits?: Array<{ edit: FileEditMeta; ts?: string | undefined }> | undefined;
  copiedMessageId: string | null;
  running: boolean;
  activity: string;
  resumeProgress?: ResumeProgressInfo | null | undefined;
  emptyState: React.ReactNode;
  theme: 'dark' | 'light';
  onCopyMessage: (id: string, text: string) => void;
  onSelectNextStep: (messageId: string, text: string) => void;
  /** Message IDs whose next-steps have been consumed (selected or auto-run). */
  consumedNextSteps: Set<string>;
  /** Open the file diff panel for a single file edit. */
  onOpenDiff?: ((meta: FileEditMeta) => void) | undefined;
}

// ── Memo'd sub-components ──────────────────────────────────────────

interface MessageItemProps {
  message: ChatMessage;
  showNextSteps: boolean;
  copiedMessageId: string | null;
  theme: 'dark' | 'light';
  onCopyMessage: (id: string, text: string) => void;
  onSelectNextStep: (messageId: string, text: string) => void;
  consumedNextSteps: Set<string>;
}

const MessageItem = memo(function MessageItem({
  message,
  showNextSteps,
  copiedMessageId,
  theme,
  onCopyMessage,
  onSelectNextStep,
  consumedNextSteps,
}: MessageItemProps) {
  // projectAssistantMessage runs two global-regex passes + parseNextSteps over
  // the whole message text. Memoize on the text so it re-runs only when the text
  // actually changes, not on every re-render from an unrelated prop (theme,
  // copiedMessageId).
  const projection = useMemo(
    () =>
      message.role === 'assistant'
        ? projectAssistantMessage(message.text)
        : { text: message.text, nextSteps: [] },
    [message.role, message.text],
  );
  // Suggestions come only from the final message of a turn — `message.final`
  // is set from the provider's stop reason (and from the message's blocks on
  // replay), so prose the model wrote on its way to a tool call stays silent.
  // The block is stripped from `projection.text` either way; only the panel
  // is gated.
  const nextSteps =
    showNextSteps &&
    message.final === true &&
    !message.streaming &&
    !consumedNextSteps.has(message.id)
      ? (message.nextSteps ?? projection.nextSteps)
      : [];

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
        {message.images && message.images.length > 0 && (
          <div className="message-images">
            {message.images.map((img, i) => (
              <img key={i} src={img.data} className="message-image" alt={`Attached ${i + 1}`} />
            ))}
          </div>
        )}
        {projection.text && !message.streaming && (
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins(theme)}
            components={markdownComponents}
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
                  onClick={() => onSelectNextStep(message.id, step.text)}
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
 * Renders the chat messages + inline file-edit widgets.
 * Tool calls (delegate, task, kanban, etc.) are NOT shown here —
 * they live in the tool sidebar. Only file operations get inline widgets.
 */
export function ChatMessageList({
  messages,
  toolCalls,
  fileEdits,
  copiedMessageId,
  running,
  activity,
  resumeProgress,
  emptyState,
  theme,
  onCopyMessage,
  onSelectNextStep,
  consumedNextSteps,
  onOpenDiff,
}: ChatMessageListProps) {
  // Suggestions are an action surface, not transcript history. Keep only the
  // latest assistant response actionable, matching WebUI and avoiding a stack
  // of stale panels when the conversation has several completed turns.
  const latestAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === 'assistant') return message.id;
    }
    return null;
  }, [messages]);

  // Interleave replay/live tool calls into the timeline by timestamp, using
  // replayOrder as the tie-breaker when the journal gave text and tool blocks
  // the same timestamp. File edits are kept only as a legacy fallback when no
  // tool-call timeline is supplied by the parent.
  const timeline = useMemo(() => {
    const entries: Array<
      | { kind: 'message'; ts: string; message: ChatMessage }
      | { kind: 'tool_call'; ts: string; toolCall: ToolCallInfo }
      | { kind: 'file_edit'; ts: string; edit: FileEditMeta }
    > = [];

    for (const entry of buildTimeline(messages, toolCalls ?? [])) {
      entries.push(entry);
    }

    if ((!toolCalls || toolCalls.length === 0) && fileEdits) {
      for (const fe of fileEdits) {
        entries.push({ kind: 'file_edit', ts: fe.ts ?? '0', edit: fe.edit });
      }
    }

    entries.sort((a, b) => {
      const hasA = a.ts && a.ts !== '0';
      const hasB = b.ts && b.ts !== '0';
      if (hasA && hasB) {
        if (a.ts < b.ts) return -1;
        if (a.ts > b.ts) return 1;
        return 0;
      }
      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;
      return 0;
    });

    return entries;
  }, [messages, toolCalls, fileEdits]);

  if (resumeProgress) {
    const pct =
      resumeProgress.totalBytes > 0
        ? Math.max(
            0,
            Math.min(
              100,
              Math.round((resumeProgress.loadedBytes / resumeProgress.totalBytes) * 100),
            ),
          )
        : null;
    const stage = resumeProgress.stage.replaceAll('_', ' ');
    return (
      <div className="conversation">
        <div className="resume-state" role="status" aria-live="polite">
          <LoaderCircle size={22} className="spin" aria-hidden="true" />
          <span>RESUMING SESSION</span>
          <h1>{pct === null ? 'Reading history' : `${pct}%`}</h1>
          <p>{stage}</p>
          <div className="resume-progress-track" aria-hidden="true">
            <span style={{ width: `${pct ?? 12}%` }} />
          </div>
        </div>
      </div>
    );
  }

  if (timeline.length === 0) {
    return <div className="conversation">{emptyState}</div>;
  }

  return (
    <div className="conversation">
      {timeline.map((entry) => {
        if (entry.kind === 'message') {
          return (
            <MessageItem
              key={entry.message.id}
              message={entry.message}
              showNextSteps={entry.message.id === latestAssistantId}
              copiedMessageId={copiedMessageId}
              theme={theme}
              onCopyMessage={onCopyMessage}
              onSelectNextStep={onSelectNextStep}
              consumedNextSteps={consumedNextSteps}
            />
          );
        }
        if (entry.kind === 'tool_call') {
          return <ToolCallEntry key={`tc-${entry.toolCall.id}`} toolCall={entry.toolCall} />;
        }
        // file_edit
        return (
          <FileEditEntry
            key={`fe-${entry.edit.path}-${entry.ts}`}
            edit={entry.edit}
            ts={entry.ts}
            onOpenDiff={onOpenDiff ?? (() => undefined)}
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
