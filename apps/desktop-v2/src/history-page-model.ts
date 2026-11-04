import { record } from './engine-values';
export interface HistoryCatalogPage {
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
  revision: string;
  truncated: boolean;
}
const englishPageErrors = {
  different: 'This runtime returned a different history page.',
  invalid: 'This runtime returned an invalid history page. Update or refresh the project runtime.',
};
export function readHistoryPage(
  value: unknown,
  requestedOffset: number | null,
  limit: number,
  count: number,
  words = englishPageErrors,
): HistoryCatalogPage {
  const page = record(value);
  const offset = page['offset'];
  const total = page['total'],
    next = page['nextOffset'],
    revision = page['revision'];
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (requestedOffset !== null && offset !== requestedOffset) ||
    (requestedOffset === null && offset % limit !== 0)
  )
    throw Error(words.different);
  const end = offset + count;
  if (
    page['limit'] !== limit ||
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < end ||
    count > limit ||
    typeof revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(revision) ||
    typeof page['truncated'] !== 'boolean' ||
    next !== (end < total ? end : null) ||
    (next !== null && (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= offset))
  )
    throw Error(words.invalid);
  return {
    offset,
    limit,
    total,
    nextOffset: next as number | null,
    revision,
    truncated: page['truncated'],
  };
}
