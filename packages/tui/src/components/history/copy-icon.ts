import type { HistoryEntry } from '../../history-entry.js';

/**
 * Glyph rendered as the clickable copy affordance on copyable chat cards.
 * Chosen from the Dingbats range (U+274F), which the TUI's tool-glyph table
 * already relies on for guaranteed single-cell monospace width — East-Asian
 * "ambiguous width" glyphs would desync the icon column the hit test records.
 */
export const COPY_ICON = '❏';

/**
 * Width in terminal cells the copy icon occupies when rendered. The hit test in
 * the mouse handler treats the icon column plus this span as the target.
 */
export const COPY_ICON_WIDTH = 1;

/**
 * Inspect affordance (U+2315). Same single-cell contract as COPY_ICON.
 * A blank column sits between copy and this glyph so the two hits are
 * not adjacent.
 */
export const INSPECT_ICON = '⌕';
export const INSPECT_ICON_WIDTH = 1;
/** Blank cells between the copy glyph and the inspect glyph. */
export const INSPECT_ICON_GAP = 1;
/** History-band column of inspect relative to the copy column. */
export const INSPECT_COL_OFFSET = COPY_ICON_WIDTH + INSPECT_ICON_GAP;

/** Serialize structured cards without letting cyclic or bigint tool input break rendering/copying. */
function stringifyRaw(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (typeof item === 'bigint') return item.toString();
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
        }
        return item;
      },
      2,
    );
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function textOrRaw(text: string, entry: HistoryEntry): string {
  return text.length > 0 ? text : stringifyRaw(entry);
}

/**
 * Return the most useful lossless clipboard representation for any retained
 * history card. Text cards preserve their original text, pasted user cards use
 * the full paste, tool cards use their unformatted result, and cards without a
 * natural text body fall back to raw JSON.
 */
export function copyableTextForEntry(entry: HistoryEntry): string {
  switch (entry.kind) {
    case 'user':
      return textOrRaw(entry.pasteContent || entry.text, entry);
    case 'assistant':
    case 'thinking':
    case 'info':
    case 'warn':
    case 'error':
    case 'turn-summary':
      return textOrRaw(entry.text, entry);
    case 'tool':
      return textOrRaw(entry.copyOutput ?? entry.output ?? '', entry);
    case 'memory-lifecycle':
      return textOrRaw([entry.label, entry.detail].filter(Boolean).join('\n'), entry);
    case 'brain':
      return textOrRaw(
        [entry.question, entry.decision, entry.rationale, entry.outcome]
          .filter(Boolean)
          .join('\n\n'),
        entry,
      );
    case 'subagent':
      return textOrRaw([entry.text, entry.detail].filter(Boolean).join('\n'), entry);
    case 'memory-activation':
    case 'model-switch':
    case 'banner':
    case 'confirm':
      return stringifyRaw(entry);
  }
}

/** Raw, ordered representation of every entry rendered inside one compact tool-group box. */
export function copyableTextForEntries(entries: readonly HistoryEntry[]): string {
  return stringifyRaw(
    entries.map((entry) => {
      if (entry.kind !== 'tool' || entry.copyOutput === undefined) return entry;
      const { copyOutput, ...displayEntry } = entry;
      return { ...displayEntry, output: copyOutput };
    }),
  );
}

/** Every retained history entry has either natural text or a raw JSON fallback. */
export function isCopyableEntry(_entry: HistoryEntry): boolean {
  return true;
}

/** Tool cards (and live tool streams) expose the inspect overlay. */
export function isInspectableEntry(entry: HistoryEntry): boolean {
  return entry.kind === 'tool';
}

/** Full inspect document: status, input, and the canonical untruncated result. */
export function inspectTextForEntry(entry: HistoryEntry): string {
  if (entry.kind !== 'tool') return copyableTextForEntry(entry);
  const status = entry.ok ? 'ok' : 'failed';
  const dur = Number.isFinite(entry.durationMs) ? ` · ${entry.durationMs}ms` : '';
  const size =
    typeof entry.outputBytes === 'number' && entry.outputBytes > 0
      ? ` · ${entry.outputBytes}B`
      : '';
  const parts = [`${entry.name}  ${status}${dur}${size}`];
  if (entry.input !== undefined) {
    parts.push('', 'INPUT', stringifyRaw(entry.input));
  }
  const output = entry.copyOutput ?? entry.output ?? '';
  parts.push('', 'OUTPUT', output.length > 0 ? output : '(empty)');
  return parts.join('\n');
}

export function inspectTextForEntries(entries: readonly HistoryEntry[]): string {
  if (entries.length === 1) {
    const only = entries[0];
    return only ? inspectTextForEntry(only) : '';
  }
  return entries
    .map((entry, index) => `── ${index + 1}/${entries.length} ──\n${inspectTextForEntry(entry)}`)
    .join('\n\n');
}

export function inspectTitleForEntries(entries: readonly HistoryEntry[]): string {
  const tools = entries.filter((entry): entry is Extract<HistoryEntry, { kind: 'tool' }> => {
    return entry.kind === 'tool';
  });
  if (tools.length === 0) return 'Inspect';
  if (tools.length === 1) return tools[0]?.name ?? 'Inspect';
  const names = [...new Set(tools.map((tool) => tool.name))];
  return names.length === 1 ? `${names[0]} × ${tools.length}` : `${tools.length} tools`;
}
