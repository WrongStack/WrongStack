import { cn } from '@/lib/utils';
import { Brain, ChevronDown, ChevronRight, ChevronsDown, ChevronsUp } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { extractSageBlock } from '@/lib/sage-block';

/** When a tool dumps hundreds of lines of output, the chat turns into a
 *  scroll-wall. This threshold gates the auto-collapse: anything longer
 *  shows the first ~LONG_PEEK_LINES with a "Show all N more" toggle. */
const LONG_OUTPUT_THRESHOLD = 25;
const LONG_PEEK_LINES = 12;

/** Per-tool on-screen render mode. Mirrors the LLM-side descriptionMode
 *  (config `tools.descriptionMode[name]`) but is independent of token-saving
 *  tiers. `simple` collapses the body by default — meta only, content hidden
 *  until the user clicks "Show all". `extend` shows the full preview with the
 *  usual LONG_PEEK_LINES cap. */
export type ToolResultRenderMode = 'simple' | 'extend';

/**
 * Render `text` as a monospace block, auto-collapsing when it exceeds
 * LONG_OUTPUT_THRESHOLD lines. The first LONG_PEEK_LINES stay visible;
 * the rest expand on click. Keeping the wrap class configurable lets the
 * `numbered` path use `whitespace-pre` (no wrap) and the bash/plain path
 * use `whitespace-pre-wrap break-all` (wrap and break long URLs/paths).
 */
function CollapsibleText({
  text,
  isError,
  className,
  wrapClass,
  showLineNumbers,
  defaultCollapsed,
}: {
  text: string;
  isError?: boolean | undefined;
  className?: string | undefined;
  wrapClass: string;
  /** Whether to render a left gutter with line numbers when the output is
   *  long. Off for the numbered/Read-tool path (which already prefixes its
   *  own line numbers in the content) and for wrap-mode bodies where a
   *  fixed gutter can't stay aligned with wrapped lines. */
  showLineNumbers?: boolean | undefined;
  /** Force the initial state to collapsed even when the body is short.
   *  Used by the `simple` render mode so users see only meta until they
   *  explicitly expand. */
  defaultCollapsed?: boolean | undefined;
}) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const isLong = lines.length > LONG_OUTPUT_THRESHOLD;
  // simple mode wants collapsed-by-default even for short bodies; extend
  // mode keeps the historical behaviour (collapsed only when long).
  const [expanded, setExpanded] = useState(defaultCollapsed ? false : !isLong);
  const { t } = useAppTranslation();
  const shown = expanded ? text : lines.slice(0, LONG_PEEK_LINES).join('\n');
  // Only emit the gutter when the body won't wrap (alignment would break
  // otherwise) AND the user actually expanded it / it's not super short.
  const renderGutter = !!showLineNumbers && isLong && expanded;
  return (
    <div className={cn('rounded-md border bg-background/40 overflow-hidden', className)}>
      {renderGutter ? (
        // Force `whitespace-pre` inside the gutter view so the line numbers
        // stay 1:1 with content rows. Long horizontal lines scroll within
        // the shared overflow container rather than wrapping (which would
        // break alignment between the gutter and the body).
        <div className="flex max-h-96 overflow-auto">
          <pre
            aria-hidden
            className="text-xs font-mono leading-[1.4] py-2 pl-2 pr-2 text-muted-foreground/70 select-none border-r border-border/40 bg-muted/20 tabular-nums text-right whitespace-pre shrink-0"
          >
            {lines.map((_, i) => `${i + 1}`).join('\n')}
          </pre>
          <pre
            className={cn(
              'text-xs font-mono leading-[1.4] py-2 px-2 flex-1 whitespace-pre',
              isError ? 'text-destructive' : 'text-foreground',
            )}
          >
            {shown}
          </pre>
        </div>
      ) : (
        <pre
          className={cn(
            'text-xs font-mono p-2 max-h-96 overflow-auto',
            wrapClass,
            isError ? 'text-destructive' : 'text-foreground',
          )}
        >
          {shown}
        </pre>
      )}
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-center gap-1 px-2 py-1 border-t bg-muted/30 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? (
            <>
              <ChevronsUp className="h-3 w-3" />
              {t('activity:toolResult.collapseToLines', { count: LONG_PEEK_LINES })}
            </>
          ) : (
            <>
              <ChevronsDown className="h-3 w-3" />
              {t('activity:toolResult.showAllLines', {
                total: lines.length,
                more: lines.length - LONG_PEEK_LINES,
              })}
            </>
          )}
        </button>
      )}
    </div>
  );
}

