import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyMemoryAnchors } from '../src/anchors/verify.js';
import {
  isSqliteAvailable,
  SqliteSageStore as SageStore,
  SqliteSageStore,
} from '../src/sqlite-store.js';

describe('SAGE agent relationships', () => {
  let projectRoot = '';
  let stores: SqliteSageStore[] = [];

  function makeStore(): SqliteSageStore {
    const store = new SageStore({ projectRoot });
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-agent-anchor-'));
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
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('materializes an about_agent edge in the canonical graph', async () => {
    const store = makeStore();
    const memory = await store.rememberSage({
      text: 'The reviewer must verify rollback behavior for database migrations.',
      anchors: [{ type: 'agent', role: 'Reviewer' }],
    });

    expect(memory.anchors).toEqual([{ type: 'agent', role: 'reviewer' }]);
    expect(await store.traverseGraph(['agent:reviewer'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: `mem:${memory.id}`,
          to: 'agent:reviewer',
          relation: 'about_agent',
        }),
      ]),
    );
  });

  it('rejects malformed agent role anchors', async () => {
    const store = makeStore();
    await expect(
      store.rememberSage({
        text: 'This invalid role must never become a graph node.',
        anchors: [{ type: 'agent', role: '../reviewer' }],
      }),
    ).rejects.toThrow(/role is invalid/);
  });

  it('treats traversal-shaped legacy agent anchors as stale during verification', async () => {
    const store = makeStore();
    const memory = await store.rememberSage({
      text: 'A valid memory used to exercise legacy anchor verification.',
      anchors: [{ type: 'agent', role: 'reviewer' }],
    });

    const result = await verifyMemoryAnchors(projectRoot, {
      ...memory,
      anchors: [{ type: 'agent', role: '../reviewer' }],
    });
    expect(result.anchors[0]).toMatchObject({
      status: 'stale',
      reason: 'Agent anchor has an invalid role.',
    });
  });

  it('does not verify an agent role that only names an Object.prototype member', async () => {
    const store = makeStore();
    const memory = await store.rememberSage({
      text: 'The constructor agent owns the bootstrap checklist for this repository.',
      anchors: [{ type: 'agent', role: 'constructor' }],
    });

    const result = await verifyMemoryAnchors(projectRoot, memory);
    expect(result.anchors[0]).toMatchObject({
      status: 'stale',
      reason: 'Agent role "constructor" is not in the roster.',
    });

    fs.mkdirSync(path.join(projectRoot, '.wrongstack', 'agents', 'constructor'), {
      recursive: true,
    });
    expect((await verifyMemoryAnchors(projectRoot, memory)).anchors[0]?.status).toBe('verified');
  });

  it.skipIf(!isSqliteAvailable())('keeps SQLite agent anchor edges in sync', async () => {
    const store = new SqliteSageStore({ projectRoot });
    const memory = await store.rememberSage({
      text: 'The executor follows the project package manager convention.',
      anchors: [{ type: 'agent', role: 'executor' }],
    });

    expect(await store.traverseGraph(['agent:executor'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: `mem:${memory.id}`,
          to: 'agent:executor',
          relation: 'about_agent',
        }),
      ]),
    );
    store.close();
  });
});
