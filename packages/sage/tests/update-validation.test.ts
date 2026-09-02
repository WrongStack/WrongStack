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
    await expect(store.updateSage(memory.id, { kind: 'bogus_kind' as never })).rejects.toThrow(
      /kind/,
    );
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

describe('createCandidate field validation (B3, 2026-08-02)', () => {
  it('rejects an unknown kind via validateRememberInput', async () => {
    await expect(
      store.createCandidate({
        text: 'candidate validation probe alpha',
        kind: 'bogus_kind' as never,
      }),
    ).rejects.toThrow(/kind/);
  });

  it('rejects an unknown scope', async () => {
    await expect(
      store.createCandidate({
        text: 'candidate validation probe beta',
        scope: 'galaxy' as never,
      }),
    ).rejects.toThrow(/scope/);
  });

  it('rejects an unknown persistence class (defense-in-depth beyond the type)', async () => {
    // 'persistence' is omitted from CreateCandidateInput (candidates are
    // proposals) — the whole-object cast is deliberate: the RUNTIME path still
    // receives it and must reject via validateRememberInput.
    await expect(
      store.createCandidate({
        text: 'candidate validation probe gamma',
        persistence: 'temporary',
      } as never),
    ).rejects.toThrow(/persistence/);
  });

  it('accepts a valid candidate', async () => {
    const candidate = await store.createCandidate({
      text: 'candidate validation probe delta',
      kind: 'fact',
      importance: 0.5,
    });
    expect(candidate.text).toBe('candidate validation probe delta');
    expect(candidate.status).toBe('pending');
    expect(candidate.kind).toBe('fact');
    expect(candidate.importance).toBe(0.5);
  });
});

describe('candidate typed review metadata (E1, 2026-08-02)', () => {
  it('correlates pending reviews via targetMemoryId and typed fields', async () => {
    const memory = await store.rememberSage({
      text: 'e1 correlation probe file note',
      kind: 'file_note',
      importance: 0.5,
      anchors: [{ type: 'file', path: 'src/e1-probe.ts' }],
    });
    await store.createCandidate({
      text: 'review this memory',
      kind: 'memory_review',
      importance: 0.4,
      targetMemoryId: memory.id,
      reviewReason: 'noise',
      suggestedAction: 'delete',
    });

    const found = await store.findMemoriesForFile('src/e1-probe.ts', {});
    const match = found.primaryMatches.find((m) => m.memory.id === memory.id);
    expect(match?.pendingReview?.reason).toBe('noise');
    expect(match?.pendingReview?.suggestedAction).toBe('delete');
  });

  it('does not correlate candidates that only carry a legacy source: user tag', async () => {
    const memory = await store.rememberSage({
      text: 'e1 correlation probe second file note',
      kind: 'file_note',
      importance: 0.5,
      anchors: [{ type: 'file', path: 'src/e1-probe-2.ts' }],
    });
    await store.createCandidate({
      text: 'tag-only proposal',
      kind: 'memory_review',
      importance: 0.4,
      tags: [`source:${memory.id}`],
    });

    const found = await store.findMemoriesForFile('src/e1-probe-2.ts', {});
    const match = found.primaryMatches.find((m) => m.memory.id === memory.id);
    expect(match?.pendingReview).toBeUndefined();
  });
});
