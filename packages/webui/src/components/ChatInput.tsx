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
  useSessionStore,
  useUIStore,
} from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import {
  FileReferencesBar,
  ModelAndPromptBar,
  PasteHintBar,
  PendingImagesBar,
} from './ChatInput/chat-input-bars.js';
import { ComposerButtonBar } from './ChatInput/composer-button-bar.js';
import { DraftTokenCounter } from './ChatInput/draft-token-counter.js';
import { FileMentionPicker, type FileMentionState } from './ChatInput/file-mention-picker.js';
import { handleNextList, handleNextSelect } from './ChatInput/next-steps-helpers.js';
import { QueuedMessages } from './ChatInput/queued-messages.js';
import { ChatInputRefinePanelHost } from './ChatInput/refine-panel-host.js';
import {
  clearSessionDraft,
  resolveCancelInput,
  useSessionDraft,
} from './ChatInput/session-draft.js';
import { detectAtMention } from './ChatInput/slash-commands.js';
import { SlashCommandPopup } from './ChatInput/slash-popup.js';
import { runChatSlashCommand } from './ChatInput/slash-routing.js';
import { useChatInputMcp } from './ChatInput/use-chat-input-mcp.js';
import { useChatKeyDown } from './ChatInput/use-chat-keydown.js';
import { useChatSubmit } from './ChatInput/use-chat-submit.js';
import { usePasteDrop } from './ChatInput/use-paste-drop.js';
import { useRefineTimeout } from './ChatInput/use-refine-timeout.js';
import { useSpeechRecognition } from './ChatInput/use-speech-recognition.js';
import { PromptLibraryModal } from './PromptLibraryModal.js';
import { toast } from './Toaster';

export { resolveCancelInput };

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
  const chatStarted = messages.length > 0;
  const queue = useChatStore((s) => s.queue);
  const enqueue = useChatStore((s) => s.enqueue);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const clearQueue = useChatStore((s) => s.clearQueue);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setPromptLibraryOpen = useUIStore((s) => s.setPromptLibraryOpen);
  const pushPrompt = useUIStore((s) => s.pushPrompt);
  const promptHistory = useUIStore((s) => s.promptHistory);
  const promptInsertRequest = useUIStore((s) => s.promptInsertRequest);
  const clearPromptInsert = useUIStore((s) => s.clearPromptInsert);
  const setProcessMonitorOpen = useUIStore((s) => s.setProcessMonitorOpen);
  const setQueuePanelOpen = useUIStore((s) => s.setQueuePanelOpen);

  const ws = useWebSocket();
  const { sendMessage, sendAbort, client, refineModel, updatePrefs } = ws;
  const { t } = useAppTranslation();
  const enhanceEnabled = useLocalPrefs((s) => s.enhanceEnabled);

  const sessionProvider = useSessionStore((s) => s.session?.provider);
  const sessionModel = useSessionStore((s) => s.session?.model);
  const fallbackProvider = useConfigStore((s) => s.provider);
  const fallbackModel = useConfigStore((s) => s.model);

  const [input, setInput] = useState(() => useUIStore.getState().draftInput ?? '');
  const refineBackstopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    isListening,
    isSupported: isSpeechSupported,
    toggleListening: handleToggleSpeech,
    stopListening: stopSpeech,
  } = useSpeechRecognition({
    onTranscript: (text) => {
      setInput((prev) => (prev ? `${prev} ${text}` : text));
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
  const [atMention, setAtMention] = useState<FileMentionState | null>(null);
  const [refinePickOpen, setRefinePickOpen] = useState(false);
  const [topicCheckBusy, setTopicCheckBusy] = useState(false);
  const topicCheckBusyRef = useRef(false);
  const topicCheckAbortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRefs = useFileReferenceStore((s) => s.refs);
  const { removeRef, clearRefs } = useFileReferenceStore.getState();

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

  useEffect(
    () => () => {
      if (refineBackstopTimerRef.current !== null) clearTimeout(refineBackstopTimerRef.current);
    },
    [],
  );

  const sessionId = useActiveSessionId();

  const clearTextarea = useCallback(() => {
    clearSessionDraft(sessionId);
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

  const handleToggleEnhance = useCallback(() => {
    const next = !enhanceEnabled;
    useLocalPrefs.getState().set({ enhanceEnabled: next });
    updatePrefs({ enhanceEnabled: next });
  }, [enhanceEnabled, updatePrefs]);

  const runSlashCommandRef = useRef<(raw: string) => boolean>(() => false);

  const {
    sendMsg,
    handleSubmit,
    handleBtw,
    handleSteer,
    handleAddQueue,
    handleAbort,
    handleStopAndEdit,
  } = useChatSubmit({
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
    setHistoryIdx: (idx) => setHistoryIdx(idx),
    stickyDraftRef: {
      get current() {
        return stickyDraftRef.current;
      },
      set current(v) {
        stickyDraftRef.current = v;
      },
    },
    refineBackstopTimerRef,
    topicCheckBusyRef,
    topicCheckAbortRef,
    setTopicCheckBusy,
    runSlashCommand: (raw) => runSlashCommandRef.current(raw),
    clearTextarea,
    t,
  });

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
  runSlashCommandRef.current = runSlashCommand;

  const {
    slashIndex,
    setSlashIndex,
    slashSuggestions,
    historyIdx,
    setHistoryIdx,
    stickyDraftRef,
    handleKeyDown,
  } = useChatKeyDown({
    input,
    setInput,
    textareaRef,
    atMention,
    promptHistory,
    runSlashCommand,
    handleSubmit,
  });

  useSessionDraft({
    sessionId,
    input,
    setInput,
    pendingImages,
    setPendingImages,
    clearPendingImages,
    fileRefs,
    clearRefs,
    setHistoryIdx,
    stickyDraftRef,
    setAtMention,
    setPasteHint,
    stopSpeech,
    topicCheckAbortRef,
    topicCheckBusyRef,
    setTopicCheckBusy,
    refineBackstopTimerRef,
    textareaRef,
  });

  useEffect(() => {
    if (promptInsertRequest == null) return;
    setInput((prev) => (prev.trim() ? `${prev}\n${promptInsertRequest}` : promptInsertRequest));
    clearPromptInsert();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [promptInsertRequest, clearPromptInsert]);

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
        <PasteHintBar pasteHint={pasteHint} onDismiss={() => setPasteHint(null)} t={t} />
      )}
      <PendingImagesBar
        pendingImages={pendingImages}
        onRemove={removeImage}
        onClearAll={clearPendingImages}
        t={t}
      />

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

      <ModelAndPromptBar
        sessionProvider={sessionProvider}
        sessionModel={sessionModel}
        fallbackProvider={fallbackProvider}
        fallbackModel={fallbackModel}
        onOpenPromptLibrary={() => setPromptLibraryOpen(true)}
        onOpenModelSwitcher={() => useUIStore.getState().setModelSwitcherOpen(true)}
        t={t}
      />

      <FileReferencesBar fileRefs={fileRefs} onRemove={removeRef} onClearAll={clearRefs} t={t} />

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
