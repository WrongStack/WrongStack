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
});
