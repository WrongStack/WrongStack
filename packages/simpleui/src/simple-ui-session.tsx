import { ArrowDown, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentChatPane } from './agent-chat-pane.js';
import { ChatMessageList } from './chat-message-list.js';
import { Composer } from './composer.js';
import { ErrorBoundary } from './error-boundary.js';
import type { FallbackPendingProjection } from './fallback-modal.js';
import { FileChangesButton } from './file-changes-button.js';
import { SessionAgentStrip } from './session-agent-strip.js';
import { SessionTopbar } from './session-topbar.js';
import { useAgentRoster } from './hooks/use-agent-roster.js';
import { useComposerActions } from './hooks/use-composer-actions.js';
import { useF5Resilience } from './hooks/use-f5-resilience.js';
import { useFileMention } from './hooks/use-file-mention.js';
import { useGlobalShortcuts } from './hooks/use-global-shortcuts.js';
import { useImageAttachments } from './hooks/use-image-attachments.js';
import { useModelCatalog } from './hooks/use-model-catalog.js';
import { usePalette } from './hooks/use-palette.js';
import { useServerOutage } from './hooks/use-server-outage.js';
import { useSettings } from './hooks/use-settings.js';
import { useSimpleMailbox } from './hooks/use-simple-mailbox.js';
import { useSimpleSessionState } from './hooks/use-simple-session-state.js';
import { useSimpleSocket } from './hooks/use-simple-socket.js';
import { useStatusNotice } from './hooks/use-status-notice.js';
import { useStickyScroll } from './hooks/use-sticky-scroll.js';
import { useTheme } from './hooks/use-theme.js';
import { useWorklists } from './hooks/use-worklists.js';
import { resetAgentNameCache } from './lib/agent-model.js';
import { retainSimpleChatMessages } from './lib/chat-model.js';
import { playChime } from './lib/chime.js';
import { copyText } from './lib/clipboard.js';
import type { CommandPaletteAction } from './lib/command-palette-model.js';
import {
  clearComposerDraft,
  pruneStaleComposerDrafts,
  readComposerDraft,
  writeComposerDraft,
} from './lib/composer-draft.js';
import { onPersistedWriteFailure } from './lib/persisted.js';
import { removeFileMention } from './lib/file-mention.js';
import { dispatchSimplePanel } from './lib/panel-events.js';
import type { MessageHandlerDeps } from './lib/message-handler.js';
import { createMessageHandler } from './lib/message-handler.js';
import { isVisionModel } from './lib/model-capabilities.js';
import { type QueuedItem, removeQueuedAt } from './lib/queue-model.js';
import type { RefineState } from './lib/refine-model.js';
import {
  compactTokens,
  isIncomingMailboxPayload,
  messageId,
  payloadSucceeded,
  payloadText,
} from './lib/session-helpers.js';
import { aggregateFileEdits } from './lib/timeline-model.js';
import { agentTranscriptToToolCalls } from './lib/tool-model.js';
import type { SimpleSocket } from './lib/ws.js';
import { SessionMailboxDrawer } from './session-mailbox-drawer.js';
import { SessionModals } from './session-modals.js';
import { ToolSidebar } from './tool-sidebar.js';
import type {
  AgentMode,
  ChatMessage,
  FileEditMeta,
  PendingConfirm,
  ToolCallInfo,
} from './types.js';
import { UpdateBanner } from './update-banner.js';

export { compactTokens, isIncomingMailboxPayload, messageId, payloadSucceeded, payloadText };

