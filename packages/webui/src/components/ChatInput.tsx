import { expectDefined, toErrorMessage } from '@wrongstack/core';
import { Bell, ListPlus, Pencil, RotateCw, Send, Sparkles, Square } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatStore, useFileReferenceStore, useSessionStore, useUIStore } from '@/stores';
import { refsToMarkdown } from '@/stores/file-reference-store.js';
import { FileReferenceChip } from './FileReferenceChip.js';
import { useAutoSubmitStreak } from '@/stores/auto-submit-streak.js';
import type { QueueMode } from '@/stores/chat-store';
import { FileMentionPicker, type FileMentionState } from './ChatInput/file-mention-picker.js';
import { QueuedMessages } from './ChatInput/queued-messages.js';
import {
  detectAtMention,
  matchSlash,
  SLASH_CATEGORY_ORDER,
  type SlashCommandDef,
} from './ChatInput/slash-commands.js';
import { runChatSlashCommand } from './ChatInput/slash-routing.js';
import { usePasteDrop } from './ChatInput/use-paste-drop.js';
import { RefinePanel } from './RefinePanel.js';
import { PromptLibraryModal } from './PromptLibraryModal.js';
import { Button } from './ui/button';

export function ChatInput({
  onOpenBreakdown,
}: {
  onOpenBreakdown?: (() => void) | undefined;
} = {}) {
  const { isLoading, setLoading, addMessage, clearMessages } = useChatStore();
  const messages = useChatStore((s) => s.messages);
  /** A "started" chat is one that already has at least one message — i.e.
   *  the user has sent a prompt at some point and is now either waiting
   *  for a response or has finished one. While the chat hasn't started yet
   *  the input only shows `refining` + `submit`; once it has started we
   *  reveal the send-mode trio (`btw` / `steer` / `queue`) alongside the
   *  `stop` button. */
  const chatStarted = messages.length > 0;
  const queue = useChatStore((s) => s.queue);
  const enqueue = useChatStore((s) => s.enqueue);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const clearQueue = useChatStore((s) => s.clearQueue);
  const { setCurrentView } = useUIStore();
  const pushPrompt = useUIStore((s) => s.pushPrompt);
  const promptHistory = useUIStore((s) => s.promptHistory);
  const ws = useWebSocket();
  const { sendMessage, sendAbort, client, refineModel } = ws;
  const { t } = useAppTranslation();
  const refineEnabled = useUIStore((s) => s.refineEnabled);
  const refinePanel = useUIStore((s) => s.refinePanel);
  const promptInsertRequest = useUIStore((s) => s.promptInsertRequest);
  const clearPromptInsert = useUIStore((s) => s.clearPromptInsert);
  const toggleRefineEnabled = useUIStore((s) => s.toggleRefineEnabled);
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);
  const setProcessMonitorOpen = useUIStore((s) => s.setProcessMonitorOpen);
  const setQueuePanelOpen = useUIStore((s) => s.setQueuePanelOpen);
  /** Auto-submit streak reset — called on every manual submit to re-arm the cap. */
  const { reset: resetAutoSubmitStreak } = useAutoSubmitStreak();
  /** Live context-budget signals — drive the token-estimate chip beside
   *  the character counter. The estimate uses the universal 4-char-per-token
   *  heuristic which is wrong by ±25% for natural prose but accurate enough
   *  to warn the user before they paste a 100k-char file into a 200k window.
   *  The chip only renders past the threshold so short drafts stay clean. */
  const lastInputTokens = useSessionStore((s) => s.lastInputTokens);
  const maxContext = useSessionStore((s) => s.maxContext);
  const [input, setInput] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  /** Cursor into promptHistory. -1 = "live input, not browsing history".
   *  Reset to -1 whenever the user types something that's NOT a history
   *  navigation. */
  const [historyIdx, setHistoryIdx] = useState(-1);
  /** Open `@`-mention picker state. We track the starting position of the
   *  `@` in the textarea so on pick we can replace the partial token
   *  (`@compa`) with the chosen path. Null = closed. */
  const [atMention, setAtMention] = useState<FileMentionState | null>(null);
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
    pendingImageRef,
    pendingImage,
    clearPendingImage,
    setPasteHint,
  } = usePasteDrop({ input, textareaRef, setInput });

  // Prompt library "Insert" pushes its rendered text here; fold it into the input.
  useEffect(() => {
    if (promptInsertRequest == null) return;
    setInput((prev) => (prev.trim() ? `${prev}\n${promptInsertRequest}` : promptInsertRequest));
    clearPromptInsert();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [promptInsertRequest, clearPromptInsert]);

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
        toggleRefineEnabled,
        setProcessMonitorOpen,
        setQueuePanelOpen,
        ws,
        onOpenBreakdown,
        handleNextList,
        handleNextSelect,
      }),
    [
      addMessage,
      clearMessages,
      client,
      queue,
      sendAbort,
      setLoading,
      setCurrentView,
      toggleRefineEnabled,
      setProcessMonitorOpen,
      setQueuePanelOpen,
      ws,
      onOpenBreakdown,
    ],
  );

  // ── /next helpers ──────────────────────────────────────────────────

  /** Regex matching "💡 Next steps" heading + numbered items. */
  const NEXT_STEPS_RE = /💡\s*Next steps?\s*\n+((?:\d+\.\s+.+\n?)+)/i;

  function parseNextStepsFromContent(content: string): Array<{ index: number; text: string }> {
    const match = NEXT_STEPS_RE.exec(content);
    if (!match?.[1]) return [];
    const steps: Array<{ index: number; text: string }> = [];
    for (const line of match[1].split('\n').filter(Boolean)) {
      const m = /^(\d+)\.\s+(.+)$/.exec(line.trim());
      if (m) steps.push({ index: Number.parseInt(m[1]!, 10), text: m[2]!.trim() });
    }
    return steps.slice(0, 6);
  }

  function parseNextStepsFromLastAssistant(): Array<{ index: number; text: string }> {
    const all = useChatStore.getState().messages;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m?.role === 'assistant' && m.content) {
        return parseNextStepsFromContent(m.content);
      }
    }
    return [];
  }

  /** Send a user message through the agent. */
  function sendMsg(content: string) {
    if (isLoading) {
      enqueue(content);
      return;
    }
    addMessage({ role: 'user', content });
    const id = sendMessage(content);
    if (id) setLoading(true);
  }

  /** Parse 💡 Next steps from the last assistant message and show them. */
  function handleNextList(): true {
    const all = useChatStore.getState().messages;
    let lastAssistant = '';
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m?.role === 'assistant' && m.content) {
        lastAssistant = m.content;
        break;
      }
    }
    const steps = parseNextStepsFromContent(lastAssistant);
    if (steps.length === 0) {
      addMessage({
        role: 'assistant',
        content: '💡 _No next-step suggestions found. Use `/suggest` to generate some._',
      });
      return true;
    }
    const lines = ['💡 **Next steps**', ''];
    for (const s of steps) lines.push(`${s.index}. ${s.text}`);
    lines.push('', '_Use `/next 1`, `/next 1 2 3` to execute._');
    addMessage({ role: 'assistant', content: lines.join('\n') });
    return true;
  }

  /** Parse 💡 Next steps and execute the selected item(s). */
  function handleNextSelect(input: string): true {
    const steps = parseNextStepsFromLastAssistant();
    if (steps.length === 0) {
      addMessage({
        role: 'assistant',
        content: '💡 _No suggestions available. Use `/suggest` first._',
      });
      return true;
    }
    const parts = input.split(/[\s,]+/).filter(Boolean);
    const indices = parts
      .map((p) => Number.parseInt(p, 10))
      .filter((n) => !Number.isNaN(n) && n > 0);
    if (indices.length === 0) {
      addMessage({ role: 'assistant', content: '💡 _No valid suggestion numbers._' });
      return true;
    }
    const invalid = indices.filter((i) => i > steps.length);
    if (invalid.length > 0) {
      addMessage({
        role: 'assistant',
        content: `💡 _Invalid suggestion(s): ${invalid.join(', ')}. Valid range: 1–${steps.length}._`,
      });
      return true;
    }
    for (const i of indices) {
      const s = steps[i - 1];
      if (s) sendMsg(s.text);
    }
    return true;
  }

  // Suggest slash commands as the user types. Only when the buffer is
  // exactly a slash command head — `/foo bar` shouldn't open the popup.
  const slashSuggestions = input.startsWith('/') && !input.includes(' ') ? matchSlash(input) : [];

  // Reset the highlight when the visible list changes so ↑/↓ always starts
  // from the top of the new matches.
  useEffect(() => {
    if (slashIndex >= slashSuggestions.length) setSlashIndex(0);
  }, [slashSuggestions.length, slashIndex]);

  /** Direct textarea DOM clear — bypasses useState so the UI updates
   *  even when React batches the state update. */
  const _clearTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.value = '';
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      if (!isLoading) {
        ta.focus();
      }
    }
  }, [isLoading]);

  /** Core submit path shared by Enter and the three mode buttons.
   *
   *  Modes:
   *  - `btw`    — send the message without interrupting the running agent.
   *               While idle this is identical to a plain send; while
   *               running, the message goes through the queue so the
   *               agent sees it on the next turn boundary.
   *  - `steer`  — interrupt the running agent, then send. While idle
   *               this collapses to a plain send (no abort target).
   *  - `queue`  — always enqueue, regardless of `isLoading`. Held until
   *               the current run completes, then sent in arrival order.
   *
   *  Refine + slash-command paths bypass this entirely — they short-circuit
   *  before mode is applied. */
  const submitWith = useCallback(
    async (mode: QueueMode) => {
      // Manual submit re-arms the auto-proceed consecutive cap.
      resetAutoSubmitStreak();
      if (!input.trim() && !pendingImageRef.current && fileRefs.length === 0) return;

      // Drain and clear the pending clipboard image (if any)
      const pendingImage = pendingImageRef.current;
      clearPendingImage();

      const content = input.trim();
      const refsMarkdown = refsToMarkdown(fileRefs);
      const combined = [content, refsMarkdown].filter(Boolean).join('\n\n');
      // Snapshot refs and clear them immediately so a rapid second submit
      // doesn't duplicate the references.
      clearRefs();

      if (content.startsWith('/') && runSlashCommand(content)) {
        pushPrompt(content);
        setInput('');
        setHistoryIdx(-1);
        _clearTextarea();
        return;
      }

      setInput('');
      setHistoryIdx(-1);
      _clearTextarea();
      pushPrompt(content);
      _clearTextarea(); // ensure textarea is cleared even if batching delays state

      // Build the full content: prepend the pasted image as a markdown
      // image link so both the chat view and the agent receive it.
      const fullContent = pendingImage ? `![pasted image](${pendingImage})\n\n${combined}` : combined;

      // `queue` mode always enqueues, even when idle. The drain loop
      // picks it up after the next run.result.
      if (mode === 'queue') {
        enqueue(fullContent, 'queue');
        return;
      }

      // `btw` while running enqueues (so the message rides alongside
      // without interrupting). While idle, it sends normally.
      // `steer` always tries to interrupt first, then sends.
      const mustSteer = mode === 'steer' && isLoading;
      const mustEnqueue = mode === 'btw' && isLoading;

      if (mustEnqueue) {
        enqueue(fullContent, 'btw');
        return;
      }

      if (mustSteer) {
        // Stop the in-flight run so the agent picks up our redirect at
        // the next turn. sendAbort is a no-op if nothing is running.
        sendAbort();
      }

      try {
        if (client?.isConnected) {
          // If refine is enabled, trigger the refinement flow instead of sending directly
          if (refineEnabled && refineModel) {
            setRefinePanel({
              original: combined,
              refined: combined, // Will be replaced when backend responds
              english: combined,
              resolve: (_decision) => {
                // This is called when the refine panel is decided
              },
            });
            refineModel(combined);
          } else {
            addMessage({ role: 'user', content: fullContent });
            setLoading(true);
            sendMessage(combined, pendingImage ?? undefined);
          }
        } else {
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
      refineModel,
      refineEnabled,
      setRefinePanel,
      addMessage,
      setLoading,
      runSlashCommand,
      pushPrompt,
      _clearTextarea,
      resetAutoSubmitStreak,
      clearPendingImage,
      pendingImageRef,
    ],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      // Enter (and the form-submit button) default to btw — the softest
      // mode. Users who want to interrupt or queue explicitly use the
      // steer / add-queue buttons beside the input.
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

  /** "Stop & edit" — abort the in-flight run, then pull the last user
   *  message back into the input so the user can rewrite the prompt and
   *  resend. Saves the two-step dance of clicking Abort, waiting for the
   *  agent to settle, then hunting for the original prompt. */
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
      // Terminal-style prompt history: ↑ pulls the previous user prompt,
      // ↓ steps forward. Only active when both popups are closed AND the
      // input is empty OR already showing a history entry. We keep the cursor
      // ergonomic — once the user starts editing, we drop out of history mode.
      if (slashSuggestions.length === 0 && !atMention && promptHistory.length > 0) {
        if (e.key === 'ArrowUp') {
          const ta = e.currentTarget;
          // Only steal ↑ if we're on the first line (so multi-line editing
          // can still navigate within the textarea naturally).
          const beforeCursor = ta.value.slice(0, ta.selectionStart);
          if (historyIdx >= 0 || beforeCursor.indexOf('\n') === -1) {
            e.preventDefault();
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
            setHistoryIdx(-1);
            setInput('');
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

      // Slash popup keyboard navigation: ↑/↓ to select, Tab/Enter to commit,
      // Esc to dismiss. Matches the TUI's slash menu UX one-for-one so users
      // moving between surfaces don't have to relearn anything.
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
          // Commit the highlighted suggestion if there's an exact match below
          // the cursor (or the user hasn't typed a full name yet). Otherwise
          // fall through to normal submit.
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
      {/* Smart paste hint — shows when code is auto-fenced (with undo)
          or when a large text block is pasted. Auto-dismisses. */}
      {pasteHint && (
        <div
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-xs flex items-center justify-between gap-2 animate-message',
            pasteHint.lang
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
              : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300',
          )}
        >
          <span>
            {pasteHint.lang ? (
              <>
                Auto-fenced as <span className="font-mono font-semibold">{pasteHint.lang}</span>
                {' — '}
                <span className="font-mono tabular-nums">{pasteHint.chars.toLocaleString()}</span>{' '}
                chars
                {' ('}
                <span className="font-mono tabular-nums">{pasteHint.lines}</span> lines)
              </>
            ) : (
              <>
                Pasted{' '}
                <span className="font-mono tabular-nums">{pasteHint.chars.toLocaleString()}</span>{' '}
                chars
                {' ('}
                <span className="font-mono tabular-nums">{pasteHint.lines}</span> lines) — fenced
                code blocks render best with <span className="font-mono">```</span>.
              </>
            )}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {pasteHint.undoFence && (
              <button
                type="button"
                onClick={pasteHint.undoFence}
                className="underline underline-offset-2 hover:opacity-80"
                title="Remove fences and restore raw text"
              >
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={() => setPasteHint(null)}
              className="opacity-60 hover:opacity-100 shrink-0"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {/* Pending image preview — shown when an image is pasted or dropped.
          Sent alongside the next message as a markdown image link. */}
      {pendingImage && (
        <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2 py-1.5">
          <img
            src={pendingImage}
            alt="Pending attachment"
            className="h-12 w-12 rounded object-cover border border-border/50"
          />
          <span className="text-xs text-muted-foreground">Image attached</span>
          <button
            type="button"
            onClick={clearPendingImage}
            title="Remove image"
            className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            ×
          </button>
        </div>
      )}

      {/* Queue visualization — shows messages the user stacked while the
          agent was still running. Each row has a remove button; the whole
          queue can be cleared. The hook below drains them after run.result. */}
      <QueuedMessages queue={queue} onClear={clearQueue} onRemove={removeQueued} />

      {/* Prompt-refinement panel — shown when the user submits and refine is enabled */}
      {refinePanel && (
        <RefinePanel
          original={refinePanel.original}
          refined={refinePanel.refined}
          english={refinePanel.english}
          onDecision={(decision) => {
            const { original, refined, english } = refinePanel;
            let text = original;
            if (decision === 'refined') text = refined;
            else if (decision === 'english') text = english;
            else if (decision === 'edit') text = refined;

            // Send the chosen text as a user message
            if (decision === 'edit') {
              // For edit, the panel handles it differently — set input to refined text
              setInput(refined);
              return;
            }

            // For refined/english/original, proceed to send
            setRefinePanel(null);
            if (client?.isConnected) {
              addMessage({ role: 'user', content: text });
              setLoading(true);
              sendMessage(text);
            }
          }}
        />
      )}

      {/* File reference chips queued for the next message. */}
      {hasFileRefs && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
            References
          </span>
          {fileRefs.map((ref) => (
            <FileReferenceChip
              key={ref.id}
              ref={ref}
              onRemove={() => removeRef(ref.id)}
            />
          ))}
          <button
            type="button"
            onClick={clearRefs}
            className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
          >
            Clear all
          </button>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'flex items-end gap-2 relative rounded-lg transition-colors',
          draggingOver && 'ring-2 ring-primary ring-offset-2 ring-offset-background bg-primary/5',
        )}
      >
        {draggingOver && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none rounded-lg bg-primary/10 text-primary text-sm font-medium">
            Drop file{`(s)`} to attach as @-mention
          </div>
        )}
        <div className="relative flex-1">
          {/* @-mention file picker — takes priority over the slash popup
            since `@` and `/` can't both be active at the cursor. */}
          <FileMentionPicker
            atMention={atMention}
            input={input}
            textareaRef={textareaRef}
            setInput={setInput}
            setAtMention={setAtMention}
          />

          {/* Slash command popup — descriptions inline, ↑/↓ to select, Tab to
            autocomplete, Enter to dispatch directly. Click also works. */}
          {!atMention &&
            slashSuggestions.length > 0 &&
            (() => {
              // Bucket the suggestions by category and preserve the global
              // index across categories — the keyboard navigation (↑/↓) tracks
              // a flat index, so each rendered row needs to map back to its
              // position in the un-grouped `slashSuggestions` array.
              const byCategory: Record<string, Array<{ cmd: SlashCommandDef; idx: number }>> = {};
              slashSuggestions.forEach((cmd, idx) => {
                if (!byCategory[cmd.category]) byCategory[cmd.category] = [];
                byCategory[cmd.category]?.push({ cmd, idx });
              });
              const orderedCategories = SLASH_CATEGORY_ORDER.filter((c) => byCategory[c]?.length);
              return (
                <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border bg-popover shadow-md p-1 text-sm max-h-72 overflow-auto">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b mb-1">
                    ↑/↓ select · Tab complete · Enter dispatch · Esc dismiss
                  </div>
                  {orderedCategories.map((cat) => (
                    <div key={cat} className="mb-1">
                      <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                        {cat}
                      </div>
                      {byCategory[cat]?.map(({ cmd, idx }) => (
                        <button
                          type="button"
                          key={cmd.name}
                          onClick={() => {
                            setInput('');
                            runSlashCommand(cmd.name);
                          }}
                          onMouseEnter={() => setSlashIndex(idx)}
                          className={cn(
                            'w-full text-left px-3 py-1.5 rounded transition-colors flex items-center gap-3',
                            idx === slashIndex
                              ? 'bg-accent text-accent-foreground'
                              : 'hover:bg-accent/40',
                          )}
                        >
                          <span className="font-mono shrink-0">{cmd.name}</span>
                          {cmd.aliases?.length ? (
                            <span className="text-xs text-muted-foreground/70 font-mono shrink-0">
                              ({cmd.aliases.join(', ')})
                            </span>
                          ) : null}
                          <span className="text-xs text-muted-foreground truncate">
                            — {cmd.description}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })()}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              adjustTextareaHeight();
              // Manual typing drops us out of history mode so the next
              // Enter sends the user's edits, not a stale history entry.
              if (historyIdx >= 0) setHistoryIdx(-1);
              // Detect / refresh @-mention based on cursor position.
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
              'flex min-h-[44px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 pr-12',
              'text-sm ring-offset-background placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'scrollbar-thin',
            )}
            rows={1}
            disabled={!client?.isConnected}
          />

          {input.length > 0 &&
            (() => {
              // Hide the token estimate until the draft is non-trivial — small
              // messages aren't worth a context warning, and the chip would
              // otherwise just flicker as the user types each character.
              const showTokens = input.length >= 400;
              const estTokens = Math.ceil(input.length / 4);
              // Project the next request's context usage: last sent + draft +
              // small overhead. If that crosses 85% of the configured window,
              // tint amber; past 100% turns red. Falls through to muted when
              // we don't have the window size yet (e.g. before first request).
              let tone = 'text-muted-foreground';
              let title: string | undefined;
              if (maxContext > 0 && showTokens) {
                const projected = lastInputTokens + estTokens + 64;
                const pct = (projected / maxContext) * 100;
                if (pct >= 100) {
                  tone = 'text-red-600 dark:text-red-400 font-medium';
                  title = `Projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx — will likely error or compact.`;
                } else if (pct >= 85) {
                  tone = 'text-amber-600 dark:text-amber-400 font-medium';
                  title = `Projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx — getting tight.`;
                } else {
                  title = `≈ ${estTokens.toLocaleString()} tokens · projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx.`;
                }
              } else if (showTokens) {
                title = `≈ ${estTokens.toLocaleString()} tokens (4-char heuristic)`;
              }
              return (
                <span
                  className={cn('absolute bottom-1.5 right-12 text-xs tabular-nums', tone)}
                  title={title}
                >
                  {input.length}
                  {showTokens && (
                    <span className="ml-1 opacity-70">
                      · ≈{estTokens >= 1000 ? `${(estTokens / 1000).toFixed(1)}k` : estTokens}t
                    </span>
                  )}
                </span>
              );
            })()}
        </div>

        <div className="flex gap-1">
          {isLoading && chatStarted ? (
            <>
              {/* Stop controls stay beside the new send-mode buttons so
                  the user can interrupt from the same row. Stop-and-edit
                  pulls the last prompt back; Stop aborts without editing. */}
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={handleStopAndEdit}
                className="h-[44px] w-[44px] rounded-lg"
                title="Stop run and edit the last prompt (reuse + rewrite)"
                data-testid="stop-and-edit"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="destructive"
                onClick={handleAbort}
                className="h-[44px] w-[44px] rounded-lg"
                title="Abort the current run"
                data-testid="stop"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="icon"
              variant={refineEnabled ? 'default' : 'outline'}
              disabled={!client?.isConnected}
              onClick={toggleRefineEnabled}
              className={cn(
                'h-[44px] w-[44px] rounded-lg transition-colors',
                refineEnabled &&
                  'bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-600 dark:text-yellow-400 border-yellow-500/50',
              )}
              title={
                refineEnabled
                  ? 'Refining enabled — click to disable'
                  : 'Refining disabled — click to enable'
              }
            >
              <Sparkles className="h-4 w-4" />
            </Button>
          )}

          {/* Send button — visible both before and after chat has started.
              Enter on the textarea routes here via the form submit handler too. */}
          <Button
            type="submit"
            size="icon"
            variant="default"
            disabled={!input.trim() || !client?.isConnected}
            className="h-[44px] w-[44px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white dark:bg-sky-500 dark:hover:bg-sky-600"
            title={t('chat:sendTitle')}
            data-testid="send-submit"
          >
            <Send className="h-4 w-4" />
          </Button>

          {/* Send-mode buttons. btw is the new default send (Enter also
              routes here). steer interrupts the run and redirects; addQueue
              always enqueues, regardless of run state. Only revealed once
              the chat has started — before the first send there's nothing
              to interrupt, steer, or queue against. */}
          {chatStarted && (
            <>
              <Button
                type="button"
                size="icon"
                variant="default"
                disabled={!input.trim() || !client?.isConnected}
                onClick={handleBtw}
                className="h-[44px] w-[44px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white dark:bg-sky-500 dark:hover:bg-sky-600"
                title={
                  isLoading
                    ? 'btw — send without interrupting the running agent'
                    : 'btw — send (Enter)'
                }
                data-testid="send-btw"
              >
                <Bell className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                disabled={!input.trim() || !client?.isConnected}
                onClick={handleSteer}
                className="h-[44px] w-[44px] rounded-lg border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
                title={
                  isLoading
                    ? 'steer — interrupt the running agent and redirect'
                    : 'steer — send (no interrupt target while idle)'
                }
                data-testid="send-steer"
              >
                <RotateCw className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                disabled={!input.trim() || !client?.isConnected}
                onClick={handleAddQueue}
                className="h-[44px] w-[44px] rounded-lg border-indigo-500/50 text-indigo-700 dark:text-indigo-400 hover:bg-indigo-500/10"
                title="add queue — hold until the current run completes"
                data-testid="send-queue"
              >
                <ListPlus className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
