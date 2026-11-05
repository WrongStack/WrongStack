/**
 * The mirror in `wrongmemory` and `auto` mode. The WrongMemory port emits the
 * in-process store's host events on the bus it was given; the mirror must
 * find that bus through the memory port, as it does for the in-process and
 * project-server ports. Without it the mirror stayed off and memories written
 * after the first boot never reached semantic recall.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import {
  createSageMemoryPortForService,
  getSageSurface,
  type Sage,
  WrongMemoryPort,
} from '@wrongstack/sage';
import { afterEach, describe, expect, it } from 'vitest';

import { subscribeVectorMemoryToSage, VectorMemoryStore } from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const ROOT = process.platform === 'win32' ? 'C:\\work\\wm-mirror' : '/work/wm-mirror';
const PROJECT = {
  projectId: 'p_1',
  displayName: 'wm-mirror',
  root: ROOT,
  storePath: '/data/p_1/sage.db',
  storeKind: 'managed',
  admission: 'read-write',
  admissionReason: 'service-managed store',
  ownerEpoch: 1,
  storageProfileId: null,
  createdAtMs: 0,
};

/** A daemon stand-in: keeps remembered records and serves them back. */
function fakeDaemon() {
  const records = new Map<string, Sage>();
  let next = 0;
  return {
    async call<T>(method: string, params: unknown = {}): Promise<T> {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case 'project.list':
          return { projects: [PROJECT] } as T;
        case 'project.get':
          return PROJECT as T;
        case 'session.acquire':
          return { sessionId: p.hostSessionId, daemonIssued: false } as T;
        case 'session.release':
          return { released: true } as T;
        case 'memory.remember': {
          next += 1;
          const id = `01WMMIRROR${String(next).padStart(16, '0')}`;
          const record = {
            id,
            revision: 1,
            text: String(p.text),
            kind: 'fact',
            scope: 'project',
            status: 'active',
            tags: [],
            anchors: [],
            sources: [],
            importance: 0.6,
            confidence: 0.8,
            freshness: 1,
            createdAt: '2026-11-04T00:00:00.000Z',
            updatedAt: '2026-11-04T00:00:00.000Z',
          } as unknown as Sage;
          records.set(id, record);
          return { outcome: 'memory-committed', id, revision: 1, replayed: false, record } as T;
        }
        case 'memory.get': {
          const r = records.get(String(p.id));
          if (!r) throw Object.assign(new Error('memory not found'), { code: 'NOT_FOUND' });
          return r as T;
        }
        default:
          return undefined as T;
      }
    },
    close(): void {},
  };
}

async function mirrored(store: VectorMemoryStore, id: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (store.findBySageId(id)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe('subscribeVectorMemoryToSage over the WrongMemory port', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  function vectorStore(): VectorMemoryStore {
    const store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot: path.join(
        os.tmpdir(),
        `wm-mirror-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ),
    });
    cleanups.push(() => store.close());
    return store;
  }

  it('mirrors a memory remembered through a wrongmemory-mode port', async () => {
    const events = new EventBus();
    const daemon = fakeDaemon();
    const port = new WrongMemoryPort({
      projectRoot: ROOT,
      events,
      relayIntervalMs: 0,
      connect: async () => daemon,
    });
    await port.initialize();
    cleanups.push(() => port.dispose());
    const store = vectorStore();
    const handle = subscribeVectorMemoryToSage({ store, memoryStore: port });
    cleanups.push(() => handle.dispose());

    const created = await getSageSurface(port)!.rememberSage({
      text: 'Deploys go out on Tuesdays',
      anchors: [],
    });

    expect(await mirrored(store, created.id)).toBe(true);
    expect(store.findBySageId(created.id)?.text).toBe('Deploys go out on Tuesdays');
  });

  it('mirrors through an auto-mode port that picked WrongMemory', async () => {
    const events = new EventBus();
    const daemon = fakeDaemon();
    const port = createSageMemoryPortForService({
      projectRoot: ROOT,
      service: { mode: 'auto' },
      events,
      connect: async () => daemon,
    });
    await (port as { initialize(): Promise<void> }).initialize();
    cleanups.push(() => (port as { dispose?(): Promise<void> }).dispose?.());
    const store = vectorStore();
    const handle = subscribeVectorMemoryToSage({ store, memoryStore: port });
    cleanups.push(() => handle.dispose());

    const created = await getSageSurface(port)!.rememberSage({
      text: 'Releases are tagged on main',
      anchors: [],
    });

    expect(await mirrored(store, created.id)).toBe(true);
  });
});