export function SimpleUiSession() {
  const { theme, toggleTheme } = useTheme();
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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [contextBreakdownOpen, setContextBreakdownOpen] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [refineState, setRefineState] = useState<RefineState | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [fallbackPending, setFallbackPending] = useState<FallbackPendingProjection | null>(null);
  const [draft, setDraft] = useState('');
  const [fileRefs, setFileRefs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState('');
  const { notice, showNotice: setNotice } = useStatusNotice();
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [consumedNextSteps, setConsumedNextSteps] = useState<Set<string>>(new Set());
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
  const [diffFiles, setDiffFiles] = useState<FileEditMeta[] | null>(null);
  /** Provider ids already asked for their model list — catalog + saved overlap. */
  const requestedModelsRef = useRef<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftRef = useRef('');
  const fileRefsRef = useRef<string[]>([]);
  const runningRef = useRef(false);
  // handleServerMessage is a stable []-callback, so the drain and refine
  // paths it triggers read live state through refs rather than closing over
  // a stale render.
  const refineStateRef = useRef<RefineState | null>(null);
  /** Monotonically increasing epoch attached to each `model.refine` request
   *  so the handler can detect and drop stale results that arrive after the
   *  user flushed the panel and started a new round-trip. */
  const refineEpochRef = useRef(0);
  /** Stash the original text when kicking off a refine round-trip so the
   *  socket send can happen post-commit in a useEffect, decoupling the
   *  send from the setRefineState updater and preventing a race where the
   *  status flips to 'refining' without a request in flight. */
  const pendingSendRef = useRef<string | null>(null);
  /** One-shot guard for refineStartNow. The RefinePanel's `countdownFiredRef`
   *  only protects the timer-path effect; a click racing the timer (or
   *  StrictMode double-invoke) can call refineStartNow twice in the same
   *  batch, and `refineStateRef.current` does not update between those two
   *  calls. Without this guard the second call would bump the epoch again
   *  (making the eventual result look stale → spinner stuck forever) and
   *  re-stash `pendingSendRef` after the effect already consumed it
   *  (leaking a duplicate `model.refine` on the next unrelated refineState
   *  change). Reset at the start of every countdown round by startSend. */
  const refineStartFiredRef = useRef(false);
  const queueRef = useRef<QueuedItem[]>([]);
  const attachedImagesRef = useRef<{ data: string; mime: string; name: string; id: string }[]>([]);
  draftRef.current = draft;
  fileRefsRef.current = fileRefs;
  runningRef.current = running;
  refineStateRef.current = refineState;
  queueRef.current = queue;

  // Refs for the global keyboard shortcut handler — read live state
  // without re-registering the keydown listener on every render.
  const messagesRef = useRef<ChatMessage[]>([]);
  const diffFilesRef = useRef<FileEditMeta[] | null>(null);
  messagesRef.current = messages;
  diffFilesRef.current = diffFiles;
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

  /** Send a message to the agent and reflect it locally. The single send
   *  path — the composer, the queue drain, and every refine decision all
   *  funnel through here.
   *
   *  Returns `true` when the message was actually dispatched, `false` when it
   *  was dropped (no session, empty content, or no live socket). Callers that
   *  advance a queue MUST gate on this: a drop must not consume the queued
   *  item, or the user's held message is silently lost. */
  const dispatchUserMessage = useCallback(
    (content: string, images?: { data: string; mime: string; mediaType?: string }[]): boolean => {
      const sessionId = sessionIdRef.current;
      const socket = socketRef.current;
      if ((!content && (!images || images.length === 0)) || !sessionId || !socket) return false;
      setMessages((current) =>
        retainSimpleChatMessages([
          ...current,
          {
            id: messageId('user'),
            role: 'user',
            text: content,
            ...(images && images.length > 0 ? { images } : {}),
          },
        ]),
      );
      setRunning(true);
      setToolCalls([]);
      setActivity('Thinking');
      const payload: Record<string, unknown> = {
        sessionId,
        id: messageId('prompt'),
        content,
        timestamp: Date.now(),
      };
      if (images && images.length > 0) payload['images'] = images;
      socket.send('user_message', payload);
      return true;
    },
    [],
  );

  /** Open the refine round-trip, or send straight through when refine is off. */
  const startSend = useCallback(
    (content: string, images?: { data: string; mime: string; mediaType?: string }[]) => {
      // Flush any pending refine state before starting a new one.  If a
      // previous send is still in countdown/refining, dispatch its original
      // immediately so the user's first message isn't silently dropped.
      // Increment the epoch so any in-flight model.refine result is
      // recognised as stale and dropped by the message handler.
      // Note: auto-dispatch is restricted to countdown/refining — for
      // 'ready'/'failed' the user has already seen the panel and may be
      // reviewing or deciding what to do, so we must not silently
      // re-send the unrefined original.
      const pending = refineStateRef.current;
      if (pending && (pending.status === 'countdown' || pending.status === 'refining')) {
        refineEpochRef.current++;
        // Null the ref synchronously — refineStateRef.current is otherwise
        // only refreshed on commit, so between here and the setRefineState
        // commit a same-tick Escape/decision handler would still see the
        // flushed state and could dispatch the original a second time.
        refineStateRef.current = null;
        setRefineState(null);
        dispatchUserMessage(pending.original, pending.images);
      }
      // Reset the one-shot refineStartNow guard so the new countdown round
      // can fire once on timer-zero / "Refine now" click.
      refineStartFiredRef.current = false;

      if (!prefsRef.current.enhanceEnabled) {
        dispatchUserMessage(content, images);
        return;
      }
      const active = activeModelRef.current;
      const profileRef = prefsRef.current.refinerFallbackProfile
        ? prefsRef.current.fallbackProfiles[prefsRef.current.refinerFallbackProfile]?.[0]
        : undefined;
      const slash = profileRef?.indexOf('/') ?? -1;
      const displayedProvider = profileRef
        ? slash > 0
          ? profileRef.slice(0, slash)
          : active?.provider
        : prefsRef.current.refinerProvider || active?.provider;
      const displayedModel = profileRef
        ? slash > 0
          ? profileRef.slice(slash + 1)
          : profileRef
        : prefsRef.current.refinerModel || active?.model;
      // Reset the one-shot guard so the new countdown round can fire
      // refineStartNow. Without this, a second startSend while a previous
      // refine is still in-flight would leave refineStartFiredRef=true and
      // the new message would never be refined.
      refineStartFiredRef.current = false;
      // Open with a 3-2-1 grace countdown (mirrors the WebUI): the refine
      // request itself is deferred until the countdown elapses or the user
      // clicks "Refine now" — refineStartNow fires it.
      setRefineState({
        original: content,
        refined: content,
        english: content,
        status: 'countdown',
        provider: displayedProvider,
        model: displayedModel,
        images,
      });
    },
    [dispatchUserMessage],
  );

  /** Countdown elapsed (or "Refine now") — kick off the refine round-trip. */
  const refineStartNow = useCallback(() => {
    const cur = refineStateRef.current;
    if (cur?.status !== 'countdown' || !cur.original) return;
    if (refineStartFiredRef.current) return;
    refineStartFiredRef.current = true;
    refineEpochRef.current++;
    pendingSendRef.current = cur.original;
    setRefineState((prev) =>
      prev?.status === 'countdown'
        ? { ...prev, status: 'refining', epoch: refineEpochRef.current }
        : prev,
    );
  }, []);

  /** Send a user-edited version of the refined text straight through. */
  const refineSendEdited = useCallback(
    (text: string) => {
      if (!text) return;
      setRefineState(null);
      dispatchUserMessage(text);
    },
    [dispatchUserMessage],
  );

  /** Post-commit: fire the model.refine send when the status transitions
   *  to 'refining'. The original text is stashed in pendingSendRef by
   *  refineStartNow so the send is driven by the committed state, not by
   *  a side effect inside the setState updater. */
  useEffect(() => {
    const text = pendingSendRef.current;
    if (text) {
      pendingSendRef.current = null;
      socketRef.current?.send('model.refine', { text });
    }
  }, [refineState]);

  // F5 / tab-close resilience: exit confirmation + draft flush.
  useF5Resilience({
    confirmExitRef: prefsRef,
    runningRef,
    sessionIdRef,
    draftRef,
    fileRefsRef,
    writeComposerDraft,
  });

  useEffect(() => {
    if (!copiedMessageId) return;
    const timer = setTimeout(() => setCopiedMessageId(null), 1_800);
    return () => clearTimeout(timer);
  }, [copiedMessageId]);

  /** Ask the server for a provider's model list, at most once per provider. */

  const {
    setSubagents,
    agentTranscripts,
    setAgentTranscripts,
    setSelectedAgentId,
    agentTabs,
    liveAgentTabs,
    finishedAgentTabs,
    activeAgentId,
    activeAgent,
    leaderSelected,
  } = useAgentRoster({ running });

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

  const visionSupported = isVisionModel(session?.model ?? '');

  const {
    fileMention,
    setFileMention,
    fileMatches,
    setFileMatches,
    filePickerIndex,
    setFilePickerIndex,
    fileSearching,
    setFileSearching,
  } = useFileMention({ socketRef });

  const { attachedImages, attachImages, removeImage, setAttachedImages, rejectedImages } =
    useImageAttachments();
  attachedImagesRef.current = attachedImages;

  useEffect(() => {
    if (rejectedImages.length > 0) {
      const first = rejectedImages[0];
      setNotice({
        id: messageId('notice'),
        text: `Image rejected: ${first?.name} (${first?.reason})`,
        tone: 'error',
      });
    }
  }, [rejectedImages, setNotice]);

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
    startSend,
    messagesRef,
  });

  const {
    scrollRef,
    showJumpToLatest,
    setShowJumpToLatest,
    jumpToLatest,
    onScroll: onScrollSticky,
    stickToBottomRef,
  } = useStickyScroll({ messages, activity, pendingConfirm });

  const { submitWith, refineDecision, refineRetry, refineRetryFallback, abort } =
    useComposerActions({
      sessionIdRef,
      socketRef,
      draftRef,
      fileRefsRef,
      refineStateRef,
      refineEpochRef,
      draft,
      fileRefs,
      running,
      startSend,
      dispatchUserMessage,
      setQueue,
      setDraft,
      setFileRefs,
      setAttachedImages,
      attachedImagesRef,
      setRefineState,
    });

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

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(180, Math.max(48, element.scrollHeight))}px`;
  }, [draft]);

  useEffect(() => {
    if (!session?.id) return;
    const timer = setTimeout(() => {
      writeComposerDraft(session.id, { text: draft, fileRefs });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, fileRefs, session?.id]);

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

  // Drafts for abandoned sessions would otherwise accumulate forever.
  useEffect(() => {
    pruneStaleComposerDrafts();
  }, []);

  const load = Math.max(0, Math.min(1, context.load));
  // Filter out thinking blocks when the user has disabled model reasoning display.
  const displayMessages = useMemo(
    () => (prefs.showModelReasoning ? messages : messages.filter((m) => m.role !== 'thinking')),
    [messages, prefs.showModelReasoning],
  );

  const selectedToolCalls = useMemo(
    () =>
      leaderSelected
        ? toolCalls
        : agentTranscriptToToolCalls(agentTranscripts[activeAgentId] ?? []),
    [activeAgentId, agentTranscripts, leaderSelected, toolCalls],
  );

  const { fileEditSummary, fileEdits } = useMemo(() => {
    const aggregate = aggregateFileEdits(toolCalls);
    return {
      fileEditSummary: aggregate,
      fileEdits: aggregate.files.map((edit) => ({ edit, ts: edit.ts ?? '' })),
    };
  }, [toolCalls]);

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

  const selectFile = (path: string) => {
    if (!fileMention) return;
    const cursor = fileMention.start;
    setDraft((current) => removeFileMention(current, fileMention));
    setFileRefs((current) => (current.includes(path) ? current : [...current, path]));
    setFileMention(null);
    setFileMatches([]);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  };

  const createSession = () => {
    if (running || !sessionIdRef.current) return;
    socketRef.current?.send('session.new', { sessionId: sessionIdRef.current });
  };

  const resumeSession = (id: string) => {
    if (running || !sessionIdRef.current || id === sessionIdRef.current) return;
    socketRef.current?.send('session.resume', { sessionId: sessionIdRef.current, id });
  };

  useEffect(() => {
    if (connection === 'open') refreshMailbox();
  }, [connection, refreshMailbox]);

  const switchMode = (id: string) => {
    setActiveModeId(id);
    socketRef.current?.send('mode.switch', { id });
  };

  const decideConfirm = (decision: 'yes' | 'no' | 'always') => {
    if (!pendingConfirm) return;
    socketRef.current?.send('tool.confirm_result', {
      sessionId: sessionIdRef.current ?? undefined,
      id: pendingConfirm.id,
      decision,
    });
    setPendingConfirm(null);
  };

  const runCommandPaletteAction = useCallback(
    (action: CommandPaletteAction) => {
      switch (action) {
        case 'new-session':
          createSession();
          return;
        case 'focus-composer':
          textareaRef.current?.focus();
          return;
        case 'toggle-theme':
          toggleTheme();
          return;
        case 'open-settings':
          setSettingsOpen(true);
          return;
        case 'open-tools':
          openWorkspacePanel('tools');
          return;
        case 'open-todos':
          openWorkspacePanel('todos');
          return;
        case 'open-tasks':
          openWorkspacePanel('tasks');
          return;
        case 'open-plan':
          openWorkspacePanel('plan');
          return;
        case 'open-memory':
          dispatchSimplePanel('open-memory-drawer');
          return;
        case 'open-vector-memory':
          dispatchSimplePanel('open-vector-memory-panel');
          return;
        case 'open-files':
          dispatchSimplePanel('open-file-explorer');
          return;
        case 'open-prompts':
          dispatchSimplePanel('open-prompt-library');
          return;
        case 'open-brain':
          dispatchSimplePanel('open-brain-panel');
          return;
        case 'open-health':
          dispatchSimplePanel('open-session-health');
          return;
        case 'open-context-breakdown':
          setContextBreakdownOpen(true);
          return;
        case 'compact-context':
          if (sessionIdRef.current && !runningRef.current) {
            socketRef.current?.send('context.compact', {
              sessionId: sessionIdRef.current,
              aggressive: false,
            });
            setActivity('Compacting context');
          }
          return;
      }
    },
    [createSession, openWorkspacePanel, toggleTheme],
  );

  // Single source of truth for "a genuine newer version is available" — the
  // version chip (class / title / suffix) and the update banner all gate on
  // this exact condition. Keeping it in one const prevents the four call
  // sites from silently diverging on a future edit (e.g. dropping the
  // equality guard, which would re-introduce a bogus "vX → vX" notice).
  const hasUpdate =
    updateInfo.updateAvailable &&
    Boolean(updateInfo.latestVersion) &&
    updateInfo.latestVersion !== updateInfo.appVersion;

  return (
    <div className="app-shell">
      <ErrorBoundary section="topbar">
        <SessionTopbar
        session={session}
        sessions={sessions}
        running={running}
        models={{
          selectedModel,
          groupedModels,
          providerLabels,
          pendingModelSwitch,
          selectModel,
          confirmModelSwitch,
          cancelModelSwitch,
        }}
        contextTokens={context.tokens}
        contextMaxContext={context.maxContext}
        load={load}
        cache={context.cache}
        connection={connection}
        theme={theme}
        commandPaletteOpen={commandPaletteOpen}
        mailboxOpen={mailboxOpen}
        mailboxUnreadCount={mailboxUnreadCount}
        settingsOpen={settingsOpen}
        appVersion={updateInfo.appVersion}
        latestVersion={updateInfo.latestVersion}
        hasUpdate={hasUpdate}
        onCreateSession={createSession}
        onResumeSession={resumeSession}
        onRefreshSessions={() => {
          if (sessionIdRef.current) {
            socketRef.current?.send('sessions.list', {
              sessionId: sessionIdRef.current,
              limit: 12,
            });
          }
        }}
        onOpenContextBreakdown={() => setContextBreakdownOpen(true)}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onToggleTheme={toggleTheme}
        onToggleMailbox={() => {
          setMailboxOpen((current) => {
            const next = !current;
            if (next) refreshMailbox();
            return next;
          });
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      </ErrorBoundary>

      <UpdateBanner
        appVersion={updateInfo.appVersion}
        latestVersion={updateInfo.latestVersion}
        show={hasUpdate}
        onDismiss={() =>
          // Dismiss the *update banner* only — preserve `appVersion` so
          // the persistent topbar version chip stays visible (functional
          // form avoids a stale-closure race if a newer `session.start`
          // lands between render and click). Clearing `appVersion` here
          // would unmount the chip the moment the user dismisses the
          // upgrade call-to-action, contradicting its "visible at all
          // times" contract and diverging from the WebUI sibling
          // (UpdateBanner.tsx keeps appVersion after dismissal).
          setUpdateInfo((prev) => ({
            ...prev,
            latestVersion: '',
            updateAvailable: false,
          }))
        }
      />

      <SessionAgentStrip
        activeAgentId={activeAgentId}
        finishedAgentTabs={finishedAgentTabs}
        liveAgentTabs={liveAgentTabs}
        onSelectAgent={setSelectedAgentId}
      />

      <ErrorBoundary>
        <main
          id="agent-panel-leader"
          className="chat-scroll"
          role="tabpanel"
          aria-labelledby="agent-tab-leader"
          hidden={!leaderSelected}
          ref={scrollRef}
          onScroll={onScrollSticky}
        >
          <ChatMessageList
            messages={displayMessages}
            toolCalls={leaderSelected ? toolCalls : undefined}
            fileEdits={leaderSelected ? fileEdits : undefined}
            copiedMessageId={copiedMessageId}
            running={running}
            activity={activity}
            theme={theme}
            onOpenDiff={(meta) => setDiffFiles([meta])}
            emptyState={
              <div className="empty-state">
                <Sparkles size={25} strokeWidth={1.5} />
                <span>READY IN</span>
                <h1>{session?.projectName ?? 'your project'}</h1>
                <p>Describe the job. WrongStack will handle the rest.</p>
              </div>
            }
            onCopyMessage={copyAssistantMessage}
            onSelectNextStep={selectNextStep}
            consumedNextSteps={consumedNextSteps}
          />
        </main>
        {agentTabs
          .filter((agent) => !agent.isLeader)
          .map((agent) => (
            <AgentChatPane
              key={agent.id}
              agentId={agent.id}
              agentName={agent.name}
              entries={agentTranscripts[agent.id] ?? []}
              running={agent.status === 'running' || agent.status === 'busy'}
              hidden={activeAgentId !== agent.id}
              theme={theme}
            />
          ))}
      </ErrorBoundary>

      <ErrorBoundary section="workspace">
        <ToolSidebar
          agentId={activeAgentId}
          agentName={activeAgent?.name ?? activeAgentId}
          calls={selectedToolCalls}
          worklists={worklists}
          requestWorklist={requestWorklist}
          onTodoStatusChange={updateTodoStatus}
          onTaskStatusChange={updateTaskStatus}
          onPlanStatusChange={updatePlanStatus}
        />

        <FileChangesButton
          fileCount={fileEditSummary.fileCount}
          totalAdded={fileEditSummary.totalAdded}
          totalRemoved={fileEditSummary.totalRemoved}
          files={fileEditSummary.files}
          onOpenDiff={(files) => setDiffFiles(files)}
        />
      </ErrorBoundary>

      <ErrorBoundary section="mailbox">
        <SessionMailboxDrawer
          open={mailboxOpen}
          onClose={() => setMailboxOpen(false)}
          store={mailboxStore}
          onRefresh={refreshMailbox}
          onSend={sendMailboxMessage}
          onAction={handleMailboxAction}
        />
      </ErrorBoundary>

      <SessionModals
        socketRef={socketRef}
        session={session}
        running={running}
        leaderSelected={leaderSelected}
        commandPaletteOpen={commandPaletteOpen}
        onCloseCommandPalette={() => setCommandPaletteOpen(false)}
        onRunCommandPaletteAction={runCommandPaletteAction}
        onRecallPrompt={(text) => {
          setDraft(text);
          textareaRef.current?.focus();
        }}
        context={context}
        messages={messages}
        sessionStart={sessionStart}
        contextBreakdownOpen={contextBreakdownOpen}
        onCloseContextBreakdown={() => setContextBreakdownOpen(false)}
        onOpenContextBreakdown={() => setContextBreakdownOpen(true)}
        onCompactContext={() => {
          if (sessionIdRef.current) {
            socketRef.current?.send('context.compact', {
              sessionId: sessionIdRef.current,
              aggressive: false,
            });
            setActivity('Compacting context');
          }
          setContextBreakdownOpen(false);
        }}
        fallbackPending={fallbackPending}
        onCloseFallbackModal={() => setFallbackPending(null)}
        settingsOpen={settingsOpen}
        onCloseSettings={() => setSettingsOpen(false)}
        prefs={prefs}
        modes={modes}
        activeModeId={activeModeId}
        palette={palette}
        connection={connection}
        onAutonomyChange={switchAutonomy}
        onModeChange={switchMode}
        onPaletteChange={setPalette}
        onPrefChange={updatePrefs}
        onResetPrefs={resetPrefs}
        isAtDefaults={isAtDefaults}
        diffFiles={diffFiles}
        onCloseDiffFiles={() => setDiffFiles(null)}
        outageDismissed={outageDismissed}
        outage={outage}
        onDismissOutage={dismissOutage}
        sessionId={sessionIdRef.current}
      />

      {leaderSelected && showJumpToLatest && (
        <button type="button" className="jump-to-latest" onClick={jumpToLatest}>
          <ArrowDown size={13} aria-hidden="true" />
          LATEST
        </button>
      )}

      {leaderSelected && (
        <ErrorBoundary>
          <footer className="composer-wrap">
            <Composer
              draft={draft}
              setDraft={setDraft}
              fileRefs={fileRefs}
              setFileRefs={setFileRefs}
              fileMention={fileMention}
              setFileMention={setFileMention}
              fileMatches={fileMatches}
              filePickerIndex={filePickerIndex}
              setFilePickerIndex={setFilePickerIndex}
              fileSearching={fileSearching}
              running={running}
              connection={connection}
              session={session}
              pendingConfirm={pendingConfirm}
              notice={notice}
              textareaRef={textareaRef}
              queue={queue}
              refineState={refineState}
              submitWith={submitWith}
              abort={abort}
              decideConfirm={decideConfirm}
              selectFile={selectFile}
              clearQueue={() => setQueue([])}
              removeQueued={(id) =>
                setQueue((current) =>
                  removeQueuedAt(
                    current,
                    current.findIndex((item) => item.id === id),
                  ),
                )
              }
              onRefineDecision={refineDecision}
              onRefineRetry={refineRetry}
              onRefineRetryFallback={refineRetryFallback}
              onRefineStartNow={refineStartNow}
              onRefineSendEdited={refineSendEdited}
              preRefineSeconds={prefsRef.current.preRefineSeconds}
              attachedImages={attachedImages}
              onAttachImages={attachImages}
              onRemoveImage={removeImage}
              visionSupported={visionSupported}
            />
          </footer>
        </ErrorBoundary>
      )}
    </div>
  );
}
