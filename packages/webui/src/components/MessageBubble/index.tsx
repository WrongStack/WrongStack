import { expectDefined } from '@wrongstack/core';
import { summarizeToolInput } from '@/lib/tool-summary';
import { getToolVisual, getToolTooltip } from '@/lib/tool-icon';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import type { ChatMessage } from '@/stores';
import { useChatStore, useSessionStore, useUIStore } from '@/stores';
import { useConfigStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useAutoSubmitStreak } from '@/stores/auto-submit-streak.js';
import {
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  FileCode2,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Terminal,
  User,
  XCircle,
} from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolDiffView, diffFromToolInput } from '../DiffView';
import { ToolResult } from '../ToolResult';
import { NextStepsBar, fillInput, parseNextSteps } from '../NextStepsBar';
import { CopyButton } from './CopyButton.js';
import { ErrorBodyWithStack } from './ErrorBody.js';
import { ToolInputView } from './ToolInputView.js';
import { downloadTextFile, fileExtensionFor, formatToolDuration, markdownComponents, rehypePlugins } from './utils.js';
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
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isThinkingLog = !!message.thinkingLog;
  void message.role;

  const truncateAfter = useChatStore((s) => s.truncateAfter);
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
  const { autonomy, yolo } = localPrefs;

  const { canAutoSubmit, recordAutoSubmit, capWarned } = useAutoSubmitStreak();
  const autoProceedMaxIterations = localPrefs.autoProceedMaxIterations;
  const canAutoSubmitNow = autoProceedMaxIterations <= 0 || canAutoSubmit();

  /** Auto-submit callback for YOLO+auto mode countdown completion */
  const handleAutoSubmit = (text: string) => {
    if (!canAutoSubmit()) {
      // Cap already hit — show a one-time warning and stop.
      if (!capWarned) {
        addMessage({
          role: 'assistant',
          content:
            t('activity:message.autoPaused'),
        });
      }
      return;
    }
    recordAutoSubmit();
    addMessage({ role: 'user', content: text });
    setLoading(true);
    const client = getWSClient(wsUrl);
    client.sendMessage(text);
    // Clear the input field after auto-submitting, matching the behaviour
    // of the normal form submission path in ChatInput.
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
   * Parse the assistant output once and cache the result for both:
   *   - the stripped content fed to react-markdown (so raw <nextsteps> tags
   *     never leak into the rendered DOM)
   *   - the steps array fed to the <NextStepsBar> below.
   * Recomputes only when message.content changes.
   */
  const nextStepsResult = useMemo(
    () => (isLatestAssistant && message.content ? parseNextSteps(message.content) : null),
    [isLatestAssistant, message.content],
  );

  useEffect(() => {
    if (!message.thinkingLog || !searchOpen || searchActiveMessageId !== message.id) return;
    const query = useUIStore.getState().searchQuery.trim().toLowerCase();
    if (query && message.thinkingLog.text.toLowerCase().includes(query)) {
      setThinkingExpanded(true);
    }
  }, [message.id, message.thinkingLog, searchActiveMessageId, searchOpen]);

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
    const userMsg = expectDefined(all[userIdx]);
    truncateAfter(userMsg.id);
    addMessage({ role: 'user', content: userMsg.content });
    setLoading(true);
    const client = getWSClient(wsUrl);
    client.sendMessage(userMsg.content);
  };

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }));
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
    if (!next) { cancelEdit(); return; }
    truncateAfter(message.id);
    addMessage({ role: 'user', content: next });
    setLoading(true);
    const client = getWSClient(wsUrl);
    client.sendMessage(next);
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
        <div className={cn(
          'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
          'ring-1 ring-offset-2 ring-offset-background',
          isUser ? 'bg-primary text-primary-foreground ring-primary/20' : isTool ? 'bg-secondary text-secondary-foreground ring-secondary/20' : isThinkingLog ? 'bg-primary/10 text-primary ring-primary/20' : 'bg-accent text-accent-foreground ring-accent/20',
        )}>
          {isUser ? <User className="h-4 w-4" /> : isTool ? <Terminal className="h-4 w-4" /> : isThinkingLog ? <Brain className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </div>
      )}

      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-[52rem]',
          isUser && 'items-end sm:max-w-[44rem]',
        )}
      >
        {isFirst && !isContinuation && (
          <span className={cn('text-xs font-medium px-1', isUser ? 'text-primary' : isTool ? 'text-secondary' : isThinkingLog ? 'text-primary' : 'text-muted-foreground')}>
            {isUser ? t('activity:message.roleYou') : isTool ? t('activity:message.roleTool') : isThinkingLog ? t('activity:message.roleThinking') : t('activity:message.roleAssistant')}
          </span>
        )}

        {isTool && message.toolName && (() => {
          const { Icon: ToolIcon, color: toolColor } = getToolVisual(message.toolName);
          const tooltip = getToolTooltip(message.toolName);
          return (
          <button type="button" onClick={() => toggleTool(message.id)}
            className={cn('flex items-center gap-2 text-sm font-medium cursor-pointer select-none', 'hover:bg-muted/50 rounded-lg px-2 py-1 -mx-2 transition-colors', message.isError ? 'text-destructive' : 'text-foreground')}
            title={tooltip}>
            <span className="text-muted-foreground/50">{expandedTools[message.id] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
            <ToolIcon className="h-3 w-3" style={{ color: toolColor }} />
            <span className="font-mono" style={{ color: toolColor }}>{message.toolName}</span>
            {message.toolResult === undefined ? <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" aria-hidden /> : message.isError ? <XCircle className="h-3 w-3 text-destructive" /> : <CheckCircle2 className="h-3 w-3 text-success" />}
            {typeof message.toolDurationMs === 'number' && <span className="text-xs text-muted-foreground tabular-nums font-normal">{formatToolDuration(message.toolDurationMs)}</span>}
          </button>
          );
        })()}

        <div className={cn('max-w-full rounded-lg shadow-sm', compactMode ? 'px-3 py-1.5' : 'px-4 py-3',
          isUser ? 'bg-primary text-primary-foreground rounded-br-sm' : isTool ? message.isError ? 'bg-destructive/5 border border-destructive/25 text-destructive' : 'bg-muted/70 border border-border/60 text-foreground' : 'bg-card border border-border/70 text-foreground',
          message.isError && !isTool && 'border-destructive/20',
          isUser && message.status === 'failed' && 'opacity-60 ring-1 ring-destructive/30')}>
          {isTool ? (() => {
            const expanded = !!expandedTools[message.id];
            const inputSummary = message.toolInput !== undefined ? summarizeToolInput(message.toolName, message.toolInput) : '';
            const lines = message.toolResult ? message.toolResult.split('\n').length : 0;
            return (
              <div className="space-y-1 tool-details">
                {inputSummary && !expanded && <div className="text-xs text-muted-foreground font-mono truncate">{inputSummary}</div>}
                {message.toolResult === undefined && message.progressLines && message.progressLines.length > 0 && (
                  <div className="mt-1 rounded-md border border-warning/20 bg-warning/5 p-1.5 text-[11px] font-mono leading-snug max-h-32 overflow-auto">
                    {(() => {
                      const seen = new Map<string, number>();
                      return message.progressLines.slice(-6).map((line) => {
                        const occurrence = seen.get(line) ?? 0;
                        seen.set(line, occurrence + 1);
                        return (<div key={`${line}-${occurrence}`} className="truncate text-muted-foreground">{line}</div>);
                      });
                    })()}
                  </div>
                )}
                {expanded && message.toolInput !== undefined && (() => {
                  const diff = diffFromToolInput(message.toolName, message.toolInput);
                  if (diff) return <ToolDiffView diff={diff} />;
                  return (<div className="p-3 bg-muted/50 rounded-lg overflow-x-auto"><div className="flex items-center gap-1 text-muted-foreground mb-2 text-xs"><Clock className="h-3 w-3" /><span>{t('activity:message.inputLabel')}</span></div><ToolInputView input={message.toolInput} /></div>);
                })()}
                {expanded && message.toolResult !== undefined && message.toolResult.length > 0 && (
                  <div className="relative group/tool">
                    <ToolResult
                      toolName={message.toolName}
                      result={message.toolResult}
                      isError={message.isError}
                      // TODO: wire to backend — pass the per-tool
                      // `tools.resultRenderMode[name]` value down through
                      // the WS tool.executed event so the WebUI mirrors
                      // the CLI's `/tool <name> result simple|extend`
                      // toggle. Until then, always extend (default).
                    />
                    <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover/tool:opacity-100 transition-opacity">
                      <CopyButton text={message.toolResult} label="" className="bg-background/80 border rounded px-1.5 py-0.5" />
                      {message.toolResult.split('\n').length > 5 && (
                        <button type="button" onClick={(ev) => { ev.stopPropagation(); const ext = fileExtensionFor(message.toolName); const base = (message.toolName ?? 'output').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase(); downloadTextFile(`${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, message.toolResult ?? ''); }}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-background/80 border rounded px-1.5 py-0.5" title={t('activity:message.downloadTitle')}><Download className="h-3 w-3" /></button>
                      )}
                    </div>
                  </div>
                )}
                {expanded && message.toolResult !== undefined && message.toolResult.length === 0 && <span className="text-xs text-muted-foreground italic">{t('activity:message.empty')}</span>}
                {!expanded && message.isError && message.toolResult && <div className="text-xs font-mono text-destructive truncate">{message.toolResult.split('\n')[0]}</div>}
                {((message.toolResult !== undefined && message.toolResult.length > 0) || (message.toolInput !== undefined && Object.keys((message.toolInput as object) ?? {}).length > 0)) && (
                  <button type="button" onClick={() => toggleTool(message.id)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {expanded ? t('activity:message.hideDetails') : lines > 0 ? t('activity:message.showDetailsLines', { count: lines }) : t('activity:message.showDetails')}
                  </button>
                )}
              </div>
            );
          })() : editing && isUser ? (
            <div className="flex flex-col gap-2 min-w-[280px]">
              <textarea value={editValue} onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); } }}
                rows={Math.min(8, Math.max(2, editValue.split('\n').length))}
                className="w-full resize-none rounded-md border bg-background text-foreground px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring" />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-primary-foreground/60">{t('activity:message.editHint')}</span>
                <div className="flex gap-1">
                  <button type="button" onClick={cancelEdit} className="text-xs px-2 py-0.5 rounded border border-primary-foreground/30 hover:bg-primary-foreground/10">{t('common:action.cancel')}</button>
                  <button type="button" onClick={saveEdit} disabled={!editValue.trim()} className="text-xs px-2 py-0.5 rounded bg-primary-foreground text-primary disabled:opacity-50">{t('activity:message.saveResend')}</button>
                </div>
              </div>
            </div>
          ) : message.thinkingLog ? (() => {
            const log = message.thinkingLog;
            const lineCount = log.text.split('\n').length;
            const seconds = Math.max(0.1, log.durationMs / 1000);
            const durationLabel = log.replayed ? t('activity:message.replay') : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
            const preview = log.text.split('\n').slice(-4).join('\n').trim();
            return (
              <div className="min-w-0 max-w-full sm:max-w-[720px]">
                <button
                  type="button"
                  onClick={() => setThinkingExpanded((v) => !v)}
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-left text-sm font-medium text-primary"
                >
                  <span className="text-muted-foreground/60">
                    {thinkingExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </span>
                  <Brain className="h-3.5 w-3.5" />
                  <span className="min-w-0">{t('activity:message.thinkingProcess')}</span>
                  <span className="ml-0 text-[10px] font-mono font-normal text-muted-foreground sm:ml-auto">
                    {t('activity:message.thinkingMeta', { iter: log.iteration, dur: durationLabel, lines: t('activity:message.linesSuffix', { count: lineCount }) })}
                  </span>
                </button>
                <pre className={cn(
                  'mt-2 whitespace-pre-wrap break-words rounded-lg border border-primary/20 bg-primary/[0.04] p-3 font-mono text-xs leading-relaxed text-foreground/80',
                  thinkingExpanded ? 'max-h-[32rem] overflow-auto' : 'max-h-24 overflow-hidden',
                )}>
                  {thinkingExpanded ? log.text : (preview || log.text)}
                </pre>
                <div className="mt-2 flex items-center gap-2">
                  <CopyButton text={log.text} label={t('activity:message.copyLog')} className="opacity-70 hover:opacity-100 transition-opacity" />
                  {!thinkingExpanded && lineCount > 4 && (
                    <button
                      type="button"
                      onClick={() => setThinkingExpanded(true)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {t('activity:message.showFullLog')}
                    </button>
                  )}
                </div>
              </div>
            );
          })() : (() => {
            // For assistant output, strip the canonical <nextsteps> block
            // before passing to react-markdown — otherwise the raw tags leak
            // through as literal text. The parsed steps render as a separate
            // <NextStepsBar> below the bubble.
            const renderedContent = nextStepsResult ? nextStepsResult.stripped : message.content;
            return (
              <div className={cn('text-sm leading-relaxed markdown-content', message.streaming && 'streaming-cursor')}>
                {renderedContent ? (showRaw && message.role === 'assistant' ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90 max-h-[40rem] overflow-auto">{message.content}</pre>
                ) : message.role === 'assistant' && message.isError ? (
                  <ErrorBodyWithStack text={message.content} />
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={markdownComponents}>{renderedContent}</ReactMarkdown>
                )) : message.streaming ? (
                  <span className="inline-block animate-pulse text-muted-foreground">{t('activity:message.typing')}</span>
                ) : (
                  <span className="text-muted-foreground italic">{t('activity:message.noContent')}</span>
                )}
              </div>
            );
          })()}
        </div>

        {/* Failed delivery indicator for optimistic user messages */}
        {isUser && message.status === 'failed' && (
          <span className="text-[10px] font-medium text-destructive flex items-center gap-1 px-1">
            {t('activity:message.failedToSend')}
          </span>
        )}

        {/* Next steps — parse canonical <nextsteps> from assistant output */}
        {nextStepsResult && nextStepsResult.steps.length > 0 && (
          <NextStepsBar
            steps={nextStepsResult.steps}
            yoloMode={yolo}
            autoMode={autonomy === 'auto'}
            autoDelayMs={localPrefs.autonomyDelayMs}
            onAutoSubmit={handleAutoSubmit}
            canAutoSubmit={canAutoSubmitNow}
          />
        )}

        <div className={cn('flex max-w-full flex-wrap items-center gap-2 px-1', isUser ? 'flex-row-reverse' : 'flex-row')}>
          <span className="text-xs text-muted-foreground/50">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          {/* ── Separator ── */}
          <span className="w-px h-3 bg-border/60 shrink-0" aria-hidden />
          {message.runSummary && (
            <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums"
              title={[t('activity:message.rsIterations', { n: message.runSummary.iterations }), t('activity:message.rsTools', { n: message.runSummary.tools }), t('activity:message.rsElapsed', { s: `${(message.runSummary.durationMs / 1000).toFixed(2)}s` }), message.runSummary.costDelta > 0 ? t('activity:message.rsCost', { c: message.runSummary.costDelta.toFixed(4) }) : ''].filter(Boolean).join('  ·  ')}>
              {message.runSummary.iterations} iter{message.runSummary.tools > 0 ? ` · ${message.runSummary.tools} tool${message.runSummary.tools === 1 ? '' : 's'}` : ''} · {message.runSummary.durationMs < 60_000 ? `${(message.runSummary.durationMs / 1000).toFixed(1)}s` : `${Math.floor(message.runSummary.durationMs / 60_000)}m ${Math.floor((message.runSummary.durationMs % 60_000) / 1000)}s`}{message.runSummary.costDelta > 0 ? ` · ${message.runSummary.costDelta >= 0.01 ? message.runSummary.costDelta.toFixed(4) : message.runSummary.costDelta.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : ''}
            </span>
          )}
          {message.usage && (message.usage.input > 0 || message.usage.output > 0) && (() => {
            const u = message.usage;
            const dollars = (u.input * inputCost + u.output * outputCost + (u.cacheRead ?? 0) * cacheReadCost) / 1_000_000;
            const haveCost = inputCost > 0 || outputCost > 0;
            const dollarStr = dollars >= 0.01 ? `${dollars.toFixed(4)}` : dollars > 0 ? `${dollars.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : '';
            return (<span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums" title={[t('activity:message.useInput', { n: u.input.toLocaleString() }), t('activity:message.useOutput', { n: u.output.toLocaleString() }), u.cacheRead ? t('activity:message.useCacheRead', { n: u.cacheRead.toLocaleString() }) : '', haveCost ? t('activity:message.useCost', { c: dollarStr }) : ''].filter(Boolean).join('  ·  ')}>
              {u.input.toLocaleString()}→{u.output.toLocaleString()}{u.cacheRead ? ` · ${u.cacheRead.toLocaleString()} ↺` : ''}{haveCost && dollarStr ? ` · ${dollarStr}` : ''}
            </span>);
          })()}
          {/* ── Actions — always visible, subtle opacity, full on hover ── */}
          {!isTool && message.content && !message.streaming && (
            <CopyButton text={message.content} label={t('common:action.copy')} className="opacity-50 hover:opacity-100 transition-opacity" />
          )}
          {message.role === 'assistant' && message.content && !message.streaming && (
            <button type="button" onClick={() => setShowRaw((v) => !v)} title={showRaw ? t('activity:message.showRenderedTitle') : t('activity:message.showRawTitle')}
              className={cn('text-xs inline-flex items-center gap-1 transition-opacity', showRaw ? 'text-primary hover:text-primary/80 opacity-100' : 'opacity-50 hover:opacity-100 text-muted-foreground hover:text-foreground')}>
              <FileCode2 className="h-3 w-3" /><span>{showRaw ? t('activity:message.renderedLabel') : t('activity:message.rawLabel')}</span>
            </button>
          )}
          {isUser && !editing && !isLoading && message.content && (
            <button type="button" onClick={startEdit} title={t('activity:message.editTitle')} className="opacity-50 hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <Pencil className="h-3 w-3" /><span>{t('activity:message.editLabel')}</span>
            </button>
          )}
          {message.role === 'assistant' && message.content && !message.streaming && (
            <button type="button" onClick={() => togglePin(message.id)} title={isPinned ? t('activity:message.unpinTitle') : t('activity:message.pinTitle')}
              className={cn('text-xs inline-flex items-center gap-1 transition-opacity', isPinned ? 'text-warning hover:text-warning/85 opacity-100' : 'opacity-50 hover:opacity-100 text-muted-foreground hover:text-foreground')}>
              {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}<span>{isPinned ? t('activity:message.pinnedLabel') : t('activity:message.pinLabel')}</span>
            </button>
          )}
          {isLatestAssistant && message.content && !message.streaming && (
            <button type="button" onClick={regenerate} title={t('activity:message.regenerateTitle')} className="opacity-50 hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <RotateCcw className="h-3 w-3" /><span>{t('activity:message.retryLabel')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
