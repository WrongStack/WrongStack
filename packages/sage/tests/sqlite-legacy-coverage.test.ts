import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';
import type { SageStatus } from '../src/types.js';

let directory: string;
let stores: SqliteSageStore[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sage-legacy-'));
  stores = [];
});

afterEach(async () => {
  for (const store of stores) store.close();
  await fs.rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createStore(events?: { emit: ReturnType<typeof vi.fn> }): SqliteSageStore {
  const store = new SqliteSageStore({
    projectRoot: directory,
    events: events as never,
  });
  stores.push(store);
  return store;
}

describe('SQLite legacy MemoryStore compatibility coverage', () => {
  it('formats, lists, searches, and forgets legacy memories', async () => {
    const events = { emit: vi.fn() };
    const store = createStore(events);
    await store.remember('Agent instruction', 'project-agents', {
      type: 'convention',
      priority: 'critical',
      tags: ['agents'],
      source: 'AGENTS.md',
      confidence: 0.9,
    });
    await store.remember('Project decision', 'project-memory', {
      type: 'decision',
      priority: 'high',
      tags: ['build', 'pnpm'],
    });
    await store.remember('User preference', 'user-memory', {
      type: 'preference',
      priority: 'low',
    });
    await store.remember('Default metadata');

    const all = await store.readAll();
    expect(all).toContain('## Project AGENTS.md');
    expect(all).toContain('## Project Memory');
    expect(all).toContain('## User Memory');
    expect(all).toContain('[convention|critical]');
    expect(all).toContain('#build #pnpm');
    await expect(store.read('project-memory')).resolves.toContain('Project decision');
    await expect(store.list()).resolves.toHaveLength(2);
    await expect(store.list('project-memory', 1)).resolves.toHaveLength(1);
    await expect(store.list('project-memory', -1)).resolves.toEqual([]);
    await expect(store.search('decision')).resolves.toHaveLength(1);
    await expect(store.search('missing')).resolves.toEqual([]);

    expect(await store.forget('')).toBe(0);
    expect(await store.forget('does-not-match')).toBe(0);
    expect(await store.forget('pnpm')).toBe(1);
    expect(events.emit).toHaveBeenCalledWith(
      'memory.forgotten',
      expect.objectContaining({ removed: 1 }),
    );
  });

  it('protects permanent memories during forget and clear operations', async () => {
    const store = createStore();
    const permanent = await store.rememberSage({
      text: 'Permanent legacy memory',
      scope: 'project',
      legacyScope: 'project-memory',
      persistence: 'permanent',
      tags: ['protected'],
    });
    await store.remember('Mutable project memory', 'project-memory');
    await store.remember('Mutable user memory', 'user-memory');

    expect(await store.forget(permanent.id, 'project-memory')).toBe(0);
    await store.clear('project-memory');
    expect((await store.getSage(permanent.id))?.status).toBe('active');
    expect(await store.search('Mutable project')).toEqual([]);
    expect(await store.search('Mutable user', 'user-memory')).toHaveLength(1);

    await store.clear();
    expect((await store.getSage(permanent.id))?.status).toBe('active');
    expect(await store.search('Mutable user', 'user-memory')).toEqual([]);
    expect((await store.readAudit(50)).map((entry) => entry.event)).toContain(
      'memory.clear_skipped_permanent',
    );
  });

  it('consolidates mutable duplicates while leaving permanent-only groups untouched', async () => {
    const events = { emit: vi.fn() };
    const store = createStore(events);
    const first = await store.rememberSage({
      text: 'First duplicate',
      legacyScope: 'project-memory',
      tags: ['first'],
      importance: 0.9,
    });
    const second = await store.rememberSage({
      text: 'Second duplicate',
      legacyScope: 'project-memory',
      tags: ['second'],
      importance: 0.5,
    });
    await store.updateSage(second.id, { text: first.text });
    await store.consolidate('project-memory');

    const results = await store.listSage(['active', 'superseded']);
    expect(results.filter((memory) => memory.status === 'active')).toHaveLength(1);
    expect(results.filter((memory) => memory.status === 'superseded')).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith(
      'memory.consolidated',
      expect.objectContaining({ removed: 1 }),
    );

    const permanent = await store.rememberSage({
      text: 'Permanent duplicate',
      legacyScope: 'project-memory',
      persistence: 'permanent',
    });
    const mutable = await store.rememberSage({
      text: 'Mutable duplicate',
      legacyScope: 'project-memory',
    });
    await store.updateSage(mutable.id, { text: permanent.text });
    await store.consolidate('project-memory');
    expect((await store.getSage(permanent.id))?.status).toBe('active');
    expect((await store.getSage(mutable.id))?.status).toBe('active');
  });

  it('imports markdown bullets and covers alias edge cases', async () => {
    const store = createStore();
    await expect(
      store.importLegacy('heading\n- first imported\n* second imported\n- \nplain'),
    ).resolves.toEqual({ imported: 2, skipped: 1, files: 0 });
    await expect(store.listSage()).resolves.toHaveLength(2);
    await expect(store.listSage([])).resolves.toHaveLength(2);
    await expect(store.listSage(['invalid' as SageStatus])).resolves.toEqual([]);
    await expect(store.getSage('missing')).resolves.toBeNull();
    await store.recordInjection([], 'empty');
    await store.recordUse([], 'empty');
    await expect(store.drainMutations()).resolves.toBeUndefined();
  });

  it('initializes before deleting from a fresh store', async () => {
    const store = createStore();

    await expect(
      store.deleteSage('missing', 'fresh-store deletion', { force: true }),
    ).rejects.toThrow('SAGE "missing" not found.');
  });

  it('enforces delete authorization, supports hard delete, and is idempotent', async () => {
    const store = createStore();
    const normal = await store.rememberSage({ text: 'Delete guard' });
    await expect(store.deleteSage('missing')).rejects.toThrow('not found');
    await expect(store.deleteSage(normal.id)).rejects.toThrow('explicit authorization');
    await expect(store.hardDeleteSage(normal.id)).resolves.toEqual({
      deleted: true,
      id: normal.id,
    });
    await expect(store.deleteSage(normal.id, 'again', { force: true })).resolves.toBeUndefined();

    const permanent = await store.rememberSage({
      text: 'Permanent delete guard',
      persistence: 'permanent',
    });
    await expect(store.deleteSage(permanent.id)).rejects.toThrow("marked 'permanent'");
    await expect(
      store.deleteSage(permanent.id, 'operator override', {
        force: true,
        neverInject: true,
      }),
    ).resolves.toBeUndefined();
    expect((await store.getSage(permanent.id))?.contextPolicy).toBe('never');
  });

  it('keeps close idempotent before and after initialization', async () => {
    const uninitialized = createStore();
    expect(() => uninitialized.close()).not.toThrow();
    expect(() => uninitialized.close()).not.toThrow();

    const initialized = createStore();
    await initialized.initialize();
    initialized.close();
    expect(() => initialized.close()).not.toThrow();
  });
});
