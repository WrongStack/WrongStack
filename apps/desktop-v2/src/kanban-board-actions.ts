import { entries, record } from './engine-values';

export interface BoardHistoryRow {
  id: string;
  boardId: string;
  boardTitle: string;
  label: string;
  detail: string;
  ts: string;
  actor: string;
}

/** History rows shown at most; the engine's log is append-only and can be long. */
export const BOARD_HISTORY_LIMIT = 200;

const LABELS: Record<string, string> = {
  'board.created': 'Created',
  'board.updated': 'Updated',
  'board.duplicated': 'Duplicated',
  'board.deleted': 'Deleted',
  'board.lifecycle.adopted': 'Lifecycle adopted',
};

function detail(type: string, after: Record<string, unknown>, note: string): string {
  if (type === 'board.updated') {
    const fields = Object.keys(after);
    return fields.length ? `Changed ${fields.join(', ')}` : '';
  }
  if (type === 'board.duplicated')
    return typeof after['sourceBoardTitle'] === 'string'
      ? `Copied from ${after['sourceBoardTitle']}`
      : '';
  if (type === 'board.created' && after['kind'] && after['kind'] !== 'project')
    return `Kind ${String(after['kind'])}`;
  return note;
}

/** The engine's board history, newest first and bounded; unknown event types keep their name. */
export function boardHistoryRows(value: unknown): BoardHistoryRow[] {
  return entries(value)
    .flatMap((item) => {
      if (typeof item['id'] !== 'string' || typeof item['type'] !== 'string') return [];
      const type = item['type'];
      const note = typeof item['note'] === 'string' ? item['note'] : '';
      return [
        {
          id: item['id'],
          boardId: String(item['boardId'] ?? ''),
          boardTitle: String(item['boardTitle'] ?? ''),
          label: LABELS[type] ?? type,
          detail: detail(type, record(item['after']), note),
          ts: typeof item['ts'] === 'string' ? item['ts'] : '',
          actor: typeof item['actor'] === 'string' ? item['actor'] : '',
        },
      ];
    })
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, BOARD_HISTORY_LIMIT);
}

/** Deleting a board is permanent, so the exact title must be typed (surrounding spaces aside). */
export function deleteConfirmed(typed: string, title: string): boolean {
  return !!title.trim() && typed.trim() === title.trim();
}
