import type React from 'react';
import { Box, Text } from '../../ink.js';
import { sanitizeTerminalText } from '../../terminal-width.js';
import { theme } from '../../theme.js';
import { type ParsedSageMemoryLine, parseSageMemoryLine } from './utils.js';

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
export function SageMemoryBlock({
  sageLines,
  toolName,
  stats,
  compact = false,
}: {
  // `HistoryEntry.sageLines` is optional — replayed entries recover the block
  // inline from `output` via `extractSageBlock`, so the structured form may be
  // absent. Guard before slicing; an empty/null block means "no panel" here,
  // not "renderer crash".
  sageLines?: string[] | undefined;
  toolName: string;
  stats?: string | undefined;
  /**
   * Compact (opt-in): one magenta chip with count + first preview.
   * Full (default): bordered panel with every memory row. The bordered form
   * is the canonical SAGE surface and is asserted by every render test in
   * `tests/glob-sage-render.test.tsx` and `tests/sage-memory-block-render.test.tsx`.
   */
  compact?: boolean | undefined;
}): React.ReactElement | null {
  if (!sageLines || sageLines.length < 2) return null;
  const memoryLines = sageLines.slice(1);
  if (memoryLines.length === 0) return null;

  if (compact) {
    const first = parseSageMemoryLine(memoryLines[0] ?? '');
    const preview = first
      ? sanitizeTerminalText(first.text).slice(0, 72)
      : sanitizeTerminalText(memoryLines[0] ?? '').slice(0, 72);
    const labels = first?.labels?.length ? first.labels.map((l) => `[${l}]`).join('') : '';
    return (
      <Box flexDirection="row" marginTop={0}>
        <Text color={theme.accent}>
          {`🧠 ${memoryLines.length} SAGE · ${toolName}`}
          {stats ? ` · ${stats}` : ''}
          {labels ? ` ${labels}` : ''}
          {preview ? ` — ${preview}${preview.length >= 72 ? '…' : ''}` : ''}
        </Text>
      </Box>
    );
  }

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
              {sanitizeTerminalText(line)}
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
  const labelText =
    parsed.labels.length > 0 ? parsed.labels.map((l) => `[${l}]`).join('') : '[memory]';
  const tagText = parsed.tags && parsed.tags.length > 0 ? parsed.tags.join(', ') : undefined;
  return (
    <Box flexDirection="column" marginTop={index > 0 ? 1 : 0}>
      <Text bold color={theme.accent}>
        {labelText}
      </Text>
      <Text color={theme.textPrimary}>{sanitizeTerminalText(parsed.text)}</Text>
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
export function SageKv({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box flexDirection="row" marginRight={2}>
      <Text dimColor>{`${label}: `}</Text>
      <Text color={theme.textSecondary}>{sanitizeTerminalText(value)}</Text>
    </Box>
  );
}
