import { Bot, Brain, CircleDot, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import { memo } from 'react';
import { MarkdownHooks as ReactMarkdown } from 'react-markdown';
import rehypePrettyCode from 'rehype-pretty-code';
import remarkGfm from 'remark-gfm';
import type { AgentTranscriptEntry } from './types.js';

interface AgentChatPaneProps {
  agentId: string;
  agentName: string;
  entries: AgentTranscriptEntry[];
  running: boolean;
  hidden: boolean;
}

const CONVERSATION_KINDS = new Set<AgentTranscriptEntry['kind']>([
  'text',
  'thinking',
  'error',
  'status',
  'system',
]);

const KIND_META = {
  text: { label: 'ASSISTANT', icon: Bot, className: 'text' },
  thinking: { label: 'MODEL REASONING', icon: Brain, className: 'thinking' },
  error: { label: 'ERROR', icon: TriangleAlert, className: 'error' },
  status: { label: 'STATUS', icon: Info, className: 'status' },
  system: { label: 'SYSTEM', icon: CircleDot, className: 'system' },
} as const;

export function agentConversationEntries(entries: AgentTranscriptEntry[]): AgentTranscriptEntry[] {
  return entries.filter((entry) => CONVERSATION_KINDS.has(entry.kind));
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A mounted pane preserves its DOM and scroll position while another tab is selected. */
export const AgentChatPane = memo(function AgentChatPane({
  agentId,
  agentName,
  entries,
  running,
  hidden,
}: AgentChatPaneProps) {
  const conversationEntries = agentConversationEntries(entries);
  return (
    <section
      id={`agent-panel-${agentId}`}
      className="agent-chat-pane"
      role="tabpanel"
      aria-labelledby={`agent-tab-${agentId}`}
      hidden={hidden}
    >
      <div className="agent-conversation">
        {conversationEntries.length === 0 ? (
          <div className="agent-empty-state">
            <Bot size={24} strokeWidth={1.5} aria-hidden="true" />
            <span>{running ? 'AGENT RUNNING' : 'NO AGENT OUTPUT'}</span>
            <h1>{agentName}</h1>
            <p>{running ? 'Live output will appear here.' : 'This agent has no transcript yet.'}</p>
          </div>
        ) : (
          conversationEntries.map((entry) => {
            const meta = KIND_META[entry.kind as keyof typeof KIND_META];
            const Icon = meta.icon;
            return (
              <article className={`agent-transcript-entry ${meta.className}`} key={entry.id}>
                <div className="agent-entry-label">
                  <Icon size={13} aria-hidden="true" />
                  <span>{meta.label}</span>
                  <time dateTime={entry.ts}>{formatTime(entry.ts)}</time>
                </div>
                <div className="agent-entry-body">
                  {entry.kind === 'text' ? (
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
                      {entry.content}
                    </ReactMarkdown>
                  ) : (
                    <pre>{entry.content}</pre>
                  )}
                </div>
              </article>
            );
          })
        )}
        {running && (
          <div className="agent-activity-line" role="status" aria-live="polite">
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
            <span>{agentName} is working</span>
          </div>
        )}
      </div>
    </section>
  );
});
