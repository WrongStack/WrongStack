import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TechStackStore, attemptDelivery, drainPendingDeliveries } from '../src/index.js';
import type { Snapshot } from '../src/types.js';

let tmpDir: string;

function createTestStore(): TechStackStore {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techstack-delivery-'));
  return new TechStackStore({ projectSlug: 'test', dbPath: path.join(tmpDir, 'test.db') });
}

const SAMPLE_SNAPSHOT: Snapshot = {
  id: 'snap-1',
  projectId: 'proj-1',
  targetRoot: '/tmp/project',
  fingerprint: 'ts-abc',
  createdAt: new Date().toISOString(),
  adapterVersion: '0.1.0',
  coverage: 'full',
  workspaces: [],
  dependencies: [],
  findings: [],
};

describe('DeliveryCoordinator', () => {
  let store: TechStackStore;

  beforeEach(() => {
    store = createTestStore();
    store.saveSnapshot(SAMPLE_SNAPSHOT);
  });

  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks delivery while run is in progress', async () => {
    store.createOutbox('del-1', 'snap-1', 'session-1');
    const result = await attemptDelivery('del-1', {
      store,
      isRunInProgress: () => true,
      deliverToSession: async () => true,
    });
    expect(result.delivered).toBe(false);
  });

  it('delivers when idle and claims atomically', async () => {
    store.createOutbox('del-1', 'snap-1', 'session-1');
    const result = await attemptDelivery('del-1', {
      store,
      isRunInProgress: () => false,
      deliverToSession: async () => true,
    });
    expect(result.delivered).toBe(true);
    expect(result.sessionId).toBe('session-1');

    // Second attempt finds no pending entry
    const result2 = await attemptDelivery('del-1', {
      store,
      isRunInProgress: () => false,
      deliverToSession: async () => true,
    });
    expect(result2.delivered).toBe(false);
  });

  it('fires onDelivered callback', async () => {
    store.createOutbox('del-2', 'snap-1', 'session-1');
    let fired = false;
    await attemptDelivery('del-2', {
      store,
      isRunInProgress: () => false,
      deliverToSession: async () => true,
      onDelivered: () => {
        fired = true;
      },
    });
    expect(fired).toBe(true);
  });

  it('marks failed when deliverToSession returns false', async () => {
    store.createOutbox('del-3', 'snap-1', 'session-1');
    const result = await attemptDelivery('del-3', {
      store,
      isRunInProgress: () => false,
      deliverToSession: async () => false,
    });
    expect(result.delivered).toBe(false);
    const failed = store.listOutboxByStatus('failed');
    expect(failed.some((e) => e.deliveryId === 'del-3')).toBe(true);
  });

  it('drainPendingDeliveries processes all pending for a session', async () => {
    store.createOutbox('del-a', 'snap-1', 'session-1');
    store.createOutbox('del-b', 'snap-1', 'session-1');
    store.createOutbox('del-c', 'snap-1', 'session-2');
    const count = await drainPendingDeliveries('session-1', {
      store,
      isRunInProgress: () => false,
      deliverToSession: async () => true,
    });
    expect(count).toBe(2);
    // session-2 entry still pending
    const pending = store.listOutboxByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sessionId).toBe('session-2');
  });

  it('survives store close/reopen (durable)', () => {
    store.createOutbox('del-durable', 'snap-1', 'session-1');
    store.close();

    const reopened = new TechStackStore({
      projectSlug: 'test',
      dbPath: path.join(tmpDir, 'test.db'),
    });
    const pending = reopened.listOutboxByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.deliveryId).toBe('del-durable');
    reopened.close();
    // Prevent afterEach from double-closing
    store = reopened;
  });

  it('duplicate outbox entries → single visible delivery (CAS)', async () => {
    store.createOutbox('del-dup', 'snap-1', 'session-1');
    // claimOutbox uses INSERT OR IGNORE, so a second createOutbox for the same id is a no-op
    store.createOutbox('del-dup', 'snap-1', 'session-1');

    const deliveries: string[] = [];
    const result = await attemptDelivery('del-dup', {
      store,
      isRunInProgress: () => false,
      deliverToSession: async (sid) => {
        deliveries.push(sid);
        return true;
      },
    });
    expect(result.delivered).toBe(true);
    expect(deliveries).toHaveLength(1);
  });
});
