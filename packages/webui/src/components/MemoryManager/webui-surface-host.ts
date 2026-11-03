import {
  type SageSocket,
  type SurfaceClient,
  type SurfaceHost,
  setDefaultSurfaceHost,
} from '@wrongstack/project-surfaces/host';
import { useCallback } from 'react';
import { confirmModal } from '@/components/ConfirmModal';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useWebSocket } from '@/hooks/useWebSocket';
import { sendRosterMessage } from '@/lib/roster-ws';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useUIStore } from '@/stores';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';

function useNavigateBack() {
  const setCurrentView = useUIStore((state) => state.setCurrentView);
  return useCallback(() => setCurrentView('chat'), [setCurrentView]);
}

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
};
setDefaultSurfaceHost(webuiSurfaceHost);
