/**
 * Sidebar session listing, read from `.summary.json` sidecars.
 *
 * The store layout under test is real: `sessions/<YYYY-MM-DD>/<id>.summary.json`,
 * written next to each transcript by `file-session-writer.ts`. These tests build
 * that layout in a temp directory and point `WRONGSTACK_HOME` at it, so the
 * production path resolution (`wstackGlobalRoot` + `projectSlug`) runs for real
 * rather than being stubbed.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
let projectRoot: string;
const savedHome = process.env.WRONGSTACK_HOME;

/** Import fresh so `wstackGlobalRoot()` sees the temp home. */
async function loadModule() {
  vi.resetModules();
  return import('../src/main/session-index.js');
}

async function writeSummary(
  storeDir: string,
  shard: string,
  sessionId: string,
  body: unknown | string,
): Promise<void> {
  const dir = path.join(storeDir, 'sessions', shard);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.summary.json`),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  );
}

function summary(id: string, title: string, lastActivityAt: string, messageCount = 3) {
  return { id, title, startedAt: lastActivityAt, lastActivityAt, messageCount, model: 'gpt-5.6' };
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-session-index-'));
  process.env.WRONGSTACK_HOME = home;
  projectRoot = path.join(home, 'repos', 'demo');
  await fs.mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.WRONGSTACK_HOME;
  else process.env.WRONGSTACK_HOME = savedHome;
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('listProjectSessions', () => {
  it('returns nothing for a project that has never been opened', async () => {
    const { listProjectSessions } = await loadModule();
    expect(await listProjectSessions(projectRoot)).toEqual([]);
  });

  it('reads summaries across date shards, newest activity first', async () => {
    const { listProjectSessions, projectStoreDir } = await loadModule();
    const store = projectStoreDir(projectRoot);
    await writeSummary(
      store,
      '2026-09-07',
      'sess_A',
      summary('2026-09-07/sess_A', 'older', '2026-09-07T10:00:00.000Z'),
    );
    await writeSummary(
      store,
      '2026-09-09',
      'sess_C',
      summary('2026-09-09/sess_C', 'newest', '2026-09-09T09:00:00.000Z'),
    );
    await writeSummary(
      store,
      '2026-09-08',
      'sess_B',
      summary('2026-09-08/sess_B', 'middle', '2026-09-08T18:00:00.000Z'),
    );

    const sessions = await listProjectSessions(projectRoot);
    expect(sessions.map((s) => s.title)).toEqual(['newest', 'middle', 'older']);
    expect(sessions[0]).toMatchObject({ messageCount: 3, model: 'gpt-5.6' });
  });

  it('honours the limit without scanning older shards', async () => {
    const { listProjectSessions, projectStoreDir } = await loadModule();
    const store = projectStoreDir(projectRoot);
    for (let day = 1; day <= 9; day++) {
      const shard = `2026-09-0${day}`;
      await writeSummary(
        store,
        shard,
        `sess_${day}`,
        summary(`${shard}/sess_${day}`, `s${day}`, `${shard}T12:00:00.000Z`),
      );
    }
    const sessions = await listProjectSessions(projectRoot, { limit: 3 });
    expect(sessions).toHaveLength(3);
    expect(sessions.map((s) => s.title)).toEqual(['s9', 's8', 's7']);
  });

  it('skips a truncated sidecar and keeps the rest of the shard', async () => {
    // A session killed mid-write leaves a partial JSON file. One bad sidecar
    // must not cost the project its whole session list.
    const { listProjectSessions, projectStoreDir } = await loadModule();
    const store = projectStoreDir(projectRoot);
    await writeSummary(
      store,
      '2026-09-09',
      'sess_ok',
      summary('2026-09-09/sess_ok', 'good', '2026-09-09T10:00:00.000Z'),
    );
    await writeSummary(store, '2026-09-09', 'sess_bad', '{"id":"2026-09-09/sess_bad","tit');

    const sessions = await listProjectSessions(projectRoot);
    expect(sessions.map((s) => s.title)).toEqual(['good']);
  });

  it('falls back to the session id when a session has no title', async () => {
    const { listProjectSessions, projectStoreDir } = await loadModule();
    const store = projectStoreDir(projectRoot);
    await writeSummary(store, '2026-09-09', 'sess_untitled', {
      id: '2026-09-09/sess_untitled',
      startedAt: '2026-09-09T10:00:00.000Z',
      title: '   ',
    });
    const sessions = await listProjectSessions(projectRoot);
    expect(sessions[0]?.title).toBe('sess_untitled');
  });

  it('picks up a session added to an existing date shard', async () => {
    // The bug this guards: keying the cache on the `sessions/` directory mtime.
    // A new session lands in an EXISTING shard, which does not change the
    // parent directory's mtime — so an mtime-keyed cache would keep serving
    // the old list for the rest of the day and the sidebar would appear frozen.
    vi.useFakeTimers();
    try {
      const { listProjectSessions, projectStoreDir } = await loadModule();
      const store = projectStoreDir(projectRoot);
      await writeSummary(
        store,
        '2026-09-09',
        'sess_1',
        summary('2026-09-09/sess_1', 'first', '2026-09-09T10:00:00.000Z'),
      );
      expect(await listProjectSessions(projectRoot)).toHaveLength(1);

      await writeSummary(
        store,
        '2026-09-09',
        'sess_2',
        summary('2026-09-09/sess_2', 'second', '2026-09-09T11:00:00.000Z'),
      );
      // Inside the memo window the old answer is fine — that is the point of it.
      expect(await listProjectSessions(projectRoot)).toHaveLength(1);

      vi.advanceTimersByTime(5_000);
      const after = await listProjectSessions(projectRoot);
      expect(after.map((s) => s.title)).toEqual(['second', 'first']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves a repeated call from the memo instead of re-reading', async () => {
    const { listProjectSessions, projectStoreDir, clearSessionIndexCache } = await loadModule();
    const store = projectStoreDir(projectRoot);
    await writeSummary(
      store,
      '2026-09-09',
      'sess_1',
      summary('2026-09-09/sess_1', 'only', '2026-09-09T10:00:00.000Z'),
    );
    await listProjectSessions(projectRoot);

    // Delete everything; a memoised answer still comes back.
    await fs.rm(path.join(store, 'sessions', '2026-09-09'), { recursive: true, force: true });
    expect(await listProjectSessions(projectRoot)).toHaveLength(1);

    clearSessionIndexCache();
    expect(await listProjectSessions(projectRoot)).toHaveLength(0);
  });
});
