import type { MailboxMessage } from '@wrongstack/project-surfaces/office/types';
import type { ChronicleQueryResult } from '@wrongstack/project-surfaces/story/chronicle-types';
import type { StoryFeed, StoryMemoryTrace } from '@wrongstack/project-surfaces/story/story-host';
import { createContext, useContext, useMemo } from 'react';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';

/** What the desktop's story feed reads: one conversation's engine and its live state. */
export interface DesktopStoryValue {
  state: EngineState;
  projectRoot: string;
  send: EngineSend;
  command: EngineCommand;
  onBack: () => void;
}

export const DesktopStoryContext = createContext<DesktopStoryValue | null>(null);

function useDesktopStory(): DesktopStoryValue {
  const value = useContext(DesktopStoryContext);
  if (!value) throw new Error('The desktop story feed rendered outside its conversation.');
  return value;
}

const NO_CONTEXT_REQUEST = { requested: false, clear: () => undefined };

/** The conversation's start, from its `session.start` reply; 0 when it has not arrived. */
export function sessionStartedAt(state: EngineState): number {
  const value = state.results['session.start']?.['startedAt'];
  const at =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
}

/** Whether the engine said it answers Chronicle queries. */
function engineSupportsChronicle(state: EngineState): boolean {
  const capabilities = state.results['session.start']?.['protocolCapabilities'];
  return Array.isArray(capabilities) && capabilities.includes('chronicle.query');
}

/** The messages of a `mailbox.messages` reply. */
export function mailboxMessages(reply: Record<string, unknown> | undefined): MailboxMessage[] {
  const messages = reply?.['messages'];
  return Array.isArray(messages) ? (messages as MailboxMessage[]) : [];
}

/**
 * The Session Story on one desktop conversation. Its hooks read the engine state through
 * `DesktopStoryContext`; queries and actions read the latest value through `value`, so the
 * feed itself never changes and the story is not rebuilt with every frame.
 */
export function desktopStoryFeed(value: () => DesktopStoryValue): StoryFeed {
  return {
    useSessionId: () => useDesktopStory().state.sessionId || null,
    useSession: () => {
      const { state } = useDesktopStory();
      const startedAt = sessionStartedAt(state);
      return useMemo(
        () => (state.sessionId ? { id: state.sessionId, startedAt } : null),
        [state.sessionId, startedAt],
      );
    },
    useProjectRoot: () => useDesktopStory().projectRoot,
    useRunning: () => useDesktopStory().state.running,
    useLatestRequest: () => {
      const { messages } = useDesktopStory().state;
      return useMemo(
        () => [...messages].reverse().find((message) => message.role === 'user')?.text,
        [messages],
      );
    },
    useAgents: () => {
      const { agents } = useDesktopStory().state.fleet;
      return useMemo(() => [...agents.values()], [agents]);
    },
    useMail: () => {
      const reply = useDesktopStory().state.results['mailbox.messages'];
      return useMemo(() => mailboxMessages(reply), [reply]);
    },
    useMemoryTraces: () => {
      const { memoryRuns, sessionId } = useDesktopStory().state;
      return useMemo<StoryMemoryTrace[]>(
        () => memoryRuns.map((run) => ({ ...run, sessionId })),
        [memoryRuns, sessionId],
      );
    },
    // The conversation's context button opens the context dashboard itself, not the story.
    useContextRequest: () => NO_CONTEXT_REQUEST,
    supportsChronicle: () => engineSupportsChronicle(value().state),
    queryChronicle: async (query, signal) => {
      const reply = value().command(
        'chronicle.query',
        { query },
        ['chronicle.query_result', 'chronicle.error'],
        { timeoutMs: 45000 },
      );
      const aborted = new Promise<never>((_, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new Error('The history request was cancelled.')),
          { once: true },
        ),
      );
      const result = await Promise.race([reply, aborted]);
      if (typeof result['message'] === 'string' && !Array.isArray(result['events']))
        throw new Error(result['message']);
      return result as unknown as ChronicleQueryResult;
    },
    refreshMail: () => {
      void value()
        .send('mailbox.messages', { limit: 100 })
        .catch(() => undefined);
    },
    back: () => value().onBack(),
  };
}
