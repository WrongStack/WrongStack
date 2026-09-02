import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { SpecStore } from '../src/spec-store.js';

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `spec-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

describe('SpecStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  it('creates and loads a spec', async () => {
    const store = new SpecStore({ baseDir: dir });
    const spec = await store.createDraft('Test Feature', 'Some overview');
    expect(spec.title).toBe('Test Feature');
    expect(spec.overview).toBe('Some overview');
    expect(spec.status).toBe('draft');

    const loaded = await store.load(spec.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Test Feature');
  });

  it('lists saved specs', async () => {
    const store = new SpecStore({ baseDir: dir });
    await store.createDraft('Spec A');
    await store.createDraft('Spec B');

    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list.map((e) => e.title).sort()).toEqual(['Spec A', 'Spec B']);
  });

  it('updates a spec', async () => {
    const store = new SpecStore({ baseDir: dir });
    const spec = await store.createDraft('Draft');
    const updated = await store.update(spec.id, { title: 'Updated', version: '1.0.0' });
    expect(updated!.title).toBe('Updated');
    expect(updated!.version).toBe('1.0.0');

    const loaded = await store.load(spec.id);
    expect(loaded!.title).toBe('Updated');
  });

  it('deletes a spec', async () => {
    const store = new SpecStore({ baseDir: dir });
    const spec = await store.createDraft('To Delete');
    const deleted = await store.delete(spec.id);
    expect(deleted).toBe(true);

    const loaded = await store.load(spec.id);
    expect(loaded).toBeNull();
  });

  it('returns null for non-existent spec', async () => {
    const store = new SpecStore({ baseDir: dir });
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('checks existence', async () => {
    const store = new SpecStore({ baseDir: dir });
    const spec = await store.createDraft('Exists');
    expect(await store.exists(spec.id)).toBe(true);
    expect(await store.exists('nonexistent')).toBe(false);
  });

  it('persists index across instances', async () => {
    const store1 = new SpecStore({ baseDir: dir });
    await store1.createDraft('Persistent');

    const store2 = new SpecStore({ baseDir: dir });
    const list = await store2.list();
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe('Persistent');
  });

  it('returns empty list when no specs', async () => {
    const store = new SpecStore({ baseDir: dir });
    const list = await store.list();
    expect(list).toEqual([]);
  });
});
