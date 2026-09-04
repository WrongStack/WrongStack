import { getWSClient } from '@/lib/ws-client';
import { foregroundSessionId } from '@/lib/ws-client-utils';
import type { ContextEditorContentBlock } from '@/types/runtime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useContextEditorStore } from '@/stores/context-editor-store';
import { useChatStore } from '@/stores';
import { useActiveSessionId } from '@/stores/session-lanes';
import { useServerMessage } from '@/hooks/useServerMessage';
import { useSessionStore } from '@/stores/session-store';
import { useAppTranslation, i18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react';

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface MessageRowProps {
  index: number;
  role: string;
  tokens: number;
  content: ReturnType<typeof useContextEditorStore.getState>['messages'][number]['content'];
  blockCount: number | null;
  warnings: { code: string; severity: string; message: string }[];
  markedForRemoval: boolean;
  markedRanges: Array<{
    blockIndex?: number | undefined;
    start?: number | undefined;
    end?: number | undefined;
  }>;
  disabled: boolean;
  onToggle: () => void;
  onMarkRange: (blockIndex: number | undefined, start: number, end: number) => void;
}

function selectedOffsets(element: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return null;
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const end = start + range.toString().length;
  return end > start ? { start, end } : null;
}

function blockSummary(block: ContextEditorContentBlock): string {
  if (block.type === 'image') {
    return block.source?.type === 'base64'
      ? `${block.source.media_type ?? 'image'} · ${block.source.data?.length ?? 0} base64 chars`
      : 'URL image source';
  }
  if (block.type === 'tool_use') return `${block.name ?? 'tool'} · ${block.id ?? 'unknown id'}`;
  if (block.type === 'tool_result') return `tool result · ${block.tool_use_id ?? 'unknown id'}`;
  if (block.type === 'thinking') return `thinking · ${block.thinking?.length ?? 0} chars`;
  return block.type;
}

function SelectableContent({
  text,
  blockIndex,
  marked,
  disabled,
  onMarkRange,
}: {
  text: string;
  blockIndex?: number | undefined;
  marked: boolean;
  disabled: boolean;
  onMarkRange: (blockIndex: number | undefined, start: number, end: number) => void;
}): React.ReactElement {
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const contentRef = useRef<HTMLParagraphElement>(null);

  const captureSelection = useCallback(() => {
    if (disabled) return;
    const element = contentRef.current;
    if (element) setSelection(selectedOffsets(element));
  }, [disabled]);

  useEffect(() => {
    setSelection(null);
  }, [text]);

  return (
    <div
      className={cn(
        'rounded-md border bg-background p-3',
        marked && 'border-destructive/40 bg-destructive/5',
      )}
    >
      <p
        ref={contentRef}
        className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground select-text"
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        tabIndex={disabled ? -1 : 0}
      >
        {text || '(empty)'}
      </p>
      {selection && (
        <button
          type="button"
          disabled={disabled}
          className="mt-2 rounded-md border border-destructive/30 px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onMarkRange(blockIndex, selection.start, selection.end);
            window.getSelection()?.removeAllRanges();
            setSelection(null);
          }}
        >
          Mark for removal
        </button>
      )}
    </div>
  );
}

