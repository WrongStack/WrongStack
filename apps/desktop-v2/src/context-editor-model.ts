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
