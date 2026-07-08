import { type DiffRow, type ToolDiff, computeLineDiff, parseUnifiedDiff } from '@wrongstack/tools/tool-diff';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { memo, useMemo } from 'react';

// The diff MODEL (line-diff algorithm, unified-diff parser, and tool-input
// extraction) is the single source of truth in @wrongstack/tools/tool-diff,
// shared with the HQ dashboard. This module owns only the React RENDERING.
export { diffFromToolInput } from '@wrongstack/tools/tool-diff';

interface DiffViewProps {
  oldText: string;
  newText: string;
  /** Optional caption shown above the diff (file path, "write" vs "edit", etc.) */
  caption?: string | undefined;
  /**
   * When true, the diff body fills its container's height instead of the
   * compact `max-h-96` chat preview. Used by the full-pane Changes view.
   */
  fill?: boolean | undefined;
}

/**
 * Line-based diff renderer. Delegates the actual line diff to the shared
 * `computeLineDiff` (LCS) in @wrongstack/tools, then renders add/del/context
 * rows. Context lines are de-emphasised so the eye lands on the changes.
 *
 * Limits: text > 5000 lines is shown without a diff (just a "too large" note);
 * that's a UI guard, not a hard limit on the underlying tool.
 */
export const DiffView = memo(function DiffView({ oldText, newText, caption, fill }: DiffViewProps) {
  const rows = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText]);
  return <DiffRows rows={rows} caption={caption} fill={fill} />;
});

/**
 * Render an already-extracted {@link ToolDiff}. `lcs` mode runs the line diff;
 * `unified` mode parses the tool's own patch hunks. Both share the same row
 * rendering, so edit/write and patch look consistent. Returns the same "too
 * large" guard as {@link DiffView} for oversized LCS inputs.
 */
export const ToolDiffView = memo(function ToolDiffView({ diff, fill }: { diff: ToolDiff; fill?: boolean }) {
  const rows = useMemo(
    () => (diff.mode === 'unified' ? parseUnifiedDiff(diff.patchText) : computeLineDiff(diff.oldText, diff.newText)),
    [diff],
  );
  return <DiffRows rows={rows} caption={diff.caption} fill={fill} />;
});

/** Shared row renderer for both DiffView (lcs) and ToolDiffView (lcs|unified). */
const DiffRows = memo(function DiffRows({
  rows,
  caption,
  fill,
}: {
  rows: DiffRow[] | null;
  caption?: string | undefined;
  fill?: boolean | undefined;
}) {
  const { t } = useAppTranslation();

  if (rows === null) {
    return (
      <div className="text-xs text-muted-foreground italic px-3 py-2">{t('activity:diff.tooLarge')}</div>
    );
  }

  const adds = rows.filter((r) => r.kind === 'add').length;
  const dels = rows.filter((r) => r.kind === 'del').length;

  return (
    <div
      className={cn(
        'rounded-lg border bg-background/40 overflow-hidden text-xs',
        fill && 'flex h-full min-h-0 flex-col',
      )}
    >
      {(caption || adds > 0 || dels > 0) && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/40 font-mono text-[11px]">
          {caption && <span className="text-muted-foreground truncate">{caption}</span>}
          <span className="ml-auto flex items-center gap-2">
            {adds > 0 && <span className="text-emerald-500">+{adds}</span>}
            {dels > 0 && <span className="text-red-500">-{dels}</span>}
          </span>
        </div>
      )}
      <div className={cn('overflow-auto font-mono leading-relaxed', fill ? 'flex-1 min-h-0' : 'max-h-96')}>
        {rows.map((r, idx) => (
          <div
            key={idx}
            className={cn(
              'flex items-start',
              r.kind === 'add' && 'bg-emerald-500/10',
              r.kind === 'del' && 'bg-red-500/10',
              r.kind === 'meta' && 'bg-muted/60',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'select-none w-4 shrink-0 text-center',
                r.kind === 'add' && 'text-emerald-500',
                r.kind === 'del' && 'text-red-500',
                (r.kind === 'ctx' || r.kind === 'meta') && 'text-muted-foreground/50',
              )}
            >
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : r.kind === 'meta' ? '@' : ' '}
            </span>
            <pre
              className={cn(
                'whitespace-pre-wrap break-all flex-1 px-2',
                (r.kind === 'ctx' || r.kind === 'meta') && 'text-muted-foreground/70',
              )}
            >
              {r.text || ' '}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
});
