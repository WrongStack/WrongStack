import type { StoryFeed } from '@wrongstack/project-surfaces/story/story-host';
import { useMemo } from 'react';
import { safeId } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useActiveSessionId, useSessionStore } from '@/stores';
import { EMPTY_LANE, useChatLanes } from '@/stores/chat-lanes';
import { useFleetStore } from '@/stores/fleet-store';
import { useMailboxStore } from '@/stores/mailbox-store';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import { useUIStore } from '@/stores/ui-store';
import type { ChronicleQueryResult } from '@/types';

const clearContextRequest = () => useUIStore.setState({ storyContextRequested: false });

/** The Session Story on the WebUI's active conversation, its stores and its socket. */
export const webuiStoryFeed: StoryFeed = {
  useSessionId: () => useActiveSessionId(),
  useSession: () => useSessionStore((state) => state.session),
  useProjectRoot: () => useSessionStore((state) => state.projectRoot) ?? '',
  useRunning: () => {
    const sessionId = useActiveSessionId();
    return useChatLanes((state) => state.lanes[sessionId ?? '']?.isLoading ?? false);
  },
  useLatestRequest: () => {
    const sessionId = useActiveSessionId();
    const messages = useChatLanes(
      (state) => state.lanes[sessionId ?? '']?.messages ?? EMPTY_LANE.messages,
    );
    return useMemo(
      () => [...messages].reverse().find((message) => message.role === 'user')?.content,
      [messages],
    );
  },
  useAgents: () => {
    const agents = useFleetStore((state) => state.agents);
    return useMemo(() => [...agents.values()], [agents]);
  },
  useMail: () => useMailboxStore((state) => state.messages),
  useMemoryTraces: () => useMemoryInjectorTraceStore((state) => state.traces),
  useContextRequest: () => {
    const requested = useUIStore((state) => state.storyContextRequested);
    return useMemo(() => ({ requested, clear: clearContextRequest }), [requested]);
  },
  supportsChronicle: () => getWSClient().supportsCapability('chronicle.query'),
  queryChronicle: (query, signal) =>
    new Promise<ChronicleQueryResult>((resolve, reject) => {
      const client = getWSClient();
      // The prefix keeps the Chronicle dashboard from taking the story's replies.
      const requestId = `session-story:${safeId()}`;
      const stop = () => {
        offResult();
        offError();
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        stop();
        reject(new Error('The history request was cancelled.'));
      };
      const offResult = client.on('chronicle.query_result', (message) => {
        if (message.type !== 'chronicle.query_result' || message.payload.requestId !== requestId)
          return;
        stop();
        resolve(message.payload);
      });
      const offError = client.on('chronicle.error', (message) => {
        if (message.type !== 'chronicle.error' || message.payload.requestId !== requestId) return;
        stop();
        reject(new Error(message.payload.message));
      });
      signal.addEventListener('abort', abort, { once: true });
      client.send({ type: 'chronicle.query', payload: { requestId, query } });
    }),
  refreshMail: () => getWSClient().send({ type: 'mailbox.messages', payload: { limit: 100 } }),
  back: () => useUIStore.getState().setCurrentView('chat'),
};