function MessageRow({
  index,
  role,
  tokens,
  content,
  blockCount,
  warnings,
  markedForRemoval,
  markedRanges,
  disabled,
  onToggle,
  onMarkRange,
}: MessageRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const roleColor =
    role === 'user'
      ? 'text-primary'
      : role === 'assistant'
        ? 'text-success'
        : 'text-muted-foreground';
  const hasWarnings = warnings.length > 0;

  return (
    <div
      className={cn(
        'group flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors',
        markedForRemoval && 'border-destructive/40 bg-destructive/5 opacity-70',
        !markedForRemoval && 'hover:border-primary/30',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className="mt-0.5 shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={markedForRemoval ? 'Undo removal' : 'Mark for removal'}
      >
        {markedForRemoval ? (
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <div className="h-3.5 w-3.5 rounded-sm border border-border/60 group-hover:border-primary/50 transition-colors" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[11px]">
          {blockCount !== null && blockCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-muted-foreground/60 hover:text-foreground shrink-0"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          )}
          <span className={cn('font-mono font-medium', roleColor)}>{role}</span>
          <span className="text-muted-foreground/60 tabular-nums">{fmtTok(tokens)} tok</span>
          {blockCount !== null && blockCount > 0 && (
            <span className="text-muted-foreground/50 tabular-nums">{blockCount} blk</span>
          )}
          {hasWarnings && <AlertTriangle className="h-3 w-3 text-warning shrink-0" />}
        </div>
        <div className="mt-3 space-y-2">
          {typeof content === 'string' ? (
            <SelectableContent
              text={content}
              marked={markedRanges.some((range) => range.blockIndex === undefined)}
              disabled={disabled}
              onMarkRange={onMarkRange}
            />
          ) : (
            content.map((block, blockIndex) => (
              <div key={`${index}-${blockIndex}`} className="space-y-1">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span className="font-mono">{block.type}</span>
                  {typeof block.text === 'string' && (
                    <span>{fmtTok(Math.ceil(block.text.length / 4))} tok</span>
                  )}
                </div>
                {block.type === 'text' && typeof block.text === 'string' ? (
                  <SelectableContent
                    text={block.text}
                    blockIndex={blockIndex}
                    marked={markedRanges.some((range) => range.blockIndex === blockIndex)}
                    disabled={disabled}
                    onMarkRange={onMarkRange}
                  />
                ) : (
                  <div className="rounded-md border bg-muted/20 p-3 font-mono text-[11px] text-muted-foreground">
                    {blockSummary(block)}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
        {expanded && hasWarnings && (
          <div className="mt-2 space-y-1">
            {warnings.map((w, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-start gap-1 text-[10px] rounded px-1.5 py-0.5',
                  w.severity === 'danger'
                    ? 'bg-destructive/10 text-destructive'
                    : w.severity === 'warning'
                      ? 'bg-warning/10 text-warning'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                <span className="font-mono">{w.code}</span>
                <span className="opacity-80">{w.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ContextWindowEditorProps {
  open: boolean;
  onClose: () => void;
}

const SNAPSHOT_TIMEOUT_MS = 5_000;

export function ContextWindowEditor({
  open,
  onClose,
}: ContextWindowEditorProps): React.ReactElement | null {
  const { t } = useAppTranslation();

  const phase = useContextEditorStore((s) => s.phase);
  const revision = useContextEditorStore((s) => s.revision);
  const messageBreakdown = useContextEditorStore((s) => s.messageBreakdown);
  const readonlyContext = useContextEditorStore((s) => s.readonlyContext);
  const messages = useContextEditorStore((s) => s.messages);
  const removeMessages = useContextEditorStore((s) => s.removeMessages);
  const removeRanges = useContextEditorStore((s) => s.removeRanges);
  const validation = useContextEditorStore((s) => s.validation);
  const appliedResult = useContextEditorStore((s) => s.appliedResult);
  const errorMessage = useContextEditorStore((s) => s.errorMessage);

  const store = useContextEditorStore;
  const isLoading = useChatStore((s) => s.isLoading);
  const contextLimitWarning = useSessionStore((s) => s.contextLimitWarning);
  // Lane pointer, not SessionInfo: a brand-new empty tab has no session record
  // until `session.start` lands, and reading that record here left the editor
  // requesting (or worse, keeping) another tab's snapshot.
  const activeSessionId = useActiveSessionId();

  // Subscribe FIRST, then ask. Empty sessions answer in the same tick as the
  // send (no transcript to walk), so a listener registered in a later effect
  // misses the snapshot and the overlay stays on "Loading context snapshot…".
  //
  // Re-runs when the tab in front changes, because the OVERLAY is one surface
  // shared by every tab. What is no longer shared is the state behind it: the
  // store is session-scoped, so each tab keeps its own snapshot, its own
  // pending removals and its own validation result.
  //
  // That is why this no longer calls `open()` unconditionally. It used to, and
  // with one global store that meant switching tabs while the editor was open
  // silently discarded whatever the outgoing tab had selected for removal —
  // the user came back to a re-fetched, empty selection with no warning. A
  // lane that already holds a snapshot is left exactly as the user left it and
  // only re-subscribes; a lane that has nothing (or failed) asks for one.
  //
  // B-03: subscription now goes through `useServerMessage`, which embeds the
  // sessionId lane filter and cleans up on unmount automatically. Three ad-hoc
  // `ws.on` calls + a manual cleanup block collapsed into three hook calls.
  //
  // askedFor precedence matches the OLD inline path:
  //   1. `ws.withSession({}).sessionId` — the WS client's own stamp for the
  //      lane whose socket originated the request (the most authoritative
  //      source in production; the chat-lane pointer drifts in boot/empty
  //      tabs);
  //   2. `useActiveSessionId()` — the lane pointer fallback;
  //   3. `foregroundSessionId()` — same lane, read off the legacy store.
  // The OLD code evaluated #1 inside the effect where it always had a fresh
  // ws.withSession result. We must call it here too — taking a different
  // shortcut broke a test that only stubs the chat-lanes store.
  const askedFor =
    getWSClient()?.withSession?.({})?.sessionId ??
    activeSessionId ??
    foregroundSessionId() ??
    undefined;

  useServerMessage(
    'context.editor.snapshot',
    (msg) => {
      const p = msg.payload;
      if (!p || typeof (p as { revision?: unknown }).revision !== 'string') return;
      if (!Array.isArray((p as { messages?: unknown }).messages)) return;
      store.getState().loadSnapshot(
        p as Parameters<ReturnType<typeof store.getState>['loadSnapshot']>[0],
      );
    },
    { sessionId: askedFor, deps: [open, store, askedFor] },
  );

  useServerMessage(
    'context.editor.validation',
    (msg) => {
      store.getState().setValidation(
        msg.payload as Parameters<ReturnType<typeof store.getState>['setValidation']>[0],
      );
    },
    { sessionId: askedFor, deps: [open, store, askedFor] },
  );

  useServerMessage(
    'context.editor.applied',
    (msg) => {
      store.getState().setApplied(
        msg.payload as Parameters<ReturnType<typeof store.getState>['setApplied']>[0],
      );
      const ws = getWSClient();
      if (typeof ws?.openContextEditor === 'function') ws.openContextEditor();
    },
    { sessionId: askedFor, deps: [open, store, askedFor] },
  );

  useEffect(() => {
    if (!open) {
      store.getState().close();
      return;
    }
    const needsSnapshot =
      store.getState().phase === 'closed' || store.getState().phase === 'apply_failed';
    if (needsSnapshot) store.getState().open();
    const ws = getWSClient();
    if (!ws?.send || !ws?.on) {
      store.getState().setError(i18n.t('activity:context.wsNotConnected'));
      return;
    }

    const request = () => {
      ws.send({ type: 'context.editor.open', payload: ws.withSession({}) });
    };
    request();

    const timeout = setTimeout(() => {
      if (store.getState().phase === 'loading_snapshot') {
        store.getState().setError(i18n.t('activity:ctxEditor.snapshotTimedOut'));
      }
    }, SNAPSHOT_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [open, store, askedFor]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'applying' && phase !== 'validating') {
        if ((removeMessages.size > 0 || removeRanges.length > 0) && phase === 'dirty') return;
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, phase, removeMessages.size, removeRanges.length]);

  const handleValidate = useCallback(() => {
    const ws = getWSClient();
    if (!ws?.send || !revision) return;
    store.getState().beginValidation();
    const state = store.getState();
    const proposed = state.getProposedMessages();
    const removals = [
      ...[...state.removeMessages].map((messageIndex) => ({ messageIndex })),
      ...state.removeRanges,
    ];
    ws.validateContextEditor(revision, proposed, removals, true);
  }, [revision, store]);

  const handleApply = useCallback(() => {
    const ws = getWSClient();
    if (!ws?.send || !revision) return;
    const state = store.getState();
    const proposed = state.getProposedMessages();
    const removals = [
      ...[...state.removeMessages].map((messageIndex) => ({ messageIndex })),
      ...state.removeRanges,
    ];
    store.getState().beginApply();
    ws.applyContextEditor(revision, proposed, removals, true);
  }, [revision, store]);

  if (!open) return null;

  const isBusy = phase === 'applying' || phase === 'validating';
  const hasRemovals = removeMessages.size > 0 || removeRanges.length > 0;
  const canApply = phase === 'validated' && !isLoading;
  const canValidate = hasRemovals && !isBusy && !isLoading;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('activity:ctxEditor.contextWindowEditor')}
        className="m-6 flex max-h-[calc(100dvh-3rem)] w-full max-w-4xl flex-col overflow-hidden rounded-lg border bg-card shadow-sm"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">{t('activity:ctxEditor.contextWindowEditor')}</h3>
            {revision && (
              <span className="text-[10px] font-mono text-muted-foreground/60 ml-2">
                rev {revision.slice(0, 8)}…
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="p-1.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40"
            aria-label={t('common:action.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {contextLimitWarning && (
          <div
            role="status"
            className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {t('activity:ctxEditor.providerLimitDecreased', {
                previous: fmtTok(contextLimitWarning.previousMaxContext),
                current: fmtTok(contextLimitWarning.maxContext),
              })}
            </span>
          </div>
        )}

        {/* Read-only context summary */}
        {readonlyContext && (
          <div className="grid grid-cols-4 gap-2 px-4 py-2 border-b bg-muted/20 text-[11px] shrink-0">
            <div className="flex flex-col">
              <span className="text-muted-foreground/60">{t('activity:ctxEditor.system')}</span>
              <span className="font-mono font-medium">
                {fmtTok(readonlyContext.systemPromptTokens)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground/60">Tools ({readonlyContext.toolCount})</span>
              <span className="font-mono font-medium">
                {fmtTok(readonlyContext.toolSchemaTokens)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground/60">{t('activity:ctxEditor.messages')}</span>
              <span className="font-mono font-medium">{fmtTok(readonlyContext.messageTokens)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground/60">{t('activity:ctxEditor.total')}</span>
              <span className="font-mono font-medium text-primary">
                {fmtTok(readonlyContext.totalTokens)}
              </span>
            </div>
          </div>
        )}

        {/* Loading */}
        {phase === 'loading_snapshot' && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-12">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('activity:ctxEditor.loadingContextSnapshot')}
          </div>
        )}

        {/* Empty conversation — still a valid snapshot (system prompt + tools). */}
        {phase !== 'loading_snapshot' && messageBreakdown.length === 0 && !errorMessage && (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground">
            <FileText className="h-5 w-5 text-muted-foreground/60" />
            <p>{t('activity:ctxEditor.emptyConversation')}</p>
          </div>
        )}

        {/* Error */}
        {errorMessage && phase === 'apply_failed' && (
          <div className="m-4 rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
            {errorMessage}
          </div>
        )}

        {/* Applied success */}
        {phase === 'applied_success' && appliedResult && (
          <div className="m-4 rounded-md bg-success/10 border border-success/20 p-3 text-sm">
            <div className="flex items-center gap-2 text-success font-medium">
              <CheckCircle2 className="h-4 w-4" />
              Context updated: {appliedResult.before.messages} → {appliedResult.after.messages}{' '}
              messages
            </div>
            <div className="mt-1 text-muted-foreground text-xs">
              Saved{' '}
              {fmtTok(
                appliedResult.before.fullRequestTokens - appliedResult.after.fullRequestTokens,
              )}{' '}
              tokens
              {appliedResult.removed.toolUses.length > 0 &&
                ` · ${appliedResult.removed.toolUses.length} tool calls repaired`}
            </div>
          </div>
        )}

        {/* Conflict */}
        {validation?.conflict && (
          <div className="m-4 rounded-md bg-warning/10 border border-warning/20 p-3 text-sm text-warning">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              {validation.conflict.code === 'CONTEXT_REVISION_CONFLICT'
                ? 'Context changed while editor was open.'
                : 'Agent is currently running.'}
            </div>
            <p className="mt-1 text-xs opacity-80">{validation.conflict.message}</p>
          </div>
        )}

        {/* Message list */}
        {phase !== 'loading_snapshot' && messageBreakdown.length > 0 && (
          <div className="flex-1 min-h-0 space-y-3 overflow-y-auto overscroll-contain bg-muted/10 p-4">
            {messageBreakdown.map((entry) => (
              <MessageRow
                key={entry.index}
                index={entry.index}
                role={entry.role}
                tokens={entry.tokens}
                content={messages[entry.index]?.content ?? ''}
                blockCount={entry.blockCount}
                warnings={entry.warnings}
                markedForRemoval={removeMessages.has(entry.index)}
                markedRanges={removeRanges.filter((range) => range.messageIndex === entry.index)}
                disabled={isBusy}
                onToggle={() => store.getState().toggleRemoveMessage(entry.index)}
                onMarkRange={(blockIndex, start, end) =>
                  store.getState().markRangeForRemoval({
                    messageIndex: entry.index,
                    ...(blockIndex === undefined ? {} : { blockIndex }),
                    start,
                    end,
                  })
                }
              />
            ))}
          </div>
        )}

        {/* Validation preview */}
        {validation?.ok === false && validation.validationErrors.length > 0 && (
          <div className="border-t px-4 py-2 bg-destructive/5 shrink-0">
            <div className="text-[11px] font-medium text-destructive mb-1">
              Validation errors ({validation.validationErrors.length})
            </div>
            {validation.validationErrors.slice(0, 5).map((e, i) => (
              <div key={i} className="text-[10px] text-destructive/80 font-mono">
                {e.path}: {e.message}
              </div>
            ))}
          </div>
        )}

        {validation?.ok && validation.repair.changed && (
          <div className="border-t px-4 py-2 bg-warning/5 shrink-0">
            <div className="flex items-center gap-1.5 text-[11px] text-warning">
              <Zap className="h-3 w-3" />
              <span>{t('activity:ctxEditor.repairPreviewWillRemove')}</span>
              {validation.repair.removedToolUses.length > 0 && (
                <span>{validation.repair.removedToolUses.length} orphan tool_use(s)</span>
              )}
              {validation.repair.removedToolResults.length > 0 && (
                <span>{validation.repair.removedToolResults.length} orphan tool_result(s)</span>
              )}
              {validation.repair.removedMessages > 0 && (
                <span>{validation.repair.removedMessages} empty message(s)</span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 border-t px-4 py-3 shrink-0">
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {hasRemovals && (
              <>
                <Trash2 className="h-3 w-3 text-destructive" />
                <span>
                  {removeMessages.size} message{removeMessages.size === 1 ? '' : 's'} and{' '}
                  {removeRanges.length} range{removeRanges.length === 1 ? '' : 's'} marked
                </span>
              </>
            )}
            {isLoading && (
              <span className="flex items-center gap-1 text-warning">
                <Clock className="h-3 w-3" />
                {t('activity:ctxEditor.agentRunningApplyDisabled')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasRemovals && (
              <button
                type="button"
                onClick={() => store.getState().clearRemovals()}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                disabled={isBusy}
              >
                {t('activity:ctxEditor.clear')}
              </button>
            )}
            <button
              type="button"
              onClick={handleValidate}
              disabled={!canValidate}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
                canValidate
                  ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
            >
              {phase === 'validating' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <FileText className="h-3 w-3" />
              )}
              Validate
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!canApply}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
                canApply
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
            >
              {phase === 'applying' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              Apply Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
