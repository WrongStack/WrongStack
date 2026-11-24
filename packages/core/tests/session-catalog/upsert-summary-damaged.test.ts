import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { initializeCatalogSchema } from '../../src/session-catalog/store-schema.js';
import { executeUpsertSummary } from '../../src/session-catalog/store-summary.js';

const ID = '2026-01-01/sess_x';
const SUMMARY = {
  id: ID,
  title: ID,
  startedAt: '2026-01-01T00:00:00.000Z',
  model: 'm',
  provider: 'p',
  tokenTotal: 0,
};
const TRANSCRIPT_PATH = path.join('2026-01-01', 'sess_x.jsonl');
const TRANSCRIPT_LINE =
  '{"type":"session_start","ts":"2026-01-01T00:00:00.000Z","model":"m","provider":"p"}\n';

describe('executeUpsertSummary — damaged flag reflects transcript existence', () => {
  let root: string;
  let db: DatabaseSync;
  let scrubber: DefaultSecretScrubber;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'catalog-upsert-damaged-'));
    db = new DatabaseSync(':memory:');
    initializeCatalogSchema(db);
    scrubber = new DefaultSecretScrubber();
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  function upsert() {
    return executeUpsertSummary(db, root, scrubber, SUMMARY);
  }

  function damagedRow(): number {
    const row = db.prepare('SELECT damaged FROM sessions WHERE session_id = ?').get(ID) as
      | { damaged: number }
      | undefined;
    expect(row).toBeDefined();
    return row!.damaged;
  }

  it('marks a summary-only upsert damaged instead of indexing a resumable session', () => {
    const record = upsert();

    // No transcript on disk: the summary must not claim the session is healthy.
    expect(record.damaged).toBe(true);
    expect(damagedRow()).toBe(1);
  });

  it('does not clear existing damage on a later summary-only update', () => {
    upsert();
    const second = upsert();

    expect(second.damaged).toBe(true);
    expect(damagedRow()).toBe(1);
  });

  it('heals the damage flag once the transcript exists', async () => {
    await fsp.mkdir(path.join(root, '2026-01-01'), { recursive: true });
    await fsp.writeFile(path.join(root, TRANSCRIPT_PATH), TRANSCRIPT_LINE);

    const record = upsert();

    expect(record.damaged).toBe(false);
    expect(damagedRow()).toBe(0);
  });
});
