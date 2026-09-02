import { ChevronDown, ChevronRight, Clock, Download, Loader2 } from 'lucide-react';
import { memo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { getToolTooltip, getToolVisual } from '@/lib/tool-icon';
import { summarizeToolInput } from '@/lib/tool-summary';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores';
import { diffFromToolInput, ToolDiffView } from '../DiffView';
import { ToolResult } from '../ToolResult';
import { CopyButton } from './CopyButton.js';
import { ToolInputView } from './ToolInputView.js';
import './ledger.css';
import {
  downloadTextFile,
  extractExitCode,
  fileExtensionFor,
  formatToolDuration,
} from './utils.js';

type Status = 'running' | 'error' | 'ok';

function statusOf(message: ChatMessage): Status {
  if (message.toolResult === undefined) return 'running';
  return message.isError ? 'error' : 'ok';
}

/** Tailwind text-color for the status dot / accents, per status. */
const DOT_COLOR: Record<Status, string> = {
  running: 'text-warning',
  error: 'text-destructive',
  ok: 'text-success',
};

/**
 * A single tool call rendered as a Terminal Ledger card: a colored status rail,
 * a monospace header row (dot · icon · name · summary · meta · exit code), a
 * line-numbered console body (via {@link ToolResult}), and a hairline action
 * footer. Sharp corners by design — the identity is the rail + hairline, not
 * rounding. Replaces the old two-part "chevron button + gray box" layout.
 */
export const ToolLedgerCard = memo(function ToolLedgerCard({ message }: { message: ChatMessage }) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const status = statusOf(message);
  // ToolLedgerCard only renders for tool messages, which always carry a name;
  // fall back to '' so the icon/summary helpers (which want a plain string)
  // stay happy on the rare untyped tool event.
  const toolName = message.toolName ?? '';
  const { Icon: ToolIcon, color: toolColor } = getToolVisual(toolName);
  const tooltip = getToolTooltip(toolName);

  const inputSummary =
    message.toolInput !== undefined ? summarizeToolInput(toolName, message.toolInput) : '';
  const resultLines = message.toolResult ? message.toolResult.split('\n').length : 0;
  const exitCode = extractExitCode(message.toolResult);
  const hasBody =
    (message.toolResult !== undefined && message.toolResult.length > 0) ||
    (message.toolInput !== undefined &&
      Object.keys((message.toolInput as object) ?? {}).length > 0);
  const diff = expanded ? diffFromToolInput(toolName, message.toolInput) : null;

  return (
    <div
      className={cn(
        'ws-ledger min-w-0 max-w-full overflow-hidden border border-l-2 border-border/50',
        status === 'ok' && 'ws-ledger--ok',
        status === 'error' && 'ws-ledger--error',
        status === 'running' && 'ws-ledger--running',
      )}
    >
      {/* ── Header row (whole row toggles) ─────────────────────────────── */}
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={tooltip}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs select-none',
          hasBody ? 'cursor-pointer hover:bg-muted/40' : 'cursor-default',
          'transition-colors',
        )}
      >
        <span
          className={cn(
            'ws-ledger__dot',
            DOT_COLOR[status],
            status === 'running' && 'ws-ledger__dot--running',
          )}
        />
        <ToolIcon className="h-3.5 w-3.5 shrink-0" style={{ color: toolColor }} />
        <span className="font-semibold tracking-tight" style={{ color: toolColor }}>
          {message.toolName}
        </span>

        {inputSummary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{inputSummary}</span>
        )}
        {!inputSummary && <span className="flex-1" />}

        {/* Meta cluster — right aligned, tabular so it doesn't jitter. */}
        <span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground/75">
          {resultLines > 0 && !expanded && (
            <span className="text-[10px]">
              {t('activity:message.linesSuffix', { count: resultLines })}
            </span>
          )}
          {exitCode !== undefined && (
            <span
              className={cn(
                'px-1 text-[10px] font-semibold',
                exitCode === 0 ? 'text-success/90' : 'text-destructive',
              )}
            >
              exit {exitCode}
            </span>
          )}
          {typeof message.toolDurationMs === 'number' && (
            <span className="text-[10px]">{formatToolDuration(message.toolDurationMs)}</span>
          )}
          {status === 'running' ? (
            <Loader2 className="h-3 w-3 animate-spin text-warning" />
          ) : hasBody ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : null}
        </span>
      </button>

      {/* ── Live progress lines (while running) ────────────────────────── */}
      {message.toolResult === undefined &&
        message.progressLines &&
        message.progressLines.length > 0 && (
          <div className="border-t border-border/40 bg-warning/[0.04] px-2.5 py-1.5 font-mono text-[11px] leading-snug">
            {(() => {
              const seen = new Map<string, number>();
              return message.progressLines.slice(-6).map((line) => {
                const occurrence = seen.get(line) ?? 0;
                seen.set(line, occurrence + 1);
                return (
                  <div key={`${line}-${occurrence}`} className="truncate text-muted-foreground">
                    {line}
                  </div>
                );
              });
            })()}
          </div>
        )}

      {/* ── Collapsed error peek — surface the first line without a click. ─ */}
      {!expanded && status === 'error' && message.toolResult && (
        <div className="truncate border-t border-destructive/20 px-2.5 py-1 font-mono text-[11px] text-destructive/90">
          {message.toolResult.split('\n')[0]}
        </div>
      )}

      {/* ── Expanded body ──────────────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-border/40">
          {message.toolInput !== undefined &&
            (diff ? (
              <div className="p-2">
                <ToolDiffView diff={diff} />
              </div>
            ) : (
              <div className="overflow-x-auto bg-muted/30 p-2.5">
                <div className="mb-1.5 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  <Clock className="h-3 w-3" />
                  <span>{t('activity:message.inputLabel')}</span>
                </div>
                <ToolInputView input={message.toolInput} />
              </div>
            ))}

          {message.toolResult !== undefined && message.toolResult.length > 0 && (
            <div className="p-2">
              <ToolResult
                toolName={message.toolName}
                result={message.toolResult}
                isError={message.isError}
                sageLines={message.sageLines}
              />
            </div>
          )}

          {message.toolResult !== undefined && message.toolResult.length === 0 && (
            <div className="px-2.5 py-1.5 font-mono text-[11px] italic text-muted-foreground">
              {t('activity:message.empty')}
            </div>
          )}
        </div>
      )}

      {/* ── Action footer — hairline rail, right-aligned, appears on hover ─ */}
      {expanded && message.toolResult !== undefined && message.toolResult.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border/40 px-2.5 py-1">
          <span className="h-px flex-1 bg-border/30" aria-hidden />
          <CopyButton
            text={message.toolResult}
            label={t('common:action.copy')}
            className="text-[10px] text-muted-foreground/70 hover:text-foreground"
          />
          {message.toolResult.split('\n').length > 5 && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                const ext = fileExtensionFor(message.toolName);
                const base = (message.toolName ?? 'output')
                  .replace(/[^a-z0-9_-]+/gi, '-')
                  .toLowerCase();
                downloadTextFile(
                  `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`,
                  message.toolResult ?? '',
                );
              }}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
              title={t('activity:message.downloadTitle')}
            >
              <Download className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});
