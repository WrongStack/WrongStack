import { useCallback, useEffect } from 'react';
import { installFaviconVisibilityReset } from '@/lib/favicon';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useHistoryStore, useUIStore } from '@/stores';
import { WS_HANDLERS } from './ws-handlers.js';

/**
 * One-shot WebSocket handler installation.
 *
 * Critical: this is called by `useWebSocketBootstrap` from App.tsx EXACTLY
 * ONCE per page. Every other component that needs to talk to the backend uses
 * `useWebSocket()` (below) which only returns action methods — it does NOT
 * register handlers.
 *
 * The earlier design had every component that imported `useWebSocket()`
 * register its own copy of the handlers via `ws.on(type, handler)`. With
 * ChatInput + ConfirmDialog + SettingsPanel all using the hook, every
 * incoming WS message was processed three times — three identical tool
 * bubbles, three appends of the same text_delta, three clearMessages on
 * session.start. That's the "duplicate tool bubble / repeated text" bug
 * the user kept hitting. Singleton install fixes it at the root.
 */
function installHandlers(ws: WrongStackWebSocketClient): () => void {
  const offs: Array<() => void> = [];
  for (const [type, handler] of Object.entries(WS_HANDLERS)) {
    if (!handler) continue;
    offs.push(ws.on(type, handler));
  }
  return () => {
    for (const off of offs) off();
  };
}

/**
 * Mounts the WebSocket connection and installs event handlers.
 * Call this from App.tsx (top of the tree) and nowhere else.
 *
 * The handler install/uninstall runs every time `wsUrl` changes — this is
 * intentional and fixes a silent-stall bug. The previous design guarded the
 * install with a one-shot `useRef` flag, so after a `wsUrl` change the effect
 * re-ran (re-connecting the socket and tearing the old handlers down via
 * cleanup) but never re-registered `WS_HANDLERS` — every server message was
 * then silently dropped until a full page reload. The singleton client is
 * stable and `ws.on()` is cheap, so unconditional (re)install is both safe
 * and correct.
 */
