import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Info,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Terminal,
  User,
} from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import remarkGfm from 'remark-gfm';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import type { ChatMessage } from '@/stores';
import { useChatStore, useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { useAutoSubmitStreak } from '@/stores/auto-submit-streak.js';
import { useLocalPrefs } from '@/stores/local-prefs';
import { toWireImages } from '../ChatInput/image-attachments.js';
import { fillInput, NextStepsBar } from '../NextStepsBar';
import { toast } from '../Toaster';
import { BrainDecisionCard, parseBrainMarkdown } from '../ChatView/BrainDecisionCard.js';
import { CouncilDecisionCard, parseCouncilMarkdown } from '../ChatView/CouncilDecisionCard.js';
import { AttachmentGallery } from './AttachmentGallery.js';
import { CopyButton } from './CopyButton.js';
import { ErrorBodyWithStack } from './ErrorBody.js';
import { FailedRunContinue } from './FailedRunContinue.js';
import { LazyMarkdown as ReactMarkdown } from './LazyMarkdown.js';
import { StreamingMarkdown } from './StreamingMarkdown.js';
import { ToolLedgerCard } from './ToolLedgerCard.js';
import { markdownComponents, rehypePlugins } from './utils.js';

interface MessageBubbleProps {
  message: ChatMessage;
  isFirst?: boolean | undefined;
  isContinuation?: boolean | undefined;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isFirst = false,
  isContinuation = false,
}: MessageBubbleProps) {
  const { t } = useAppTranslation();
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isThinkingLog = !!message.thinkingLog;
  const isSystem = message.role === 'system' && !isThinkingLog;
  void message.role;

  const truncateAfter = useChatStore((s) => s.truncateAfter);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const addMessage = useChatStore((s) => s.addMessage);
  const setLoading = useChatStore((s) => s.setLoading);
  const isLoading = useChatStore((s) => s.isLoading);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const pinnedIds = useUIStore((s) => s.pinnedIds);
  const togglePin = useUIStore((s) => s.togglePin);
  const compactMode = useUIStore((s) => s.compactMode);
  const searchOpen = useUIStore((s) => s.searchOpen);
  const searchActiveMessageId = useUIStore((s) => s.searchActiveMessageId);
  const isPinned = pinnedIds.includes(message.id);
  const inputCost = useSessionStore((s) => s.inputCost);
  const outputCost = useSessionStore((s) => s.outputCost);
  const cacheReadCost = useSessionStore((s) => s.cacheReadCost);
  const localPrefs = useLocalPrefs();
  const { autonomy, yolo, showThinkingLogs } = localPrefs;

  // ── Hooks (must precede early return — Rules of Hooks) ──
  const { canAutoSubmit, recordAutoSubmit, recordPrompt, capWarned } = useAutoSubmitStreak();
  const canAutoSubmitNow = canAutoSubmit();

  useEffect(() => {
    if (!message.thinkingLog || !searchOpen || searchActiveMessageId !== message.id) return;
    const query = useUIStore.getState().searchQuery.trim().toLowerCase();
    if (query && message.thinkingLog.text.toLowerCase().includes(query)) {
      setThinkingExpanded(true);
    }
  }, [message.id, message.thinkingLog, searchActiveMessageId, searchOpen]);

  /** When model reasoning is turned off and the message has only a
   *  thinking log (no visible content), suppress the entire message
   *  bubble — avatar, role label, content card, and timestamp.
   *  Without this, the outer container div + avatar + empty card
   *  remain visible even though the reasoning content is hidden. */
  const hideEmptyReasoning =
    !showThinkingLogs && !!message.thinkingLog && !message.content && !message.streaming;
  if (hideEmptyReasoning) return null;

  if (message.councilDecision || parseCouncilMarkdown(message.content)) {
    return <CouncilDecisionCard message={message} />;
  }

  if (message.brainDecision || parseBrainMarkdown(message.content)) {
    return <BrainDecisionCard message={message} />;
  }

  /** Auto-submit callback for YOLO+auto mode countdown completion */
  const handleAutoSubmit = (text: string) => {
    if (useChatStore.getState().isLoading) return;
    if (!canAutoSubmit()) {
      // Cap already hit — show a one-time warning and stop.
      if (!capWarned) {
        addMessage({
          role: 'assistant',
          content: t('activity:message.autoPaused'),
        });
      }
      return;
    }
    const client = getWSClient(wsUrl);
    if (!client.isConnected) {
      toast.error(t('common:status.notConnectedRetry'));
      return;
    }
    // Record at the final automatic-submission boundary. All MessageBubble
    // instances share one session guard through useAutoSubmitStreak().
    if (!recordPrompt(text)) {
      addMessage({
        role: 'assistant',
        content: t('activity:message.autoLoopHalted'),
      });
      fillInput('');
      return;
    }
    recordAutoSubmit();
    addMessage({ role: 'user', content: text });
    setLoading(true);
    client.sendMessage(text);
    // Clear the input field after auto-submitting, matching the behaviour
    // of the normal form submission path in ChatInput.
    fillInput('');
  };

  /** Batch-submit callback for multi-select: joins selected step texts and
   *  sends as a single user message, bypassing the refine/enhance panel. */
  const handleBatchSubmit = (texts: string[]) => {
    if (useChatStore.getState().isLoading) return;
    const combined = texts.join('\n');
    const client = getWSClient(wsUrl);
    if (!client.isConnected) {
      toast.error(t('common:status.notConnectedRetry'));
      return;
    }
    addMessage({ role: 'user', content: combined });
    setLoading(true);
    client.sendMessage(combined);
    fillInput('');
  };

  const isLatestAssistant = (() => {
    if (message.role !== 'assistant' || isLoading) return false;
    const all = useChatStore.getState().messages;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = expectDefined(all[i]);
      if (m.role === 'assistant') return m.id === message.id;
    }
    return false;
  })();

  /**
   * Next-steps source of truth.
   *
   * The canonical <nextsteps> block is stripped from message.content at
   * finalization time (chat-store.finalizeMessage) and the parsed steps
   * are persisted on message.nextSteps. We read them directly here — no
   * re-parsing. Only the latest assistant response exposes its panel, so
   * old suggestions do not accumulate through the visible transcript.
   *
   * The previous implementation re-parsed content on every render and
   * gated the strip on isLatestAssistant. When the user clicked a
   * suggestion, setLoading(true) flipped isLatestAssistant to false,
   * nextStepsResult became null, and the un-stripped content — including
   * the raw <nextsteps> XML — rendered verbatim. Reading the persisted
   * field breaks that coupling.
   */
  const nextSteps = message.nextSteps?.steps ?? [];

  /** Attachments of a user message that can still be resent — only those
   *  whose data URL survived (persistence strips it, so after a refresh a
   *  regenerate/edit resend degrades to text-only, matching the placeholder
   *  chip the bubble already shows). */
  const resendableAttachments = (msg: ChatMessage) =>
    (msg.attachments ?? []).flatMap((a) =>
      a.dataUrl
        ? [{ id: a.id, dataUrl: a.dataUrl, mediaType: a.mediaType, bytes: a.bytes, name: a.name }]
        : [],
    );

  const retryUserMessage = () => {
    const client = getWSClient(wsUrl);
    if (!client.isConnected) {
      toast.error(t('common:status.notConnectedRetry'));
      return;
    }
    const atts = resendableAttachments(message);
    truncateAfter(message.id);
    updateMessage(message.id, { status: undefined });
    setLoading(true);
    client.sendMessage(message.content, atts.length > 0 ? toWireImages(atts) : undefined);
  };

  const regenerate = () => {
    const all = useChatStore.getState().messages;
    const idx = all.findIndex((m) => m.id === message.id);
    if (idx === -1) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (all[i]?.role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const client = getWSClient(wsUrl);
    if (!client.isConnected) {
      toast.error(t('common:status.notConnectedRetry'));
      return;
    }
    const userMsg = expectDefined(all[userIdx]);
    const atts = resendableAttachments(userMsg);
    truncateAfter(userMsg.id);
    updateMessage(userMsg.id, { status: undefined });
    setLoading(true);
    client.sendMessage(userMsg.content, atts.length > 0 ? toWireImages(atts) : undefined);
  };

  const startEdit = () => {
    setEditValue(message.content);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditValue('');
  };
  const saveEdit = () => {
    const next = editValue.trim();
    if (!next) {
      cancelEdit();
      return;
    }
    const client = getWSClient(wsUrl);
    if (!client.isConnected) {
      toast.error(t('common:status.notConnectedRetry'));
      return;
    }
    const atts = resendableAttachments(message);
    truncateAfter(message.id);
    updateMessage(message.id, {
      content: next,
      status: undefined,
      ...(atts.length > 0
        ? { attachments: atts.map((a) => ({ ...a, kind: 'image' as const })) }
        : {}),
    });
    setLoading(true);
    client.sendMessage(next, atts.length > 0 ? toWireImages(atts) : undefined);
    setEditing(false);
    setEditValue('');
  };

  return (
    <div
      data-message-id={message.id}
      data-pinned={isPinned ? '1' : undefined}
      className={cn(
        'group flex msg-bubble animate-message rounded-lg transition-shadow',
        compactMode ? 'gap-2' : 'gap-3',
        isUser ? 'flex-row-reverse' : 'flex-row',
        isPinned && 'ring-1 ring-warning/30 bg-warning/[0.02] px-1 -mx-1',
      )}
    >
      {isContinuation ? (
        <div className="flex-shrink-0 w-8 h-8" aria-hidden />
      ) : (
        <div
          className={cn(
            'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
            'ring-1 ring-offset-2 ring-offset-background',
            isUser
              ? 'bg-primary text-primary-foreground ring-primary/20'
              : isTool
                ? 'bg-secondary text-secondary-foreground ring-secondary/20'
                : isSystem
                  ? 'bg-muted/60 text-muted-foreground ring-border/40'
                  : isThinkingLog
                    ? 'bg-primary/10 text-primary ring-primary/20'
                    : 'bg-accent text-accent-foreground ring-accent/20',
          )}
        >
          {isUser ? (
            <User className="h-4 w-4" />
          ) : isTool ? (
            <Terminal className="h-4 w-4" />
          ) : isSystem ? (
            <Info className="h-4 w-4" />
          ) : isThinkingLog ? (
            <Brain className="h-4 w-4" />
          ) : (
            <Bot className="h-4 w-4" />
          )}
        </div>
      )}

      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-[52rem]',
          isUser && 'items-end sm:max-w-[44rem]',
        )}
      >
        {isFirst && !isContinuation && (
          <span
            className={cn(
              'text-xs font-medium px-1',
              isUser
                ? 'text-primary'
                : isSystem
                  ? 'text-muted-foreground/60'
                  : isTool
                    ? 'text-secondary'
                    : isThinkingLog
                      ? 'text-primary'
                      : 'text-muted-foreground',
            )}
          >
            {isUser
              ? t('activity:message.roleYou')
              : isSystem
                ? 'System'
                : isTool
                  ? t('activity:message.roleTool')
                  : isThinkingLog
                    ? t('activity:message.roleThinking')
                    : t('activity:message.roleAssistant')}
          </span>
        )}

        {isTool ? (
          <ToolLedgerCard message={message} />
        ) : (
          <div
            className={cn(
              'max-w-full rounded-lg shadow-sm',
              compactMode ? 'px-3 py-1.5' : 'px-4 py-3',
              isUser
                ? 'bg-transparent text-foreground border border-primary/40 rounded-br-sm'
                : isSystem
                  ? 'bg-muted/30 border border-border/30 text-muted-foreground text-xs italic py-2'
                  : 'bg-card border border-border/70 text-foreground',
              message.isError && 'border-destructive/20',
              isUser && message.status === 'failed' && 'opacity-60 ring-1 ring-destructive/30',
            )}
          >
            {editing && isUser ? (
              <div className="flex flex-col gap-2 min-w-[280px]">
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEdit();
                    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      saveEdit();
                    }
                  }}
                  rows={Math.min(8, Math.max(2, editValue.split('\n').length))}
                  className="w-full resize-none rounded-md border bg-background text-foreground px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-primary-foreground/60">
                    {t('activity:message.editHint')}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="text-xs px-2 py-0.5 rounded border border-primary-foreground/30 hover:bg-primary-foreground/10"
                    >
                      {t('common:action.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={!editValue.trim()}
                      className="text-xs px-2 py-0.5 rounded bg-primary-foreground text-primary disabled:opacity-50"
                    >
                      {t('activity:message.saveResend')}
                    </button>
                  </div>
                </div>
              </div>
            ) : message.thinkingLog && showThinkingLogs ? (
              (() => {
                const log = message.thinkingLog;
                const lineCount = log.text.split('\n').length;
                const seconds = Math.max(0.1, log.durationMs / 1000);
                const durationLabel = log.replayed
                  ? t('activity:message.replay')
                  : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
                const preview = log.text.split('\n').slice(-4).join('\n').trim();
                return (
                  <div className="ws-reasoning min-w-0 max-w-full py-0.5 sm:max-w-[720px]">
                    <button
                      type="button"
                      onClick={() => setThinkingExpanded((v) => !v)}
                      className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-left font-mono text-xs"
                      aria-expanded={thinkingExpanded}
                    >
                      <span className="ws-reasoning__mark text-sm leading-none" aria-hidden>
                        ✦
                      </span>
                      <span className="font-semibold uppercase tracking-wide text-primary">
                        {t('activity:message.thinkingProcess')}
                      </span>
                      <span className="text-[10px] text-muted-foreground/70">
                        {t('activity:message.thinkingMeta', {
                          iter: log.iteration,
                          dur: durationLabel,
                          lines: t('activity:message.linesSuffix', { count: lineCount }),
                        })}
                      </span>
                      <span className="ml-auto text-muted-foreground/60">
                        {thinkingExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </span>
                    </button>
                    <pre
                      className={cn(
                        'mt-1.5 whitespace-pre-wrap break-words font-mono text-xs italic leading-relaxed text-foreground/65',
                        thinkingExpanded
                          ? 'max-h-[32rem] overflow-auto'
                          : 'max-h-24 overflow-hidden',
                      )}
                    >
                      {thinkingExpanded ? log.text : preview || log.text}
                    </pre>
                    <div className="mt-1.5 flex items-center gap-2">
                      <CopyButton
                        text={log.text}
                        label={t('activity:message.copyLog')}
                        className="text-[10px] text-muted-foreground/60 opacity-70 transition-opacity hover:opacity-100"
                      />
                      {!thinkingExpanded && lineCount > 4 && (
                        <button
                          type="button"
                          onClick={() => setThinkingExpanded(true)}
                          className="text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
                        >
                          {t('activity:message.showFullLog')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()
            ) : (
              (() => {
                // When model reasoning is off and the message only has a
                // thinking log with no visible content, hide the entire block.
                if (hideEmptyReasoning) return null;

                // For assistant output, the canonical <nextsteps> block was
                // already stripped from message.content at finalization time
                // (chat-store.finalizeMessage), so renderedContent is simply
                // message.content. The parsed steps render as a separate
                // <NextStepsBar> below the bubble, reading from message.nextSteps.
                const renderedContent = message.content;
                const hasAttachments = !!message.attachments && message.attachments.length > 0;
                return (
                  <div
                    className={cn(
                      'text-sm leading-relaxed markdown-content',
                      message.streaming && 'streaming-cursor',
                    )}
                  >
                    {hasAttachments && (
                      <AttachmentGallery
                        attachments={message.attachments ?? []}
                        notRetainedLabel={t('activity:message.imageNotRetained')}
                      />
                    )}
                    {renderedContent ? (
                      showRaw && message.role === 'assistant' ? (
                        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90 max-h-[40rem] overflow-auto">
                          {message.content}
                        </pre>
                      ) : message.role === 'assistant' && message.isError ? (
                        <>
                          <ErrorBodyWithStack text={message.content} />
                          {isLatestAssistant && !message.streaming && !isLoading && (
                            <FailedRunContinue
                              text={message.content}
                              timestamp={message.timestamp}
                            />
                          )}
                        </>
                      ) : message.streaming ? (
                        // While streaming, avoid re-parsing the whole growing
                        // message through remark on every frame — see
                        // StreamingMarkdown for the stable-prefix strategy.
                        <StreamingMarkdown text={renderedContent} />
                      ) : (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={rehypePlugins}
                          components={markdownComponents}
                        >
                          {renderedContent}
                        </ReactMarkdown>
                      )
                    ) : message.streaming ? (
                      <span className="inline-block animate-pulse text-muted-foreground">
                        {t('activity:message.typing')}
                      </span>
                    ) : hasAttachments || nextSteps.length > 0 ? null : (
                      <span className="text-muted-foreground italic">
                        {t('activity:message.noContent')}
                      </span>
                    )}
                  </div>
                );
              })()
            )}
          </div>
        )}

        {/* Failed delivery indicator for optimistic user messages */}
        {isUser && message.status === 'failed' && (
          <span className="text-[10px] font-medium text-destructive flex items-center gap-1 px-1">
            {t('activity:message.failedToSend')}
          </span>
        )}

        {/* Next steps — read from message.nextSteps (parsed at finalize time).
            Only show after the run completes (!isLoading) so the user can't
            trigger "a run is already in progress" by clicking a suggestion
            mid-run. The <nextsteps> XML is still stripped from content at
            finalize time regardless of this gate. */}
        {isLatestAssistant && !isLoading && nextSteps.length > 0 && (
          <NextStepsBar
            steps={nextSteps}
            yoloMode={yolo}
            autoMode={autonomy === 'auto'}
            autoDelayMs={localPrefs.autonomyDelayMs}
            onAutoSubmit={handleAutoSubmit}
            canAutoSubmit={canAutoSubmitNow}
            onBatchSubmit={handleBatchSubmit}
            isLatest={isLatestAssistant}
            sessionEndAutoFill={true}
          />
        )}

        <div
          className={cn(
            'flex max-w-full flex-wrap items-center gap-2 px-1',
            isUser ? 'flex-row-reverse' : 'flex-row',
          )}
        >
          {!hideEmptyReasoning && (
            <>
              <span className="text-xs text-muted-foreground/70">
                {new Date(message.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              {/* ── Separator ── */}
              <span className="w-px h-3 bg-border/60 shrink-0" aria-hidden />
            </>
          )}
          {message.runSummary && (
            <span
              className="text-[10px] text-muted-foreground/75 font-mono tabular-nums"
              title={[
                t('activity:message.rsIterations', { n: message.runSummary.iterations }),
                t('activity:message.rsTools', { n: message.runSummary.tools }),
                t('activity:message.rsElapsed', {
                  s: `${(message.runSummary.durationMs / 1000).toFixed(2)}s`,
                }),
                message.runSummary.costDelta > 0
                  ? t('activity:message.rsCost', { c: message.runSummary.costDelta.toFixed(4) })
                  : '',
              ]
                .filter(Boolean)
                .join('  ·  ')}
            >
              {message.runSummary.iterations} iter
              {message.runSummary.tools > 0
                ? ` · ${message.runSummary.tools} tool${message.runSummary.tools === 1 ? '' : 's'}`
                : ''}{' '}
              ·{' '}
              {message.runSummary.durationMs < 60_000
                ? `${(message.runSummary.durationMs / 1000).toFixed(1)}s`
                : `${Math.floor(message.runSummary.durationMs / 60_000)}m ${Math.floor((message.runSummary.durationMs % 60_000) / 1000)}s`}
              {message.runSummary.costDelta > 0
                ? ` · ${message.runSummary.costDelta >= 0.01 ? message.runSummary.costDelta.toFixed(4) : message.runSummary.costDelta.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
                : ''}
            </span>
          )}
          {message.usage &&
            (message.usage.input > 0 || message.usage.output > 0) &&
            (() => {
              const u = message.usage;
              const dollars =
                ((u.input + (u.cacheWrite ?? 0)) * inputCost +
                  u.output * outputCost +
                  (u.cacheRead ?? 0) * cacheReadCost) /
                1_000_000;
              const haveCost = inputCost > 0 || outputCost > 0;
              const dollarStr =
                dollars >= 0.01
                  ? `${dollars.toFixed(4)}`
                  : dollars > 0
                    ? `${dollars.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
                    : '';
              return (
                <span
                  className="text-[10px] text-muted-foreground/75 font-mono tabular-nums"
                  title={[
                    t('activity:message.useInput', { n: u.input.toLocaleString() }),
                    t('activity:message.useOutput', { n: u.output.toLocaleString() }),
                    u.cacheRead
                      ? t('activity:message.useCacheRead', { n: u.cacheRead.toLocaleString() })
                      : '',
                    haveCost ? t('activity:message.useCost', { c: dollarStr }) : '',
                  ]
                    .filter(Boolean)
                    .join('  ·  ')}
                >
                  {u.input.toLocaleString()}→{u.output.toLocaleString()}
                  {u.cacheRead ? ` · ${u.cacheRead.toLocaleString()} ↺` : ''}
                  {haveCost && dollarStr ? ` · ${dollarStr}` : ''}
                </span>
              );
            })()}
          {/* ── Actions — always visible, subtle opacity, full on hover ── */}
          {!isTool && message.content && !message.streaming && (
            <CopyButton
              text={message.content}
              label={t('common:action.copy')}
              className="opacity-50 hover:opacity-100 transition-opacity"
            />
          )}
          {message.role === 'assistant' && message.content && !message.streaming && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              title={
                showRaw
                  ? t('activity:message.showRenderedTitle')
                  : t('activity:message.showRawTitle')
              }
              className={cn(
                'text-xs inline-flex items-center gap-1 transition-opacity',
                showRaw
                  ? 'text-primary hover:text-primary/80 opacity-100'
                  : 'opacity-50 hover:opacity-100 text-muted-foreground hover:text-foreground',
              )}
            >
              <FileCode2 className="h-3 w-3" />
              <span>
                {showRaw ? t('activity:message.renderedLabel') : t('activity:message.rawLabel')}
              </span>
            </button>
          )}
          {isUser && !editing && !isLoading && (
            <>
              {message.status === 'failed' && (
                <button
                  type="button"
                  onClick={retryUserMessage}
                  title={t('activity:message.retryLabel', 'Retry')}
                  className="opacity-75 hover:opacity-100 transition-opacity text-xs text-destructive hover:text-destructive/80 inline-flex items-center gap-1 font-medium"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>{t('activity:message.retryLabel', 'Retry')}</span>
                </button>
              )}
              {message.content && (
                <button
                  type="button"
                  onClick={startEdit}
                  title={t('activity:message.editTitle')}
                  className="opacity-50 hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  <Pencil className="h-3 w-3" />
                  <span>{t('activity:message.editLabel')}</span>
                </button>
              )}
            </>
          )}
          {message.role === 'assistant' && message.content && !message.streaming && (
            <button
              type="button"
              onClick={() => togglePin(message.id)}
              title={isPinned ? t('activity:message.unpinTitle') : t('activity:message.pinTitle')}
              className={cn(
                'text-xs inline-flex items-center gap-1 transition-opacity',
                isPinned
                  ? 'text-warning hover:text-warning/85 opacity-100'
                  : 'opacity-50 hover:opacity-100 text-muted-foreground hover:text-foreground',
              )}
            >
              {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
              <span>
                {isPinned ? t('activity:message.pinnedLabel') : t('activity:message.pinLabel')}
              </span>
            </button>
          )}
          {(isLatestAssistant || message.isError) &&
            message.content &&
            !message.streaming &&
            !isLoading && (
              <button
                type="button"
                onClick={regenerate}
                title={t('activity:message.regenerateTitle')}
                className="opacity-50 hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <RotateCcw className="h-3 w-3" />
                <span>{t('activity:message.retryLabel')}</span>
              </button>
            )}
        </div>
      </div>
    </div>
  );
});
