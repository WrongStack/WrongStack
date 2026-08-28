import { create } from 'zustand';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from './config-store';

interface InspectEvent {
  ts: string;
  type: string;
  label: string;
  detail: string;
}

interface InspectFileEntry {
  operation: string;
  filePath: string;
  toolName: string;
  ts: string;
}

interface SessionInspectData {
  id: string;
  title: string;
  name?: string | undefined;
  model: string;
  provider: string;
  startedAt: string;
  endedAt?: string | undefined;
  tokenTotal: number;
  outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
  messageCount: number;
  iterationCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  fileChangeCount: number;
  compactionCount: number;
  toolBreakdown: Record<string, number>;
  events: InspectEvent[];
  fileEvents: InspectFileEntry[];
  lastUserMessage?: string | undefined;
}

interface SessionInspectState {
  payload: SessionInspectData | null;
  loading: boolean;
  error: string | null;
  setPayload: (payload: SessionInspectData) => void;
  setError: (error: string) => void;
  setLoading: (loading: boolean) => void;
  clear: () => void;
}

export const useSessionInspectStore = create<SessionInspectState>((set) => ({
  payload: null,
  loading: false,
  error: null,
  setPayload: (payload) => set({ payload, loading: false, error: null }),
  setError: (error) => set({ error, loading: false }),
  setLoading: (loading) => set({ loading }),
  clear: () => set({ payload: null, loading: false, error: null }),
}));

let _handlerInstalled = false;

/**
 * Idempotently registers a WS handler for `session.inspect` responses.
 * Safe to call multiple times — only the first call installs the handler.
 * The handler updates the Zustand store with the response payload.
 */
export function ensureInspectHandlerInstalled(): void {
  if (_handlerInstalled) return;

  const wsUrl = useConfigStore.getState().wsUrl;
  if (!wsUrl) {
    // wsUrl not yet available — will be retried on next call from the component.
    return;
  }

  const ws = getWSClient(wsUrl);
  ws.on('session.inspect', (msg) => {
    const payload = msg.payload as SessionInspectData & { error?: string } | undefined;
    const store = useSessionInspectStore.getState();
    if (payload?.error) {
      store.setError(payload.error);
    } else if (payload) {
      store.setPayload(payload);
    }
  });
  _handlerInstalled = true;
}
