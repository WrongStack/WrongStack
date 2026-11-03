import type {
  ContextDebugPayload,
  ContextFeed,
} from '@wrongstack/project-surfaces/context/context-host';
import { useShallow } from 'zustand/react/shallow';
import { agentBelongsToSession } from '@/lib/agent-session';
import { getWSClient } from '@/lib/ws-client';
import {
  useActiveSessionId,
  useConfigStore,
  useFleetStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { ContextMemoryMonitor } from '../ContextMemoryMonitor';
import { MemoryLifecycleTrace } from './MemoryLifecycleTrace';

/** How long the dashboard waits for the engine's breakdown. */
const DEBUG_TIMEOUT_MS = 5000;

function ContextMemoryPanels() {
  return (
    <div className="space-y-4">
      <ContextMemoryMonitor />
      <MemoryLifecycleTrace />
    </div>
  );
}

/**
 * Asks the engine for the foreground tab's breakdown. Addressed at that tab: unaddressed, the
 * server answers from whichever session it points at, and a reply meant for another tab would
 * land here.
 */
function requestDebug(signal: AbortSignal): Promise<ContextDebugPayload> {
  return new Promise((resolve, reject) => {
    const ws = getWSClient(useConfigStore.getState().wsUrl);
    if (!ws?.send) {
      reject(new Error('WebSocket not connected'));
      return;
    }
    const askedFor = ws.withSession({}).sessionId;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      unsubscribe();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      finish();
      reject(new Error('The context request was cancelled.'));
    };
    const unsubscribe = ws.on('context.debug', (message: { type: string; payload?: unknown }) => {
      if (message.type !== 'context.debug') return;
      const replyFor = (message.payload as { sessionId?: string } | undefined)?.sessionId;
      if (askedFor !== undefined && replyFor !== undefined && replyFor !== askedFor) return;
      finish();
      resolve(message.payload as ContextDebugPayload);
    });
    timeoutId = setTimeout(() => {
      finish();
      reject(new Error('No response from server'));
    }, DEBUG_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    ws.send({ type: 'context.debug', payload: ws.withSession({}) }, { echoToChat: false });
  });
}

/** The context dashboard on the WebUI's foreground tab, its stores and its socket. */
export const webuiContextFeed: ContextFeed = {
  useSessionId: () => useActiveSessionId(),
  useSession: () =>
    useSessionStore(
      useShallow((s) => ({
        lastInputTokens: s.lastInputTokens,
        maxContext: s.maxContext,
        model: s.session?.model ?? '',
        provider: s.session?.provider ?? '',
        mode: s.mode,
        contextMode: s.contextMode,
        startTime: s.startTime,
        iteration: s.iteration,
        projectName: s.projectName ?? '',
        cwd: s.cwd ?? '',
      })),
    ),
  // This tab's agents only: other tabs' tokens belong to their own dashboards.
  useAgents: () => {
    const sessionId = useActiveSessionId();
    return useFleetStore(
      useShallow((s) =>
        [...s.agents.values()].filter((a) => agentBelongsToSession(a.sessionId, sessionId)),
      ),
    );
  },
  useConnectionKey: () => useConfigStore((s) => s.wsUrl),
  requestDebug,
  Memory: ContextMemoryPanels,
  back: () => useUIStore.getState().setCurrentView('chat'),
};
