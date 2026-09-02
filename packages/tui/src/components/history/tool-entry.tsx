import type React from 'react';
import { useMemo } from 'react';
import { langFromPath } from '../../highlight.js';
import { Box, Text } from '../../ink.js';
import { sanitizeTerminalText } from '../../terminal-width.js';
import { theme } from '../../theme.js';
import { getToolVisual } from '../../tool-glyph.js';
import {
  DiffBlock,
  DiffFileBlock,
  extractDiffPreview,
  extractMultiFileDiffs,
  formatDiffStats,
  formatMultiDiffSummary,
  summarizeMultiFileDiffs,
} from './code-block.js';
import { SageMemoryBlock } from './sage-memory-block.js';
import { ToolCard } from './tool-card.js';
import type { HistoryEntry } from './types.js';
import {
  fmtBytes,
  fmtTok,
  formatToolArgs,
  formatToolOutputSage,
  formatToolVisualOutput,
  shortenPath,
  stringOf,
  ToolOutputLines,
  tryParseJson,
} from './utils.js';

export function ToolEntry({
  entry,
  termWidth,
  multiDiffSummaryThreshold,
  showSageMemoryInject,
}: {
  entry: Extract<HistoryEntry, { kind: 'tool' }>;
  termWidth: number;
  multiDiffSummaryThreshold?: number | undefined;
  showSageMemoryInject?: boolean | undefined;
}): React.ReactElement {
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
      // MCP-style aliases share the edit/write result shapes; canonicalize
      // before extraction so they get diff previews (the mutation guard
      // below already recognizes the alias names).
      const diffSource =
        entry.name === 'replace_file_content'
          ? 'edit'
          : entry.name === 'write_to_file'
            ? 'write'
            : entry.name;
      const diff = entry.ok
        ? extractDiffPreview(diffSource, outputForFormatting, entry.input)
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
        if (
          name !== 'edit' &&
          name !== 'replace_file_content' &&
          name !== 'write' &&
          name !== 'write_to_file' &&
          name !== 'patch' &&
          name !== 'replace' &&
          name !== 'diff'
        ) {
          return undefined;
        }
        if (!entry.ok || (!diff && !multiDiffs)) return undefined;
        const inputObj =
          entry.input && typeof entry.input === 'object'
            ? (entry.input as Record<string, unknown>)
            : undefined;
        const outJson = tryParseJson(outputForFormatting.trim());
        const outObj =
          outJson && typeof outJson === 'object' ? (outJson as Record<string, unknown>) : undefined;
        // `created` lives in the JSON output shape; the serialized-text
        // shape carries it as a `created=true` field on the header line.
        const created =
          (name === 'write' || name === 'write_to_file') &&
          (outObj?.['created'] === true || /^[^\n]*\bcreated=true\b/.test(outputForFormatting));
        const verb = name === 'diff' ? 'Diff' : created ? 'Write' : 'Update';
        const outFiles = Array.isArray(outObj?.['files'])
          ? (outObj?.['files'] as unknown[])
          : undefined;
        const firstOutFile = outFiles && outFiles.length > 0 ? stringOf(outFiles[0]) : undefined;
        const path =
          stringOf(inputObj?.['path']) ??
          stringOf(inputObj?.['TargetFile']) ??
          stringOf(inputObj?.['file']) ??
          stringOf(inputObj?.['files']) ??
          stringOf(inputObj?.['a']) ??
          stringOf(outObj?.['path']) ??
          firstOutFile;
        const agg = multiDiffs ? summarizeMultiFileDiffs(multiDiffs) : undefined;
        const target = multiDiffs
          ? agg?.fileCount === 1
            ? multiDiffs[0]!.path
            : `${agg?.fileCount ?? multiDiffs.length} files`
          : (path ?? 'changes');
        return {
          verb,
          target,
          added: agg ? agg.added : (diff?.added ?? 0),
          removed: agg ? agg.removed : (diff?.removed ?? 0),
          lang: langFromPath(
            multiDiffs && multiDiffs.length > 1 ? '' : (multiDiffs?.[0]?.path ?? path ?? ''),
          ),
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
    const statsText = formatDiffStats(mutation.added, mutation.removed) ?? 'No line changes';
    const targetBudget = Math.max(24, termWidth - mutation.verb.length - 16);
    const hasCounts = mutation.added > 0 || mutation.removed > 0;
    const toolContentWidth = Math.max(1, termWidth - 2);
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
        {showSageMemoryInject !== false ? (
          <SageMemoryBlock sageLines={sageLines} toolName={entry.name} stats={entry.sageStats} />
        ) : null}
      </Box>
    );
  }
  const toolContentWidth = Math.max(1, termWidth - 2);
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
          <ToolOutputLines lines={visualLines} hasFollowingBlock={Boolean(diff || multiDiffs)} />
        ) : visualLines ? (
          <ToolOutputLines lines={visualLines} hasFollowingBlock={false} />
        ) : entry.resultRenderMode === 'simple' ? null : (
          outLines.map((line, i) => {
            const connector = i === outLines.length - 1 && !diff && !multiDiffs ? '  └─ ' : '  ├─ ';
            return (
              <Text key={i}>
                <Text color={color} dimColor>
                  {connector}
                </Text>
                <Text
                  dimColor={entry.ok && !line.startsWith('!')}
                  {...(!entry.ok || line.startsWith('!') ? { color: 'red' } : {})}
                >
                  {sanitizeTerminalText(line)}
                </Text>
              </Text>
            );
          })
        )}
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
      {showSageMemoryInject !== false ? (
        <SageMemoryBlock sageLines={sageLines} toolName={entry.name} stats={entry.sageStats} />
      ) : null}
    </Box>
  );
}
