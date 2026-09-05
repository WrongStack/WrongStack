import { toErrorMessage } from '@wrongstack/core/utils/error';
import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import type React from 'react';
import { useCallback, useEffect } from 'react';
import type { useWebSocket } from '@/hooks/useWebSocket';
import {
  useChatStore,
  useConfigStore,
  useFileReferenceStore,
  useFileStore,
  useUIStore,
} from '@/stores';
import { useAutoSubmitStreak } from '@/stores/auto-submit-streak.js';
import type { QueueMode } from '@/stores/chat-store';
import { refsToMarkdown } from '@/stores/file-reference-store.js';
import { useLocalPrefs } from '@/stores/local-prefs';
import { confirmModalChoice } from '../ConfirmModal.js';
import { toast } from '../Toaster';
import { type ImageAttachment, toWireImages } from './image-attachments.js';

export interface UseChatSubmitOptions {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  sessionId: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  pendingImagesRef: React.MutableRefObject<ImageAttachment[]>;
  clearPendingImages: () => void;
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
  addMessage: ReturnType<typeof useChatStore.getState>['addMessage'];
  enqueue: ReturnType<typeof useChatStore.getState>['enqueue'];
  ws: ReturnType<typeof useWebSocket>;
  enhanceEnabled: boolean;
  pushPrompt: (prompt: string) => void;
  setHistoryIdx: (idx: number) => void;
  stickyDraftRef: React.MutableRefObject<string | null>;
  refineBackstopTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  topicCheckBusyRef: React.MutableRefObject<boolean>;
  topicCheckAbortRef: React.MutableRefObject<AbortController | null>;
  setTopicCheckBusy: (busy: boolean) => void;
  runSlashCommand: (raw: string) => boolean;
  clearTextarea: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useChatSubmit({
  input,
  setInput,
  sessionId,
  textareaRef,
  pendingImagesRef,
  clearPendingImages,
  isLoading,
  setLoading,
  addMessage,
  enqueue,
  ws,
  enhanceEnabled,
  pushPrompt,
  setHistoryIdx,
  stickyDraftRef,
  refineBackstopTimerRef,
  topicCheckBusyRef,
  topicCheckAbortRef,
  setTopicCheckBusy,
  runSlashCommand,
  clearTextarea,
  t,
}: UseChatSubmitOptions) {
  const { sendMessage, sendAbort, sendMailboxMessage, client, refineModel, adviseTopic } = ws;
  const messages = useChatStore((s) => s.messages);
  const openFiles = useFileStore((s) => s.openFiles);
  const fileRefs = useFileReferenceStore((s) => s.refs);
  const { clearRefs } = useFileReferenceStore.getState();
  const configProvider = useConfigStore((s) => s.provider);
  const configModel = useConfigStore((s) => s.model);
  const refinerProvider = useLocalPrefs((s) => s.refinerProvider);
  const refinerModel = useLocalPrefs((s) => s.refinerModel);
  const refinerFallbackProfile = useLocalPrefs((s) => s.refinerFallbackProfile);
  const fallbackProfiles = useLocalPrefs((s) => s.fallbackProfiles);
  const refinePanel = useUIStore((s) => s.refinePanel);
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);
  const { reset: resetAutoSubmitStreak } = useAutoSubmitStreak();

  // Refinement was switched off while a panel was still open: send the
  // original prompt instead of leaving it stranded.
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
    setInput,
    t,
  ]);

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
          if (refineBackstopTimerRef.current !== null) clearTimeout(refineBackstopTimerRef.current);
          refineBackstopTimerRef.current = setTimeout(() => {
            refineBackstopTimerRef.current = null;
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
    [
      isLoading,
      pendingImagesRef,
      refineModel,
      enqueue,
      addMessage,
      sendMessage,
      setLoading,
      refineBackstopTimerRef,
    ],
  );

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
        clearTextarea();
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
      clearTextarea();
      pushPrompt(content);

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
      clearTextarea,
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
      sessionId,
      setInput,
      setHistoryIdx,
      stickyDraftRef,
      topicCheckAbortRef,
      topicCheckBusyRef,
      setTopicCheckBusy,
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
  }, [sendAbort, setLoading, setInput, textareaRef]);

  return {
    sendMsg,
    submitWith,
    handleSubmit,
    handleBtw,
    handleSteer,
    handleAddQueue,
    handleAbort,
    handleStopAndEdit,
  };
}