interface Props {
  toolName?: string | undefined;
  result: string;
  isError?: boolean | undefined;
  className?: string | undefined;
  /**
   * On-screen result render mode. Mirrors the CLI/terminal behaviour:
   * `simple` starts the body collapsed (meta only) so the chat stays
   * scannable; `extend` follows the historical "auto-expand short bodies,
   * auto-collapse long ones" rule. Driven by `tools.resultRenderMode[name]`
   * on the backend (toggled via `/tool <name> result simple`); passed
   * here as a prop so the WebUI doesn't have to know about the config
   * map.
   */
  renderMode?: 'simple' | 'extend' | undefined;
  /**
   * SAGE Memory Injector lines delivered out-of-band by `tool.executed.sage`.
   * Authoritative when present: the backend split the block off the tool text
   * before its preview cap, so `result` carries no SAGE suffix to recover.
   * Replayed messages have no such field and fall back to splitting `result`.
   */
  sageLines?: string[] | undefined;
}

/**
 * Decides which renderer to use for a tool result based on its shape /
 * tool name. The goal is to make output *legible at a glance*:
 *   - Read tool with leading line numbers stays line-numbered, monospace.
 *   - Bash output gets a "exit code N" footer split from stdout.
 *   - Valid JSON gets pretty-printed and collapsible by default.
 *   - Everything else falls back to raw monospace.
 */
export const ToolResult = memo(function ToolResult({
  toolName,
  result,
  isError,
  className,
  renderMode,
  sageLines: sageLinesFromEvent,
}: Props) {
  // SAGE-injected memory is rendered as its own bordered card, never as tool
  // text. Live tool results carry it out-of-band (`tool.executed.sage`), split
  // off by the backend before the event's preview cap — the cap used to land
  // inside a memory line and leak the fragment into this body. Replayed
  // messages still have the block inline in the persisted tool_result content,
  // so fall back to splitting the text; that split mirrors the TUI's
  // `extractSageBlock` so both surfaces agree on what counts as a SAGE suffix.
  const split = useMemo(() => extractSageBlock(result), [result]);
  const cleanOutput = split.cleanOutput;
  const sageLines =
    sageLinesFromEvent && sageLinesFromEvent.length > 0 ? sageLinesFromEvent : split.sageLines;
  const shape = useMemo(() => detectShape(toolName, cleanOutput), [toolName, cleanOutput]);
  const { t } = useAppTranslation();
  // `simple` starts the body collapsed so the user sees only the meta
  // (line count / exit code) until they explicitly expand. `extend`
  // (the default) preserves the historical auto-collapse behaviour for
  // long bodies. Both modes let the user expand on demand — `simple`
  // is just a different initial state, not a permanent gate.
  const defaultCollapsed = renderMode === 'simple';

  // SAGE memory badge — tiny pill indicator, not a full card.
  // The full memory detail lives in the Memory Injector side panel.
  const sageCount = sageLines.length > 0 ? sageLines.length - 1 : 0;

  const memoryBadge = sageCount > 0 && (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('open:memory-panel'))}
      className="mt-1 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/[0.06] px-2 py-0.5 text-[10px] font-medium text-primary/80 hover:bg-primary/10 hover:text-primary transition-colors"
      title={`${sageCount} SAGE ${sageCount === 1 ? 'memory' : 'memories'} injected — click to open Memory panel`}
      data-testid="sage-memory-badge"
    >
      <Brain className="size-2.5" />
      <span className="tabular-nums">{sageCount}</span>
      <span className="text-[9px] uppercase tracking-wide opacity-70">
        {sageCount === 1 ? 'memory' : 'memories'}
      </span>
    </button>
  );

  if (shape.kind === 'json') {
    return (
      <>
        <JsonResult
          value={shape.value}
          isError={isError}
          className={className}
          defaultCollapsed={defaultCollapsed}
        />
        {memoryBadge}
      </>
    );
  }
  if (shape.kind === 'numbered') {
    return (
      <>
        <CollapsibleText
          text={cleanOutput}
          isError={isError}
          className={className}
          wrapClass="whitespace-pre"
          defaultCollapsed={defaultCollapsed}
        />
        {memoryBadge}
      </>
    );
  }
  if (shape.kind === 'bash') {
    return (
      <>
        <div className={cn('rounded-md border bg-background/40 overflow-hidden', className)}>
          {shape.stdout && (
            <CollapsibleText
              text={shape.stdout}
              isError={isError}
              // Nested CollapsibleText already adds border/bg; strip them here
              // so we get one outer frame, not two.
              className="border-0 rounded-none bg-transparent"
              wrapClass="whitespace-pre-wrap break-all"
              showLineNumbers
              defaultCollapsed={defaultCollapsed}
            />
          )}
          {(shape.exitCode !== undefined || shape.duration) && (
            <div
              className={cn(
                'flex items-center gap-3 text-[11px] px-2 py-1 border-t bg-muted/30 tabular-nums',
                shape.exitCode && shape.exitCode !== 0
                  ? 'text-destructive'
                  : 'text-muted-foreground',
              )}
            >
              {shape.exitCode !== undefined && (
                <span>
                  {t('activity:toolResult.exitCode')}{' '}
                  <span className="font-mono">{shape.exitCode}</span>
                </span>
              )}
              {shape.duration && <span>{shape.duration}</span>}
            </div>
          )}
        </div>
        {memoryBadge}
      </>
    );
  }
  return (
    <>
      <CollapsibleText
        text={cleanOutput}
        isError={isError}
        className={className}
        wrapClass="whitespace-pre-wrap break-all"
        showLineNumbers
        defaultCollapsed={defaultCollapsed}
      />
      {memoryBadge}
    </>
  );
});