export function useWebSocketBootstrap(): void {
  const { autoConnect, wsUrl } = useConfigStore();
  const setWsStatus = useConfigStore((s) => s.setWsStatus);

  useEffect(() => {
    if (!autoConnect) return;
    installFaviconVisibilityReset();
    const ws = getWSClient(wsUrl);
    let cancelled = false;

    const offStatus = ws.onStatus((s) => {
      if (!cancelled) setWsStatus(s);
    });

    ws.connect()
      .then(() => {
        if (cancelled) return;
        // Pull the current preference snapshot from the server so the
        // client starts with the server's truth — surviving a page refresh
        // without losing any settings changed in another tab.
        ws.getPrefs();
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'webui.ws_connection_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      });

    const off = installHandlers(ws);
    return () => {
      cancelled = true;
      off();
      offStatus();
    };
  }, [autoConnect, wsUrl, setWsStatus]);
}

/**
 * Cheap accessor for the singleton WS client and its imperative action
 * methods. Components call this freely; it does NOT register handlers.
 */
export function useWebSocket() {
  const { wsUrl } = useConfigStore();
  const client = getWSClient(wsUrl);

  const sendMessage = useCallback(
    (content: string, images?: import('@/types').WSUserMessageImage[]) => {
      if (client.isConnected) return client.sendMessage(content, images);
      return null;
    },
    [client],
  );

  const sendAbort = useCallback(() => client.sendAbort(), [client]);

  const { hideConfirm } = useUIStore();
  const sendConfirm = useCallback(
    (id: string, decision: 'yes' | 'no' | 'always' | 'deny') => {
      client.sendConfirm(id, decision);
      hideConfirm();
    },
    [client, hideConfirm],
  );

  const switchModel = useCallback(
    (provider: string, model: string) => client.switchModel(provider, model),
    [client],
  );

  const listProviders = useCallback(() => client.listProviders(), [client]);
  const listProviderModels = useCallback(
    (providerId: string) => client.listProviderModels(providerId),
    [client],
  );
  const listSavedProviders = useCallback(() => client.listSavedProviders(), [client]);
  const addKey = useCallback(
    (providerId: string, label: string, apiKey: string) => client.addKey(providerId, label, apiKey),
    [client],
  );
  const updateKey = useCallback(
    (providerId: string, label: string, apiKey: string) =>
      client.updateKey(providerId, label, apiKey),
    [client],
  );
  const deleteKey = useCallback(
    (providerId: string, label: string) => client.deleteKey(providerId, label),
    [client],
  );
  const setActiveKey = useCallback(
    (providerId: string, label: string) => client.setActiveKey(providerId, label),
    [client],
  );
  const addProvider = useCallback(
    (id: string, family: string, baseUrl?: string | undefined, apiKey?: string) =>
      client.addProvider(id, family, baseUrl, apiKey),
    [client],
  );
  const removeProvider = useCallback(
    (providerId: string) => client.removeProvider(providerId),
    [client],
  );

  const listSessions = useCallback(
    (limit?: number) => {
      useHistoryStore.getState().setLoading(true);
      client.listSessions(limit);
    },
    [client],
  );
  const deleteSession = useCallback((id: string) => client.deleteSession(id), [client]);
  const renameSession = useCallback(
    (id: string, name: string) => {
      useHistoryStore.getState().updateEntryName(id, name);
      client.renameSession(id, name);
    },
    [client],
  );
  const resumeSession = useCallback((id: string) => client.resumeSessionById(id), [client]);
  const saveSession = useCallback(() => client.saveSession(), [client]);
  const listTools = useCallback(() => client.listTools(), [client]);
  const listMemory = useCallback(() => client.listMemory(), [client]);
  const listSkills = useCallback(() => client.listSkills(), [client]);
  const getDiag = useCallback(() => client.getDiag(), [client]);
  const getStats = useCallback(() => client.getStats(), [client]);
  const getPlan = useCallback(() => client.getPlan(), [client]);
  const listModes = useCallback(() => client.listModes(), [client]);
  const switchMode = useCallback((id: string) => client.switchMode(id), [client]);
  const listContextModes = useCallback(() => client.listContextModes(), [client]);
  const switchContextMode = useCallback((id: string) => client.switchContextMode(id), [client]);
  const createContextMode = useCallback(
    (mode: {
      id: string;
      name: string;
      description: string;
      thresholds: { warn: number; soft: number; hard: number };
      preserveK: number;
      eliseThreshold: number;
    }) => client.createContextMode(mode),
    [client],
  );
  const updateContextMode = useCallback(
    (
      id: string,
      patch: {
        name?: string | undefined;
        description?: string | undefined;
        thresholds?:
          | { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined }
          | undefined;
        preserveK?: number | undefined;
        eliseThreshold?: number | undefined;
      },
    ) => client.updateContextMode(id, patch),
    [client],
  );
  const deleteContextMode = useCallback((id: string) => client.deleteContextMode(id), [client]);
  const repairContext = useCallback(() => client.repairContext(), [client]);

  // Model refine
  const refineModel = useCallback(
    (
      text: string,
      opts?: {
        timeoutMs?: number | undefined;
        provider?: string | undefined;
        model?: string | undefined;
      },
    ) => client.refineModel(text, opts),
    [client],
  );

  // Autonomy / Preferences
  const switchAutonomy = useCallback((mode: string) => client.switchAutonomy(mode), [client]);
  const updatePrefs = useCallback(
    (prefs: Record<string, unknown>) => client.updatePrefs(prefs),
    [client],
  );

  // AutoPhase
  const toggleAutoPhaseAutonomous = useCallback(
    (autonomous: boolean) => {
      client.send({ type: 'autophase.toggleAutonomous', payload: { autonomous } });
    },
    [client],
  );
  const startAutoPhase = useCallback(
    (title: string, phases?: unknown[] | undefined, autonomous = true) => {
      client.send({ type: 'autophase.start', payload: { title, phases, autonomous } });
    },
    [client],
  );
  const pauseAutoPhase = useCallback(() => {
    client.send({ type: 'autophase.pause', payload: {} });
  }, [client]);
  const resumeAutoPhase = useCallback(() => {
    client.send({ type: 'autophase.resume', payload: {} });
  }, [client]);
  const stopAutoPhase = useCallback(() => {
    client.send({ type: 'autophase.stop', payload: {} });
  }, [client]);
  const selectAutoPhase = useCallback(
    (phaseId: string) => {
      client.send({ type: 'autophase.selectPhase', payload: { phaseId } });
    },
    [client],
  );

  return {
    client,
    sendMessage,
    sendAbort,
    sendConfirm,
    switchModel,
    listProviders,
    listProviderModels,
    listSavedProviders,
    addKey,
    updateKey,
    deleteKey,
    setActiveKey,
    addProvider,
    removeProvider,
    listSessions,
    deleteSession,
    renameSession,
    resumeSession,
    saveSession,
    listTools,
    listMemory,
    listSkills,
    getDiag,
    getStats,
    getPlan,
    listModes,
    switchMode,
    listContextModes,
    switchContextMode,
    createContextMode,
    updateContextMode,
    deleteContextMode,
    repairContext,
    toggleAutoPhaseAutonomous,
    startAutoPhase,
    pauseAutoPhase,
    resumeAutoPhase,
    stopAutoPhase,
    selectAutoPhase,
    switchAutonomy,
    updatePrefs,
    refineModel,
  };
}
