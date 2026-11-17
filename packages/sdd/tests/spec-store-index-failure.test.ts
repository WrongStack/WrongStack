import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SpecStore } from '../src/spec-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const realRename = vi.mocked(fs.rename).getMockImplementation()!;

it.each(['create', 'update', 'delete'] as const)(
  'recovers its spec index after an index commit fails during %s',
  async (operation) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'spec-index-failure-'));
    try {
      const store = new SpecStore({ baseDir: dir });
      const control = await store.createDraft('Control');
      const created = { ...control, id: 'durable', title: 'Durable', version: '1.0.0' };
      const failure = Object.assign(new Error('injected index ENOSPC'), { code: 'ENOSPC' });
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (String(to) === join(dir, '_index.json')) throw failure;
        return realRename(from, to);
      });
      const mutation =
        operation === 'create'
          ? store.save(created)
          : operation === 'update'
            ? store.update(control.id, { title: 'Updated', version: '1.0.0' })
            : store.delete(control.id);
      await expect(mutation).rejects.toBe(failure);
      vi.mocked(fs.rename).mockImplementation(realRename);
      const recovered = new SpecStore({ baseDir: dir });
      const list = await recovered.list();
      if (operation === 'create') {
        expect((await recovered.load('durable'))?.version).toBe('1.0.0');
        expect(new Set(list.map((entry) => entry.id))).toEqual(new Set([control.id, 'durable']));
      } else if (operation === 'update') {
        expect((await recovered.load(control.id))?.version).toBe('1.0.0');
        expect(list).toMatchObject([{ id: control.id, title: 'Updated', version: '1.0.0' }]);
      } else {
        expect(await recovered.load(control.id)).toBeNull();
        expect(list).toEqual([]);
      }
      const next = await store.createDraft('Next');
      expect((await recovered.list()).some((entry) => entry.id === next.id)).toBe(true);
    } finally {
      vi.mocked(fs.rename).mockImplementation(realRename);
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
