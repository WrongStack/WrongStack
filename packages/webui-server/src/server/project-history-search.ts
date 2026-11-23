import { createHash } from 'node:crypto';
import type { SessionStore, SessionSummary } from '@wrongstack/contracts/types';
import { foldCaseSameLength } from './search-fold.js';
import { findTranscriptMatches, transcriptRevision } from './session-transcript.js';
import { errMessage } from './ws-utils.js';

/** One bounded read batch. The caller requests further batches to continue a search. */
export async function searchProjectHistory(
  store: Pick<SessionStore, 'list' | 'load' | 'listPage'>,
  raw: unknown,
  carrierId: string,
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('Invalid conversation search.');
  const options = raw as Record<string, unknown>;
  const query =
    typeof options['query'] === 'string' ? foldCaseSameLength(options['query'].trim()) : '';
  if (query.length < 2 || query.length > 500)
    throw Error('Enter 2–500 characters to search conversations.');
  const role = options['role'] ?? '';
  if (typeof role !== 'string' || !['', 'user', 'assistant', 'system'].includes(role))
    throw Error('Invalid conversation search role.');
  const window = options['window'] ?? 100;
  const cursor = options['cursor'] ?? 0;
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0)
    throw Error('Invalid conversation search window or cursor.');
  let rows: SessionSummary[],
    total: number,
    end: number,
    nextCursor: number | null,
    revision: string;
  let catalogRevision: string | undefined,
    truncated = false;
  if (window === 'catalog') {
    if (!store.listPage)
      throw Error('Update the project runtime to search the full conversation catalog.');
    if (cursor > 0 && typeof options['catalogRevision'] !== 'string')
      throw Error('Conversation search continuation requires its catalog revision.');
    const page = await store.listPage({
      limit: 5,
      offset: cursor,
      excludeId: carrierId,
      ...(typeof options['catalogRevision'] === 'string'
        ? { expectedRevision: options['catalogRevision'] }
        : {}),
    });
    rows = page.sessions;
    total = page.total;
    end = page.offset + rows.length;
    nextCursor = page.nextOffset;
    catalogRevision = page.revision;
    truncated = page.truncated;
    revision = createHash('sha256')
      .update(JSON.stringify([query, role, window, catalogRevision]))
      .digest('hex');
  } else {
    if (typeof window !== 'number' || !Number.isSafeInteger(window) || window < 1 || window > 500)
      throw Error('Invalid conversation search window or cursor.');
    const pool = (await store.list(window)).filter((row) => row.id !== carrierId);
    total = pool.length;
    if (cursor > total)
      throw Error('Conversation search continuation requires its catalog revision.');
    end = Math.min(cursor + 5, total);
    rows = pool.slice(cursor, end);
    nextCursor = end < total ? end : null;
    revision = createHash('sha256')
      .update(JSON.stringify([query, role, window, pool.map((row) => row.id)]))
      .digest('hex');
  }
  if (options['expectedRevision'] !== undefined && options['expectedRevision'] !== revision)
    throw Error('The session catalog changed. Start a new conversation search.');
  if (cursor > 0 && options['expectedRevision'] === undefined)
    throw Error('Conversation search continuation requires its catalog revision.');
  const results = [];
  const errors: { id: string; message: string }[] = [];
  for (const summary of rows) {
    try {
      const data = await store.load(summary.id);
      const found = findTranscriptMatches(data.messages, query, role);
      if (found.matching)
        results.push({
          id: summary.id,
          title: summary.name || summary.title || 'Recorded conversation',
          provider: summary.provider,
          model: summary.model,
          startedAt: summary.startedAt,
          revision: transcriptRevision(data.messages),
          ...found,
        });
    } catch (error) {
      errors.push({ id: summary.id, message: errMessage(error) });
    }
  }
  return {
    query,
    role,
    revision,
    total,
    scanned: end,
    nextCursor,
    ...(catalogRevision ? { catalogRevision, truncated } : {}),
    results,
    errors,
  };
}
