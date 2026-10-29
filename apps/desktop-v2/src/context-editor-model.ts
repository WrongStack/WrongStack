import { entries, record } from './engine-values';

export interface ContextEditorRow {
  index: number;
  role: string;
  tokens: number;
  preview: string;
  warnings: string[];
  /** Assistant replies that must leave together with this user message. */
  paired: number[];
}

export interface ContextEditorSnapshot {
  revision: string;
  messages: Record<string, unknown>[];
  rows: ContextEditorRow[];
  totalTokens: number;
}

/** Reads the engine snapshot, refusing one without a revision or message list. */
export function contextEditorSnapshot(value: Record<string, unknown>): ContextEditorSnapshot {
  const revision = value['revision'];
  if (typeof revision !== 'string' || !revision || !Array.isArray(value['messages']))
    throw Error('The engine returned an unreadable context snapshot. Reload before editing.');
  const messages = value['messages'] as Record<string, unknown>[];
  const rows = entries(value['messageBreakdown']).map((row) => ({
    index: Number(row['index']),
    role: String(row['role'] ?? ''),
    tokens: Number(row['tokens'] ?? 0),
    preview: String(row['preview'] ?? ''),
    warnings: entries(row['warnings']).map((warning) =>
      String(warning['message'] ?? warning['code'] ?? ''),
    ),
    paired: Array.isArray(row['pairedAssistantIndices'])
      ? (row['pairedAssistantIndices'] as unknown[]).filter(Number.isInteger).map(Number)
      : [],
  }));
  if (rows.length !== messages.length || rows.some((row, index) => row.index !== index))
    throw Error('The context snapshot breakdown does not match its messages. Reload first.');
  return {
    revision,
    messages,
    rows,
    totalTokens: Number(record(value['readonlyContext'])['totalTokens'] ?? 0),
  };
}

/**
 * The messages that will actually be removed: the chosen ones plus the assistant replies paired
 * with any chosen user message, which the engine requires to leave together.
 */
export function removalSet(snapshot: ContextEditorSnapshot, chosen: ReadonlySet<number>) {
  const removed = new Set(chosen);
  for (const index of chosen)
    for (const pair of snapshot.rows[index]?.paired ?? []) removed.add(pair);
  return removed;
}

/** The engine proposal for whole-message removals: remaining messages plus the removal plan. */
export function removalProposal(
  snapshot: ContextEditorSnapshot,
  removed: ReadonlySet<number>,
): {
  baseRevision: string;
  messages: Record<string, unknown>[];
  removals: { messageIndex: number }[];
  allowRepair: true;
} {
  const indices = [...removed].sort((a, b) => a - b);
  return {
    baseRevision: snapshot.revision,
    messages: structuredClone(snapshot.messages.filter((_, index) => !removed.has(index))),
    removals: indices.map((messageIndex) => ({ messageIndex })),
    allowRepair: true,
  };
}

/** One line describing an engine validation or apply metric pair. */
export function metricsSummary(result: Record<string, unknown>): string {
  const before = record(result['before']),
    after = record(result['after']);
  if (!Object.keys(after).length) return '';
  const tokens = (value: unknown) => Number(value ?? 0).toLocaleString();
  return `${before['messages']} → ${after['messages']} messages · ~${tokens(before['fullRequestTokens'])} → ~${tokens(after['fullRequestTokens'])} request tokens`;
}

/** A text removal inside one message: its string content, or one of its text blocks. */
export interface ContextTextRange {
  messageIndex: number;
  blockIndex?: number;
  start: number;
  end: number;
}

/** The editable texts of a message: its string content or each text block. */
export function messageTexts(
  message: Record<string, unknown>,
): { blockIndex?: number; text: string }[] {
  const content = message['content'];
  if (typeof content === 'string') return [{ text: content }];
  return entries(content).flatMap((block, blockIndex) =>
    block['type'] === 'text' && typeof block['text'] === 'string'
      ? [{ blockIndex, text: block['text'] }]
      : [],
  );
}

/**
 * Adds a text range unless it is empty or overlaps a range already chosen on the same text.
 * Returns the new list, or a reason the range was not added.
 */
export function withTextRange(
  ranges: readonly ContextTextRange[],
  next: ContextTextRange,
): ContextTextRange[] | string {
  if (next.end <= next.start) return 'Select some text to remove first.';
  const sameTarget = ranges.filter(
    (range) => range.messageIndex === next.messageIndex && range.blockIndex === next.blockIndex,
  );
  if (sameTarget.some((range) => next.start < range.end && range.start < next.end))
    return 'That text overlaps a part already chosen for removal.';
  return [...ranges, next];
}

/**
 * Whole-message removals for a plan with text ranges: editing a user message also removes the
 * replies it produced, as the engine requires. Ranges inside removed messages are dropped.
 */
export function rangePlan(
  snapshot: ContextEditorSnapshot,
  removed: ReadonlySet<number>,
  ranges: readonly ContextTextRange[],
) {
  const whole = new Set(removed);
  for (const range of ranges)
    if (snapshot.rows[range.messageIndex]?.role === 'user')
      for (const pair of snapshot.rows[range.messageIndex]?.paired ?? []) whole.add(pair);
  return { whole, ranges: ranges.filter((range) => !whole.has(range.messageIndex)) };
}

/** The engine proposal for whole-message removals and text ranges together. */
export function editProposal(
  snapshot: ContextEditorSnapshot,
  removed: ReadonlySet<number>,
  ranges: readonly ContextTextRange[],
) {
  const plan = rangePlan(snapshot, removed, ranges);
  const messages = structuredClone(snapshot.messages);
  const targets = new Map<string, ContextTextRange[]>();
  for (const range of plan.ranges) {
    const key = `${range.messageIndex}:${range.blockIndex ?? ''}`;
    targets.set(key, [...(targets.get(key) ?? []), range]);
  }
  for (const group of targets.values()) {
    const first = group[0]!;
    const message = messages[first.messageIndex]!;
    const cut = (text: string) => {
      let next = '';
      let cursor = 0;
      for (const range of [...group].sort((a, b) => a.start - b.start)) {
        next += text.slice(cursor, range.start);
        cursor = range.end;
      }
      return next + text.slice(cursor);
    };
    if (first.blockIndex === undefined) message['content'] = cut(String(message['content']));
    else {
      const block = record(entries(message['content'])[first.blockIndex]);
      block['text'] = cut(String(block['text'] ?? ''));
      (message['content'] as unknown[])[first.blockIndex] = block;
    }
  }
  const indices = [...plan.whole].sort((a, b) => a - b);
  return {
    baseRevision: snapshot.revision,
    messages: messages.filter((_, index) => !plan.whole.has(index)),
    removals: [
      ...indices.map((messageIndex) => ({ messageIndex })),
      ...plan.ranges.map((range) => ({ ...range })),
    ],
    allowRepair: true as const,
  };
}

/**
 * Request tokens expected after the edit, before the engine checks it: removed messages take
 * their reported tokens, removed text about one token per 3.5 characters (the engine's own
 * estimator). The engine's checked figure replaces this once the plan is validated.
 */
export function draftTokenEstimate(
  snapshot: ContextEditorSnapshot,
  removed: ReadonlySet<number>,
  ranges: readonly ContextTextRange[],
): number {
  const plan = rangePlan(snapshot, removed, ranges);
  let tokens = snapshot.totalTokens;
  for (const index of plan.whole) tokens -= snapshot.rows[index]?.tokens ?? 0;
  for (const range of plan.ranges) tokens -= Math.ceil((range.end - range.start) / 3.5);
  return Math.max(0, tokens);
}
