import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { expect, it } from 'vitest';
import { toSessionHistoryEntries } from '../src/server/session-history.js';

async function removeFixture(root: string) {
  const target = resolve(root);
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('wrongstack-history-content-')
  )
    throw Error('Unsafe fixture cleanup');
  await rm(target, { recursive: true, force: true });
}

import { withSessionContentState } from '../src/server/session-history-content.js';

it('annotates actual journal content independently of summary counters, without changing legacy rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrongstack-history-content-'));
  const store = new DefaultSessionStore({ dir: root });
  const filled = await store.create({ id: 'filled', title: '', provider: 'test', model: 'test' });
  const empty = await store.create({ id: 'empty', title: '', provider: 'test', model: 'test' });
  try {
    await filled.append({
      type: 'message_appended',
      ts: new Date().toISOString(),
      version: 1,
      message: { role: 'user', content: 'Actual retained text' },
    });
    await filled.flush();
    await filled.close();
    await empty.close();
    const rows = toSessionHistoryEntries(await store.list(100), 'carrier');
    const result = await withSessionContentState(rows, store);
    expect(result.find((row) => row.id === 'filled')?.isEmpty).toBe(false);
    expect(result.find((row) => row.id === 'empty')?.isEmpty).toBe(true);
    expect(rows.every((row) => !('isEmpty' in row))).toBe(true);
    expect(
      (await withSessionContentState(rows, {})).every((row) => row.isEmpty === undefined),
    ).toBe(true);
    expect(
      (
        await withSessionContentState(rows, {
          isEmpty: async () => {
            throw Error('Unreadable');
          },
        })
      ).every((row) => row.isEmpty === undefined),
    ).toBe(true);
  } finally {
    await filled.close();
    await empty.close();
    await removeFixture(root);
  }
});

// 2026-11-13: a journal that was never written (0 bytes, no lifecycle line — an engine's boot
// session a resume left open) failed the strict check and showed in every history list even
// with empty journals hidden. Summary counters cannot decide it, so the file size does.
it('treats a never-written journal as empty, and a counter-less journal with content as not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrongstack-history-content-'));
  const store = new DefaultSessionStore({ dir: root });
  const unwritten = await store.create({ id: 'unwritten', title: '', provider: 't', model: 't' });
  const filled = await store.create({ id: 'filled', title: '', provider: 't', model: 't' });
  try {
    await filled.append({
      type: 'message_appended',
      ts: new Date().toISOString(),
      version: 1,
      message: { role: 'user', content: 'Actual retained text' },
    });
    await filled.flush();
    const rows = toSessionHistoryEntries(await store.list(100), 'carrier');
    const result = await withSessionContentState(rows, store);
    expect(result.find((row) => row.id === 'unwritten')?.isEmpty).toBe(true);
    expect(result.find((row) => row.id === 'filled')?.isEmpty).toBe(false);
    expect(await store.isEmpty('unwritten'), 'the sweep still keeps it').toBe(false);
  } finally {
    await unwritten.close();
    await filled.close();
    await removeFixture(root);
  }
});
