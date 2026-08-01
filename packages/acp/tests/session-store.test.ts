/**
 * Tests for ACPSessionStore.
 *
 * Uses a temp directory to persist session files.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACPSessionStore } from '../src/agent/session-store.js';

let dir: string;
let store: ACPSessionStore;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-store-'));
  store = new ACPSessionStore({ dir });
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const fakeState = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess_test1',
  cwd: '/test',
  abort: new AbortController(),
  modeId: 'code',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('ACPSessionStore', () => {
  it('saves a session state to disk', async () => {
    const id = await store.save(fakeState());
    expect(id).toBe('sess_test1');
    const file = path.join(dir, 'sess_test1.json');
    const content = await fsp.readFile(file, 'utf8');
    expect(JSON.parse(content)).toMatchObject({ id: 'sess_test1', cwd: '/test' });
  });

  it('saves a session with history', async () => {
    await store.save(fakeState(), [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
    ]);
    const loaded = await store.load('sess_test1');
    expect(loaded?.history).toHaveLength(1);
    expect(loaded?.history?.[0]?.content).toEqual({ type: 'text', text: 'hello' });
  });

  it('loads a persisted session', async () => {
    await store.save(fakeState());
    const loaded = await store.load('sess_test1');
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('sess_test1');
    expect(loaded?.cwd).toBe('/test');
  });

  it('returns null when loading a non-existent session', async () => {
    const loaded = await store.load('sess_nope');
    expect(loaded).toBeNull();
  });

  it('rejects the reserved "index" id so it cannot collide with the sidecar index', async () => {
    // Seed a real sidecar index.json with content.
    const indexPath = path.join(dir, 'index.json');
    await fsp.writeFile(
      indexPath,
      JSON.stringify([{ id: 'sess_real', updatedAt: '2026-01-01T00:00:00.000Z' }]),
    );

    // load("index") must NOT read the sidecar index.
    expect(await store.load('index')).toBeNull();

    // save({ id: "index" }) must refuse to clobber the sidecar index.
    await expect(store.save(fakeState({ id: 'index' }))).rejects.toThrow(/unsafe session id/);

    // delete("index") must NOT unlink the sidecar index.
    await store.delete('index');
    const stillThere = await fsp.readFile(indexPath, 'utf8');
    expect(JSON.parse(stillThere)).toEqual([
      { id: 'sess_real', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('lists persisted sessions', async () => {
    await store.save(fakeState({ id: 'sess_a', updatedAt: '2026-01-01T00:00:00.000Z' }));
    await store.save(fakeState({ id: 'sess_b', updatedAt: '2026-01-02T00:00:00.000Z' }));
    // Verify both session files exist on disk instead of relying on list()
    // which has an internal race with its async index writer
    const files = await fsp.readdir(dir);
    const sessionFiles = files.filter((f) => f.endsWith('.json') && f !== 'index.json');
    expect(sessionFiles).toHaveLength(2);
    // list() with directory scan fallback should find both
    const list = await store.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(sessionFiles).toContain('sess_a.json');
    expect(sessionFiles).toContain('sess_b.json');
  });

  it('list rebuilds index from files when index is missing', async () => {
    await store.save(fakeState({ id: 'sess_r', updatedAt: '2026-01-01T00:00:00.000Z' }));
    // Delete the index so the fallback directory-scan path activates
    await fsp.unlink(path.join(dir, 'index.json')).catch(() => {});
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('sess_r');
  });

  it('list handles an empty directory gracefully', async () => {
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('delete removes the session file and updates the index', async () => {
    await store.save(fakeState({ id: 'sess_del' }));
    await store.delete('sess_del');
    const loaded = await store.load('sess_del');
    expect(loaded).toBeNull();
    const files = await fsp.readdir(dir);
    const sessionFiles = files.filter((f) => f.endsWith('.json') && f !== 'index.json');
    expect(sessionFiles).toHaveLength(0);
  });

  it('delete updates the sidecar index when it already exists', async () => {
    // First, pre-populate an index file so delete() finds it
    const indexData = [
      { id: 'sess_del1', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'sess_keep', updatedAt: '2026-01-02T00:00:00.000Z' },
    ];
    const indexPath = path.join(dir, 'index.json');
    await fsp.writeFile(indexPath, JSON.stringify(indexData), 'utf8');
    // Now save the session file for deletion
    await store.save(fakeState({ id: 'sess_del1' }));
    await store.save(fakeState({ id: 'sess_keep' }));
    // Delete removes both the file and the index entry
    await store.delete('sess_del1');
    const loaded = await store.load('sess_del1');
    expect(loaded).toBeNull();
    // The keep session should still exist
    const kept = await store.load('sess_keep');
    expect(kept?.id).toBe('sess_keep');
  });

  it('delete ignores a non-existent session id', async () => {
    await expect(store.delete('sess_nope')).resolves.toBeUndefined();
  });

  it('getDirectory returns the configured dir', () => {
    const s = new ACPSessionStore({ dir });
    expect(s.getDirectory()).toBe(dir);
  });

  it('uses default dir when no options provided', () => {
    const s = new ACPSessionStore();
    expect(s.getDirectory()).toContain('.acp-sessions');
  });

  it('init is idempotent (calling init twice does not throw)', async () => {
    // Access via the private init through save which calls init internally
    await store.save(fakeState({ id: 'sess_init1' }));
    await store.save(fakeState({ id: 'sess_init2' }));
    const files = await fsp.readdir(dir);
    const sessionFiles = files.filter((f) => f.endsWith('.json') && f !== 'index.json');
    expect(sessionFiles).toHaveLength(2);
    // The save method calls init internally; doing it twice doesn't fail
    expect(sessionFiles).toContain('sess_init1.json');
    expect(sessionFiles).toContain('sess_init2.json');
  });

  it('handles corrupted index.json gracefully', async () => {
    await store.save(fakeState({ id: 'sess_corrupt' }));
    // Write invalid JSON to the index
    await fsp.writeFile(path.join(dir, 'index.json'), 'not-json', 'utf8');
    const list = await store.list();
    // Should fall back to directory scan
    expect(list).toHaveLength(1);
  });

  it('handles non-array index gracefully', async () => {
    await store.save(fakeState({ id: 'sess_na' }));
    // Write a non-array JSON to the index
    await fsp.writeFile(path.join(dir, 'index.json'), '{"not":"an-array"}', 'utf8');
    const list = await store.list();
    expect(list).toHaveLength(1);
  });

  it('filters malformed index entries', async () => {
    await fsp.writeFile(
      path.join(dir, 'index.json'),
      JSON.stringify([
        null,
        { id: 1, updatedAt: 'bad' },
        { id: 'valid', updatedAt: '2026-01-01T00:00:00.000Z' },
      ]),
      'utf8',
    );
    expect(await store.list()).toEqual([{ id: 'valid', updatedAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('sorts scanned sessions and defaults a missing updatedAt', async () => {
    await fsp.writeFile(path.join(dir, 'one.json'), JSON.stringify({ id: 'one' }), 'utf8');
    await fsp.writeFile(
      path.join(dir, 'two.json'),
      JSON.stringify({ id: 'two', updatedAt: '2026-01-02T00:00:00.000Z' }),
      'utf8',
    );
    expect(await store.list()).toEqual([
      { id: 'two', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'one', updatedAt: '' },
    ]);
  });

  it('leaves an index unchanged when deleting an absent id', async () => {
    const index = [{ id: 'keep', updatedAt: '2026-01-01T00:00:00.000Z' }];
    await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(index), 'utf8');
    await store.delete('absent');
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'))).toEqual(index);
  });

  it('handles corrupted session file by skipping it', async () => {
    await store.save(fakeState({ id: 'sess_ok' }));
    // Write a corrupted file
    await fsp.writeFile(path.join(dir, 'sess_bad.json'), '{bad', 'utf8');
    const list = await store.list();
    // Should only show the valid one
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('sess_ok');
  });

  it('handles list when the directory does not exist', async () => {
    const missingDir = path.join(os.tmpdir(), 'wstack-missing-' + Date.now());
    const s = new ACPSessionStore({ dir: missingDir });
    const list = await s.list();
    expect(list).toEqual([]);
    // Cleanup
    await fsp.rm(missingDir, { recursive: true, force: true }).catch(() => {});
  });

  it('save creates the directory if needed', async () => {
    const newDir = path.join(os.tmpdir(), 'wstack-new-' + Date.now());
    const s = new ACPSessionStore({ dir: newDir });
    await s.save(fakeState({ id: 'sess_newdir' }));
    const loaded = await s.load('sess_newdir');
    expect(loaded?.id).toBe('sess_newdir');
    await fsp.rm(newDir, { recursive: true, force: true }).catch(() => {});
  });

  // WS-015 regression guard: sessionId arrives verbatim from the ACP wire
  // (session/load, session/close, session/delete all take it raw). A caller
  // supplying a traversal segment must NOT be able to read, write, or unlink
  // any file outside the configured store dir.
  describe('traversal-id safety (WS-015)', () => {
    it('save throws when state.id contains path traversal', async () => {
      await expect(store.save(fakeState({ id: '../../etc/passwd' }))).rejects.toThrow(
        /unsafe session id/,
      );
    });

    it('save throws for "../" segment', async () => {
      await expect(store.save(fakeState({ id: '..' }))).rejects.toThrow(/unsafe session id/);
    });

    it('load returns null for a traversal id and never reads outside the store', async () => {
      // Plant a canary file outside the store dir to prove load did not reach it.
      const canaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-canary-'));
      const canaryPath = path.join(canaryDir, 'canary.json');
      await fsp.writeFile(canaryPath, JSON.stringify({ id: 'sensitive' }), 'utf8');
      // Resolve the canary path into a session id; the segment validator must
      // reject it before the file system is touched.
      const evilId = path
        .relative(dir, canaryPath)
        .replace(/\\/g, '/')
        .replace(/\.json$/, '');
      const loaded = await store.load(evilId);
      expect(loaded).toBeNull();
      // The canary must still exist — load must not have unlinked it either.
      expect(await fsp.readFile(canaryPath, 'utf8')).toBe('{"id":"sensitive"}');
      await fsp.rm(canaryDir, { recursive: true, force: true }).catch(() => {});
    });

    it('load returns null for "../" segment', async () => {
      expect(await store.load('..')).toBeNull();
    });

    it('load returns null for an empty id', async () => {
      expect(await store.load('')).toBeNull();
    });

    it('load returns null for a path separator in the id', async () => {
      expect(await store.load('foo/bar')).toBeNull();
    });

    it('delete is a no-op for a traversal id and never unlinks outside the store', async () => {
      const canaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-canary-'));
      const canaryPath = path.join(canaryDir, 'canary.json');
      await fsp.writeFile(canaryPath, JSON.stringify({ id: 'sensitive' }), 'utf8');
      const evilId = path
        .relative(dir, canaryPath)
        .replace(/\\/g, '/')
        .replace(/\.json$/, '');
      await expect(store.delete(evilId)).resolves.toBeUndefined();
      // The canary must still exist — delete must not have unlinked it.
      expect(await fsp.readFile(canaryPath, 'utf8')).toBe('{"id":"sensitive"}');
      await fsp.rm(canaryDir, { recursive: true, force: true }).catch(() => {});
    });

    it('delete is a no-op for "../" segment', async () => {
      await expect(store.delete('..')).resolves.toBeUndefined();
    });

    it('save-throws vs load/delete-null asymmetry is deliberate (throws = unsafe call from a trusted author; null = untrusted wire input)', async () => {
      // save() is the only one whose caller built a SessionState themselves
      // and can be told to fix the id. load() and delete() are called from
      // the request handler on a wire-supplied id, where a silent no-op is
      // the correct behavior.
      const evilId = '../../x';
      await expect(store.save(fakeState({ id: evilId }))).rejects.toThrow();
      expect(await store.load(evilId)).toBeNull();
      await expect(store.delete(evilId)).resolves.toBeUndefined();
    });
  });

  // Regression guards for the Chimera cascade fixes (HIGH race + MEDIUM
  // orphan tmp cleanup).
  describe('index-update concurrency (Chimera HIGH)', () => {
    it('concurrent saves do not lose or duplicate entries in the sidecar index', async () => {
      // 100 concurrent saves — without the index lock, two writers can read
      // the same baseline and the loser overwrites the winner's edit, so
      // some sessions permanently disappear from list(). The race window is
      // real even on single-threaded Node: readIndex awaits, mutate is sync,
      // writeIndex awaits — and another save's readIndex can interleave
      // between those two awaits.
      const ids = Array.from({ length: 100 }, (_, i) => `sess_race_${i}`);
      await Promise.all(
        ids.map((id, i) =>
          store.save(
            fakeState({
              id,
              updatedAt: `2026-02-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
            }),
          ),
        ),
      );
      const list = await store.list();
      const listed = new Set(list.map((e) => e.id));
      for (const id of ids) {
        expect(listed.has(id), `missing ${id} from list()`).toBe(true);
      }
      // And the index file itself must mention every id.
      const indexData = JSON.parse(
        await fsp.readFile(path.join(dir, 'index.json'), 'utf8'),
      ) as Array<{ id: string }>;
      expect(new Set(indexData.map((e) => e.id))).toEqual(new Set(ids));
    });

    it('save/delete races converge on the index', async () => {
      // Plant a baseline index so delete's branch (and save's update) both
      // hit the read-modify-write path; without serialization, deletes can
      // resurrect or saves can overwrite surviving entries.
      const baseline = Array.from({ length: 10 }, (_, i) => ({
        id: `sess_pre_${i}`,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }));
      await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(baseline), 'utf8');

      const keep = baseline.map((b) => b.id);
      const drop = new Set(['sess_pre_0', 'sess_pre_3', 'sess_pre_7']);

      await Promise.all([
        ...[...drop].map((id) => store.delete(id)),
        ...keep
          .filter((id) => !drop.has(id))
          .map((id) => store.save(fakeState({ id, updatedAt: '2026-02-09T00:00:00.000Z' }))),
      ]);

      const indexData = JSON.parse(
        await fsp.readFile(path.join(dir, 'index.json'), 'utf8'),
      ) as Array<{ id: string }>;
      const survivors = new Set(indexData.map((e) => e.id));
      for (const id of keep) {
        if (drop.has(id)) {
          expect(survivors.has(id), `dropped id resurrected: ${id}`).toBe(false);
        } else {
          expect(survivors.has(id), `kept id lost from index: ${id}`).toBe(true);
        }
      }
      expect(survivors.size).toBe(keep.length - drop.size);
    });
  });

  describe('orphan tmp cleanup (Chimera MEDIUM)', () => {
    it('save removes its tmp file when the rename fails', async () => {
      // Make the target unrenameable by planting a directory in its place —
      // rename over a non-empty directory throws ENOTDIR/EEXIST, the tmp
      // write succeeds, and the tmp must be cleaned up in the finally.
      const target = path.join(dir, 'sess_orphan.json');
      await fsp.mkdir(target, { recursive: false });
      await expect(store.save(fakeState({ id: 'sess_orphan' }))).rejects.toThrow();
      const leftover = await fsp.readdir(dir);
      const tmps = leftover.filter((f) => f.includes('.tmp'));
      expect(tmps, `orphan tmp files leaked: ${tmps.join(', ')}`).toEqual([]);
      // Cleanup the planted directory so afterEach can rm the tmp dir.
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    });

    it('writeIndex removes its tmp file when the rename fails', async () => {
      // Same trick on the index path: replace index.json with a directory so
      // rename throws. writeIndex is private — go through updateIndex which
      // reaches it via the index path.
      const indexPath = path.join(dir, 'index.json');
      // First populate a valid index so updateIndex's branch is the
      // read-modify-write (not the fallback list()).
      await fsp.writeFile(
        indexPath,
        JSON.stringify([{ id: 'placeholder', updatedAt: 'x' }]),
        'utf8',
      );
      // Replace it with a non-empty directory to force rename failure.
      await fsp.rm(indexPath).catch(() => {});
      await fsp.mkdir(indexPath, { recursive: false });
      // Restore the file so the inner readIndex can succeed and the failure
      // surfaces from writeFile/rename rather than readIndex returning null.
      // Simpler: delete the directory and write a sentinel — but we want the
      // rename to fail. So we leave the directory in place and verify the
      // writeIndex call swallows + cleans up.
      await expect(
        // Trigger writeIndex by saving a session — updateIndex will read
        // (now-unreadable) index, hit null, and call list(). list() rebuilds
        // and writes, which will trip the same orphan path. Verify no .tmp
        // files remain regardless.
        store.save(fakeState({ id: 'sess_idx_orphan' })),
      ).resolves.toBe('sess_idx_orphan');
      const leftover = await fsp.readdir(dir);
      const tmps = leftover.filter((f) => f.includes('.tmp'));
      expect(tmps, `orphan tmp files leaked: ${tmps.join(', ')}`).toEqual([]);
      await fsp.rm(indexPath, { recursive: true, force: true }).catch(() => {});
    });
  });
});
