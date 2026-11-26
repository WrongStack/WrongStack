import { createHash } from 'node:crypto';
import type {
  SessionHistoryPageOptions,
  SessionSummary,
} from '@wrongstack/contracts/types/session';

export function historyPageOptions(options: SessionHistoryPageOptions = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw Error('Invalid history page.');
  const limit = options.limit ?? 100,
    offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw Error('History pages require a size of 1–200 and a non-negative offset.');
  if (
    options.excludeId !== undefined &&
    (typeof options.excludeId !== 'string' || options.excludeId.length > 1024)
  )
    throw Error('Invalid excluded history identity.');
  if (
    options.anchorId !== undefined &&
    (typeof options.anchorId !== 'string' ||
      !options.anchorId ||
      options.anchorId.length > 1024 ||
      offset !== 0)
  )
    throw Error('A history anchor requires an exact identity and no offset.');
  if (
    options.expectedRevision !== undefined &&
    (typeof options.expectedRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(options.expectedRevision))
  )
    throw Error('Invalid history page revision.');
  if (offset > 0 && !options.expectedRevision)
    throw Error('History continuation requires its catalog revision.');
  return {
    limit,
    offset,
    excludeId: options.excludeId ?? '',
    expectedRevision: options.expectedRevision,
    anchorId: options.anchorId,
  };
}
export function historyPageOffset(
  ids: readonly string[],
  options: ReturnType<typeof historyPageOptions>,
) {
  if (!options.anchorId) return options.offset;
  const index = ids.indexOf(options.anchorId);
  if (index < 0)
    throw Error('The recorded session is no longer in this project catalog. Reload history.');
  return Math.floor(index / options.limit) * options.limit;
}
export function historyPageRevision(ids: readonly string[], excludeId: string) {
  return createHash('sha256')
    .update(JSON.stringify(['history-page-v1', excludeId, ids]))
    .digest('hex');
}
export function checkHistoryPageRevision(
  revision: string,
  expected: string | undefined,
  offset: number,
  total: number,
) {
  if ((expected !== undefined && revision !== expected) || offset > total)
    throw Error('The session catalog changed. Reload history before continuing.');
}
export function historyPageFromSummaries(
  rows: SessionSummary[],
  raw: SessionHistoryPageOptions = {},
  budget = 10000,
) {
  const options = historyPageOptions(raw);
  const filtered = rows.filter((row) => row.id !== options.excludeId);
  const safeBudget =
    typeof budget === 'number' && Number.isFinite(budget) && budget >= 0
      ? Math.floor(budget)
      : 10000;
  const pool = filtered.slice(0, safeBudget),
    revision = historyPageRevision(
      pool.map((row) => row.id),
      options.excludeId,
    );
  const offset = historyPageOffset(
    pool.map((row) => row.id),
    options,
  );
  checkHistoryPageRevision(revision, options.expectedRevision, offset, pool.length);
  const sessions = pool.slice(offset, offset + options.limit);
  const end = offset + sessions.length;
  return {
    sessions,
    total: pool.length,
    offset,
    limit: options.limit,
    nextOffset: end < pool.length ? end : null,
    revision,
    truncated: filtered.length > safeBudget,
  };
}
