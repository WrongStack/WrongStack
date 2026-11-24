import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildCatalogIndex } from '../../src/session-catalog/store-rebuild.js';
import { initializeCatalogSchema } from '../../src/session-catalog/store-schema.js';

const ID = '2026-01-01/sess_x';
const SUMMARY = {
  id: ID,
  title: ID,
  startedAt: '2026-01-01T00:00:00.000Z',
  model: 'm',
  provider: 'p',
  tokenTotal: 0,
};
const TRANSCRIPT_LINE =
  '{"type":"session_start","ts":"2026-01-01T00:00:00.000Z","model":"m","provider":"p"}\n';

describe('rebuildCatalogIndex — summary-only orphan', () => {
  let root: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'catalog-orphan-'));
    db = new DatabaseSync(':memory:');
    initializeCatalogSchema(db);
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  function rebuild(): { indexed: number; damaged: number } {
    return rebuildCatalogIndex(
      db,
      root,
      (relative) => path.join(root, relative),
      (run) => run(),
      () => {},
    );
  }

  function row(): { damaged: number; storage_state: string | null } | undefined {
    return db.prepare('SELECT damaged, storage_state FROM sessions WHERE session_id = ?').get(ID) as
      | { damaged: number; storage_state: string | null }
      | undefined;
  }

  it('marks a summary-only orphan damaged instead of indexing a resumable cold session', async () => {
    await fsp.mkdir(path.join(root, '2026-01-01'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '2026-01-01', 'sess_x.summary.json'),
      JSON.stringify(SUMMARY),
    );

    const result = rebuild();

    // The transcript is gone on both tiers: the session must not be indexed as
    // a resumable cold row pointing at a `.jsonl.gz` that does not exist.
    expect(result.indexed).toBe(0);
    expect(result.damaged).toBe(1);
    expect(row()?.damaged).toBe(1);
  });

  it('still indexes a session that has a summary and a hot transcript', async () => {
    await fsp.mkdir(path.join(root, '2026-01-01'), { recursive: true });
    await fsp.writeFile(
      path.join(root, '2026-01-01', 'sess_x.summary.json'),
      JSON.stringify(SUMMARY),
    );
    await fsp.writeFile(path.join(root, '2026-01-01', 'sess_x.jsonl'), TRANSCRIPT_LINE);

    const result = rebuild();

    expect(result.indexed).toBe(1);
    expect(result.damaged).toBe(0);
    expect(row()?.damaged).toBe(0);
    expect(row()?.storage_state).toBe('hot');
  });

  it('still indexes a transcript-only session through the summary builder', async () => {
    await fsp.mkdir(path.join(root, '2026-01-01'), { recursive: true });
    await fsp.writeFile(path.join(root, '2026-01-01', 'sess_x.jsonl'), TRANSCRIPT_LINE);

    const result = rebuild();

    expect(result.indexed).toBe(1);
    expect(result.damaged).toBe(0);
    expect(row()?.storage_state).toBe('hot');
  });
});
