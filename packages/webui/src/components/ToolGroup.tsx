import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Terminal, XCircle } from 'lucide-react';
import { memo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { toolDisplayName } from '@/lib/tool-summary';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores';
import { MessageBubble } from './MessageBubble';

interface ToolGroupProps {
  /** A run of consecutive tool messages (>=1). Rendered as one chip while
   *  collapsed, expanded into the usual MessageBubble list on click. */
  tools: ChatMessage[];
  /** Force-expand the latest group so newly-running tools are visible by
   *  default (otherwise users see "5 tool calls" pop in and have to click to
   *  understand what's running). Older groups stay collapsed. */
  defaultOpen?: boolean | undefined;
  /** Render as a continuation of the previous item in the same agent turn —
   *  hides the avatar column (replaced with a transparent spacer) and the
   *  group's chrome stitches into the same flow as the surrounding text /
   *  tool items instead of standing alone. */
  isContinuation?: boolean | undefined;
  /** Observation-only rendering (the subagent tabs) — see MessageBubble. */
  readOnly?: boolean | undefined;
}

type ToolGroupFilter = 'all' | 'failed' | 'running';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) {
    const secs = (ms / 1000).toFixed(ms < 10_000 ? 2 : 1);
    // 59.95s rounds to "60.0": past the unit, so it reads as the next minute.
    return Number(secs) < 60 ? `${secs}s` : '1m0s';
  }
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function formatDataSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export const ToolGroup = memo(function ToolGroup({
  tools,
  defaultOpen = false,
  isContinuation = false,
  readOnly = false,
}: ToolGroupProps) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState<ToolGroupFilter>('all');

  // Single tool? Render as a normal bubble — grouping overhead is just noise.
  if (tools.length === 1) {
    return (
      <MessageBubble
        message={expectDefined(tools[0])}
        isFirst
        isContinuation={isContinuation}
        readOnly={readOnly}
      />
    );
  }

  const running = tools.filter((t) => t.toolResult === undefined).length;
  const errored = tools.filter((t) => t.isError).length;
  const succeeded = tools.length - running - errored;
  const totalMs = tools.reduce((acc, t) => acc + (t.toolDurationMs ?? 0), 0);
  const totalOutputBytes = tools.reduce((acc, t) => acc + (t.toolOutputBytes ?? 0), 0);
  const filteredTools = tools.filter((tool) => {
    if (filter === 'failed') return !!tool.isError;
    if (filter === 'running') return tool.toolResult === undefined;
    return true;
  });

  // Show the first few tool names so the user has a hint of what's inside
  // without expanding ("Read, Grep, Bash …").
  const names = Array.from(
    new Set(tools.filter((t) => t.toolName).map((t) => toolDisplayName(t.toolName!, t.toolInput))),
  );
  const preview = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` +${names.length - 3}` : '';

  return (
    <div className="flex gap-3 animate-message">
      {isContinuation ? (
        <div className="flex-shrink-0 w-8 h-8" aria-hidden />
      ) : (
        <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-secondary text-secondary-foreground ring-2 ring-offset-2 ring-offset-background ring-secondary/20">
          <Terminal className="h-4 w-4" />
        </div>
      )}

      <div className="flex flex-col gap-1.5 max-w-[85%] flex-1 min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex flex-wrap items-center gap-2 text-sm font-medium cursor-pointer select-none',
            'hover:bg-muted/50 rounded-lg px-2 py-1.5 -mx-2 transition-colors',
            'border border-border/40 bg-muted/30',
          )}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-xs">
            {t('activity:toolGroup.toolCalls', { count: tools.length })}
          </span>
          {running > 0 ? (
            <Loader2 className="h-3 w-3 animate-spin text-warning" />
          ) : errored > 0 ? (
            <XCircle className="h-3 w-3 text-destructive" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-success" />
          )}
          {succeeded > 0 && (
            <span className="rounded border border-success/30 bg-success/[0.06] px-1 py-0.5 font-mono text-[10px] font-medium text-success">
              {t('activity:toolGroup.succeeded', {
                count: succeeded,
                defaultValue: '{{count}} succeeded',
              })}
            </span>
          )}
          {errored > 0 && (
            <span className="rounded border border-destructive/30 bg-destructive/[0.06] px-1 py-0.5 font-mono text-[10px] font-medium text-destructive">
              {t('activity:toolGroup.failed', { count: errored, defaultValue: '{{count}} failed' })}
            </span>
          )}
          {running > 0 && (
            <span className="rounded border border-warning/30 bg-warning/[0.06] px-1 py-0.5 font-mono text-[10px] font-medium text-warning">
              {t('activity:toolGroup.running', {
                count: running,
                defaultValue: '{{count}} running',
              })}
            </span>
          )}
          {totalMs > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums font-normal">
              {formatDuration(totalMs)}
            </span>
          )}
          {totalOutputBytes > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums font-normal">
              {formatDataSize(totalOutputBytes)}
            </span>
          )}
          {preview && (
            <span className="text-xs text-muted-foreground/80 font-mono truncate">
              · {preview}
              {more}
            </span>
          )}
        </button>

        {open && (
          <div className="space-y-2 pl-3 border-l-2 border-border/40 ml-2 tool-details">
            {(errored > 0 || running > 0) && (
              <div
                aria-label={t('activity:toolGroup.filterLabel', 'Filter tool calls')}
                className="flex flex-wrap items-center gap-1 border-b border-border/30 pb-2"
                role="toolbar"
              >
                {(
                  [
                    ['all', tools.length, 'filterAll', 'All ({{count}})'],
                    ['failed', errored, 'filterFailed', 'Failed ({{count}})'],
                    ['running', running, 'filterRunning', 'Running ({{count}})'],
                  ] as const
                )
                  .filter(([, count]) => count > 0)
                  .map(([nextFilter, count, key, defaultValue]) => (
                    <button
                      aria-pressed={filter === nextFilter}
                      className={cn(
                        'rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors',
                        filter === nextFilter
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border/50 bg-background/50 text-muted-foreground hover:text-foreground',
                      )}
                      key={nextFilter}
                      onClick={() => setFilter(nextFilter)}
                      type="button"
                    >
                      {t(`activity:toolGroup.${key}`, { count, defaultValue })}
                    </button>
                  ))}
              </div>
            )}
            {filteredTools.length > 0 ? (
              filteredTools.map((tool) => (
                <MessageBubble key={tool.id} message={tool} isFirst={false} readOnly={readOnly} />
              ))
            ) : (
              <p className="font-mono text-[11px] italic text-muted-foreground">
                {t('activity:toolGroup.noMatchingCalls', 'No matching tool calls')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
