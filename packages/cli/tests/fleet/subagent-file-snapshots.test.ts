/**
 * Subagent file mutations must reach the parent's rewind chain.
 *
 * A subagent's `write`/`edit`/`patch` calls change the user's real working
 * tree. `/rewind` undoes changes from `file_snapshot` events, and
 * `DefaultSessionRewinder` reads exactly one transcript — the session being
 * rewound. Both subagent writer shapes used to drop `recordFileChange` on the
 * floor (the parent-proxy shim no-opped it; the per-subagent journal wrote it
 * to a file the rewinder never opens), so a subagent's edits survived a rewind
 * with nothing in the transcript admitting it.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type { SessionEvent, SessionWriter } from '@wrongstack/core/types';
import {
  createParentSubagentSessionWriter,
  withParentFileSnapshots,
} from '../../src/fleet/host-session-writer.js';

let tmp: string;
let store: DefaultSessionStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-subagent-snap-'));
  store = new DefaultSessionStore({ dir: tmp });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const edit = (file: string) => ({
  path: file,
  action: 'modified' as const,
  before: 'before',
  after: 'after',
});

async function snapshotPaths(id: string): Promise<string[]> {
  const data = await store.load(id);
  return data.events
    .filter(
      (e: SessionEvent): e is Extract<SessionEvent, { type: 'file_snapshot' }> =>
        e.type === 'file_snapshot',
    )
    .flatMap((e) => e.files.map((f) => f.path));
}

describe('subagent session writers — rewind evidence', () => {
  it('files the proxy shim`s changes against the parent prompt index', async () => {
    const parent = await store.create({ id: 'leader', model: 'm', provider: 'p' });
    await parent.writeCheckpoint(3, 'do the thing');
    const sub: SessionWriter = createParentSubagentSessionWriter(parent);

    sub.recordFileChange(edit(path.join(tmp, 'touched-by-sub.ts')));
    await parent.close();

    const data = await store.load('leader');
    const snapshots = data.events.filter((e) => e.type === 'file_snapshot');
    expect(snapshots).toHaveLength(1);
    // The prompt that spawned the subagent is the one a user would rewind to.
    expect((snapshots[0] as Extract<SessionEvent, { type: 'file_snapshot' }>).promptIndex).toBe(3);
    expect(await snapshotPaths('leader')).toEqual([path.join(tmp, 'touched-by-sub.ts')]);
  });

  it('mirrors a per-subagent journal`s changes onto the parent', async () => {
    const parent = await store.create({ id: 'leader2', model: 'm', provider: 'p' });
    await parent.writeCheckpoint(0, 'delegate');
    const own = await store.create({ id: 'sub-agent-1', model: 'm', provider: 'p' });
    await own.writeCheckpoint(0, 'subagent work');
    const sub = withParentFileSnapshots(own, parent);

    // Everything other than the file record still goes to the subagent's own
    // journal — the wrapper adds an authority, it does not redirect one.
    await sub.append({ type: 'user_input', ts: new Date().toISOString(), content: 'sub prompt' });
    sub.recordFileChange(edit(path.join(tmp, 'shared.ts')));
    await own.close();
    await parent.close();

    expect(await snapshotPaths('leader2')).toEqual([path.join(tmp, 'shared.ts')]);
    expect(await snapshotPaths('sub-agent-1')).toEqual([path.join(tmp, 'shared.ts')]);
    const subData = await store.load('sub-agent-1');
    expect(subData.events.some((e) => e.type === 'user_input')).toBe(true);
    const parentData = await store.load('leader2');
    expect(parentData.events.some((e) => e.type === 'user_input')).toBe(false);
  });

  it('does not double-record when the subagent writer IS the parent', async () => {
    const parent = await store.create({ id: 'leader3', model: 'm', provider: 'p' });
    await parent.writeCheckpoint(0, 'solo');
    const sub = withParentFileSnapshots(parent, parent);

    sub.recordFileChange(edit(path.join(tmp, 'once.ts')));
    await parent.close();

    expect(await snapshotPaths('leader3')).toEqual([path.join(tmp, 'once.ts')]);
  });
});
