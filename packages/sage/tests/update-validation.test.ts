import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

let tempDir: string;
let store: SqliteSageStore;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-update-validation-'));
  store = new SqliteSageStore({ projectRoot: tempDir });
  await store.initialize();
});

afterAll(async () => {
  store.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('updateSage field validation (2026-08-02)', () => {
  it('rejects an unknown persistence class on update', async () => {
    const memory = await store.rememberSage({
      text: 'update validation probe alpha',
      kind: 'fact',
      importance: 0.5,
    });
    await expect(
      store.updateSage(memory.id, { persistence: 'temporary' as never }),
    ).rejects.toThrow(/persistence/);
  });

  it('rejects an unknown kind on update', async () => {
    const memory = await store.rememberSage({
      text: 'update validation probe beta',
      kind: 'fact',
      importance: 0.5,
    });
    await expect(
      store.updateSage(memory.id, { kind: 'bogus_kind' as never }),
    ).rejects.toThrow(/kind/);
  });

  it('accepts valid persistence and kind updates', async () => {
    const memory = await store.rememberSage({
      text: 'update validation probe gamma',
      kind: 'fact',
      importance: 0.5,
    });
    const updated = await store.updateSage(memory.id, {
      persistence: 'permanent',
      kind: 'decision',
    });
    expect(updated.persistence).toBe('permanent');
    expect(updated.kind).toBe('decision');
  });

  it('rejects an unknown persistence class on remember (types.ts promise)', async () => {
    await expect(
      store.rememberSage({
        text: 'update validation probe delta',
        kind: 'fact',
        importance: 0.5,
        persistence: 'ephemeral' as never,
      }),
    ).rejects.toThrow(/persistence/);
  });
});
