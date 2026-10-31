/**
 * Boards the engine's run mirror keeps for Goal and SDD runs carry their origin in tags:
 * `goal` or `sdd`, `run:<id>`, `graph:<id>` and, for a Goal phase, `phase:<id>`.
 */
export interface BoardSource {
  system: 'goal' | 'sdd';
  runId: string;
  phaseId: string;
  /** The phase as a reader sees it: empty for a generated id. */
  phaseName: string;
}
export interface RunFocus {
  system: 'goal' | 'sdd';
  runId: string;
  phaseId?: string | undefined;
}

const tagValue = (tags: string[], prefix: string) =>
  tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? '';

export function boardSource(board: Record<string, unknown> | null | undefined): BoardSource | null {
  const tags = Array.isArray(board?.['tags'])
    ? board['tags'].filter((tag): tag is string => typeof tag === 'string')
    : [];
  const system = tags.includes('goal') ? 'goal' : tags.includes('sdd') ? 'sdd' : null;
  const runId = tagValue(tags, 'run:');
  const phaseId = tagValue(tags, 'phase:');
  return system && runId ? { system, runId, phaseId, phaseName: phaseLabel(phaseId) } : null;
}

/** A phase name worth showing; a generated id (a UUID) says nothing to the reader. */
export function phaseLabel(phaseId: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(phaseId)
    ? ''
    : phaseId;
}

/**
 * The board mirroring a run: the requested phase's board when there is one, otherwise the most
 * recently updated board of that run. Empty when the run has no board yet.
 */
export function runBoardId(boards: Record<string, unknown>[], focus: RunFocus): string {
  const matching = boards
    .map((board) => ({ board, source: boardSource(board) }))
    .filter(({ source }) => source?.system === focus.system && source.runId === focus.runId);
  const phase = focus.phaseId
    ? matching.find(({ source }) => source?.phaseId === focus.phaseId)
    : undefined;
  const newest = [...matching].sort((a, b) =>
    String(b.board['updatedAt'] ?? '').localeCompare(String(a.board['updatedAt'] ?? '')),
  )[0];
  return String((phase ?? newest)?.board['id'] ?? '');
}
