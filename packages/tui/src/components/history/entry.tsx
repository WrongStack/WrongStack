import { Box, Text } from '../../ink.js';
import { hasOpenTodos, type TodoItem } from '@wrongstack/core';
import React, { useEffect, useMemo } from 'react';
import { theme } from '../../theme.js';
import { getToolVisual } from '../../tool-glyph.js';
import { Banner } from './banner.js';
import { langFromPath } from '../../highlight.js';
import {
  DiffBlock,
  DiffFileBlock,
  extractDiffPreview,
  extractMultiFileDiffs,
  formatDiffStats,
  formatMultiDiffSummary,
  summarizeMultiFileDiffs,
} from './code-block.js';
import { parseNextSteps } from '../suggestions.js';
import type { ParsedNextStep } from '../suggestions.js';
import type { HistoryEntry } from './types.js';
import { AssistantBody, assistantContentWidth } from './assistant.js';
import {
  fmtBytes,
  fmtDuration,
  fmtTok,
  formatToolArgs,
  formatToolOutput,
  formatToolVisualOutput,
  shortenPath,
  stringOf,
  ToolOutputLines,
  tryParseJson,
} from './utils.js';

// ── Internal helpers ──

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
    case 'intervention':
      return { icon: '⚡', color: 'yellow' };
  }
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

// ── Entry ──

