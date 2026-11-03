import {
  type SageSocket,
  type SurfaceClient,
  type SurfaceHost,
  setDefaultSurfaceHost,
} from '@wrongstack/project-surfaces/host';
import type { KanbanHost } from '@wrongstack/project-surfaces/kanban/kanban-host';
import { type OfficeFeed, WEBUI_SELF } from '@wrongstack/project-surfaces/office/feed';
import { useCallback, useMemo } from 'react';
import { confirmModal } from '@/components/ConfirmModal';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useWebSocket } from '@/hooks/useWebSocket';
import { sendRosterMessage } from '@/lib/roster-ws';
import { getWSClient } from '@/lib/ws-client';
import {
  useConfigStore,
  useFleetStore,
  useMailboxStore,
  useMonitorStore,
  useSessionStore,
  useUIStore,
  useVizStore,
} from '@/stores';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import { useActiveSessionId } from '@/stores/session-lanes';
import { WebuiSurfaceMarkdown } from './webui-surface-markdown';

function useNavigateBack() {
  const setCurrentView = useUIStore((state) => state.setCurrentView);
  return useCallback(() => setCurrentView('chat'), [setCurrentView]);
}

/** The office surfaces read the WebUI's own fleet, mailbox, monitor and activity stores. */
const webuiOfficeFeed: OfficeFeed = {
  useLiveSessions: () => useMonitorStore((state) => state.liveSessions),
  useCurrentSession: () => useMonitorStore((state) => state.currentSession),
  useFleetAgents: () => useFleetStore((state) => state.agents),
  useAgentTranscripts: () => useFleetStore((state) => state.agentTranscripts),
  useLeaderId: () => useFleetStore((state) => state.leaderId),
  useMailboxMessages: () => useMailboxStore((state) => state.messages),
  useMailboxAgents: () => useMailboxStore((state) => state.agents),
  useVizEvents: () => useVizStore((state) => state.events),
  useToolEvents: () => useVizStore((state) => state.toolEvents),
  useProjectName: () => useSessionStore((state) => state.projectName),
  self: WEBUI_SELF,
};

const wsClient = () => getWSClient(useConfigStore.getState().wsUrl);

/** The Kanban surfaces talk over the WebUI's WebSocket and read its session and fleet stores. */
const webuiKanbanHost: KanbanHost = {
  // The client is typed per message; the board sends the protocol's own kanban.* frames.
  send: (type, payload) =>
    wsClient().send((payload === undefined ? { type } : { type, payload }) as never),
  on: (type, handler) => wsClient().on(type as never, handler as never),
  useSessionId: () => {
    const activeSessionId = useActiveSessionId();
    const sessionRecordId = useSessionStore((state) => state.session?.id ?? null);
    return activeSessionId ?? sessionRecordId;
  },
  useFleetAgents: () => useFleetStore((state) => state.agents),
  useModelCandidates: useProviderModels,
  useDefaultModel: () => {
    const provider = useConfigStore((state) => state.provider);
    const model = useConfigStore((state) => state.model);
    return useMemo(() => ({ provider, model }), [provider, model]);
  },
  openRun: () => useUIStore.getState().setCurrentView('sddhub'),
};

/**
 * The WebUI side of the shared project surfaces: its WebSocket client, stores and confirm
 * modal. Registered as the default host, so the surfaces work wherever the WebUI mounts them.
 */
// The WebUI client is typed per server frame; the surfaces read every reply as one frame shape.
// The runtime objects are the WebUI's own client and actions, unchanged.
export const webuiSurfaceHost: SurfaceHost = {
  useSageSocket: () => useWebSocket() as unknown as SageSocket,
  getClient: () => getWSClient() as unknown as SurfaceClient,
  useConnected: () => useConfigStore((state) => state.wsConnected),
  useNavigateBack,
  useScrollRestore: (key, enabled) => useScrollPosition(key, enabled),
  useValidityReview: (memoryId) =>
    useMemoryInjectorTraceStore((state) => state.contextMemories[memoryId]?.validityReview),
  useCompanionReview: (memoryId) =>
    useMemoryInjectorTraceStore((state) =>
      memoryId ? state.companionReviews[memoryId] : undefined,
    ),
  confirm: (options) => confirmModal(options),
  fetch: (path, init) => globalThis.fetch(path, init),
  requestRoster: (type, payload, signal) => sendRosterMessage(type, payload, signal),
  office: webuiOfficeFeed,
  kanban: webuiKanbanHost,
  Markdown: WebuiSurfaceMarkdown,
};
setDefaultSurfaceHost(webuiSurfaceHost);
