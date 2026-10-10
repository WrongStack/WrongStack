import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FallbackPendingProjection } from './fallback-modal.js';
import { useAgentView } from './hooks/use-agent-view.js';
import { useComposerState } from './hooks/use-composer-state.js';
import { useGlobalShortcuts } from './hooks/use-global-shortcuts.js';
import { useModelCatalog } from './hooks/use-model-catalog.js';
import { usePanelState } from './hooks/use-panel-state.js';
import { usePalette } from './hooks/use-palette.js';
import { useServerOutage } from './hooks/use-server-outage.js';
import { useSettings } from './hooks/use-settings.js';
import { useSimpleMailbox } from './hooks/use-simple-mailbox.js';
import { useSimpleSessionState } from './hooks/use-simple-session-state.js';
import { useSimpleSocket } from './hooks/use-simple-socket.js';
import { useStatusNotice } from './hooks/use-status-notice.js';
import { useStickyScroll } from './hooks/use-sticky-scroll.js';
import { useTabTitle } from './hooks/use-tab-title.js';
import { useTheme } from './hooks/use-theme.js';
import { useWorklists } from './hooks/use-worklists.js';
import { resetAgentNameCache } from './lib/agent-model.js';
import { playChime } from './lib/chime.js';
import { copyText } from './lib/clipboard.js';
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from './lib/composer-draft.js';
import type { MessageHandlerDeps } from './lib/message-handler.js';
import { createMessageHandler } from './lib/message-handler.js';
import { onPersistedWriteFailure } from './lib/persisted.js';
import { messageId } from './lib/session-helpers.js';
import type { PendingUserInputRequest } from './lib/user-input-queue.js';
import type { SimpleSocket } from './lib/ws.js';
import type { AgentMode, ChatMessage, ResumeProgressInfo, ToolCallInfo } from './types.js';
import { useSessionCommandPalette } from './use-session-command-palette.js';

