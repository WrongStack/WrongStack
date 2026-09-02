/**
 * Red/green diff card for edit / write / patch tool calls.
 *
 * Consumes the shared `@wrongstack/tools/tool-diff` model — the same LCS /
 * unified engine the main WebUI's DiffView uses — so both surfaces render
 * identical hunks for the same edit.
 */
import { type DiffRow, diffRowsFromToolInput } from '@wrongstack/tools/tool-diff';
import type * as React from 'react';
import { useMemo } from 'react';
import { cn } from '../../../lib/utils.js';

const GUTTER: Record<DiffRow['kind'], string> = {
  add: '+',
  del: '-',
  ctx: ' ',
  meta: '@',
};

const ROW_CLASS: Record<DiffRow['kind'], string> = {
  add: 'bg-success/10 text-success',
  del: 'bg-destructive/10 text-destructive',
  ctx: 'text-muted-foreground',
  meta: 'text-info',
};

export function ToolDiffView({
  toolName,
  toolInput,
}: {
  toolName: string | undefined;
  toolInput: string | undefined;
}): React.ReactElement | null {
  const diff = useMemo(() => diffRowsFromToolInput(toolName, toolInput), [toolName, toolInput]);
  if (!diff) return null;

  const { caption, rows } = diff;
  if (rows === null) {
    return (
      <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
        diff too large to render — {caption}
      </p>
    );
  }

  const additions = rows.filter((row) => row.kind === 'add').length;
  const deletions = rows.filter((row) => row.kind === 'del').length;

  return (
    <div data-testid="tool-diff" className="border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1">
        <span
          data-testid="tool-diff-path"
          title={caption}
          className="min-w-0 flex-1 truncate font-mono text-[10px]"
        >
          {caption}
        </span>
        <span className="tabular text-[10px] text-success">+{additions}</span>
        <span className="tabular text-[10px] text-destructive">-{deletions}</span>
      </div>
      <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed">
        {rows.map((row, index) => (
          <span
            // Diff rows have no stable identity of their own; the index IS the
            // identity here, and the list is fully re-rendered per diff.
            key={`${row.kind}-${index}`}
            data-testid="tool-diff-line"
            data-kind={row.kind}
            className={cn('flex px-2', ROW_CLASS[row.kind])}
          >
            <span className="w-3 shrink-0 select-none opacity-60">{GUTTER[row.kind]}</span>
            {row.text || ' '}
          </span>
        ))}
      </pre>
    </div>
  );
}
