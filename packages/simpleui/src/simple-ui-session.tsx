import { ArrowDown, ArrowUpCircle, Mail, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentChatPane } from './agent-chat-pane.js';
import { BrainPanel } from './brain-panel.js';
import { ChatMessageList } from './chat-message-list.js';
import { CommandPalette } from './command-palette.js';
import { Composer } from './composer.js';
import { ErrorBoundary } from './error-boundary.js';
import { FileChangesButton } from './file-changes-button.js';
import { FileDiffPanel } from './file-diff-panel.js';
import { FileExplorer } from './file-explorer.js';
import { useAgentRoster } from './hooks/use-agent-roster.js';
import { useComposerActions } from './hooks/use-composer-actions.js';
import { useF5Resilience } from './hooks/use-f5-resilience.js';
import { useFileMention } from './hooks/use-file-mention.js';
import { useImageAttachments } from './hooks/use-image-attachments.js';
import { useModelCatalog } from './hooks/use-model-catalog.js';
import { useServerOutage } from './hooks/use-server-outage.js';
import { useSimpleMailbox } from './hooks/use-simple-mailbox.js';
import { useSimpleSessionState } from './hooks/use-simple-session-state.js';
import { useSimpleSocket } from './hooks/use-simple-socket.js';
import { useStatusNotice } from './hooks/use-status-notice.js';
import { useStickyScroll } from './hooks/use-sticky-scroll.js';
import { useTheme } from './hooks/use-theme.js';
import { resetAgentNameCache } from './lib/agent-model.js';
import { retainSimpleChatMessages } from './lib/chat-model.js';
import { playChime } from './lib/chime.js';
import { copyText } from './lib/clipboard.js';
import type { CommandPaletteAction } from './lib/command-palette-model.js';
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from './lib/composer-draft.js';
import { removeFileMention } from './lib/file-mention.js';
import type { MessageHandlerDeps } from './lib/message-handler.js';
import { createMessageHandler } from './lib/message-handler.js';
import { isVisionModel } from './lib/model-capabilities.js';
import { type AutonomyMode, DEFAULT_PREFS, type SimplePrefs } from './lib/prefs-model.js';
import { type QueuedItem, removeQueuedAt } from './lib/queue-model.js';
import { type RefineState, resolveEscapeRestore } from './lib/refine-model.js';
import {
  compactTokens,
  isIncomingMailboxPayload,
  messageId,
  payloadSucceeded,
  payloadText,
} from './lib/session-helpers.js';
import { aggregateFileEdits } from './lib/timeline-model.js';
import { agentTranscriptToToolCalls } from './lib/tool-model.js';
import {
  createWorklistStore,
  type PlanStatus,
  type TaskStatus,
  type TodoStatus,
  type WorklistView,
} from './lib/worklist-store.js';
import type { SimpleSocket } from './lib/ws.js';
import { MailboxSidebar } from './mailbox-sidebar.js';
import { MemoryDrawer } from './memory-drawer.js';
import { PromptLibrary } from './prompt-library.js';
import { ServerOutageOverlay } from './server-outage-overlay.js';
import { SessionAgentStrip } from './session-agent-strip.js';
import { SessionHealthPanel } from './session-health-panel.js';
import { SessionTopbar } from './session-topbar.js';
import { SettingsPanel } from './settings-panel.js';
import { ToolSidebar } from './tool-sidebar.js';
import type {
  AgentMode,
  ChatMessage,
  FileEditMeta,
  PendingConfirm,
  ToolCallInfo,
} from './types.js';

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
  const [prefs, setPrefs] = useState<SimplePrefs>(DEFAULT_PREFS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [refineState, setRefineState] = useState<RefineState | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
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
  const [worklists] = useState(createWorklistStore);
  const socketRef = useRef<SimpleSocket | null>(null);
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
  const prefsRef = useRef<SimplePrefs>(DEFAULT_PREFS);
  const queueRef = useRef<QueuedItem[]>([]);
  const attachedImagesRef = useRef<{ data: string; mime: string; name: string; id: string }[]>([]);
  draftRef.current = draft;
  fileRefsRef.current = fileRefs;
  runningRef.current = running;
  refineStateRef.current = refineState;
  prefsRef.current = prefs;
  queueRef.current = queue;

  // Refs for the global keyboard shortcut handler — read live state
  // without re-registering the keydown listener on every render.
  const messagesRef = useRef<ChatMessage[]>([]);
  const diffFilesRef = useRef<FileEditMeta[] | null>(null);
  const settingsOpenRef = useRef(false);
  messagesRef.current = messages;
  diffFilesRef.current = diffFiles;
  settingsOpenRef.current = settingsOpen;
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
    (content: string, images?: { data: string; mime: string }[]): boolean => {
      const sessionId = sessionIdRef.current;
      const socket = socketRef.current;
      if (!content || !sessionId || !socket) return false;
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
    (content: string, images?: { data: string; mime: string }[]) => {
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

  // ── Global keyboard shortcuts ──────────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ── Escape: close the topmost open panel ──
      if (event.key === 'Escape') {
        if (diffFilesRef.current) {
          event.preventDefault();
          setDiffFiles(null);
          return;
        }
        if (settingsOpenRef.current) {
          event.preventDefault();
          setSettingsOpen(false);
          return;
        }
        if (mailboxOpenRef.current) {
          event.preventDefault();
          setMailboxOpen(false);
          return;
        }
        if (refineStateRef.current) {
          event.preventDefault();
          // Don't drop the user's text or images — the composer was cleared
          // when the send started (submitWith flushes draft+fileRefs+images),
          // so hand the original back for another edit pass.
          // Guard: never clobber text the user typed after the panel opened
          // (resolveEscapeRestore returns null in that case).
          const images = refineStateRef.current.images;
          // Bump the epoch so any in-flight model.refine result that
          // arrives after Escape (e.g., a slow 180s refineRetryFallback
          // window) is recognised as stale and dropped by the handler
          // — the wire protocol carries no request id, so a slow orphan
          // could otherwise match by epoch coincidence and corrupt a
          // later send.
          refineEpochRef.current++;
          refineStartFiredRef.current = false;
          const restore = resolveEscapeRestore(refineStateRef.current, draftRef.current);
          // Null the ref synchronously so a same-tick startSend flush or
          // panel decision cannot observe the dismissed state and dispatch.
          refineStateRef.current = null;
          setRefineState(null);
          if (restore !== null) {
            setDraft(restore);
            draftRef.current = restore;
          }
          // Restore attached images that were part of the original send.
          // Without this, a re-submit silently drops the images because
          // submitWith clears them before startSend.
          if (images && images.length > 0) {
            setAttachedImages(
              images.map((img, i) => ({
                id: `restored-${Date.now()}-${i}`,
                name: `restored-${i}`,
                data: img.data,
                mime: img.mime,
              })),
            );
          }
          requestAnimationFrame(() => textareaRef.current?.focus());
          return;
        }
        return;
      }

      // ── Ctrl/Cmd+K: open command palette ──
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // ── Ctrl/Cmd+Enter: send the composer ──
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        if (!runningRef.current && draftRef.current.trim()) {
          event.preventDefault();
          startSend(draftRef.current);
        }
        return;
      }

      // ── ArrowUp: recall last sent message into empty composer ──
      if (
        event.key === 'ArrowUp' &&
        document.activeElement === textareaRef.current &&
        !draftRef.current.trim() &&
        !runningRef.current
      ) {
        event.preventDefault();
        const lastUser = [...messagesRef.current].reverse().find((m) => m.role === 'user');
        if (lastUser) {
          setDraft(lastUser.text);
          // Move cursor to end on next frame so the textarea has updated.
          requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (ta) {
              ta.selectionStart = ta.value.length;
              ta.selectionEnd = ta.value.length;
            }
          });
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [startSend]);

  // F5 / tab-close resilience: exit confirmation + draft flush.
  useF5Resilience({
    confirmExitRef: prefsRef,
    runningRef,
    sessionIdRef,
    draftRef,
    fileRefsRef,
    writeComposerDraft,
  });

  // Global keyboard shortcuts
  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if (event.key === 'l' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        event.preventDefault();
        if (!runningRef.current && sessionIdRef.current) {
          socketRef.current?.send('session.new', { sessionId: sessionIdRef.current });
        }
        return;
      }
    };
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, []);

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

  const { attachedImages, attachImages, removeImage, setAttachedImages } = useImageAttachments();
  attachedImagesRef.current = attachedImages;

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
      fileEdits: aggregate.files.map((edit) => ({ edit, ts: '' })),
    };
  }, [toolCalls]);

  const selectNextStep = (messageId: string, text: string) => {
    setDraft(text);
    setConsumedNextSteps((prev) => (prev.has(messageId) ? prev : new Set(prev).add(messageId)));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const copyAssistantMessage = async (id: string, text: string) => {
    if (await copyText(text)) {
      setCopiedMessageId(id);
      return;
    }
    setNotice({
      id: messageId('notice'),
      text: 'Could not copy response',
      tone: 'error',
    });
  };

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

  const updatePrefs = (patch: Partial<SimplePrefs>) => {
    const nextPatch = patch.enhanceEnabled ? { enhanceLanguage: 'english', ...patch } : patch;
    setPrefs((current) => ({ ...current, ...patch }));
    socketRef.current?.send('prefs.update', nextPatch as Record<string, unknown>);
  };

  useEffect(() => {
    if (connection === 'open') refreshMailbox();
  }, [connection, refreshMailbox]);

  const switchAutonomy = (mode: AutonomyMode) => {
    setPrefs((current) => ({ ...current, autonomy: mode }));
    // Autonomy has its own route: prefs.update only writes meta, which the
    // running loop never reads.
    socketRef.current?.send('autonomy.switch', { mode });
  };

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

  const requestWorklist = useCallback((view: WorklistView) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    socketRef.current?.send(
      view === 'todos' ? 'todos.get' : view === 'tasks' ? 'tasks.get' : 'plan.get',
      {
        sessionId,
      },
    );
  }, []);

  const openWorkspacePanel = useCallback((view: 'tools' | WorklistView) => {
    window.dispatchEvent(new CustomEvent('simpleui:open-workspace-panel', { detail: { view } }));
  }, []);

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
          window.dispatchEvent(new Event('simpleui:open-memory-drawer'));
          return;
        case 'open-files':
          window.dispatchEvent(new Event('simpleui:open-file-explorer'));
          return;
        case 'open-prompts':
          window.dispatchEvent(new Event('simpleui:open-prompt-library'));
          return;
        case 'open-brain':
          window.dispatchEvent(new Event('simpleui:open-brain-panel'));
          return;
        case 'open-health':
          window.dispatchEvent(new Event('simpleui:open-session-health'));
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

  const updateTodoStatus = useCallback((id: string, status: TodoStatus) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) socketRef.current?.send('todo.update', { sessionId, id, status });
  }, []);

  const updateTaskStatus = useCallback((id: string, status: TaskStatus) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) socketRef.current?.send('task.update', { sessionId, id, status });
  }, []);

  const updatePlanStatus = useCallback((target: string, status: PlanStatus) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) socketRef.current?.send('plan.item.update', { sessionId, target, status });
  }, []);

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
        }}
        contextTokens={context.tokens}
        contextMaxContext={context.maxContext}
        load={load}
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
        onCompactContext={() => {
          if (sessionIdRef.current) {
            socketRef.current?.send('context.compact', {
              sessionId: sessionIdRef.current,
              aggressive: false,
            });
            setActivity('Compacting context');
          }
        }}
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

      {hasUpdate ? (
        <div className="update-banner">
          <ArrowUpCircle size={15} />
          <span>
            Update available: v{updateInfo.appVersion || '?'} → v{updateInfo.latestVersion}
            {' · '}
            <code>wstack update</code>
          </span>
          <button
            type="button"
            className="update-banner-dismiss"
            onClick={() =>
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
            aria-label="Dismiss update warning"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

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

      {mailboxOpen && (
        <>
          <button
            type="button"
            className="sidebar-overlay"
            aria-label="Close email panel"
            onClick={() => setMailboxOpen(false)}
          />
          <aside className="email-panel" aria-label="Email panel">
            <header className="tool-sidebar-header">
              <div>
                <Mail size={14} aria-hidden="true" />
                <span>EMAIL</span>
                <b>PROJECT MAILBOX</b>
              </div>
              <button
                type="button"
                aria-label="Close email panel"
                onClick={() => setMailboxOpen(false)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </header>
            <div className="tool-sidebar-list">
              <MailboxSidebar
                store={mailboxStore}
                onRefresh={refreshMailbox}
                onSend={sendMailboxMessage}
                onAction={handleMailboxAction}
              />
            </div>
          </aside>
        </>
      )}

      <CommandPalette
        open={commandPaletteOpen}
        context={{
          hasSession: Boolean(session),
          running,
          canCompose: leaderSelected,
          canCompact: Boolean(session) && !running,
        }}
        onClose={() => setCommandPaletteOpen(false)}
        onRun={runCommandPaletteAction}
      />

      <MemoryDrawer socketRef={socketRef} />
      <FileExplorer socketRef={socketRef} />
      <PromptLibrary
        onRecall={(text) => {
          setDraft(text);
          textareaRef.current?.focus();
        }}
      />
      <BrainPanel socketRef={socketRef} />
      <SessionHealthPanel context={context} messages={messages} sessionStart={sessionStart} />

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

      <ErrorBoundary>
        <SettingsPanel
          open={settingsOpen}
          prefs={prefs}
          modes={modes}
          activeModeId={activeModeId}
          connection={connection}
          onClose={() => setSettingsOpen(false)}
          onAutonomyChange={switchAutonomy}
          onModeChange={switchMode}
          onPrefChange={updatePrefs}
        />
      </ErrorBoundary>

      {diffFiles && (
        <FileDiffPanel files={diffFiles} socketRef={socketRef} onClose={() => setDiffFiles(null)} />
      )}

      {!outageDismissed && <ServerOutageOverlay outage={outage} onDismiss={dismissOutage} />}
    </div>
  );
}
