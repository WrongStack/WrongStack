/**
 * Tool output, rendered by shape.
 *
 * `detectShape` in `domain/tool-result-shape.ts` decides what a result IS;
 * this file decides how each shape looks. Long bodies auto-collapse to a peek:
 * a single 4000-line Read would otherwise bury the rest of the transcript.
 */
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp } from 'lucide-react';
import type * as React from 'react';
import { useMemo, useState } from 'react';
import { detectShape } from '../../../domain/tool-result-shape.js';
import { cn } from '../../../lib/utils.js';

const LONG_OUTPUT_THRESHOLD = 25;
const LONG_PEEK_LINES = 12;
/** JSON below this many lines opens expanded; above it, collapsed. */
const JSON_AUTO_EXPAND_LINES = 30;

export function CollapsibleText({
  text,
  isError,
  wrap,
  framed = true,
}: {
  text: string;
  isError?: boolean;
  /** false = `whitespace-pre` (numbered output); true = wrap long lines. */
  wrap: boolean;
  /** Off when nested inside another frame, e.g. the bash card. */
  framed?: boolean;
}): React.ReactElement {
  const lines = useMemo(() => text.split('\n'), [text]);
  const isLong = lines.length > LONG_OUTPUT_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);
  const shown = expanded ? text : lines.slice(0, LONG_PEEK_LINES).join('\n');

  return (
    <div className={cn(framed && 'border border-border bg-muted/30')}>
      <pre
        data-testid="tool-result-pre"
        data-wrap={wrap}
        className={cn(
          'overflow-x-auto p-2 font-mono text-[11px] leading-relaxed',
          wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
          isError === true && 'text-destructive',
        )}
      >
        {shown}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex w-full items-center justify-center gap-1 border-t border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronsUp className="size-3" /> collapse to {LONG_PEEK_LINES} lines
            </>
          ) : (
            <>
              <ChevronsDown className="size-3" /> show all {lines.length} lines (+
              {lines.length - LONG_PEEK_LINES} more)
            </>
          )}
        </button>
      )}
    </div>
  );
}

function JsonResult({ value, isError }: { value: unknown; isError?: boolean }): React.ReactElement {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      // Cyclic or otherwise unserialisable — show what we can rather than throw.
      return String(value);
    }
  }, [value]);
  const lineCount = pretty.split('\n').length;
  const [expanded, setExpanded] = useState(lineCount < JSON_AUTO_EXPAND_LINES);

  return (
    <div className={cn('border', isError === true ? 'border-destructive/40' : 'border-border')}>
      <button
        type="button"
        data-testid="tool-result-jsonbar"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-1 bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span>JSON · {lineCount} lines</span>
        <span className="ml-auto">{expanded ? 'collapse' : 'expand'}</span>
      </button>
      {expanded && (
        <pre
          className={cn(
            'overflow-x-auto whitespace-pre p-2 font-mono text-[11px] leading-relaxed',
            isError === true && 'text-destructive',
          )}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
}

export function ToolResultView({
  toolName,
  result,
  isError,
}: {
  toolName: string | undefined;
  result: string;
  isError?: boolean;
}): React.ReactElement {
  const shape = useMemo(() => detectShape(toolName, result), [toolName, result]);

  if (shape.kind === 'json') return <JsonResult value={shape.value} isError={isError} />;

  // Numbered Read output must not wrap: the `N→` gutter is the point.
  if (shape.kind === 'numbered') {
    return <CollapsibleText text={result} isError={isError} wrap={false} />;
  }

  if (shape.kind === 'bash') {
    const failed = shape.exitCode !== undefined && shape.exitCode !== 0;
    return (
      <div data-testid="tool-result-bash" className="border border-border bg-muted/30">
        {shape.stdout !== undefined && shape.stdout !== '' && (
          <CollapsibleText text={shape.stdout} isError={isError} wrap framed={false} />
        )}
        {(shape.exitCode !== undefined || shape.duration !== undefined) && (
          <div
            data-testid="tool-result-exit"
            className={cn(
              'flex gap-3 border-t border-border px-2 py-1 font-mono text-[10px]',
              failed ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {shape.exitCode !== undefined && <span>exit code {shape.exitCode}</span>}
            {shape.duration !== undefined && <span>{shape.duration}</span>}
          </div>
        )}
      </div>
    );
  }

  return <CollapsibleText text={result} isError={isError} wrap />;
}
