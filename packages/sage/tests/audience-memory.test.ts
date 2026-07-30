import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore as SageStore } from '../src/sqlite-store.js';

let projectRoot: string;
let stores: SageStore[] = [];

/** Track every store so its SQLite handle is closed before the temp dir is removed. */
function openStore(): SageStore {
  const store = new SageStore({ projectRoot });
  stores.push(store);
  return store;
}

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-audience-memory-'));
  stores = [];
});

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  // Give Windows a tick to release SQLite WAL file handles before removal.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('project agent memory audiences', () => {
  it('matches stable roles across independent store instances', async () => {
    const writer = openStore();
    const created = await writer.rememberSage({
      text: 'Review public API compatibility before approving changes.',
      kind: 'workflow',
      scope: 'project',
      audience: { roles: [' Reviewer ', 'reviewer'] },
    });

    const reader = openStore();
    const reviewer = await reader.retrieveForAudience({ role: 'REVIEWER' });
    const refactorPlanner = await reader.retrieveForAudience({ role: 'refactor-planner' });

    expect(reviewer.map((memory) => memory.id)).toEqual([created.id]);
    expect(reviewer[0]?.audience).toEqual({ roles: ['reviewer'] });
    expect(refactorPlanner).toEqual([]);
  });

  it('uses OR within a selector dimension and AND across dimensions', async () => {
    const store = openStore();
    await store.rememberSage({
      text: 'For review-mode refactors, inspect ownership boundaries first.',
      scope: 'project',
      audience: {
        roles: ['reviewer', 'refactor-planner'],
        taskTypes: ['refactor'],
        modes: ['strict-review'],
      },
    });

    expect(await store.retrieveForAudience({
      role: 'refactor-planner',
      taskType: 'refactor',
      mode: 'strict-review',
    })).toHaveLength(1);
    expect(await store.retrieveForAudience({
      role: 'reviewer',
      taskType: 'bugfix',
      mode: 'strict-review',
    })).toEqual([]);
    expect(await store.retrieveForAudience({ role: 'reviewer', taskType: 'refactor' })).toEqual([]);
  });

  it('keeps scoped policy out of ordinary automatic retrieval while explicit search remains complete', async () => {
    const store = openStore();
    await store.rememberSage({
      text: 'Review database migrations for reversible rollbacks.',
      scope: 'project',
      audience: { roles: ['reviewer'] },
      anchors: [{ type: 'directory', path: 'packages/core' }],
    });
    await store.rememberSage({
      text: 'Database migrations live in the core package.',
      scope: 'project',
      anchors: [{ type: 'directory', path: 'packages/core' }],
    });

    const explicit = await store.searchSage('database migrations');
    const automatic = await store.searchSage('database migrations', {
      includeAudienceScoped: false,
    });
    const automaticPath = await store.retrieveForPath(['packages/core/src/index.ts'], {
      path: 'packages/core/src/index.ts',
      includeAudienceScoped: false,
    });

    expect(explicit).toHaveLength(2);
    expect(automatic.map((memory) => memory.text)).toEqual([
      'Database migrations live in the core package.',
    ]);
    expect(automaticPath.map((memory) => memory.text)).toEqual([
      'Database migrations live in the core package.',
    ]);
  });

  it('does not merge identical text belonging to different roles', async () => {
    const store = openStore();
    const reviewer = await store.rememberSage({
      text: 'Check the package boundary.',
      audience: { roles: ['reviewer'] },
    });
    const git = await store.rememberSage({
      text: 'Check the package boundary.',
      audience: { roles: ['git'] },
    });

    expect(git.id).not.toBe(reviewer.id);
    expect(await store.retrieveForAudience({ role: 'reviewer' })).toHaveLength(1);
    expect(await store.retrieveForAudience({ role: 'git' })).toHaveLength(1);
  });

  it('preserves identical text for different roles during hygiene', async () => {
    const store = openStore();
    const reviewer = await store.rememberSage({
      text: 'Keep audience-specific policy.',
      audience: { roles: ['reviewer'] },
    });
    const git = await store.rememberSage({
      text: 'Keep audience-specific policy.',
      audience: { roles: ['git'] },
    });

    const report = await store.hygiene({ verify: false });

    expect(report.deduplicated).toBe(0);
    expect((await store.getSage(reviewer.id))?.status).toBe('active');
    expect((await store.getSage(git.id))?.status).toBe('active');
  });

  it('fires onTruncated when the SQL prefilter is saturated and more matching rows exist', async () => {
    const store = openStore();
    // Seed enough reviewer-scoped rows to saturate the prefilter at
    // limit=2 (prefilterSize = limit * 5 = 10) AND leave more matching
    // rows past the limit so matched.length > truncated.length.
    for (let i = 0; i < 15; i++) {
      await store.rememberSage({
        text: `Reviewer policy entry #${i}.`,
        scope: 'project',
        audience: { roles: ['reviewer'] },
        importance: 0.5 + i * 0.01,
      });
    }

    const calls: Array<{ sqlRowsExamined: number; returned: number }> = [];
    const result = await store.retrieveForAudience({ role: 'reviewer' }, 2, (info) => {
      calls.push(info);
    });

    // Limit honored, more matches exist beyond.
    expect(result).toHaveLength(2);
    // Truncation signal fired exactly once with the prefilter size.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sqlRowsExamined).toBe(10);
    expect(calls[0]?.returned).toBe(2);
  });

  it('does not fire onTruncated when fewer matching rows exist than the limit', async () => {
    const store = openStore();
    await store.rememberSage({
      text: 'A lone reviewer entry.',
      audience: { roles: ['reviewer'] },
    });

    const calls: Array<{ sqlRowsExamined: number; returned: number }> = [];
    const result = await store.retrieveForAudience({ role: 'reviewer' }, 5, (info) => {
      calls.push(info);
    });

    expect(result).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('emits the memory.audience_truncated audit event even without a callback', async () => {
    const store = openStore();
    for (let i = 0; i < 15; i++) {
      await store.rememberSage({
        text: `Reviewer audit entry #${i}.`,
        audience: { roles: ['reviewer'] },
        importance: 0.5 + i * 0.01,
      });
    }

    // No callback — but the store should still emit the audit event.
    const result = await store.retrieveForAudience({ role: 'reviewer' }, 2);
    expect(result).toHaveLength(2);

    const audit = await store.readAudit(50);
    const truncated = audit.filter((entry) => entry.event === 'memory.audience_truncated');
    expect(truncated).toHaveLength(1);
  });

  it('honors limit=0 by returning an empty slice without firing onTruncated', async () => {
    const store = openStore();
    await store.rememberSage({
      text: 'Reviewer entry for limit=0.',
      audience: { roles: ['reviewer'] },
    });

    const calls: Array<{ sqlRowsExamined: number; returned: number }> = [];
    const result = await store.retrieveForAudience({ role: 'reviewer' }, 0, (info) => {
      calls.push(info);
    });

    expect(result).toEqual([]);
    // prefilterSize = 0 * 5 = 0. SQL LIMIT 0 returns no rows, so the
    // truncation condition can never be satisfied.
    expect(calls).toEqual([]);
  });
});
