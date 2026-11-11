import { ChevronDown, ChevronRight, Clock, Download } from 'lucide-react';
import { memo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { getToolTooltip, getToolVisual } from '@/lib/tool-icon';
import { summarizeToolInput, toolDisplayName, toolFlowMetricsLabel } from '@/lib/tool-summary';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores';
import { ActivitySignal } from '../ActivitySignal';
import { diffFromToolInput, ToolDiffView } from '../DiffView';
import { ToolResult } from '../ToolResult';
import { BrowserOriginApproval, browserBlockedOrigin } from './BrowserOriginApproval.js';
import { CopyButton } from './CopyButton.js';
import { DesignReferenceCard } from './DesignReferenceCard.js';
import { GeneratedImagePreview } from './GeneratedImagePreview.js';
import { ToolCallOverview } from './ToolCallOverview.js';
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

function formatOutputBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
 * footer. State is echoed by a small animated vector; the rail stays readable
 * even when motion is reduced.
 */
export const ToolLedgerCard = memo(function ToolLedgerCard({
  message,
  readOnly = false,
}: {
  message: ChatMessage;
  readOnly?: boolean | undefined;
}) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const status = statusOf(message);
  const statusLabel =
    status === 'running'
      ? t('activity:message.toolRunning', 'Running')
      : status === 'error'
        ? t('activity:message.toolFailed', 'Failed')
        : t('activity:message.toolSucceeded', 'Succeeded');
  // ToolLedgerCard only renders for tool messages, which always carry a name;
  // fall back to '' so the icon/summary helpers (which want a plain string)
  // stay happy on the rare untyped tool event.
  const toolName = message.toolName ?? '';
  const blockedOrigin = browserBlockedOrigin(toolName, message.toolResult, message.isError);
  const { Icon: ToolIcon, color: toolColor } = getToolVisual(toolName);
  const tooltip = getToolTooltip(toolName);

  const inputSummary =
    message.toolInput !== undefined ? summarizeToolInput(toolName, message.toolInput) : '';
  const resultLines =
    message.toolOutputLines ?? (message.toolResult ? message.toolResult.split('\n').length : 0);
  const exitCode = extractExitCode(message.toolResult);
  const hasBody =
    (message.toolResult !== undefined && message.toolResult.length > 0) ||
    (message.toolInput !== undefined &&
      Object.keys((message.toolInput as object) ?? {}).length > 0);
  const diff = expanded ? diffFromToolInput(toolName, message.toolInput) : null;

  return (
    <div
      data-tool-state={status}
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
          'ws-tool-disclosure flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs select-none',
          hasBody ? 'cursor-pointer hover:bg-muted/40' : 'cursor-default',
          'transition-colors',
        )}
      >
        <ActivitySignal
          state={status === 'ok' ? 'success' : status}
          className={DOT_COLOR[status]}
        />
        <ToolIcon className="h-3.5 w-3.5 shrink-0" style={{ color: toolColor }} />
        <span className="font-semibold tracking-tight text-foreground">
          {toolDisplayName(toolName, message.toolInput)}
        </span>
        <span
          className={cn(
            'shrink-0 text-[10px] font-semibold uppercase tracking-wide',
            status === 'running'
              ? 'text-foreground'
              : status === 'error'
                ? 'text-destructive'
                : 'text-success',
          )}
        >
          {statusLabel}
        </span>

        {inputSummary && (
          <span className="ws-tool-summary min-w-0 basis-full order-2 truncate text-muted-foreground/80 sm:order-none sm:flex-1">
            {inputSummary}
          </span>
        )}
        {!inputSummary && <span className="flex-1" />}

        {/* Meta cluster — right aligned, tabular so it doesn't jitter. */}
        <span className="ws-tool-meta flex max-w-full shrink-0 items-center gap-2 tabular-nums text-muted-foreground/75">
          {resultLines > 0 && !expanded && (
            <span className="text-[10px]">
              {t('activity:message.linesSuffix', { count: resultLines })}
            </span>
          )}
          {message.toolOutputBytes !== undefined && (
            <span className="text-[10px]">{formatOutputBytes(message.toolOutputBytes)}</span>
          )}
          {message.toolOutputTokens !== undefined && message.toolOutputTokens > 0 && (
            <span className="text-[10px]">~{message.toolOutputTokens.toLocaleString()} tok</span>
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
          {hasBody ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : null}
        </span>
      </button>

      {toolFlowMetricsLabel(message.toolResult) && (
        <p
          className="border-t border-border/40 px-2.5 py-1.5 font-mono text-[11px]"
          role="status"
          aria-label={t('activity:toolOverview.toolFlowMeasuredOutput')}
        >
          {toolFlowMetricsLabel(message.toolResult)}
        </p>
      )}

      {/* ── What image_generate drew, visible without opening the card. ─── */}
      {status === 'ok' && toolName === 'image_generate' && (
        <GeneratedImagePreview result={message.toolResult} messageId={message.id} />
      )}

      {/* ── Design DNA & DESIGN.md 4-stage pipeline stepper + artifact links ── */}
      {toolName === 'design_reference' && (
        <DesignReferenceCard
          status={status}
          input={message.toolInput}
          result={message.toolResult}
          progressLines={message.progressLines}
        />
      )}

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

      {blockedOrigin && !readOnly && <BrowserOriginApproval origin={blockedOrigin} />}

      {/* ── Expanded body ──────────────────────────────────────────────── */}
      {expanded && (
        <div className="ws-tool-body border-t border-border/40">
          <ToolCallOverview message={message} />
          <details className="group/details" open>
            <summary className="cursor-pointer select-none border-b border-border/30 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75 hover:bg-muted/30">
              {t('activity:message.details', 'Details')}
            </summary>
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
          </details>
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