export const Entry = React.memo(function Entry({
  entry,
  termWidth,
  setSuggestions,
  autonomyMode,
  multiDiffSummaryThreshold,
  todos,
}: {
  entry: HistoryEntry;
  termWidth: number;
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
}): React.ReactElement {
  // Whether the agent still has open (pending/in_progress) todos. While it
  // does, finishing them takes priority over offering `<next_steps>` — both
  // the host callback (execution.ts → parseSuggestionsFromOutput) and this
  // render path gate on the same condition (b0970387) so they never disagree
  // about whether suggestions are available.
  const openTodos = hasOpenTodos(todos);

  // Parse next steps from assistant text — computed once, used only in
  // the assistant case. Must live at the top level (hooks rules).
  // Always parse (even when todos are open) so `stripped` is available and
  // the raw `<next_steps>` block never leaks into the message body; only the
  // panel rendering and the store write are gated below.
  const nextSteps = useMemo(() => {
    if (entry.kind !== 'assistant') return { steps: [] as ParsedNextStep[], stripped: '' };
    // strict=true: accepts 💡 emoji heading OR <next_steps> XML tag
    return parseNextSteps(entry.text, true);
  }, [entry.kind, (entry as never as { text?: string }).text]);

  // Store parsed next steps in the shared suggestion store (for /next and
  // auto-submit countdown). Strict=true accepts 💡 headings or <next_steps> XML tags
  // (consistent with what the TUI renders in the message body).
  // Skipped while todos are open — mirrors parseSuggestionsFromOutput, so the
  // store isn't repopulated here right after the host callback cleared it.
  // NOTE: Only assistant entries should have <next_steps> — subagents return
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
              {'USER  '}
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
                {'ASSISTANT'}
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
              <Box flexDirection="row">
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
                      <Text color="cyan" dimColor>  auto</Text>
                    ) : null}
                    {autonomyMode === 'auto' && i === 0 ? (
                      <Text color="cyan">{'  ⏩'}</Text>
                    ) : null}
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
      const {
        argSummary,
        outLines,
        visualLines,
        diff,
        multiDiffs,
        sizeChip,
        mutation,
      } = useMemo(() => {
        const argSummary = formatToolArgs(entry.name, entry.input);
        const outLines = formatToolOutput(
          entry.name,
          entry.output,
          entry.ok,
          entry.outputBytes,
          entry.outputLines,
        );
        const visualLines = formatToolVisualOutput(entry.name, entry.output, entry.ok, entry.input);
        const diff = entry.ok ? extractDiffPreview(entry.name, entry.output, entry.input) : undefined;
        const multiDiffs =
          entry.ok && !diff && (entry.name === 'replace' || entry.name === 'diff' || entry.name === 'patch')
            ? extractMultiFileDiffs(entry.name, entry.output, entry.input)
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
          const outJson = tryParseJson((entry.output ?? '').trim());
          const outObj =
            outJson && typeof outJson === 'object' ? (outJson as Record<string, unknown>) : undefined;
          // `created` lives in the JSON output shape; the serialized-text
          // shape carries it as a `created=true` field on the header line.
          const created =
            name === 'write' &&
            (outObj?.['created'] === true ||
              /^[^\n]*\bcreated=true\b/.test(entry.output ?? ''));
          const verb = created ? 'Write' : 'Update';
          const path = stringOf(inputObj?.['path']) ?? stringOf(outObj?.['path']);
          const target = multiDiffs
            ? multiDiffs.length === 1
              ? multiDiffs[0]!.path
              : `${multiDiffs.length} files`
            : (path ?? 'file');
          const agg = multiDiffs ? summarizeMultiFileDiffs(multiDiffs) : undefined;
          return {
            verb,
            target,
            added: agg ? agg.added : (diff?.added ?? 0),
            removed: agg ? agg.removed : (diff?.removed ?? 0),
            lang: langFromPath(multiDiffs ? '' : (path ?? '')),
          };
        })();
        return { argSummary, outLines, visualLines, diff, multiDiffs, sizeChip, mutation };
      }, [
        entry.name,
        entry.output,
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
        return (
          <Box flexDirection="column">
            <Text>
              <Text color={theme.success}>{'●'}</Text>
              <Text> </Text>
              <Text bold color="white">
                {`${mutation.verb}(${shortenPath(mutation.target, targetBudget)})`}
              </Text>
              <Text dimColor>{`  ·  ${fmtDuration(entry.durationMs)}`}</Text>
            </Text>
            <Text>
              <Text dimColor>{'  ⎿  '}</Text>
              <Text>{statsText}</Text>
            </Text>
            {entry.resultRenderMode !== 'simple' && multiDiffs ? (
              <Box flexDirection="column">
                {(() => {
                  const summaryLine = formatMultiDiffSummary(
                    summarizeMultiFileDiffs(multiDiffs),
                    multiDiffSummaryThreshold ?? -1,
                  );
                  return summaryLine ? (
                    <Text dimColor italic>{`  ${summaryLine}`}</Text>
                  ) : null;
                })()}
                {multiDiffs.map((item) => (
                  <DiffFileBlock
                    key={item.path}
                    path={item.path}
                    preview={item.preview}
                    useColor={theme.supportsBackground}
                    contentWidth={termWidth}
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
                contentWidth={termWidth}
              />
            ) : null}
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={color}>{glyph}</Text>
            <Text>{' '}</Text>
            <Text bold color={color}>
              {entry.name}
            </Text>
            {argSummary ? (
              <>
                <Text>{'  '}</Text>
                <Text dimColor>{argSummary}</Text>
              </>
            ) : null}
            <Text dimColor>{`  ·  ${fmtDuration(entry.durationMs)}`}</Text>
            {sizeChip ? <Text dimColor>{`  ·  ${sizeChip}`}</Text> : null}
          </Text>
          {visualLines && entry.resultRenderMode !== 'simple' ? (
            <ToolOutputLines lines={visualLines} hasFollowingBlock={Boolean(diff || multiDiffs)} />
          ) : visualLines ? (
            // `simple` mode: meta line stays visible (path + replacement
            // count for edit, line count for read, etc.) but the diff
            // body below is hidden. The user always gets a one-line
            // summary so the entry never looks empty.
            <ToolOutputLines lines={visualLines} hasFollowingBlock={false} />
          ) : entry.resultRenderMode === 'simple' ? null : (
            outLines.map((line, i) => (
              <Text key={i}>
                <Text dimColor>{i === outLines.length - 1 && !diff && !multiDiffs ? '  └─ ' : '  ├─ '}</Text>
                <Text
                  dimColor={entry.ok && !line.startsWith('!')}
                  {...(!entry.ok || line.startsWith('!') ? { color: 'red' } : {})}
                >
                  {line}
                </Text>
              </Text>
            ))
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
                  <Text dimColor italic>{summaryLine}</Text>
                ) : null;
              })()}
              {multiDiffs.map((item) => (
                <DiffFileBlock key={item.path} path={item.path} preview={item.preview} useColor={theme.supportsBackground} contentWidth={termWidth} />
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
              contentWidth={termWidth}
            />
          ) : null}
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
      return <Text dimColor={!hasAnsi}>{entry.text}</Text>;
    }
    case 'warn':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.warn}
          paddingLeft={1}
        >
          <Text color={theme.warn}>{entry.text}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box
          marginX={0}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={theme.error}
          paddingLeft={1}
        >
          <Text color={theme.error}>{entry.text}</Text>
        </Box>
      );
    case 'turn-summary':
      return <Text dimColor>{entry.text}</Text>;
    case 'brain': {
      const statusStyle = brainStatusStyle(entry.status);
      const riskColor = brainRiskColor(entry.risk);
      return (
        <Box
          flexDirection="column"
          marginX={0}
          marginY={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="magenta"
          paddingLeft={1}
        >
          <Box flexDirection="row" gap={1}>
            <Text bold color="magenta">
              BRAIN
            </Text>
            <Text color={statusStyle.color}>{statusStyle.icon}</Text>
            <Text dimColor>{entry.source}</Text>
            <Text dimColor>·</Text>
            <Text color={riskColor}>{entry.risk}</Text>
          </Box>
          <Text color="white">{entry.question}</Text>
          {entry.decision ? (
            <Text>
              <Text dimColor>Decision: </Text>
              <Text color={statusStyle.color}>{entry.decision}</Text>
            </Text>
          ) : null}
          {entry.rationale ? <Text dimColor>{entry.rationale}</Text> : null}
        </Box>
      );
    }
    case 'confirm':
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginY={1}
        >
          <Text bold color="yellow">
            ⚠ Confirm: {entry.toolName}
          </Text>
          <Text dimColor>Waiting for y / n / a / d...</Text>
        </Box>
      );
    case 'banner':
      return <Banner entry={entry} />;
    case 'subagent': {
      const lines = entry.text.split('\n');
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={entry.agentColor} bold>
              {`[${entry.agentLabel}]`}
            </Text>
            <Text> </Text>
            <Text color={entry.agentColor}>{entry.icon}</Text>
            <Text> </Text>
            <Text>{lines[0] ?? ''}</Text>
            {entry.detail ? (
              <>
                <Text dimColor>{'  ·  '}</Text>
                <Text dimColor>{entry.detail}</Text>
              </>
            ) : null}
          </Text>
          {lines.slice(1).map((line, i) => (
            <Text key={i}>
              <Text dimColor>{'  '}</Text>
              <Text>{line}</Text>
            </Text>
          ))}
        </Box>
      );
    }
  }
});
