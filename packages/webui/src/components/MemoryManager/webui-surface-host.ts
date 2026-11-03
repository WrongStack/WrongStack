import {
  type SageSocket,
  type SurfaceClient,
  type SurfaceHost,
  setDefaultSurfaceHost,
} from '@wrongstack/project-surfaces/host';
import { type OfficeFeed, WEBUI_SELF } from '@wrongstack/project-surfaces/office/feed';
import { useCallback } from 'react';
import { confirmModal } from '@/components/ConfirmModal';
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
  useScrollRestore: (key) => useScrollPosition(key),
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
  Markdown: WebuiSurfaceMarkdown,
};
setDefaultSurfaceHost(webuiSurfaceHost);
