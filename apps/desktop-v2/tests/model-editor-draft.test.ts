import { describe, expect, it } from 'vitest';
import { modelEditorDraft } from '../src/model-catalog-editor';
import {
  type ModelDraftStorage,
  ModelEditorDraftStore,
  type ModelEditorState,
  parseModelEditor,
  type SavedModelEditor,
} from '../src/model-editor-draft';

const editor = (name: string): ModelEditorState => {
  const initial = { modelsDev: { name: 'Saved definition', cost: { tiers: [{ future: true }] } } };
  const baseline = modelEditorDraft('namespace/model', initial);
  const draft = structuredClone(baseline);
  draft.text['name'] = name;
  draft.numbers['cost.input'] = '-1';
  return { originalId: 'namespace/model', initial, baseline, draft };
};
function memory() {
  let revision = 0,
    value: SavedModelEditor | null = null;
  const writes: Array<SavedModelEditor | null> = [];
  const storage: ModelDraftStorage = {
    get: async () => ({ revision, value: structuredClone(value) }),
    save: async (next, expected) => {
      if (expected !== revision) throw Error('DRAFT_CONFLICT');
      writes.push(structuredClone(next));
      value = structuredClone(next);
      return ++revision;
    },
  };
  return { storage, writes };
}
describe('native model draft ownership and lifecycle', () => {
  it('restores the full invalid-in-progress form and original saved baseline without applying it', async () => {
    const db = memory(),
      a = new ModelEditorDraftStore(db.storage, 'one');
    await a.load();
    a.edit(editor('Unfinished'));
    await a.flush();
    const b = new ModelEditorDraftStore(db.storage, 'one');
    await b.load();
    expect(b.snapshot().value).toEqual(editor('Unfinished'));
    expect(b.snapshot()).toMatchObject({ ready: true, dirty: false, error: '' });
    const other = new ModelEditorDraftStore(db.storage, 'other');
    await other.load();
    expect(other.snapshot()).toMatchObject({ ready: false, value: null });
    expect(other.snapshot().error).toContain('another provider');
    expect(parseModelEditor(null, 'one')).toBeNull();
    expect(() => parseModelEditor(db.writes[0], 'other')).toThrow(/another provider/);
    for (const value of [
      {},
      { version: 2 },
      { version: 1, providerId: 'one', editor: { draft: {} } },
    ])
      expect(() => parseModelEditor(value, 'one')).toThrow(/unsupported format/);
  });
  it('serializes saves and persists edits entered while an earlier save is in flight', async () => {
    const db = memory();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const a = new ModelEditorDraftStore(
      {
        ...db.storage,
        save: async (...args) => {
          if (first) {
            first = false;
            entered();
            await gate;
          }
          return db.storage.save(...args);
        },
      },
      'one',
    );
    await a.load();
    a.edit(editor('First'));
    await started;
    a.edit(editor('Latest'));
    release();
    await a.flush();
    expect(db.writes.map((row) => row?.editor.draft.text['name'])).toEqual(['First', 'Latest']);
    expect(a.snapshot()).toMatchObject({ dirty: false, revision: 2 });
  });
  it('refuses a stale writer and application preflight until an explicit reviewed choice', async () => {
    const db = memory(),
      a = new ModelEditorDraftStore(db.storage, 'one'),
      b = new ModelEditorDraftStore(db.storage, 'one');
    await Promise.all([a.load(), b.load()]);
    a.edit(editor('Window A'));
    await a.flush();
    b.edit(editor('Window B'));
    await b.flush();
    expect(b.snapshot().value?.draft.text['name']).toBe('Window B');
    expect(b.snapshot().review?.value?.draft.text['name']).toBe('Window A');
    await expect(b.prepare()).rejects.toThrow(/storage/);
    expect(await b.resolve('saved')).toBe(true);
    expect(b.snapshot().value?.draft.text['name']).toBe('Window A');
    expect(db.writes).toHaveLength(1);
    await expect(b.prepare(editor('Outdated rendered form'))).rejects.toThrow(/editor changed/);
  });
  it('rechecks the saved revision during comparison and protects newer peer changes during clear', async () => {
    const db = memory(),
      a = new ModelEditorDraftStore(db.storage, 'one'),
      b = new ModelEditorDraftStore(db.storage, 'one');
    await Promise.all([a.load(), b.load()]);
    a.edit(editor('A'));
    await a.flush();
    b.edit(editor('B'));
    await b.flush();
    a.edit(editor('A newer'));
    await a.flush();
    expect(await b.resolve('local')).toBe(false);
    expect(b.snapshot().review?.value?.draft.text['name']).toBe('A newer');
    expect(await b.resolve('local')).toBe(true);
    expect((await db.storage.get()).value).toMatchObject({
      editor: { draft: { text: { name: 'B' } } },
    });
    await expect(a.clear()).rejects.toThrow(/changed before applying/);
    expect(a.snapshot().value?.draft.text['name']).toBe('A newer');
    expect((await db.storage.get()).revision).toBe(3);
    expect(await a.resolve('saved')).toBe(true);
    await a.clear();
    expect((await db.storage.get()).value).toBeNull();
  });
  it('retains the editor and reviewed peer version when a save races with cleanup', async () => {
    const db = memory();
    let race = false;
    const a = new ModelEditorDraftStore(
      {
        ...db.storage,
        save: async (value, revision) => {
          if (value === null && race)
            await db.storage.save(
              { version: 1, providerId: 'one', editor: editor('Peer during clear') },
              revision,
            );
          return db.storage.save(value, revision);
        },
      },
      'one',
    );
    await a.load();
    a.edit(editor('Local'));
    await a.flush();
    race = true;
    await expect(a.clear()).rejects.toThrow('DRAFT_CONFLICT');
    expect(a.snapshot().value?.draft.text['name']).toBe('Local');
    expect(a.snapshot().review?.value?.draft.text['name']).toBe('Peer during clear');
  });
  it('keeps the cleanup conflict visible when its first comparison read fails', async () => {
    const db = memory();
    let race = false;
    let failRead = false;
    const local = new ModelEditorDraftStore(
      {
        get: async () => {
          if (failRead) throw Error('Fixture cannot read the peer model draft');
          return db.storage.get();
        },
        save: async (value, revision) => {
          if (value === null && race) {
            await db.storage.save(
              { version: 1, providerId: 'one', editor: editor('Peer during clear') },
              revision,
            );
            failRead = true;
          }
          return db.storage.save(value, revision);
        },
      },
      'one',
    );
    await local.load();
    local.edit(editor('Local editor'));
    await local.flush();

    race = true;
    await expect(local.clear()).rejects.toThrow('DRAFT_CONFLICT');
    expect(local.snapshot().value?.draft.text['name']).toBe('Local editor');
    expect(local.snapshot()).toMatchObject({
      review: null,
      error: expect.stringContaining('Fixture cannot read the peer model draft'),
    });
    failRead = false;
    await local.compare();
    expect(local.snapshot().review?.value?.draft.text['name']).toBe('Peer during clear');
    expect(db.writes).toHaveLength(2);
  });

  it('never reports an invalid acknowledgement as saved or allows apply after a failed write', async () => {
    const db = memory(),
      a = new ModelEditorDraftStore({ ...db.storage, save: async () => 99 }, 'one');
    await a.load();
    a.edit(editor('Keep me'));
    await a.flush();
    expect(a.snapshot()).toMatchObject({ dirty: true, revision: 0 });
    await expect(a.prepare()).rejects.toThrow(/storage/);
    expect(a.snapshot().value?.draft.text['name']).toBe('Keep me');
  });
});