interface Shape {
  kind: 'numbered' | 'json' | 'bash' | 'plain';
  /** For JSON results. */
  value?: unknown | undefined;
  /** For bash-shape results. */
  stdout?: string | undefined;
  exitCode?: number | undefined;
  duration?: string | undefined;
}

function detectShape(toolName: string | undefined, result: string): Shape {
  const trimmed = result.trim();
  // ---- Read tool: lines like "  42→ const foo = …" -------------
  if (/^\s*\d+→/m.test(result.slice(0, 200))) {
    return { kind: 'numbered' };
  }
  // ---- JSON ---------------------------------------------------------
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return { kind: 'json', value: parsed };
      }
    } catch {
      /* fall through */
    }
  }
  // ---- Bash-ish -----------------------------------------------------
  const isBashTool = !!toolName && /^(bash|shell|exec|run)/i.test(toolName);
  // Many bash wrappers emit a trailing "exit code: N" or "[exit 1]" line.
  const exitMatch = result.match(/(?:^|\n)\s*(?:\[?exit(?:\s*code)?\]?\s*[:=]?\s*)(\d+)\s*$/i);
  const durMatch = result.match(/(?:^|\s)(\d+\s*ms|\d+\.\d+s)\s*$/i);
  if (isBashTool || exitMatch) {
    let stdout = result;
    if (exitMatch) stdout = result.slice(0, exitMatch.index).trimEnd();
    return {
      kind: 'bash',
      stdout,
      exitCode: exitMatch ? Number(exitMatch[1]) : undefined,
      duration: durMatch?.[1],
    };
  }
  return { kind: 'plain' };
}

function JsonResult({
  value,
  isError,
  className,
  defaultCollapsed,
}: {
  value: unknown;
  isError?: boolean | undefined;
  className?: string | undefined;
  /** Force the initial state to collapsed. Used by `simple` render mode
   *  so the user sees only the line-count badge until they expand. */
  defaultCollapsed?: boolean | undefined;
}) {
  const { t } = useAppTranslation();
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const lineCount = pretty.split('\n').length;
  // `simple` forces collapsed; otherwise follow the historical
  // "expand small JSON, collapse big" rule.
  const [expanded, setExpanded] = useState(defaultCollapsed ? false : lineCount < 30);
  return (
    <div
      className={cn(
        'rounded-md border bg-background/40 overflow-hidden',
        isError && 'border-destructive/40',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-2 py-1 border-b bg-muted/30 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <span className="flex items-center gap-1">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-mono">
            {t('activity:toolResult.jsonLines', { count: lineCount })}
          </span>
        </span>
        <span>
          {expanded ? t('activity:toolResult.collapse') : t('activity:toolResult.expand')}
        </span>
      </button>
      {expanded && (
        <pre
          className={cn(
            'text-xs font-mono whitespace-pre p-2 max-h-96 overflow-auto',
            isError ? 'text-destructive' : 'text-foreground',
          )}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
}
