import type { TodoItem } from '@wrongstack/core/agent';
import { hasOpenTodos } from '@wrongstack/core/utils';
import type { ParsedNextStep } from '@wrongstack/tools/next-steps';
import { parseNextSteps } from '@wrongstack/tools/next-steps';
import React, { useEffect, useMemo } from 'react';
import { langFromPath } from '../../highlight.js';
import { Box, Text } from '../../ink.js';
import { theme } from '../../theme.js';
import { getToolVisual } from '../../tool-glyph.js';
import { AssistantBody, assistantContentWidth } from './assistant.js';
import { Banner } from './banner.js';
import {
  DiffBlock,
  DiffFileBlock,
  extractDiffPreview,
  extractMultiFileDiffs,
  formatDiffStats,
  formatMultiDiffSummary,
  summarizeMultiFileDiffs,
} from './code-block.js';
import { ToolCard } from './tool-card.js';
import type { HistoryEntry } from './types.js';
import { MEMORY_GATE_DEFAULTS } from '../../history-entry.js';
import {
  fmtBytes,
  fmtTok,
  formatToolArgs,
  formatToolOutputSage,
  formatToolVisualOutput,
  parseSageMemoryLine,
  type ParsedSageMemoryLine,
  shortenPath,
  stringOf,
  ToolOutputLines,
  tryParseJson,
} from './utils.js';

// ── Internal helpers ──

/**
 * Per-memory proof costs two rows each, so an 8-hint run would push a 20-row
 * card into the transcript. Show the top few (the list arrives score-sorted)
 * and count the rest; the side panel keeps the full set.
 */
const MAX_MEMORY_PROOF_ROWS = 4;

/**
 * Render the signed score contributions as `metadata 0.72×0.48 +0.34 │ …`.
 * Uses U+2212 for negatives so a minus is not mistaken for a hyphen inside
 * the labels, which themselves contain `×` and digits.
 */
function formatScoreTerms(terms: ReadonlyArray<{ label: string; value: number }>): string {
  if (terms.length === 0) return 'no score breakdown (emitted by an older core build)';
  return terms
    .map((term) => {
      const magnitude = Math.abs(term.value).toFixed(2);
      return `${term.label} ${term.value < 0 ? '−' : '+'}${magnitude}`;
    })
    .join(' │ ');
}

function brainStatusStyle(status: Extract<HistoryEntry, { kind: 'brain' }>['status']): {
  icon: string;
  color: string;
} {
  switch (status) {
    case 'thinking':
      return { icon: '…', color: 'magenta' };
    case 'answered':
      return { icon: '⚖', color: 'cyan' };
    case 'ask_human':
      return { icon: '?', color: 'yellow' };
    case 'denied':
      return { icon: '×', color: 'red' };
  }
}

function memoryLifecycleStyle(
  action: Extract<HistoryEntry, { kind: 'memory-lifecycle' }>['action'],
): {
  icon: string;
  color: string;
} {
  if (action === 'entered' || action === 'recovered') return { icon: '↳', color: 'green' };
  if (action === 'exited') return { icon: '↲', color: 'red' };
  if (action === 'related') return { icon: '◇', color: 'magenta' };
  return { icon: '•', color: 'cyan' };
}

function brainRiskColor(risk: Extract<HistoryEntry, { kind: 'brain' }>['risk']): string {
  switch (risk) {
    case 'low':
      return 'green';
    case 'medium':
      return 'cyan';
    case 'high':
      return 'yellow';
    case 'critical':
      return 'red';
  }
}

/**
 * Full-bordered notice card for `warn`/`error` entries. A rounded box with an
 * icon + label header in the accent color and the message body below, wrapped
 * to the terminal width and split across lines so multi-line diagnostics stay
 * readable instead of overflowing a single-line strip. Slash-command output
 * that carries raw ANSI (bold/colors) is passed through untouched — the same
 * rule the `info` renderer uses — so pre-styled text isn't double-wrapped.
 */
