import { toErrorMessage } from '@wrongstack/core/utils/error';
import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { BookOpen } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  useActiveSessionId,
  useChatStore,
  useConfigStore,
  useFileReferenceStore,
  useFileStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { useAutoSubmitStreak } from '@/stores/auto-submit-streak.js';
import { onLaneDisposed } from '@/stores/chat-lanes';
import type { QueueMode } from '@/stores/chat-store';
import { refsToMarkdown } from '@/stores/file-reference-store.js';
import { useLocalPrefs } from '@/stores/local-prefs';
import { ComposerButtonBar } from './ChatInput/composer-button-bar.js';
import { DraftTokenCounter } from './ChatInput/draft-token-counter.js';
import { FileMentionPicker, type FileMentionState } from './ChatInput/file-mention-picker.js';
import { type ImageAttachment, toWireImages } from './ChatInput/image-attachments.js';
import { handleNextList, handleNextSelect } from './ChatInput/next-steps-helpers.js';
import { QueuedMessages } from './ChatInput/queued-messages.js';
import { ChatInputRefinePanelHost } from './ChatInput/refine-panel-host.js';
import { detectAtMention, matchSlash } from './ChatInput/slash-commands.js';
import { SlashCommandPopup } from './ChatInput/slash-popup.js';
import { runChatSlashCommand } from './ChatInput/slash-routing.js';
import { useChatInputMcp } from './ChatInput/use-chat-input-mcp.js';
import { usePasteDrop } from './ChatInput/use-paste-drop.js';
import { useRefineTimeout } from './ChatInput/use-refine-timeout.js';
import { useSpeechRecognition } from './ChatInput/use-speech-recognition.js';
import { confirmModalChoice, useConfirmModalStore } from './ConfirmModal.js';
import { FileReferenceChip } from './FileReferenceChip.js';
import { PromptLibraryModal } from './PromptLibraryModal.js';
import { toast } from './Toaster';

export function resolveCancelInput(prev: string, original: string): string {
  return prev.trim() ? prev : original;
}

/**
 * One unsent draft per tab: text, image attachments and file chips.
 *
 * There is a single ChatInput for all four tabs (the chat surface is parked,
 * never unmounted), so without this the tab you switch to inherits the text
 * you were typing in the tab you left.
 *
 * Keyed by session id and freed with the lane, so a closed tab's draft cannot
 * come back on a session that is later handed the same id — and the map does
 * not grow for the life of the page.
 */
const sessionDraftMap = new Map<
  string,
  {
    input: string;
    images: ImageAttachment[];
    refs: ReturnType<typeof useFileReferenceStore.getState>['refs'];
  }
>();

onLaneDisposed((sessionId) => {
  sessionDraftMap.delete(sessionId);
});