export function useSimpleUiSession() {
  const { theme, resolvedTheme, toggleTheme } = useTheme();
  const {
    session,
    setSession,
    sessions,
    setSessions,
    context,
    setContext,
    sessionStart,
    setSessionStart,
    sessionIdRef,
    activeModelRef,
  } = useSimpleSessionState();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [modes, setModes] = useState<AgentMode[]>([]);
  const [activeModeId, setActiveModeId] = useState('default');
  const [userInputRequests, setUserInputRequests] = useState<PendingUserInputRequest[]>([]);
  const [fallbackPending, setFallbackPending] = useState<FallbackPendingProjection | null>(null);
  const [running, setRunning] = useState(false);
  const [resumeProgress, setResumeProgress] = useState<ResumeProgressInfo | null>(null);
  const [activity, setActivity] = useState('');
  const { notice, showNotice: setNotice } = useStatusNotice();
  const [updateInfo, setUpdateInfo] = useState<{
    appVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
  }>({ appVersion: '', latestVersion: '', updateAvailable: false });
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const socketRef = useRef<SimpleSocket | null>(null);
  const {
    worklists,
    requestWorklist,
    openWorkspacePanel,
    updateTodoStatus,
    updateTaskStatus,
    updatePlanStatus,
  } = useWorklists({ socketRef, sessionIdRef });
  const {
    prefs,
    setPrefs,
    prefsRef,
    settingsOpen,
    setSettingsOpen,
    settingsOpenRef,
    updatePrefs,
    switchAutonomy,
    resetPrefs,
    isAtDefaults,
  } = useSettings({ socketRef });
  /** Provider ids already asked for their model list — catalog + saved overlap. */
  const requestedModelsRef = useRef<Set<string>>(new Set());
  const runningRef = useRef(false);
  runningRef.current = running;

  // Refs for the global keyboard shortcut handler — read live state
  // without re-registering the keydown listener on every render.
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const {
    mailboxStore,
    mailboxOpen,
    setMailboxOpen,
    mailboxOpenRef,
    mailboxUnreadCount,
    refreshMailbox,
    sendMailboxMessage,
    handleMailboxAction,
    applyMailboxMessage,
  } = useSimpleMailbox({ socketRef, setNotice, prefsRef });

  const panelState = usePanelState({ setSettingsOpen, setMailboxOpen });
  const {
    setCommandPaletteOpen,
    setContextBreakdownOpen,
    setDiffFiles,
    diffFilesRef,
    setCopiedMessageId,
    setConsumedNextSteps,
  } = panelState;

  const composerState = useComposerState({
    session,
    sessionIdRef,
    socketRef,
    running,
    runningRef,
    prefsRef,
    activeModelRef,
    setMessages,
    setRunning,
    setToolCalls,
    setActivity,
    setNotice,
  });
  // Root-internal wiring (handlerDeps, global shortcuts, palette hook,
  // sticky scroll, socket disconnect) reads through these; the facade
  // returns the whole composerState object as the `composer` group.
  const {
    draftRef,
    fileRefsRef,
    queueRef,
    refineStateRef,
    refineEpochRef,
    refineStartFiredRef,
    pendingConfirmRef,
    pendingConfirm,
    setPendingConfirm,
    textareaRef,
    submitWithRef,
    decideConfirmRef,
    dispatchUserMessage,
    setDraft,
    setFileRefs,
    setFileMention,
    setFileMatches,
    setFilePickerIndex,
    setFileSearching,
    setQueue,
    setRefineState,
    setAttachedImages,
  } = composerState;

  // Tab-strip presence: running marker + unread mailbox count (D10).
  useTabTitle({ running, unreadCount: mailboxUnreadCount, enabled: prefs.showTabTitle });

  /** Ask the server for a provider's model list, at most once per provider. */

  const {
    setModels,
    providerLabels,
    setProviderLabels,
    groupedModels,
    selectedModel,
    pendingModelSwitch,
    selectModel,
    confirmModelSwitch,
    cancelModelSwitch,
    requestProviderModels,
  } = useModelCatalog({
    session,
    contextMaxContext: context.maxContext,
    running,
    socketRef,
    requestedModelsRef,
  });

  const agentView = useAgentView({
    running,
    messages,
    toolCalls,
    groupedModels,
    showModelReasoning: prefs.showModelReasoning,
  });
  const { setSubagents, setAgentTranscripts, setSelectedAgentId } = agentView;

  const { palette, setPalette } = usePalette();

  useGlobalShortcuts({
    socketRef,
    sessionIdRef,
    diffFilesRef,
    setDiffFiles,
    settingsOpenRef,
    setSettingsOpen,
    mailboxOpenRef,
    setMailboxOpen,
    refineStateRef,
    setRefineState,
    refineEpochRef,
    refineStartFiredRef,
    draftRef,
    setDraft,
    setAttachedImages,
    textareaRef,
    setCommandPaletteOpen,
    runningRef,
    messagesRef,
    submitWithRef,
    pendingConfirmRef,
    decideConfirmRef,
  });

  const {
    scrollRef,
    showJumpToLatest,
    setShowJumpToLatest,
    jumpToLatest,
    onScroll: onScrollSticky,
    stickToBottomRef,
  } = useStickyScroll({ messages, activity, pendingConfirm });

  const handlerDeps: MessageHandlerDeps = {
    prefsRef,
    draftRef,
    fileRefsRef,
    queueRef,
    sessionIdRef,
    messagesRef,
    activeModelRef,
    runningRef,
    refineStateRef,
    refineEpochRef,
    socketRef,
    requestedModelsRef,
    stickToBottomRef,
    setMessages,
    setRunning,
    setActivity,
    setToolCalls,
    setSubagents,
    setAgentTranscripts,
    setSession,
    setResumeProgress,
    setSessions,
    setContext,
    setModels,
    setModes,
    setActiveModeId,
    setPrefs,
    setDraft,
    setFileRefs,
    setFileMention,
    setNotice,
    setFallbackPending,
    setQueue,
    setRefineState,
    setPendingConfirm,
    setUserInputRequests,
    setSelectedAgentId,
    setSessionStart,
    setShowJumpToLatest,
    setFileMatches,
    setFilePickerIndex,
    setFileSearching,
    setAttachedImages,
    setCopiedMessageId,
    setProviderLabels,
    setDiffFiles,
    resetAgentNameCache: () => resetAgentNameCache(),
    onChime: playChime,
    dispatchUserMessage,
    requestProviderModels,
    writeComposerDraft,
    clearComposerDraft,
    readComposerDraft,
    worklists,
    onUpdateInfo: setUpdateInfo,
  };

  const handleServerMessage = useMemo(
    () => createMessageHandler(handlerDeps),
    [dispatchUserMessage, requestProviderModels, worklists],
  );

  const handleSocketMessage = useCallback(
    (message: Parameters<typeof handleServerMessage>[0]) => {
      if (!applyMailboxMessage(message)) handleServerMessage(message);
    },
    [handleServerMessage, applyMailboxMessage],
  );

  const { connection } = useSimpleSocket({
    onMessage: handleSocketMessage,
    sessionIdRef,
    socketRef,
    onDisconnect: () => {
      setFileMention(null);
      setFileMatches([]);
      setFileSearching(false);
    },
  });
  const {
    outage,
    dismissed: outageDismissed,
    dismiss: dismissOutage,
  } = useServerOutage(connection);

  // Draft/prompts persistence is best-effort, but a quota-exhausted browser
  // must not silently swallow user data — surface it once per failure.
  useEffect(
    () =>
      onPersistedWriteFailure(() => {
        setNotice({
          id: messageId('notice'),
          text: 'Could not save to browser storage — it may be full or blocked',
          tone: 'error',
        });
      }),
    [],
  );

  const load = Math.max(0, Math.min(1, context.load));

  // Stable identities matter: these handlers are passed into every memo'd
  // MessageItem, so a fresh closure per render would re-render the whole
  // transcript on every streaming flush.
  const selectNextStep = useCallback((messageId: string, text: string) => {
    setDraft(text);
    setConsumedNextSteps((prev) => (prev.has(messageId) ? prev : new Set(prev).add(messageId)));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const copyAssistantMessage = useCallback(async (id: string, text: string) => {
    if (await copyText(text)) {
      setCopiedMessageId(id);
      return;
    }
    setNotice({
      id: messageId('notice'),
      text: 'Could not copy response',
      tone: 'error',
    });
  }, []);

  const createSession = () => {
    if (running || !sessionIdRef.current) return;
    socketRef.current?.send('session.new', { sessionId: sessionIdRef.current });
  };

  const resumeSession = (id: string) => {
    if (running || !sessionIdRef.current || id === sessionIdRef.current) return;
    setResumeProgress({ sessionId: id, stage: 'start', loadedBytes: 0, totalBytes: 0 });
    socketRef.current?.send('session.resume', { sessionId: sessionIdRef.current, id });
  };

  useEffect(() => {
    if (connection === 'open') refreshMailbox();
  }, [connection, refreshMailbox]);

  const switchMode = (id: string) => {
    setActiveModeId(id);
    socketRef.current?.send('mode.switch', { id });
  };

  const { runCommandPaletteAction } = useSessionCommandPalette({
    createSession,
    textareaRef,
    messagesRef,
    session,
    setNotice,
    toggleTheme,
    setSettingsOpen,
    openWorkspacePanel,
    setContextBreakdownOpen,
    sessionIdRef,
    runningRef,
    socketRef,
    setActivity,
  });

  // Single source of truth for "a genuine newer version is available" — the
  // version chip (class / title / suffix) and the update banner all gate on
  // this exact condition. Keeping it in one const prevents the four call
  // sites from silently diverging on a future edit (e.g. dropping the
  // equality guard, which would re-introduce a bogus "vX → vX" notice).
  const hasUpdate =
    updateInfo.updateAvailable &&
    Boolean(updateInfo.latestVersion) &&
    updateInfo.latestVersion !== updateInfo.appVersion;

  return {
    // ── Domain groups (hook results passed through as objects) ──
    composer: composerState,
    agentView,
    panelState,
    // ── Root-owned groups (SessionTopbar's models:{} pattern) ──
    models: {
      selectedModel,
      groupedModels,
      providerLabels,
      pendingModelSwitch,
      selectModel,
      confirmModelSwitch,
      cancelModelSwitch,
    },
    connection: { state: connection, outage, outageDismissed, dismissOutage },
    mailbox: {
      open: mailboxOpen,
      setOpen: setMailboxOpen,
      unreadCount: mailboxUnreadCount,
      store: mailboxStore,
      refresh: refreshMailbox,
      send: sendMailboxMessage,
      handleAction: handleMailboxAction,
    },
    preferences: {
      prefs,
      prefsRef,
      settingsOpen,
      setSettingsOpen,
      updatePrefs,
      resetPrefs,
      isAtDefaults,
      switchAutonomy,
      modes,
      activeModeId,
      switchMode,
      palette,
      setPalette,
    },
    workspace: {
      worklists,
      requestWorklist,
      updateTodoStatus,
      updateTaskStatus,
      updatePlanStatus,
    },
    // ── Session-core flat ──
    session,
    sessions,
    running,
    context,
    load,
    theme,
    resolvedTheme,
    toggleTheme,
    updateInfo,
    hasUpdate,
    setUpdateInfo,
    createSession,
    resumeSession,
    sessionIdRef,
    socketRef,
    scrollRef,
    onScrollSticky,
    toolCalls,
    activity,
    resumeProgress,
    copyAssistantMessage,
    selectNextStep,
    messages,
    sessionStart,
    setActivity,
    fallbackPending,
    setFallbackPending,
    runCommandPaletteAction,
    notice,
    userInputRequests,
    showJumpToLatest,
    jumpToLatest,
  };
}
