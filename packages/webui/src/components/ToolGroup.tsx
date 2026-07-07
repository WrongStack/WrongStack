import { expectDefined } from '@wrongstack/core';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import type { ChatMessage } from '@/stores';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Terminal, XCircle } from 'lucide-react';
import { memo, useState } from 'react';
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
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export const ToolGroup = memo(function ToolGroup({
  tools,
  defaultOpen = false,
  isContinuation = false,
}: ToolGroupProps) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(defaultOpen);

  // Single tool? Render as a normal bubble — grouping overhead is just noise.
  if (tools.length === 1) {
    return <MessageBubble message={expectDefined(tools[0])} isFirst isContinuation={isContinuation} />;
  }

  const running = tools.filter((t) => t.toolResult === undefined).length;
  const errored = tools.filter((t) => t.isError).length;
  const totalMs = tools.reduce((acc, t) => acc + (t.toolDurationMs ?? 0), 0);

  // Show the first few tool names so the user has a hint of what's inside
  // without expanding ("Read, Grep, Bash …").
  const names = Array.from(new Set(tools.map((t) => t.toolName).filter(Boolean) as string[]));
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
            'flex items-center gap-2 text-sm font-medium cursor-pointer select-none',
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
          {totalMs > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums font-normal">
              {formatDuration(totalMs)}
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
            {tools.map((tool) => (
              <MessageBubble key={tool.id} message={tool} isFirst={false} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