export function ChatInput({
  onOpenBreakdown,
}: {
  onOpenBreakdown?: (() => void) | undefined;
} = {}) {
  const { isLoading, setLoading, addMessage, clearMessages } = useChatStore(
    useShallow((s) => ({
      isLoading: s.isLoading,
      setLoading: s.setLoading,
      addMessage: s.addMessage,
      clearMessages: s.clearMessages,
    })),
  );
  const messages = useChatStore((s) => s.messages);
  const openFiles = useFileStore((s) => s.openFiles);
  const chatStarted = messages.length > 0;
  const queue = useChatStore((s) => s.queue);
  const enqueue = useChatStore((s) => s.enqueue);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const clearQueue = useChatStore((s) => s.clearQueue);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setPromptLibraryOpen = useUIStore((s) => s.setPromptLibraryOpen);
  const pushPrompt = useUIStore((s) => s.pushPrompt);
  const promptHistory = useUIStore((s) => s.promptHistory);
  const ws = useWebSocket();
  const {
    sendMessage,
    sendAbort,
    sendMailboxMessage,
    client,
    refineModel,
    updatePrefs,
    adviseTopic,
  } = ws;
  const { t } = useAppTranslation();
  const enhanceEnabled = useLocalPrefs((s) => s.enhanceEnabled);
  const refinerProvider = useLocalPrefs((s) => s.refinerProvider);
  const refinerModel = useLocalPrefs((s) => s.refinerModel);
  const refinerFallbackProfile = useLocalPrefs((s) => s.refinerFallbackProfile);
  const fallbackProfiles = useLocalPrefs((s) => s.fallbackProfiles);
  const refinePanel = useUIStore((s) => s.refinePanel);
  const configProvider = useConfigStore((s) => s.provider);
  const configModel = useConfigStore((s) => s.model);
  const promptInsertRequest = useUIStore((s) => s.promptInsertRequest);
  const clearPromptInsert = useUIStore((s) => s.clearPromptInsert);
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);
  const setProcessMonitorOpen = useUIStore((s) => s.setProcessMonitorOpen);
  const setQueuePanelOpen = useUIStore((s) => s.setQueuePanelOpen);
  const { reset: resetAutoSubmitStreak } = useAutoSubmitStreak();

  const [input, setInput] = useState(() => useUIStore.getState().draftInput ?? '');

  const {
    isListening,
    isSupported: isSpeechSupported,
    toggleListening: handleToggleSpeech,
    stopListening: stopSpeech,
  } = useSpeechRecognition({
    onTranscript: (text) => {
      setInput((prev) => {
        const next = prev ? `${prev} ${text}` : text;
        useUIStore.getState().setDraftInput(next);
        return next;
      });
    },
  });

  useRefineTimeout({
    clientConnected: client?.isConnected,
    t,
    sendMessage,
    setInput,
  });

  useChatInputMcp({ client, sendMessage });

  const lastInputTokens = useSessionStore((s) => s.lastInputTokens);
  const maxContext = useSessionStore((s) => s.maxContext);
  const [slashIndex, setSlashIndex] = useState(0);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const stickyDraftRef = useRef<string | null>(null);
  const [atMention, setAtMention] = useState<FileMentionState | null>(null);
  const [refinePickOpen, setRefinePickOpen] = useState(false);
  const [topicCheckBusy, setTopicCheckBusy] = useState(false);
  const topicCheckBusyRef = useRef(false);
  const topicCheckAbortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRefs = useFileReferenceStore((s) => s.refs);
  const { removeRef, clearRefs } = useFileReferenceStore.getState();
  const hasFileRefs = fileRefs.length > 0;
  const {
    draggingOver,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
    onTextPaste,
    pasteHint,
    pendingImagesRef,
    pendingImages,
    addImageFiles,
    removeImage,
    clearPendingImages,
    setPendingImages,
    setPasteHint,
  } = usePasteDrop({
    input,
    textareaRef,
    setInput,
    errorText: {
      tooManyImages: (max) => t('chat:input.tooManyImages', { max }),
      imageProcessFailed: (name) => t('chat:input.imageProcessFailed', { name }),
      imageTooLarge: (name) => t('chat:input.imageTooLarge', { name }),
    },
  });
  const imagePickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    useUIStore.getState().setDraftInput(input);
  }, [input]);

  // The lane POINTER, not the lane's SessionInfo record. That record is null
  // from the moment a tab is opened until its `session.start` answer lands, so
  // keying drafts on it meant a draft typed in a brand-new tab was filed under
  // `null` — shared with every other not-yet-started tab, and dropped on the
  // way out.
  const sessionId = useActiveSessionId();
  const prevSessionIdRef = useRef<string | null>(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    const oldId = prevSessionIdRef.current;
    if (oldId) {
      sessionDraftMap.set(oldId, {
        input,
        images: [...pendingImages],
        refs: [...fileRefs],
      });
    }
    prevSessionIdRef.current = sessionId;

    // A refinement in flight belongs to the tab it was typed in. The panel is
    // one global surface over one shared composer, and both of its exits —
    // the user approving it and the 105s timeout firing on its own — dispatch
    // through the FOREGROUND. Left standing across a tab switch it therefore
    // delivers one tab's prompt into another tab's session, the timeout doing
    // so with nobody touching anything. Take it down and hand the text back
    // to the tab that typed it, which still has it when the user returns.
    const panel = useUIStore.getState().refinePanel;
    const panelOwner = panel?.sessionId ?? oldId;
    if (panel && panelOwner !== sessionId) {
      useUIStore.getState().setRefinePanel(null);
      if (panelOwner) {
        const saved = sessionDraftMap.get(panelOwner) ?? { input: '', images: [], refs: [] };
        sessionDraftMap.set(panelOwner, { ...saved, input: panel.original });
      }
    }

    if (sessionId && sessionDraftMap.has(sessionId)) {
      const saved = sessionDraftMap.get(sessionId)!;
      const projectedDraft = useUIStore.getState().draftInput;
      setInput(saved.input.trim() ? saved.input : projectedDraft);
      setPendingImages(saved.images);
      clearRefs();
      for (const r of saved.refs) {
        useFileReferenceStore.getState().addRef(r);
      }
    } else {
      setInput(sessionId ? useUIStore.getState().draftInput : '');
      clearPendingImages();
      clearRefs();
    }
    setHistoryIdx(-1);
    stickyDraftRef.current = null;
    setAtMention(null);
    setPasteHint(null);
    stopSpeech();
    topicCheckAbortRef.current?.abort();
    topicCheckAbortRef.current = null;
    topicCheckBusyRef.current = false;
    setTopicCheckBusy(false);
    useConfirmModalStore.getState().settle(null);
    const ta = textareaRef.current;
    if (ta) ta.style.height = 'auto';
  }, [sessionId]);

  /**
   * Refinement was switched off while a panel was still open: send the
   * original prompt instead of leaving it stranded.
   *
   * This used to run INSIDE render — it cleared the store and sent a message
   * as a side effect of drawing the composer, which React warns about and
   * which fired before any of the session bookkeeping below could see the
   * panel. With four tabs that mattered: the send goes through the foreground
   * facade, so a panel belonging to another tab was delivered into the tab on
   * screen. It now runs after render, and only for the tab that owns it —
   * a foreign panel is taken down by the session-change effect instead.
   */
  useEffect(() => {
    if (!refinePanel || enhanceEnabled) return;
    if (refinePanel.sessionId !== undefined && refinePanel.sessionId !== sessionId) return;
    const panel = refinePanel;
    setRefinePanel(null);
    if (client?.isConnected) {
      addMessage({ role: 'user', content: panel.original });
      setLoading(true);
      if (panel.freshContext === true) sendMessage(panel.original, undefined, true);
      else sendMessage(panel.original);
    } else {
      setInput(panel.original);
      toast.error(t('chat:input.notConnectedDraftKept'));
    }
  }, [
    refinePanel,
    enhanceEnabled,
    sessionId,
    setRefinePanel,
    client,
    addMessage,
    setLoading,
    sendMessage,
    t,
  ]);

  useEffect(() => {
    if (promptInsertRequest == null) return;
    setInput((prev) => (prev.trim() ? `${prev}\n${promptInsertRequest}` : promptInsertRequest));
    clearPromptInsert();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [promptInsertRequest, clearPromptInsert]);

  const handleToggleEnhance = useCallback(() => {
    const next = !enhanceEnabled;
    useLocalPrefs.getState().set({ enhanceEnabled: next });
    updatePrefs({ enhanceEnabled: next });
  }, [enhanceEnabled, updatePrefs]);

  const sendMsg = useCallback(
    (content: string, mode?: QueueMode) => {
      const effectiveMode = mode ?? 'queue';
      if (isLoading) {
        const images = pendingImagesRef.current;
        useChatStore.getState().setPendingRefinement(
          content,
          images.length > 0
            ? images.map((img) => {
                const comma = img.dataUrl.indexOf(',');
                return {
                  data: comma >= 0 ? img.dataUrl.slice(comma + 1) : img.dataUrl,
                  mime: img.mediaType,
                };
              })
            : [],
          effectiveMode,
        );
        useChatStore.getState().setRefining(true);
        if (refineModel) {
          refineModel(content, { timeoutMs: 15_000 });
          setTimeout(() => {
            useChatStore.getState().setRefining(false);
            useChatStore.getState().setPendingRefinement(null);
          }, 30_000);
        } else {
          useChatStore.getState().setPendingRefinement(null);
          useChatStore.getState().setRefining(false);
          enqueue(content, effectiveMode, images.length > 0 ? images : undefined);
        }
        return;
      }
      addMessage({ role: 'user', content });
      const id = sendMessage(content);
      if (id) setLoading(true);
    },
    [isLoading, pendingImagesRef, refineModel, enqueue, addMessage, sendMessage, setLoading],
  );

  const runSlashCommand = useCallback(
    (raw: string): boolean =>
      runChatSlashCommand({
        raw,
        addMessage,
        clearMessages,
        client,
        queue,
        sendAbort,
        sendMsg,
        setLoading,
        setCurrentView,
        toggleRefineEnabled: handleToggleEnhance,
        setProcessMonitorOpen,
        setQueuePanelOpen,
        ws,
        onOpenBreakdown,
        handleNextList,
        handleNextSelect: (subInput: string) => handleNextSelect(subInput, sendMsg),
      }),
    [
      addMessage,
      clearMessages,
      client,
      queue,
      sendAbort,
      sendMsg,
      setLoading,
      setCurrentView,
      handleToggleEnhance,
      setProcessMonitorOpen,
      setQueuePanelOpen,
      ws,
      onOpenBreakdown,
    ],
  );

  const slashSuggestions = input.startsWith('/') && !input.includes(' ') ? matchSlash(input) : [];

  useEffect(() => {
    if (slashIndex >= slashSuggestions.length) setSlashIndex(0);
  }, [slashSuggestions.length, slashIndex]);

  const _clearTextarea = useCallback(() => {
    const curId = sessionId ?? useSessionStore.getState().session?.id;
    if (curId) sessionDraftMap.delete(curId);
    const ta = textareaRef.current;
    if (ta) {
      ta.value = '';
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      if (!isLoading) {
        ta.focus();
      }
    }
  }, [isLoading, sessionId]);

  const submitWith = useCallback(
    async (mode: QueueMode) => {
      resetAutoSubmitStreak();
      if (topicCheckBusyRef.current) return;
      if (!input.trim() && pendingImagesRef.current.length === 0 && fileRefs.length === 0) return;

      const content = input.trim();
      const fileContents: Record<string, string> = {};
      for (const f of openFiles) fileContents[f.path] = f.content;
      const refsMarkdown = refsToMarkdown(fileRefs, fileContents);
      const combined = [content, refsMarkdown].filter(Boolean).join('\n\n');

      if (content.startsWith('/') && runSlashCommand(combined)) {
        clearRefs();
        pushPrompt(content);
        setInput('');
        setHistoryIdx(-1);
        stickyDraftRef.current = null;
        _clearTextarea();
        return;
      }

      let freshContext = false;
      const userTurns = messages.reduce(
        (count, message) => count + (message.role === 'user' ? 1 : 0),
        0,
      );
      if (
        mode === 'btw' &&
        !isLoading &&
        client?.isConnected &&
        client.supportsCapability('context.topic-boundary') &&
        userTurns >= 5
      ) {
        topicCheckBusyRef.current = true;
        setTopicCheckBusy(true);
        const abort = new AbortController();
        topicCheckAbortRef.current = abort;
        try {
          const advice = await adviseTopic(combined);
          if (abort.signal.aborted) return;
          if (advice.suggestNewContext) {
            const decision = await confirmModalChoice({
              title: t('chat:input.topicShiftTitle'),
              message: t('chat:input.topicShiftMessage', {
                reason: advice.reason,
                topic: advice.nextTopic ?? t('chat:input.topicShiftUnnamed'),
              }),
              confirmLabel: t('chat:input.topicShiftFresh'),
              cancelLabel: t('chat:input.topicShiftSame'),
              defaultAction: 'cancel',
            });
            if (abort.signal.aborted) return;
            if (decision === 'dismiss') return;
            freshContext = decision === 'confirm';
          }
        } catch {
          // Advisory failures are non-blocking
        } finally {
          topicCheckBusyRef.current = false;
          setTopicCheckBusy(false);
          if (topicCheckAbortRef.current === abort) topicCheckAbortRef.current = null;
        }
      }

      clearRefs();
      setInput('');
      setHistoryIdx(-1);
      stickyDraftRef.current = null;
      _clearTextarea();
      pushPrompt(content);
      _clearTextarea();

      const images = pendingImagesRef.current;
      const attachments = images.map((img) => ({
        id: img.id,
        kind: 'image' as const,
        dataUrl: img.dataUrl,
        mediaType: img.mediaType,
        bytes: img.bytes,
        name: img.name,
      }));

      if (mode === 'queue') {
        enqueue(combined, 'queue', images.length > 0 ? images : undefined);
        clearPendingImages();
        return;
      }

      const mustSteer = mode === 'steer' && isLoading;
      const mustEnqueue = mode === 'btw' && isLoading;

      if (mustEnqueue) {
        if (images.length > 0) {
          enqueue(combined, 'queue', images);
          clearPendingImages();
          return;
        }
        if (client?.isConnected) {
          let dispatched = false;
          try {
            sendMailboxMessage({
              type: 'btw',
              to: 'leader',
              subject: 'btw from WebUI',
              body: combined,
              priority: 'normal',
              audience: 'all',
            });
            dispatched = true;
          } catch (err) {
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'ws_btw_send_failed',
                reason: 'send_error',
                error: toErrorMessage(err),
                timestamp: new Date().toISOString(),
              }),
            );
          }
          enqueue(combined, 'btw', undefined, dispatched);
        } else {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'ws_btw_send_failed',
              reason: 'not_connected',
              timestamp: new Date().toISOString(),
            }),
          );
          enqueue(combined, 'btw');
        }
        clearPendingImages();
        return;
      }

      if (mustSteer) {
        sendAbort();
      }

      try {
        if (client?.isConnected) {
          if (enhanceEnabled && images.length === 0) {
            const profileRef = refinerFallbackProfile
              ? fallbackProfiles[refinerFallbackProfile]?.[0]
              : undefined;
            const slash = profileRef?.indexOf('/') ?? -1;
            const displayedProvider = profileRef
              ? slash > 0
                ? profileRef.slice(0, slash)
                : configProvider
              : refinerProvider || configProvider;
            const displayedModel = profileRef
              ? slash > 0
                ? profileRef.slice(slash + 1)
                : profileRef
              : refinerModel || configModel;
            setRefinePanel({
              original: combined,
              refined: combined,
              english: combined,
              status: 'countdown',
              resolve: (_decision) => {},
              provider: displayedProvider,
              model: displayedModel,
              // Stamped so the panel cannot outlive the tab it belongs to.
              ...(sessionId ? { sessionId } : {}),
              ...(freshContext ? { freshContext: true } : {}),
            });
          } else {
            const wireImages = images.length > 0 ? toWireImages(images) : undefined;
            const requestId = freshContext
              ? sendMessage(combined, wireImages, true)
              : sendMessage(combined, wireImages);
            if (!requestId) {
              toast.error(t('chat:input.notConnectedDraftKept'));
              return;
            }
            addMessage({
              id: requestId,
              role: 'user',
              content: combined,
              ...(attachments.length > 0 ? { attachments } : {}),
            });
            setLoading(true);
            clearPendingImages();
          }
        } else {
          setInput(combined);
          toast.error(t('chat:input.notConnectedDraftKept'));
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'ws_send_failed',
              reason: 'not_connected',
              timestamp: new Date().toISOString(),
            }),
          );
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'ws_send_error',
            error: toErrorMessage(err),
            timestamp: new Date().toISOString(),
          }),
        );
        setLoading(false);
      }
    },
    [
      input,
      fileRefs,
      isLoading,
      enqueue,
      client,
      sendMessage,
      sendAbort,
      sendMailboxMessage,
      enhanceEnabled,
      setRefinePanel,
      addMessage,
      setLoading,
      runSlashCommand,
      pushPrompt,
      _clearTextarea,
      resetAutoSubmitStreak,
      clearPendingImages,
      pendingImagesRef,
      configProvider,
      configModel,
      t,
      messages,
      adviseTopic,
      clearRefs,
      openFiles,
      fallbackProfiles,
      refinerFallbackProfile,
      refinerProvider,
      refinerModel,
    ],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void submitWith('btw');
    },
    [submitWith],
  );

  const handleBtw = useCallback(() => {
    void submitWith('btw');
  }, [submitWith]);
  const handleSteer = useCallback(() => {
    void submitWith('steer');
  }, [submitWith]);
  const handleAddQueue = useCallback(() => {
    void submitWith('queue');
  }, [submitWith]);

  const handleAbort = useCallback(() => {
    sendAbort();
    setLoading(false);
  }, [sendAbort, setLoading]);

  const handleStopAndEdit = useCallback(() => {
    sendAbort();
    setLoading(false);
    const all = useChatStore.getState().messages;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = expectDefined(all[i]);
      if (m.role === 'user' && m.content) {
        setInput(m.content);
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (ta) {
            ta.style.height = 'auto';
            ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
            ta.focus();
            ta.setSelectionRange(m.content.length, m.content.length);
          }
        });
        return;
      }
    }
  }, [sendAbort, setLoading]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (atMention && e.defaultPrevented) return;
      if (slashSuggestions.length === 0 && !atMention && promptHistory.length > 0) {
        if (e.key === 'ArrowUp') {
          const ta = e.currentTarget;
          const beforeCursor = ta.value.slice(0, ta.selectionStart);
          if (historyIdx >= 0 || beforeCursor.indexOf('\n') === -1) {
            e.preventDefault();
            if (historyIdx === -1) stickyDraftRef.current = ta.value;
            const next = Math.min(promptHistory.length - 1, historyIdx + 1);
            setHistoryIdx(next);
            const text = promptHistory[next] ?? '';
            setInput(text);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                el.setSelectionRange(text.length, text.length);
              }
            });
            return;
          }
        }
        if (e.key === 'ArrowDown' && historyIdx >= 0) {
          e.preventDefault();
          const next = historyIdx - 1;
          if (next < 0) {
            const restored = stickyDraftRef.current ?? '';
            stickyDraftRef.current = null;
            setHistoryIdx(-1);
            setInput(restored);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                el.setSelectionRange(restored.length, restored.length);
              }
            });
          } else {
            setHistoryIdx(next);
            const text = promptHistory[next] ?? '';
            setInput(text);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                el.setSelectionRange(text.length, text.length);
              }
            });
          }
          return;
        }
      }

      if (slashSuggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % slashSuggestions.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const pick = slashSuggestions[slashIndex];
          if (pick) {
            setInput(pick.name + ' ');
            setSlashIndex(0);
          }
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          const pick = slashSuggestions[slashIndex];
          if (pick && pick.name !== input.toLowerCase().trim()) {
            e.preventDefault();
            setInput('');
            runSlashCommand(pick.name);
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setInput('');
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [
      slashSuggestions,
      slashIndex,
      atMention,
      promptHistory,
      historyIdx,
      input,
      runSlashCommand,
      handleSubmit,
    ],
  );

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <PromptLibraryModal />
      {pasteHint && (
        <div
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-xs flex items-center justify-between gap-2 animate-message',
            pasteHint.lang
              ? 'border-success/30 bg-success/5 text-success'
              : 'border-warning/30 bg-warning/5 text-warning',
          )}
        >
          <span>
            {pasteHint.lang ? (
              <>
                {t('chat:input.autoFencedAs')}{' '}
                <span className="font-mono font-semibold">{pasteHint.lang}</span>
                {' — '}
                <span className="font-mono tabular-nums">{pasteHint.chars.toLocaleString()}</span>{' '}
                {t('chat:input.charsWord')}
                {' ('}
                <span className="font-mono tabular-nums">{pasteHint.lines}</span>{' '}
                {t('chat:input.linesWord')})
              </>
            ) : (
              <>
                {t('chat:input.pastedWord')}{' '}
                <span className="font-mono tabular-nums">{pasteHint.chars.toLocaleString()}</span>{' '}
                {t('chat:input.charsWord')}
                {' ('}
                <span className="font-mono tabular-nums">{pasteHint.lines}</span>{' '}
                {t('chat:input.linesWord')}) {t('chat:input.fencedHintPrefix')}{' '}
                <span className="font-mono">```</span>.
              </>
            )}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {pasteHint.undoFence && (
              <button
                type="button"
                onClick={pasteHint.undoFence}
                className="underline underline-offset-2 hover:opacity-80"
                title={t('chat:input.removeFencesTitle')}
              >
                {t('common:action.undo')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setPasteHint(null)}
              className="opacity-60 hover:opacity-100 shrink-0"
              title={t('chat:input.dismissTitle')}
              aria-label={t('chat:input.dismissTitle')}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {pendingImages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <span className="text-[10px] uppercase text-muted-foreground shrink-0">
            {t('chat:input.imagesLabel')}
          </span>
          {pendingImages.map((img) => (
            <div
              key={img.id}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-1.5 py-1"
              title={img.name ?? t('chat:input.pendingAttachmentAlt')}
            >
              <img
                src={img.dataUrl}
                alt={img.name ?? t('chat:input.pendingAttachmentAlt')}
                className="h-10 w-10 rounded object-cover border border-border/50"
              />
              <span className="flex flex-col leading-tight">
                <span className="text-[11px] text-foreground/90 max-w-[120px] truncate">
                  {img.name ?? t('chat:input.imageAttached')}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {img.width && img.height ? `${img.width}×${img.height} · ` : ''}
                  {Math.max(1, Math.round(img.bytes / 1024))} KB
                </span>
              </span>
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                title={t('chat:input.removeImageTitle')}
                aria-label={t('chat:input.removeImageTitle')}
                className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                ×
              </button>
            </div>
          ))}
          {pendingImages.length > 1 && (
            <button
              type="button"
              onClick={clearPendingImages}
              className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
            >
              {t('chat:input.clearAll')}
            </button>
          )}
        </div>
      )}

      <QueuedMessages queue={queue} onClear={clearQueue} onRemove={removeQueued} />

      <ChatInputRefinePanelHost
        enhanceEnabled={enhanceEnabled}
        refinePickOpen={refinePickOpen}
        setRefinePickOpen={setRefinePickOpen}
        refineModel={refineModel}
        clientConnected={client?.isConnected === true}
        addUserMessage={(content) => addMessage({ role: 'user', content })}
        setLoading={setLoading}
        sendMessage={sendMessage}
        isLoading={isLoading}
        enqueue={enqueue}
        setInput={setInput}
        resolveCancelInput={resolveCancelInput}
        notConnectedDraftKept={() => toast.error(t('chat:input.notConnectedDraftKept'))}
      />

      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => setPromptLibraryOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-accent/50 transition-all duration-200"
          title={t('chat:input.openPromptLibrary')}
        >
          <BookOpen className="h-3.5 w-3.5" />
          {t('activity:chatInput.promptLibrary')}
        </button>
      </div>

      {hasFileRefs && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <span className="text-[10px] uppercase text-muted-foreground shrink-0">
            {t('chat:input.referencesLabel')}
          </span>
          {fileRefs.map((ref) => (
            <FileReferenceChip key={ref.id} reference={ref} onRemove={() => removeRef(ref.id)} />
          ))}
          <button
            type="button"
            onClick={clearRefs}
            className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
          >
            {t('chat:input.clearAll')}
          </button>
        </div>
      )}

      {topicCheckBusy && (
        <div className="px-1 text-xs text-muted-foreground" role="status">
          {t('chat:input.topicShiftChecking')}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-session-id={sessionId ?? undefined}
        data-running={isLoading ? 'true' : 'false'}
        data-chat-started={chatStarted ? 'true' : 'false'}
        data-has-draft={input.trim() || pendingImages.length > 0 ? 'true' : 'false'}
        className={cn(
          'relative flex flex-col gap-2 rounded-xl border border-border/70 bg-background/85 p-2 shadow-lg shadow-black/5 transition-colors sm:flex-row sm:items-end',
          isLoading && 'border-warning/45 bg-warning/5 shadow-warning/10',
          !chatStarted && !isLoading && 'border-border/50 bg-card/55 shadow-none',
          draggingOver && 'ring-2 ring-primary ring-offset-2 ring-offset-background bg-primary/5',
        )}
      >
        {draggingOver && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none rounded-lg bg-primary/10 text-primary text-sm font-medium">
            {t('chat:input.dropOverlay')}
          </div>
        )}
        <div className="relative w-full flex-1">
          <FileMentionPicker
            atMention={atMention}
            input={input}
            textareaRef={textareaRef}
            setInput={setInput}
            setAtMention={setAtMention}
          />

          {!atMention && (
            <SlashCommandPopup
              suggestions={slashSuggestions}
              selectedIndex={slashIndex}
              onSelectIndex={setSlashIndex}
              onRun={(name) => {
                setInput('');
                runSlashCommand(name);
              }}
            />
          )}
          <textarea
            ref={textareaRef}
            data-chat-textarea
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              adjustTextareaHeight();
              if (historyIdx >= 0) {
                setHistoryIdx(-1);
                stickyDraftRef.current = null;
              }
              const cur = e.target.selectionStart ?? v.length;
              setAtMention(detectAtMention(v, cur));
            }}
            onSelect={(e) => {
              const ta = e.currentTarget;
              setAtMention(detectAtMention(ta.value, ta.selectionStart));
            }}
            onKeyDown={handleKeyDown}
            onPaste={onTextPaste}
            placeholder={
              !client?.isConnected
                ? t('chat:inputPlaceholderConnecting')
                : isLoading
                  ? t('chat:inputPlaceholderLoading')
                  : t('chat:inputPlaceholder')
            }
            className={cn(
              'flex min-h-[64px] w-full resize-none overflow-y-auto rounded-lg border border-input bg-card/80 px-4 py-3 pr-12 shadow-sm sm:min-h-[44px]',
              'text-sm ring-offset-background placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'scrollbar-thin',
            )}
            rows={1}
            disabled={!client?.isConnected || topicCheckBusy}
          />

          <DraftTokenCounter
            input={input}
            lastInputTokens={lastInputTokens}
            maxContext={maxContext}
          />
        </div>

        <ComposerButtonBar
          imagePickerRef={imagePickerRef}
          disabled={!client?.isConnected || topicCheckBusy}
          topicCheckBusy={topicCheckBusy}
          clientConnected={client?.isConnected === true}
          isLoading={isLoading}
          chatStarted={chatStarted}
          input={input}
          pendingImages={pendingImages}
          addImageFiles={addImageFiles}
          handleStopAndEdit={handleStopAndEdit}
          handleAbort={handleAbort}
          handleBtw={handleBtw}
          handleSteer={handleSteer}
          handleAddQueue={handleAddQueue}
          updatePrefs={updatePrefs}
          t={t}
          isListening={isListening}
          isSpeechSupported={isSpeechSupported}
          onToggleSpeech={handleToggleSpeech}
        />
      </form>
    </div>
  );
}