function NoticeCard({
  icon,
  label,
  color,
  text,
  termWidth,
}: {
  icon: string;
  label: string;
  color: string;
  text: string;
  termWidth: number;
}): React.ReactElement {
  // 2 border columns + 2 paddingX columns of chrome.
  const contentWidth = Math.max(20, termWidth - 4);
  const hasAnsi = /\x1b\[/.test(text);
  const lines = text.split('\n');
  return (
    <Box
      flexDirection="column"
      marginX={0}
      marginY={1}
      borderStyle="round"
      borderColor={color}
      paddingX={1}
    >
      <Text bold color={color}>{`${icon} ${label}`}</Text>
      <Box flexDirection="column" width={contentWidth}>
        {hasAnsi ? (
          <Text>{text}</Text>
        ) : (
          lines.map((line, i) => (
            <Text key={i} color={color}>
              {line.length > 0 ? line : ' '}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

// ── Entry ──

export const Entry = React.memo(function Entry({
  entry,
  termWidth,
  termHeight,
  setSuggestions,
  autonomyMode,
  multiDiffSummaryThreshold,
  todos,
  showModelReasoning,
}: {
  entry: HistoryEntry;
  termWidth: number;
  /** Available managed-history rows; used by height-aware entries such as the banner. */
  termHeight?: number | undefined;
  /** Store parsed next steps in the shared suggestion store so /next 1 works. */
  setSuggestions?: ((steps: string[]) => void) | undefined;
  /** Current autonomy mode — when 'auto', first step shows an auto marker. */
  autonomyMode?: string | undefined;
  /** User-tunable cutoff for the multi-file diff summary footer. Passes
   *  through to `formatMultiDiffSummary`; `undefined` means "use default". */
  multiDiffSummaryThreshold?: number | undefined;
  /** Live todo list. When non-empty (pending/in_progress), the NEXT STEPS
   *  panel is hidden and the store is not written — same rule as the host
   *  callback (b0970387), so the two paths agree. */
  todos?: readonly TodoItem[] | undefined;
  /**
   * Show the "Model Reasoning" blocks in chat history. When false,
   * `kind: 'thinking'` entries render as an empty fragment. Default: true.
   */
  showModelReasoning?: boolean | undefined;
}): React.ReactElement | null {
  // Whether the agent still has open (pending/in_progress) todos. While it
  // does, finishing them takes priority over offering `<nextsteps>` — both
  // the host callback (execution.ts → parseSuggestionsFromOutput) and this
  // render path gate on the same condition (b0970387) so they never disagree
  // about whether suggestions are available.
  const openTodos = hasOpenTodos(todos);

  // Parse next steps from assistant text — computed once, used only in
  // the assistant case. Must live at the top level (hooks rules).
  // Always parse (even when todos are open) so `stripped` is available and
  // the raw `<nextsteps>` block never leaks into the message body; only the
  // panel rendering and the store write are gated below.
  const nextSteps = useMemo(() => {
    if (entry.kind !== 'assistant') return { steps: [] as ParsedNextStep[], stripped: '' };
    // strict=true retained for compatibility; parser accepts canonical <nextsteps> only.
    return parseNextSteps(entry.text, true);
  }, [entry.kind, (entry as never as { text?: string }).text]);

  // Store parsed next steps in the shared suggestion store (for /next and
  // auto-submit countdown). Strict=true accepts 💡 headings or <nextsteps> XML tags
  // (consistent with what the TUI renders in the message body).
  // Skipped while todos are open — mirrors parseSuggestionsFromOutput, so the
  // store isn't repopulated here right after the host callback cleared it.
  // NOTE: Only assistant entries should have <nextsteps> — subagents return
  // task results, not suggestions, so we skip parsing for subagent entries.
  useEffect(() => {
    if (!setSuggestions) return;
    if (entry.kind !== 'assistant') return;
    if (openTodos) return;
    const text = (entry as never as { text?: string }).text ?? '';
    const { texts } = parseNextSteps(text, true);
    if (texts.length > 0) setSuggestions(texts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.kind, (entry as never as { text?: string }).text, openTodos, setSuggestions]);

  switch (entry.kind) {
    case 'user':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.user}
          paddingLeft={1}
        >
          <Text>
            <Text bold color={theme.user}>
              {'👤 USER  '}
            </Text>
            <Text color="white">{entry.text}</Text>
            {entry.queued ? <Text dimColor>{' (queued)'}</Text> : null}
            {entry.pasteContent ? (
              <>
                {entry.text ? '\n' : null}
                <Text dimColor>
                  {'  ↳ '}
                  {entry.pasteContent}
                </Text>
              </>
            ) : null}
          </Text>
        </Box>
      );
    case 'thinking': {
      // Hidden when the user disables model reasoning display.
      if (showModelReasoning === false) return null;
      const contentWidth = assistantContentWidth(termWidth);
      return (
        <Box
          flexDirection="column"
          marginX={0}
          marginY={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.textSecondary}
          paddingLeft={1}
        >
          <Box flexDirection="row">
            <Text bold color={theme.textSecondary}>
              {'⟳ Model Reasoning'}
            </Text>
            <Text color={theme.textSecondary}>{'  (model reasoning…)'}</Text>
          </Box>
          <Box width={contentWidth}>
            <Text color={theme.textSecondary}>{entry.text}</Text>
          </Box>
        </Box>
      );
    }
    case 'assistant': {
      const contentWidth = assistantContentWidth(termWidth);
      const { steps, stripped } = nextSteps;
      // Panel only when there are steps AND no open todos (the latter mirrors
      // the host callback — suggestions are suppressed mid-task).
      const hasNext = steps.length > 0 && !openTodos;
      return (
        <Box flexDirection="column">
          <Box
            flexDirection="column"
            marginX={0}
            marginY={1}
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={theme.assistant}
            paddingLeft={1}
          >
            <Box flexDirection="row">
              <Text bold color={theme.assistant}>
                {'💬 ASSISTANT'}
              </Text>
            </Box>
            <AssistantBody text={stripped} termWidth={termWidth} contentWidth={contentWidth} />
          </Box>
          {hasNext && (
            <Box
              flexDirection="column"
              marginX={0}
              marginY={1}
              borderStyle="single"
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              borderColor={theme.accent}
              paddingLeft={1}
            >
              <Box flexDirection="row" marginBottom={1}>
                <Text bold color={theme.accent}>
                  {'💡 NEXT STEPS  '}
                </Text>
                <Text dimColor>(use /next 1, /next 1 2 3 to select)</Text>
              </Box>
              {steps.map((s, i) => (
                <Box key={s.index} flexDirection="row" marginTop={0}>
                  <Text>
                    <Text bold color={theme.accent}>{`  ${s.index}. `}</Text>
                    <Text>{s.text}</Text>
                    {s.auto ? (
                      <Text color="cyan" dimColor>
                        {' '}
                        auto
                      </Text>
                    ) : null}
                    {autonomyMode === 'auto' && i === 0 ? <Text color="cyan">{'  ⏩'}</Text> : null}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      );
    }
    case 'tool': {
      const { glyph, color } = getToolVisual(entry.name);
      // Memoize all expensive tool-output formatting on the entry's
      // immutable properties. Without this, the formatToolOutput /
      // extractDiffPreview / extractMultiFileDiffs / formatToolVisualOutput
      // calls re-parse the entire output on every terminal resize,
      // even though the entry data never changes.
      const { argSummary, outLines, sageLines, visualLines, diff, multiDiffs, sizeChip, mutation } =
        useMemo(() => {
          const argSummary = formatToolArgs(entry.name, entry.input);
          const {
            cleanOutput: outputForFormatting,
            outLines,
            sageLines,
          } = formatToolOutputSage(
            entry.name,
            entry.output,
            entry.ok,
            entry.outputBytes,
            entry.outputLines,
            entry.sageLines,
          );
          const visualLines = formatToolVisualOutput(
            entry.name,
            outputForFormatting,
            entry.ok,
            entry.input,
          );
          const diff = entry.ok
            ? extractDiffPreview(entry.name, outputForFormatting, entry.input)
            : undefined;
          const multiDiffs =
            entry.ok &&
            !diff &&
            (entry.name === 'replace' || entry.name === 'diff' || entry.name === 'patch')
              ? extractMultiFileDiffs(entry.name, outputForFormatting, entry.input)
              : undefined;
          const sizeChip = (() => {
            if (!entry.ok) return '';
            const parts: string[] = [];
            if (entry.outputLines !== undefined && entry.outputLines > 0) {
              parts.push(`${entry.outputLines} L`);
            }
            if (entry.outputBytes && entry.outputBytes > 0) {
              parts.push(fmtBytes(entry.outputBytes));
            }
            if (entry.outputTokens && entry.outputTokens > 0) {
              parts.push(`≈${fmtTok(entry.outputTokens)} tok`);
            }
            return parts.join(' · ');
          })();
          // Claude-Code-style header info for file-mutating tools whose diff
          // is renderable: `● Update(path)` / `● Write(path)` + a
          // `⎿  Added N lines, removed M lines` stats line. Only successful
          // calls with a recovered diff take this shape — failures and
          // diff-less results keep the generic glyph header below.
          const mutation = (() => {
            const name = entry.name;
            if (name !== 'edit' && name !== 'write' && name !== 'patch' && name !== 'replace') {
              return undefined;
            }
            if (!entry.ok || (!diff && !multiDiffs)) return undefined;
            const inputObj =
              entry.input && typeof entry.input === 'object'
                ? (entry.input as Record<string, unknown>)
                : undefined;
            const outJson = tryParseJson(outputForFormatting.trim());
            const outObj =
              outJson && typeof outJson === 'object'
                ? (outJson as Record<string, unknown>)
                : undefined;
            // `created` lives in the JSON output shape; the serialized-text
            // shape carries it as a `created=true` field on the header line.
            const created =
              name === 'write' &&
              (outObj?.['created'] === true || /^[^\n]*\bcreated=true\b/.test(outputForFormatting));
            const verb = created ? 'Write' : 'Update';
            const path = stringOf(inputObj?.['path']) ?? stringOf(outObj?.['path']);
            const agg = multiDiffs ? summarizeMultiFileDiffs(multiDiffs) : undefined;
            const target = multiDiffs
              ? agg?.fileCount === 1
                ? multiDiffs[0]!.path
                : `${agg?.fileCount ?? multiDiffs.length} files`
              : (path ?? 'file');
            return {
              verb,
              target,
              added: agg ? agg.added : (diff?.added ?? 0),
              removed: agg ? agg.removed : (diff?.removed ?? 0),
              lang: langFromPath(multiDiffs ? '' : (path ?? '')),
            };
          })();
          return {
            argSummary,
            outLines,
            sageLines,
            visualLines,
            diff,
            multiDiffs,
            sizeChip,
            mutation,
          };
        }, [
          entry.name,
          entry.output,
          entry.sageLines,
          entry.input,
          entry.ok,
          entry.outputBytes,
          entry.outputLines,
          entry.outputTokens,
        ]);
      if (mutation) {
        // Claude-Code-style file-mutation entry:
        //   ● Update(D:\path\to\file.tsx)  ·  12ms
        //     ⎿  Added 2 lines, removed 2 lines
        //     122        <div className="…">
        //     125 -      <Loader2 … /> Loading kits…      (dark red wash)
        //     125 +      <Loader2 … /> {t('…')}           (dark green wash)
        // In `simple` result-render mode only the header + stats line show;
        // the diff body stays hidden.
        const statsText = formatDiffStats(mutation.added, mutation.removed) ?? 'No line changes';
        // Keep the header on one line: budget the path to the terminal
        // width minus the bullet, verb, parens and the trailing duration
        // chip — a too-long absolute path elides from the left
        // (`…\SidePanel\DesignStudioPanel.tsx`) instead of wrapping the
        // bullet onto its own row.
        const targetBudget = Math.max(24, termWidth - mutation.verb.length - 16);
        const hasCounts = mutation.added > 0 || mutation.removed > 0;
        const toolContentWidth = Math.max(20, termWidth - 2);
        return (
          <Box flexDirection="column">
            <ToolCard
              glyph={glyph}
              color={color}
              title={`${mutation.verb}(${shortenPath(mutation.target, targetBudget)})`}
              meta={`${entry.durationMs}ms`}
              ok={entry.ok}
              termWidth={termWidth}
              hasBody
            >
              <Text>
                <Text dimColor>{'⎿  '}</Text>
                {mutation.added > 0 ? (
                  <Text bold color={theme.success}>{`+${mutation.added}`}</Text>
                ) : null}
                {mutation.added > 0 && mutation.removed > 0 ? <Text> </Text> : null}
                {mutation.removed > 0 ? (
                  <Text bold color={theme.error}>{`-${mutation.removed}`}</Text>
                ) : null}
                {hasCounts ? <Text dimColor>{'  '}</Text> : null}
                <Text dimColor>{statsText}</Text>
              </Text>
              {entry.resultRenderMode !== 'simple' && multiDiffs ? (
                <Box flexDirection="column">
                  {(() => {
                    const summaryLine = formatMultiDiffSummary(
                      summarizeMultiFileDiffs(multiDiffs),
                      multiDiffSummaryThreshold ?? -1,
                    );
                    return summaryLine ? <Text dimColor italic>{`  ${summaryLine}`}</Text> : null;
                  })()}
                  {multiDiffs.map((item) => (
                    <DiffFileBlock
                      key={item.path}
                      path={item.path}
                      preview={item.preview}
                      useColor={theme.supportsBackground}
                      contentWidth={toolContentWidth}
                    />
                  ))}
                </Box>
              ) : entry.resultRenderMode !== 'simple' && diff ? (
                <DiffBlock
                  rows={diff.rows}
                  hidden={diff.hidden}
                  added={diff.added}
                  removed={diff.removed}
                  hiddenAdded={diff.hiddenAdded}
                  hiddenRemoved={diff.hiddenRemoved}
                  useColor={theme.supportsBackground}
                  lang={mutation.lang}
                  showStats={false}
                  contentWidth={toolContentWidth}
                />
              ) : null}
            </ToolCard>
            <SageMemoryBlock
              sageLines={sageLines}
              toolName={entry.name}
              stats={entry.sageStats}
            />
          </Box>
        );
      }
      const toolContentWidth = Math.max(20, termWidth - 2);
      const hasToolBody = Boolean(
        (visualLines && visualLines.length > 0) ||
          (entry.resultRenderMode !== 'simple' && outLines.length > 0) ||
          (entry.resultRenderMode !== 'simple' && (diff || multiDiffs)),
      );
      return (
        <Box flexDirection="column">
          <ToolCard
            glyph={glyph}
            color={color}
            title={entry.name}
            detail={argSummary || undefined}
            meta={[`${entry.durationMs}ms`, sizeChip].filter(Boolean).join(' · ')}
            ok={entry.ok}
            termWidth={termWidth}
            hasBody={hasToolBody}
          >
            {visualLines && entry.resultRenderMode !== 'simple' ? (
              <ToolOutputLines
                lines={visualLines}
                hasFollowingBlock={Boolean(diff || multiDiffs)}
              />
            ) : visualLines ? (
              // `simple` mode: meta line stays visible (path + replacement
              // count for edit, line count for read, etc.) but the diff
              // body below is hidden. The user always gets a one-line
              // summary so the entry never looks empty.
              <ToolOutputLines lines={visualLines} hasFollowingBlock={false} />
            ) : entry.resultRenderMode === 'simple' ? null : (
              outLines.map((line, i) => {
                const connector =
                  i === outLines.length - 1 && !diff && !multiDiffs ? '  └─ ' : '  ├─ ';
                return (
                  <Text key={i}>
                    <Text color={color} dimColor>
                      {connector}
                    </Text>
                    <Text
                      dimColor={entry.ok && !line.startsWith('!')}
                      {...(!entry.ok || line.startsWith('!') ? { color: 'red' } : {})}
                    >
                      {line}
                    </Text>
                  </Text>
                );
              })
            )}
            {/* `simple` mode: hide diff blocks too — only the meta chip
              stays visible. Diff bodies can re-flow onto the screen on
              demand via the chip expansion hook (future work). */}
            {entry.resultRenderMode !== 'simple' && multiDiffs ? (
              <Box flexDirection="column">
                {(() => {
                  const summaryLine = formatMultiDiffSummary(
                    summarizeMultiFileDiffs(multiDiffs),
                    multiDiffSummaryThreshold ?? -1,
                  );
                  return summaryLine ? (
                    <Text dimColor italic>
                      {summaryLine}
                    </Text>
                  ) : null;
                })()}
                {multiDiffs.map((item) => (
                  <DiffFileBlock
                    key={item.path}
                    path={item.path}
                    preview={item.preview}
                    useColor={theme.supportsBackground}
                    contentWidth={toolContentWidth}
                  />
                ))}
              </Box>
            ) : entry.resultRenderMode !== 'simple' && diff ? (
              <DiffBlock
                rows={diff.rows}
                hidden={diff.hidden}
                added={diff.added}
                removed={diff.removed}
                hiddenAdded={diff.hiddenAdded}
                hiddenRemoved={diff.hiddenRemoved}
                useColor={theme.supportsBackground}
                contentWidth={toolContentWidth}
              />
            ) : null}
          </ToolCard>
          <SageMemoryBlock sageLines={sageLines} toolName={entry.name} stats={entry.sageStats} />
        </Box>
      );
    }
    case 'memory-activation': {
      // Only a FAILED run gets its own card. A successful one is already on
      // screen as the SAGE memory panel under the tool result — showing the
      // injector's arithmetic beside it said the same thing twice, so the
      // numbers moved onto that panel's header and the full decision proof
      // (scores against their gates, the searched query, reject buckets)
      // lives in the context panel, which also keeps the runs that injected
      // nothing. The proof render below stays for the error path and for
      // sessions replayed from before this split.
      if (!entry.error) return null;
      const rejected = Object.entries(entry.rejected)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(' · ');
      // On a failed run, `injectedIds` is empty (nothing made it through the
      // gate), so filtering activated by it would blank the proof card. Show
      // every activated candidate instead — the operator still wants to see
      // what was considered before the rejection, with score vs gates.
      const injected =
        entry.outcome === 'error'
          ? entry.activated
          : entry.activated.filter((memory) => entry.injectedIds.includes(memory.id));
      const shown = injected.slice(0, MAX_MEMORY_PROOF_ROWS);
      const overflow = injected.length - shown.length;
      // Entries rehydrated from a session recorded before the proof fields
      // existed carry neither thresholds nor score terms. Fall back to the
      // shipped defaults rather than crashing the whole transcript render.
      const thresholds = entry.thresholds ?? MEMORY_GATE_DEFAULTS;
      return (
        <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
          <Box flexDirection="row">
            <Text bold color="magenta">
              {'🧠 MEMORY INJECTOR  '}
            </Text>
            <Text color="cyan">{entry.trigger}</Text>
            <Text dimColor>
              {`  ${entry.activated.length} activated → ${entry.injectedIds.length} injected / ${entry.candidates} · ctx ${Math.round(entry.contextPressure * 100)}% · +${entry.injectedChars} chars`}
            </Text>
          </Box>
          {entry.error ? <Text color="red">{`error: ${entry.error}`}</Text> : null}
          {/* The searched text, not the user's message. When task-aware
              planning is on this carries todo/Kanban text, which is usually
              the real reason an "unrelated" memory matched. */}
          {entry.queryPreview ? (
            <Text dimColor wrap="truncate-end">
              {`query: ${entry.queryPreview}`}
            </Text>
          ) : null}
          {shown.map((memory) => {
            const scorePass = memory.score >= thresholds.minScore;
            const relationPass = memory.relationStrength >= thresholds.relationFloor;
            const reason = memory.activationReasons[0] ?? 'no recorded reason';
            return (
              <Box key={memory.id} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color="green">{`${memory.id} `}</Text>
                  <Text color={scorePass ? 'green' : 'red'}>
                    {`${memory.score.toFixed(2)} ${scorePass ? '✓' : '✗'} ${thresholds.minScore.toFixed(2)}`}
                  </Text>
                  <Text dimColor>{' · relation '}</Text>
                  <Text color={relationPass ? 'green' : 'red'}>
                    {`${memory.relationStrength.toFixed(2)} ${relationPass ? '✓' : '✗'} ${thresholds.relationFloor.toFixed(2)}`}
                  </Text>
                  <Text dimColor>{` · ${reason}`}</Text>
                </Text>
                <Text dimColor wrap="truncate-end">
                  {`  ${formatScoreTerms(memory.scoreTerms ?? [])}`}
                </Text>
              </Box>
            );
          })}
          {overflow > 0 ? <Text dimColor>{`  +${overflow} more injected`}</Text> : null}
          {rejected ? <Text dimColor>{`filtered: ${rejected}`}</Text> : null}
        </Box>
      );
    }
    case 'memory-lifecycle': {
      const style = memoryLifecycleStyle(entry.action);
      return (
        <Box flexDirection="row">
          <Text bold color={style.color}>{`${style.icon} MEMORY  `}</Text>
          <Text color={style.color}>{entry.label}</Text>
          {entry.detail ? <Text dimColor>{`  · ${entry.detail}`}</Text> : null}
        </Box>
      );
    }
    case 'info': {
      // Slash commands style their own output with raw ANSI (bold, colors,
      // dim sections). Wrapping that in dimColor breaks mid-string: the
      // first \x1b[22m close inside the text cancels the outer dim, leaving
      // the rest of the entry patchy half-dim/half-bright. Only dim plain,
      // unstyled lines.
      const hasAnsi = /\x1b\[/.test(entry.text);
      if (hasAnsi) return <Text>{entry.text}</Text>;
      return (
        <Text dimColor>
          <Text>{'ℹ '}</Text>
          {entry.text}
        </Text>
      );
    }
    case 'warn':
      // Compact single-line tag for warnings. Previously rendered as a
      // full-bordered NoticeCard that took 4+ lines — now a one-liner so
      // common warnings (retries, rate-limits) don't dominate the history.
      return (
        <Box flexDirection="row" marginY={0}>
          <Text>
            <Text bold color={theme.warn}>
              {'⚠ '}
            </Text>
            <Text color={theme.warn}>{entry.text}</Text>
          </Text>
        </Box>
      );
    case 'error':
      return (
        <NoticeCard
          icon="✗"
          label="ERROR"
          color={theme.error}
          text={entry.text}
          termWidth={termWidth}
        />
      );
    case 'turn-summary':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderColor={theme.textMuted}
          backgroundColor={theme.surfaceRaised}
          paddingX={1}
        >
          <Text>
            <Text color={theme.brandPrimary}>{'📋 '}</Text>
            <Text color={theme.textSecondary}>{entry.text}</Text>
          </Text>
        </Box>
      );
    case 'model-switch': {
      const shrink =
        entry.fromContext !== undefined &&
        entry.toContext !== undefined &&
        entry.toContext > 0 &&
        entry.toContext < entry.fromContext;
      const accent = shrink ? theme.warn : theme.accent;
      const ctxChip = (ctx: number | undefined): string =>
        ctx && ctx > 0 ? `${fmtTok(ctx)} ctx` : '';
      const fromRef =
        entry.fromProvider && entry.fromModel
          ? `${entry.fromProvider} / ${entry.fromModel}`
          : undefined;
      const toRef = `${entry.toProvider} / ${entry.toModel}`;
      const fromChip = ctxChip(entry.fromContext);
      const toChip = ctxChip(entry.toContext);
      const pct =
        shrink && entry.requestTokens && entry.requestTokens > 0 && entry.toContext
          ? Math.round((entry.requestTokens / entry.toContext) * 100)
          : undefined;
      return (
        <Box
          flexDirection="column"
          marginX={0}
          marginY={1}
          borderStyle="round"
          borderColor={accent}
          paddingX={1}
        >
          <Text bold color={accent}>
            {'🔄 MODEL SWITCHED'}
          </Text>
          {fromRef ? (
            <Text>
              <Text dimColor>{'  from  '}</Text>
              <Text dimColor>{fromRef}</Text>
              {fromChip ? <Text dimColor>{`   ${fromChip}`}</Text> : null}
            </Text>
          ) : null}
          <Text>
            <Text dimColor>{fromRef ? '  to    ' : '  now   '}</Text>
            <Text bold color={theme.assistant}>
              {toRef}
            </Text>
            {toChip ? (
              <Text color={shrink ? theme.warn : theme.success}>{`   ${toChip}`}</Text>
            ) : null}
          </Text>
          <Text color={theme.success}>
            {entry.runActive
              ? '  ✓ active for next LLM request · current run continues'
              : '  ✓ active for next LLM request'}
          </Text>
          {shrink ? (
            <Text color={theme.warn}>
              {`  ⚠ smaller window: ${fmtTok(entry.fromContext as number)} → ${fmtTok(
                entry.toContext as number,
              )}${
                pct !== undefined
                  ? ` · request ≈ ${fmtTok(entry.requestTokens as number)} (${pct}% of new window)`
                  : ''
              }`}
            </Text>
          ) : null}
        </Box>
      );
    }
    case 'brain': {
      const statusStyle = brainStatusStyle(entry.status);
      const riskColor = brainRiskColor(entry.risk);
      // Shared left indent so nested details visually nest under the header.
      const indentWidth = 2;
      return (
        <Box
          flexDirection="column"
          marginX={0}
          marginY={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.monitor.agents}
          paddingLeft={1}
        >
          <Box flexDirection="row" gap={1}>
            <Text bold color={theme.monitor.agents}>
              {'✦ BRAIN'}
            </Text>
            <Text color={statusStyle.color}>{statusStyle.icon}</Text>
            <Text dimColor>{entry.source}</Text>
            <Text dimColor>·</Text>
            <Text bold color={riskColor}>
              {entry.risk}
            </Text>
          </Box>
          <Box paddingLeft={indentWidth}>
            <Text color={theme.textPrimary}>{entry.question}</Text>
          </Box>
          {entry.decision ? (
            <Box paddingLeft={indentWidth} marginTop={1}>
              <Text>
                <Text bold color={statusStyle.color}>
                  {'↳ Decision: '}
                </Text>
                <Text color={theme.textPrimary}>{entry.decision}</Text>
              </Text>
            </Box>
          ) : null}
          {entry.rationale ? (
            <Box paddingLeft={indentWidth} marginTop={1}>
              <Text dimColor>{entry.rationale}</Text>
            </Box>
          ) : null}
          {entry.outcome ? (
            <Box paddingLeft={indentWidth} marginTop={1}>
              <Text>
                <Text bold color={statusStyle.color}>
                  {'✓ Outcome: '}
                </Text>
                <Text color={theme.textPrimary}>{entry.outcome}</Text>
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'confirm':
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.warn}
          paddingX={1}
          marginY={1}
        >
          <Text bold color={theme.warn}>
            {'⚠ Confirm: '}
            {entry.toolName}
          </Text>
          <Text dimColor>Waiting for y / n / a / d...</Text>
        </Box>
      );
    case 'banner':
      return (
        <Banner
          entry={entry}
          termWidth={termWidth}
          {...(termHeight === undefined ? {} : { termHeight })}
        />
      );
    case 'subagent': {
      // Quiet single-line fleet/delegate chrome: no heavy colored rail and no
      // vertical margin that punches holes between history items. Role color
      // stays on the icon + label only.
      const lines = entry.text.split('\n');
      return (
        <Box flexDirection="column" marginX={0} marginY={0} paddingLeft={0}>
          <Text>
            <Text color={theme.borderSubtle}>│ </Text>
            <Text color={entry.agentColor}>{entry.icon}</Text>
            <Text> </Text>
            <Text bold color={entry.agentColor}>
              {entry.agentLabel}
            </Text>
            <Text> </Text>
            <Text color={theme.textSecondary}>{lines[0] ?? ''}</Text>
            {entry.detail ? (
              <>
                <Text color={theme.textMuted}>{'  ·  '}</Text>
                <Text color={theme.textMuted}>{entry.detail}</Text>
              </>
            ) : null}
          </Text>
          {lines.slice(1).map((line, i) => (
            <Text key={i}>
              <Text color={theme.borderSubtle}>│ </Text>
              <Text color={theme.textMuted}>{line}</Text>
            </Text>
          ))}
        </Box>
      );
    }
  }
});

/**
 * Compact magenta-bordered panel rendering SAGE memory-injection lines
 * appended to a tool result. Renders nothing when `sageLines` is empty.
 *
 * Layout:
 *
 *   ┌ 🧠 SAGE MEMORY INJECTED · <tool>  N memories ────────────────┐
 *   │ [kind][importance]                                                │
 *   │     text body (wrapped to panel width)                            │
 *   │     id: mem_…  anchor: pkg/path  relation: about_file            │
 *   │     tags: t1, t2, t3                                              │
 *   │ [next memory …]                                                    │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Each memory is parsed by `parseSageMemoryLine` and rendered as key/value
 * rows instead of the raw `[kind] <memory id="…">text</memory> (anchor) […]`
 * blob. Lines that fail to parse fall back to the literal text so a future
 * SAGE format change cannot silently drop data.
 */
function SageMemoryBlock({
  sageLines,
  toolName,
  stats,
}: {
  // `HistoryEntry.sageLines` is optional — replayed entries recover the block
  // inline from `output` via `extractSageBlock`, so the structured form may be
  // absent. Guard before slicing; an empty/null block means "no panel" here,
  // not "renderer crash".
  sageLines?: string[] | undefined;
  toolName: string;
  stats?: string | undefined;
}): React.ReactElement | null {
  if (!sageLines || sageLines.length < 2) return null;
  const memoryLines = sageLines.slice(1);
  if (memoryLines.length === 0) return null;
  return (
    <Box
      flexDirection="column"
      marginY={0}
      borderStyle="single"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={0}
    >
      <Box flexDirection="row">
        <Text bold color={theme.accent}>
          {`🧠 SAGE MEMORY INJECTED · ${toolName}  `}
        </Text>
        <Text dimColor>
          {`${memoryLines.length} ${memoryLines.length === 1 ? 'memory' : 'memories'}${
            stats ? ` · ${stats}` : ''
          }`}
        </Text>
      </Box>
      {memoryLines.map((line, i) => {
        const parsed = parseSageMemoryLine(line);
        if (!parsed) {
          return (
            <Text key={i} color={theme.accent} dimColor wrap="truncate-end">
              {line}
            </Text>
          );
        }
        return <SageMemoryRow key={i} parsed={parsed} index={i} />;
      })}
    </Box>
  );
}

/** One parsed memory, rendered as a structured key/value row block. */
function SageMemoryRow({
  parsed,
  index,
}: {
  parsed: ParsedSageMemoryLine;
  index: number;
}): React.ReactElement {
  const labelText = parsed.labels.length > 0 ? parsed.labels.map((l) => `[${l}]`).join('') : '[memory]';
  const tagText = parsed.tags && parsed.tags.length > 0 ? parsed.tags.join(', ') : undefined;
  return (
    <Box flexDirection="column" marginTop={index > 0 ? 1 : 0}>
      <Text bold color={theme.accent}>
        {labelText}
      </Text>
      <Text color={theme.textPrimary}>{parsed.text}</Text>
      <Box flexDirection="row" flexWrap="wrap">
        <SageKv label="id" value={parsed.id} />
        {parsed.anchor ? <SageKv label="anchor" value={parsed.anchor} /> : null}
        {parsed.relation ? <SageKv label="relation" value={parsed.relation} /> : null}
        {tagText ? <SageKv label="tags" value={tagText} /> : null}
      </Box>
    </Box>
  );
}

/** Compact key/value row used inside `SageMemoryRow`. */
function SageKv({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box flexDirection="row" marginRight={2}>
      <Text dimColor>{`${label}: `}</Text>
      <Text color={theme.textSecondary}>{value}</Text>
    </Box>
  );
}
