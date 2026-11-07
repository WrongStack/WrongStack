import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteMemoryPort } from '@wrongstack/sage';
import { handleSageGraph } from '@wrongstack/webui-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

let root: string;
let openStores: SqliteMemoryPort[] = [];

/** Track each store so its SQLite handle is closed before the temp dir is removed. */
function newPort(opts: { projectRoot: string }): SqliteMemoryPort {
  const store = new SqliteMemoryPort(opts);
  openStores.push(store);
  return store;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-memory-graph-handler-'));
  openStores = [];
});

afterEach(async () => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  // Give Windows a tick to release SQLite WAL file handles before removal.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.rm(root, { recursive: true, force: true });
});

function mockSocket(): WebSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    readyState: 1,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  } as never;
}

describe('handleSageGraph', () => {
  it('returns persisted edges, evidence, and referenced memory records', async () => {
    const store = newPort({ projectRoot: root });
    const first = await store.rememberSage({
      text: 'The auth package owns session state.',
      kind: 'file_note',
      tags: ['auth', 'session'],
      anchors: [{ type: 'package', path: 'packages/auth' }],
    });
    const second = await store.rememberSage({
      text: 'Session changes require auth tests.',
      kind: 'command_note',
      tags: ['auth', 'session'],
      anchors: [{ type: 'package', path: 'packages/auth' }],
    });
    const ws = mockSocket();

    await handleSageGraph(
      ws,
      { type: 'memory.sage.graph', payload: { query: first.id, maxDepth: 1 } },
      store,
    );

    expect(ws.sent).toHaveLength(1);
    const response = ws.sent[0] as {
      type: string;
      payload: {
        query: string;
        edges: Array<{ evidence?: string[] }>;
        memories: Array<{ id: string }>;
      };
    };
    expect(response.type).toBe('memory.sage.graph');
    expect(response.payload.query).toBe(first.id);
    expect(
      response.payload.edges.some((edge) => edge.evidence?.includes('package:packages/auth')),
    ).toBe(true);
    expect(response.payload.memories.map((memory) => memory.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
  });
});
