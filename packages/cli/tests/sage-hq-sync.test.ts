import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, type HqPublisher, writeHqAuthFile } from '@wrongstack/core/hq';
import { SageProjectServerConnection } from '@wrongstack/sage';
import { afterEach, expect, it, vi } from 'vitest';
import { waitForProcessExit } from '../../core/tests/helpers/project-server-harness.js';
import { createCliHqPublisher } from '../src/hq-publisher.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { createSageHqSync } from '../src/sage-hq-sync.js';

// The daemon is a built process; source aliases resolve its sibling .js to src/.
vi.mock('@wrongstack/sage', async () => import('../../sage/dist/index.js'));

let root: string;
let server: HqServerHandle | undefined;
const clients: Array<{
  publisher: HqPublisher;
  sync: ReturnType<typeof createSageHqSync>;
  ipc: SageProjectServerConnection;
}> = [];
const callOptions = { meta: { clientId: 'sync-integration-test' } };
afterEach(async () => {
  for (const c of clients) {
    c.sync.stop();
    c.publisher.close();
  }
  await server?.close();
  await Promise.all(
    clients.map(async (c) => {
      const stopped = await c.ipc.shutdown('test-cleanup');
      c.ipc.close();
      if (stopped.pid !== undefined) await waitForProcessExit(stopped.pid);
    }),
  );
  clients.length = 0;
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

it('syncs external daemon writes over real HQ WebSockets, isolates projects, restores late/reconnected clients', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-sage-wire-'));
  const dataDir = path.join(root, 'hq');
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
  server = await startHqServer({ host: '127.0.0.1', port: 0, dataDir });
  async function client(name: string, projectAlias = 'shared', directory?: string) {
    const projectRoot = path.join(root, name);
    await fs.mkdir(projectRoot, { recursive: true });
    let sync: ReturnType<typeof createSageHqSync>;
    const publisher = createCliHqPublisher({
      projectRoot,
      clientKind: 'cli',
      // One vitest process hosts every client. Without a distinct machine, HQ
      // reads same pid + project + kind as one publisher restarting and has
      // each hello supersede the others (close 4001) — under load a client was
      // still evicted when the final assertion ran.
      machineId: `sage-hq-sync-test-${name}`,
      config: { enabled: true, url: `http://127.0.0.1:${server!.port}`, projectAlias },
      onSageSnapshot: (payload) => sync.handleRemote(payload),
    })!;
    sync = createSageHqSync(projectRoot, publisher, directory);
    const c = { publisher, sync, ipc: new SageProjectServerConnection(projectRoot, directory) };
    clients.push(c);
    publisher.connect();
    await vi.waitFor(() => expect(publisher.connected).toBe(true), {
      timeout: 15_000,
      interval: 100,
    });
    return c;
  }
  const a = await client('a');
  const b = await client('b', 'shared', 'custom-memories');
  const other = await client('other', 'different');
  const text = `Project memory must survive transport. ${'detailed evidence '.repeat(100)}`;
  const memory = await a.ipc.call('rememberSage', { input: { text, kind: 'fact' } }, callOptions);
  await vi.waitFor(
    async () => {
      await a.sync.refresh();
      await b.sync.refresh();
      expect((await b.ipc.call('getSage', { id: memory.id }, callOptions))?.text).toBe(memory.text);
    },
    { timeout: 15_000, interval: 100 },
  );
  expect(await other.ipc.call('getSage', { id: memory.id }, callOptions)).toBeNull();
  const late = await client('late');
  await vi.waitFor(
    async () => {
      await late.sync.refresh();
      expect((await late.ipc.call('getSage', { id: memory.id }, callOptions))?.text).toBe(
        memory.text,
      );
    },
    { timeout: 15_000, interval: 100 },
  );
  b.sync.stop();
  b.publisher.close();
  await a.ipc.call(
    'updateSage',
    { id: memory.id, patch: { text: 'Updated while client B was offline' } },
    callOptions,
  );
  await a.sync.refresh();
  // Publishing is asynchronous. Observe the update through another live
  // client before restarting HQ, so its persisted snapshot contains the update.
  await vi.waitFor(
    async () => {
      await a.sync.refresh();
      await late.sync.refresh();
      expect((await late.ipc.call('getSage', { id: memory.id }, callOptions))?.text).toBe(
        'Updated while client B was offline',
      );
    },
    { timeout: 15_000, interval: 100 },
  );
  // A new HQ process reads its persisted store; reconnecting publishers re-announce.
  const port = server.port;
  await server.close();
  server = await startHqServer({ host: '127.0.0.1', port, dataDir });
  // Use a fresh publisher callback so the restored connection targets its new sync owner.
  const restored = await client('b', 'shared', 'custom-memories');
  await vi.waitFor(
    async () => {
      await a.sync.refresh();
      await restored.sync.refresh();
      expect((await restored.ipc.call('getSage', { id: memory.id }, callOptions))?.text).toBe(
        'Updated while client B was offline',
      );
    },
    { timeout: 15_000, interval: 100 },
  );
  await a.ipc.call(
    'deleteSage',
    { id: memory.id, reason: 'User requested deletion', options: { force: true } },
    callOptions,
  );
  await vi.waitFor(
    async () => {
      await a.sync.refresh();
      await restored.sync.refresh();
      expect(
        (await restored.ipc.call('listHqSync', { after: '' }, callOptions))[0]?.memory?.status,
      ).toBe('deleted');
    },
    { timeout: 15_000, interval: 100 },
  );
}, 60_000);
