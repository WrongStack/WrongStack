import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnnotationsStore } from '../../src/storage/annotations-store.js';

// Covers add() input validation, resolve() of a missing id, and list() of a
// wrong-version / corrupt annotations file.

let dir: string;
let store: AnnotationsStore;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-annot-'));
  store = new AnnotationsStore({ dir });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('annotations-store — extra coverage', () => {
  it('rejects empty text', async () => {
    await expect(
      store.add({ sessionId: 's', atEventIndex: 0, authorId: 'a', text: '   ' }),
    ).rejects.toThrow(/non-empty/i);
  });

  it('rejects text over the length cap', async () => {
    await expect(
      store.add({ sessionId: 's', atEventIndex: 0, authorId: 'a', text: 'x'.repeat(2001) }),
    ).rejects.toThrow(/exceeds/i);
  });

  it('rejects a negative / non-integer atEventIndex', async () => {
    await expect(
      store.add({ sessionId: 's', atEventIndex: -1, authorId: 'a', text: 'ok' }),
    ).rejects.toThrow(/atEventIndex/i);
    await expect(
      store.add({ sessionId: 's', atEventIndex: 1.5, authorId: 'a', text: 'ok' }),
    ).rejects.toThrow(/atEventIndex/i);
  });

  it('resolve returns null for an unknown annotation id', async () => {
    expect(
      await store.resolve({ sessionId: 's', annotationId: 'does-not-exist', resolvedBy: 'p' }),
    ).toBeNull();
  });

  it('list returns [] for a wrong-version annotations file', async () => {
    await fs.writeFile(
      path.join(dir, 's.annotations.json'),
      JSON.stringify({ version: 99, annotations: [] }),
      'utf8',
    );
    expect(await store.list('s')).toEqual([]);
  });

  it('list returns [] for a corrupt annotations file', async () => {
    await fs.writeFile(path.join(dir, 'c.annotations.json'), '{ not json', 'utf8');
    expect(await store.list('c')).toEqual([]);
  });
});
