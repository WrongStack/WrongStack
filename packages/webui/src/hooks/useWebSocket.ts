import { useCallback, useEffect } from 'react';
import { installFaviconVisibilityReset } from '@/lib/favicon';
import type { WrongStackWebSocketClient, WSSendOptions } from '@/lib/ws-client';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useHistoryStore, useUIStore } from '@/stores';
import { resolvePendingConfirm } from '@/stores/chat-lanes';
import type { ProviderCustomModelWire } from '@/types';
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
    offs.push(
      ws.on(type, (message) => {
        if (ws.consumeSuppressedChatEcho(type)) return;
        handler(message);
      }),
    );
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
        // Check URL for session query param to support direct multi-session routing
        try {
          const params = new URLSearchParams(window.location.search);
          const urlSessionId = params.get('session');
          if (urlSessionId) {
            ws.resumeSessionById(urlSessionId);
          }
        } catch {
          // ignore
        }
        // Pull the current preference snapshot from the server so the
        // client starts with the server's truth — surviving a page refresh
        // without losing any settings changed in another tab.
        ws.getPrefs();
        // Same reason, for the identity-prompt catalogue: the first-run picker
        // needs to know whether a variant was ever chosen before the user gets
        // a chance to type, so it is pulled on connect rather than on open.
        ws.getSystemPrompt();
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
    (content: string, images?: import('@/types').WSUserMessageImage[], freshContext = false) => {
      if (client.isConnected) {
        return freshContext
          ? client.sendMessage(content, images, true)
          : client.sendMessage(content, images);
      }
      return null;
    },
    [client],
  );

  const sendAbort = useCallback(() => client.sendAbort(), [client]);
  const adviseTopic = useCallback((prompt: string) => client.adviseTopic(prompt), [client]);

  // Mailbox send (btw/steer/note/…). Mirrors the TUI setBtwNote path so a
  // mid-run note can fold into the running agent's next iteration without
  // starting a new run. Forwards straight to the client method.
  const sendMailboxMessage = useCallback(
    (opts: Parameters<typeof client.sendMailboxMessage>[0]) => client.sendMailboxMessage(opts),
    [client],
  );

  const { hideConfirm } = useUIStore();
  const sendConfirm = useCallback(
    (id: string, decision: 'yes' | 'no' | 'always' | 'deny') => {
      client.sendConfirm(id, decision);
      // Retire the parked copy too, or switching back to this tab re-opens a
      // prompt that has already been answered.
      resolvePendingConfirm(id);
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
    (
      id: string,
      family: string,
      baseUrl?: string | undefined,
      apiKey?: string,
      models?: string[] | undefined,
      customModels?: Record<string, ProviderCustomModelWire> | undefined,
    ) => client.addProvider(id, family, baseUrl, apiKey, models, customModels),
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
  const newSession = useCallback(() => client.newSession(), [client]);
  const inspectSession = useCallback((id: string) => client.inspectSession(id), [client]);
  const saveSession = useCallback(() => client.saveSession(), [client]);
  const listTools = useCallback((options?: WSSendOptions) => client.listTools(options), [client]);
  const listMemory = useCallback((options?: WSSendOptions) => client.listMemory(options), [client]);
  const listSageMemories = useCallback(
    (options?: WSSendOptions) => client.listSageMemories(options),
    [client],
  );
  const listSageMemoriesPage = useCallback(
    (
      params?: {
        statuses?: string[];
        kind?: string;
        query?: string;
        limit?: number;
        cursor?: string;
      },
      options?: WSSendOptions,
    ) => client.listSageMemoriesPage(params, options),
    [client],
  );
  const searchSageBreakdown = useCallback(
    (params: { query: string; limit?: number; includeStale?: boolean }, options?: WSSendOptions) =>
      client.searchSageBreakdown(params, options),
    [client],
  );
  const listMemoryCandidates = useCallback(
    (params?: { includeResolved?: boolean }, options?: WSSendOptions) =>
      client.listMemoryCandidates(params, options),
    [client],
  );
  const getSage = useCallback(
    (id: string, options?: WSSendOptions) => client.getSage(id, options),
    [client],
  );
  const getSageGraph = useCallback(
    (query: string, params?: { maxDepth?: number; limit?: number }, options?: WSSendOptions) =>
      client.getSageGraph(query, params, options),
    [client],
  );
  const updateSage = useCallback(
    (id: string, patch: Record<string, unknown>, options?: WSSendOptions) =>
      client.updateSage(id, patch, options),
    [client],
  );
  const deleteSage = useCallback(
    (id: string, reason?: string) => client.deleteSage(id, reason),
    [client],
  );
  const rememberSage = useCallback(
    (opts: Parameters<typeof client.rememberSage>[0], options?: WSSendOptions) =>
      client.rememberSage(opts, options),
    [client],
  );
  const findMemoriesForFile = useCallback(
    (opts: Parameters<typeof client.findMemoriesForFile>[0], options?: WSSendOptions) =>
      client.findMemoriesForFile(opts, options),
    [client],
  );
  const recoverSage = useCallback(
    (opts: Parameters<typeof client.recoverSage>[0], options?: WSSendOptions) =>
      client.recoverSage(opts, options),
    [client],
  );
  const resolveMemoryCandidate = useCallback(
    (opts: Parameters<typeof client.resolveMemoryCandidate>[0], options?: WSSendOptions) =>
      client.resolveMemoryCandidate(opts, options),
    [client],
  );
  const backfillRecoverable = useCallback(
    (opts: Parameters<typeof client.backfillRecoverable>[0], options?: WSSendOptions) =>
      client.backfillRecoverable(opts, options),
    [client],
  );
  const listSkills = useCallback((options?: WSSendOptions) => client.listSkills(options), [client]);
  const getDiag = useCallback((options?: WSSendOptions) => client.getDiag(options), [client]);
  const getStats = useCallback((options?: WSSendOptions) => client.getStats(options), [client]);
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

  // Goal
  const toggleGoalAutonomous = useCallback(
    (autonomous: boolean) => {
      client.send({ type: 'goal.toggleAutonomous', payload: { autonomous } });
    },
    [client],
  );
  const startGoal = useCallback(
    (title: string, phases?: unknown[] | undefined, autonomous = true) => {
      client.send({ type: 'goal.start', payload: { title, phases, autonomous } });
    },
    [client],
  );
  const pauseGoal = useCallback(() => {
    client.send({ type: 'goal.pause', payload: {} });
  }, [client]);
  const resumeGoal = useCallback(() => {
    client.send({ type: 'goal.resume', payload: {} });
  }, [client]);
  const stopGoal = useCallback(() => {
    client.send({ type: 'goal.stop', payload: {} });
  }, [client]);
  const selectGoal = useCallback(
    (phaseId: string) => {
      client.send({ type: 'goal.selectPhase', payload: { phaseId } });
    },
    [client],
  );

  // Git Staging
  const stageGit = useCallback((paths: string | string[]) => client.stageGit(paths), [client]);
  const unstageGit = useCallback((paths: string | string[]) => client.unstageGit(paths), [client]);
  const discardGit = useCallback((paths: string | string[]) => client.discardGit(paths), [client]);
  const commitGit = useCallback((message: string) => client.commitGit(message), [client]);

  return {
    client,
    sendMessage,
    adviseTopic,
    sendAbort,
    sendMailboxMessage,
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
    newSession,
    inspectSession,
    saveSession,
    listTools,
    listMemory,
    listSageMemories,
    listSageMemoriesPage,
    searchSageBreakdown,
    listMemoryCandidates,
    getSage,
    getSageGraph,
    updateSage,
    deleteSage,
    rememberSage,
    findMemoriesForFile,
    recoverSage,
    resolveMemoryCandidate,
    backfillRecoverable,
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
    toggleGoalAutonomous,
    startGoal,
    pauseGoal,
    resumeGoal,
    stopGoal,
    selectGoal,
    switchAutonomy,
    updatePrefs,
    refineModel,
    stageGit,
    unstageGit,
    discardGit,
    commitGit,
  };
}
