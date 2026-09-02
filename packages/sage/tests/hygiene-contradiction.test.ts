import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

let tempDir: string;
let store: SqliteSageStore;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-contradiction-'));
  store = new SqliteSageStore({ projectRoot: tempDir });
  await store.initialize();
});

afterAll(async () => {
  store.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});

// Hygiene options that suppress every other pass so only contradiction
// detection can contribute to the report counters.
const CONTRADICTION_ONLY = {
  verify: false,
  retentionDays: 3650,
  archiveLowConfidenceAfterDays: 3650,
  archiveUnusedAfterDays: 3650,
  unusedMinInjections: 100,
} as const;

describe('hygiene contradiction detection (v1, 2026-08-02)', () => {
  it('flags active pairs whose texts differ only by a negation cue', async () => {
    const older = await store.rememberSage({
      text: 'the database driver caches query results',
      kind: 'fact',
      importance: 0.7,
    });
    const newer = await store.rememberSage({
      text: 'the database driver does not cache query results',
      kind: 'anti_pattern',
      importance: 0.7,
    });

    const report = await store.hygiene(CONTRADICTION_ONLY);
    expect(report.contradicted).toBe(1);

    // The newer member carries the contradicts link to the older one.
    const newerLoaded = await store.getSage(newer.id);
    expect(newerLoaded?.contradicts).toContain(older.id);

    // An 'investigate' review candidate points at the newer member.
    const pending = await store.listCandidates(false);
    const candidate = pending.find(
      (c) =>
        c.targetMemoryId === newer.id && c.reviewReason?.startsWith('Possible contradiction with'),
    );
    expect(candidate).toBeDefined();
    expect(candidate?.suggestedAction).toBe('investigate');
  });

  it('does not flag overlapping pairs without a negation cue, nor re-flag linked pairs', async () => {
    await store.rememberSage({
      text: 'the api caches response data now',
      kind: 'fact',
      importance: 0.6,
    });
    await store.rememberSage({
      text: 'the api caches response data here',
      kind: 'fact',
      importance: 0.6,
    });

    // First run: the no-cue pair contributes nothing; the negation pair from
    // the previous test is now linked via `contradicts`, so the re-run must
    // not flag it again (no candidate spam).
    const first = await store.hygiene(CONTRADICTION_ONLY);
    expect(first.contradicted).toBe(0);
    const second = await store.hygiene(CONTRADICTION_ONLY);
    expect(second.contradicted).toBe(0);
  });

  it('flags the canonical "not" superset and prevents the near-dup merge', async () => {
    const first = await store.rememberSage({
      text: 'the build is stable when tests pass',
      kind: 'fact',
      importance: 0.7,
    });
    const second = await store.rememberSage({
      text: 'the build is not stable when tests pass',
      kind: 'fact',
      importance: 0.7,
    });

    const report = await store.hygiene(CONTRADICTION_ONLY);
    expect(report.contradicted).toBe(1);

    // The polarity pair must NOT have been near-dup merged: both records
    // remain active, with the newer one linked via contradicts.
    const [a, b] = await Promise.all([store.getSage(first.id), store.getSage(second.id)]);
    expect(a?.status).toBe('active');
    expect(b?.status).toBe('active');
    const newer = b && a && b.createdAt >= a.createdAt ? b : a;
    expect(newer?.contradicts).toContain(newer === b ? first.id : second.id);
  });

  it('keeps a same-kind polarity pair separate at write time (remember guard)', async () => {
    const a = await store.rememberSage({
      text: 'the cache layer keeps retry counts',
      kind: 'fact',
      importance: 0.7,
    });
    const b = await store.rememberSage({
      text: 'the cache layer never keeps retry counts',
      kind: 'fact',
      importance: 0.7,
    });
    // True ≥0.88 near-dup pair (overlap 6/6, no stemming differences):
    // findNearDuplicate passes the near-dup threshold, so it is the polarity
    // guard (isPossiblyContradictory) that must refuse the merge — removing
    // that guard turns this red.
    expect(a.id).not.toBe(b.id);
  });
});
