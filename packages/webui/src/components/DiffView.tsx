import { expectDefined } from '@wrongstack/core';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { memo, useMemo } from 'react';
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
 * Tiny line-based diff renderer. Computes the longest-common-subsequence
 * between `oldText` and `newText` line arrays, then walks both sides
 * emitting `add`/`remove`/`context` rows. Context lines are de-emphasised
 * so the eye lands on the changes. Not as pretty as a Myers diff but it's
 * one short function with no deps and good enough for a chat preview.
 *
 * Limits: text > 5000 lines is shown without a diff (just a "too large"
 * note); that's a UI guard, not a hard limit on the underlying tool.
 */
export const DiffView = memo(function DiffView({ oldText, newText, caption, fill }: DiffViewProps) {
  const { t } = useAppTranslation();
  const rows = useMemo(() => computeDiff(oldText, newText), [oldText, newText]);

  if (rows === null) {
    return (
      <div className="text-xs text-muted-foreground italic px-3 py-2">
        {t('activity:diff.tooLarge')}
      </div>
    );
  }

  const adds = rows.filter((r) => r.kind === 'add').length;
  const dels = rows.filter((r) => r.kind === 'del').length;

  return (
    <div
      className={cn(
        'rounded-lg border bg-background/40 overflow-hidden text-xs',
        fill && 'flex h-full min-h-0 min-w-0 flex-col',
      )}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/40 shrink-0">
        <span className="font-mono text-muted-foreground truncate">{caption ?? 'diff'}</span>
        <span className="font-mono shrink-0">
          <span className="text-success">+{adds}</span>
          <span className="text-muted-foreground mx-1 opacity-50">·</span>
          <span className="text-destructive">-{dels}</span>
        </span>
      </div>
      <div
        className={cn('font-mono leading-relaxed overflow-auto', fill ? 'min-h-0 flex-1' : 'max-h-96')}
      >
        {rows.map((r, i) => (
          <div
            key={i}
            className={cn(
              'flex',
              r.kind === 'add' && 'bg-success/10',
              r.kind === 'del' && 'bg-destructive/10',
            )}
          >
            <span
              className={cn(
                'w-6 shrink-0 text-center select-none',
                r.kind === 'add' && 'text-success',
                r.kind === 'del' && 'text-destructive',
                r.kind === 'ctx' && 'text-muted-foreground/40',
              )}
            >
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
            </span>
            <pre
              className={cn(
                'whitespace-pre-wrap break-all flex-1 px-2',
                r.kind === 'ctx' && 'text-muted-foreground/70',
              )}
            >
              {r.text || ' '}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
});

interface DiffRow {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

const MAX_LINES = 5000;

/**
 * Returns null when either side exceeds the line cap. Otherwise walks the
 * LCS table to produce a clean diff. LCS table is O(n*m) memory — fine for
 * a file edit (usually <500 lines), prohibitive for a full file rewrite of
 * a giant generated file (hence the cap).
 */
function computeDiff(oldText: string, newText: string): DiffRow[] | null {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) expectDefined(dp[i])[j] = expectDefined(dp[i + 1]?.[j + 1]) + 1;
      else expectDefined(dp[i])[j] = Math.max(expectDefined(dp[i + 1]?.[j]), expectDefined(dp[i]?.[j + 1]));
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: expectDefined(a[i]) });
      i++;
      j++;
    } else if (expectDefined(dp[i + 1]?.[j]) >= expectDefined(dp[i]?.[j + 1])) {
      rows.push({ kind: 'del', text: expectDefined(a[i]) });
      i++;
    } else {
      rows.push({ kind: 'add', text: expectDefined(b[j]) });
      j++;
    }
  }
  while (i < n) rows.push({ kind: 'del', text: expectDefined(a[i++]) });
  while (j < m) rows.push({ kind: 'add', text: expectDefined(b[j++]) });
  return rows;
}

/**
 * Recognise the WrongStack edit-family tools and pull a (oldText, newText,
 * caption) tuple out of their input. Returns null when the tool doesn't
 * carry diffable input. Caller uses this to decide whether to render the
 * DiffView at all.
 */
export function diffFromToolInput(
  toolName: string | undefined,
  input: unknown,
): { oldText: string; newText: string; caption: string } | null {
  if (!toolName || typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  const filePath = String(obj.file_path ?? obj.path ?? '');
  switch (toolName) {
    case 'edit':
    case 'str_replace':
    case 'edit_file': {
      const oldText = typeof obj.old_string === 'string' ? obj.old_string : '';
      const newText = typeof obj.new_string === 'string' ? obj.new_string : '';
      if (!oldText && !newText) return null;
      return { oldText, newText, caption: `edit ${filePath}` };
    }
    case 'write':
    case 'write_file':
    case 'create_file': {
      const content = typeof obj.content === 'string' ? obj.content : '';
      // For a fresh write there's no "old" — treat as additive so the
      // viewer shows everything green.
      return { oldText: '', newText: content, caption: `write ${filePath} (new)` };
    }
    default:
      return null;
  }
}
