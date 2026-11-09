import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getKanbanPath } from '../src/storage.js';
import { removeProjectFixtureDirectory } from './helpers/remove-fixture-directory.js';
import { createBoard, getBoard, pruneSessionBoards } from './helpers/session-manager.js';

const BEFORE = '2026-11-09T00:00:00.000Z';
const NOW = '2026-11-09T00:00:02.000Z';
const SCENARIOS = ['delete_ttl', 'archive_ttl', 'purge', 'legacy_purge'] as const;
type Scenario = (typeof SCENARIOS)[number];
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-retention-duration-'));
});

afterEach(async () => {
  await removeProjectFixtureDirectory(root);
});

async function persistedPolicy(scenario: Scenario, duration: unknown): Promise<string> {
  const board = await createBoard(root, { title: 'Retention duration boundary' });
  const purge = scenario === 'purge' || scenario === 'legacy_purge';
  const retention = purge
    ? { mode: 'archive_after_ttl', ttlMs: 1000, archivedAt: BEFORE, purgeAfterArchiveMs: duration }
    : {
        mode: scenario === 'delete_ttl' ? 'delete_after_ttl' : 'archive_after_ttl',
        ttlMs: duration,
      };
  // Exercise the persisted-data trust boundary without casting malformed input to a domain type.
  await fs.writeFile(
    getKanbanPath(root, board.id),
    JSON.stringify({
      ...board,
      kind: scenario === 'purge' ? 'archive' : 'session_mirror',
      updatedAt: BEFORE,
      retention,
    }),
  );
  return board.id;
}

describe('retention durations fail closed', () => {
  it.each(SCENARIOS)('retains malformed policies for %s', async (scenario) => {
    const ids: string[] = [];
    for (const duration of ['not-a-duration', '1000', -1, 0, null, true, {}, []]) {
      ids.push(await persistedPolicy(scenario, duration));
    }
    const result = await pruneSessionBoards(root, { now: NOW });
    expect(result.deleted).toEqual([]);
    expect(result.archived).toEqual([]);
    for (const id of ids) {
      expect(await getBoard(root, id)).not.toBeNull();
    }
  });

  it.each(SCENARIOS)('honors valid expired and unexpired policies for %s', async (scenario) => {
    const expired = await persistedPolicy(scenario, 1000);
    const fresh = await persistedPolicy(scenario, 10_000);
    const before = await getBoard(root, fresh);
    const result = await pruneSessionBoards(root, { now: NOW });
    if (scenario === 'archive_ttl') {
      expect(result.archived).toContain(expired);
      expect((await getBoard(root, expired))?.kind).toBe('archive');
    } else {
      expect(result.deleted).toContain(expired);
      expect(await getBoard(root, expired)).toBeNull();
    }
    expect(await getBoard(root, fresh)).toEqual(before);
  });
});
