import type { HqPublisher, HqSageRecord } from '@wrongstack/hq';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSageHqSync } from '../src/sage-hq-sync.js';

const ipc = vi.hoisted(() => ({ call: vi.fn(), close: vi.fn() }));
vi.mock('@wrongstack/sage', () => ({
  SageProjectServerConnection: class {
    call = ipc.call;
    close = ipc.close;
  },
}));
const owners: Array<ReturnType<typeof createSageHqSync>> = [];
const tombstone: HqSageRecord = { id: 'm1', revision: 1, changeId: 'a'.repeat(32), memory: null };
beforeEach(() => {
  vi.clearAllMocks();
  ipc.call.mockImplementation(async (op: string, args: { after?: string }) => {
    if (op === 'getHqSyncVersion') return 'epoch:1';
    if (op === 'listHqSync') return args.after ? [] : [tombstone];
    return undefined;
  });
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.stop();
  vi.restoreAllMocks();
});
function setup(connected = true) {
  let reconnect = () => {};
  const publisher = {
    connected,
    project: { projectId: 'p' },
    publishEvent: vi.fn(),
    onConnected: (fn: () => void) => {
      reconnect = fn;
      return vi.fn();
    },
  };
  const sync = createSageHqSync('/project', publisher as unknown as HqPublisher);
  owners.push(sync);
  return { publisher, sync, reconnect: () => reconnect() };
}
it('polls only the constant-size clock after acknowledgement, and replays on reconnect', async () => {
  const { sync, publisher, reconnect } = setup();
  await sync.refresh();
  expect(publisher.publishEvent).toHaveBeenCalledOnce();
  const scans = () => ipc.call.mock.calls.filter((c) => c[0] === 'listHqSync').length;
  expect(scans()).toBe(2);
  await sync.handleRemote({ projectId: 'p', records: [tombstone] });
  for (let i = 0; i < 5; i++) await sync.refresh();
  expect(scans()).toBe(2);
  reconnect();
  await sync.refresh();
  expect(publisher.publishEvent).toHaveBeenCalledTimes(2);
  expect(scans()).toBe(4);
});
it('retries records until HQ acknowledgement rather than trusting a successful local send', async () => {
  const { sync, publisher } = setup();
  await sync.refresh();
  await sync.refresh();
  expect(publisher.publishEvent).toHaveBeenCalledTimes(2);
});
it('bounds coalesced remote IPC writes by bytes as well as record count', async () => {
  const { sync, publisher } = setup(false);
  for (let i = 0; i < 12; i++) {
    const id = `m${i}`;
    const record = {
      ...tombstone,
      id,
      memory: {
        id,
        text: '界'.repeat(60_000),
        scope: 'project',
        kind: 'fact',
        status: 'active',
        importance: 1,
        confidence: 1,
        freshness: 1,
        createdAt: '2026-09-29',
        updatedAt: '2026-09-29',
        tags: [],
        anchors: [],
        sources: [],
      },
    };
    await sync.handleRemote({ projectId: 'p', records: [record] });
  }
  publisher.connected = true;
  await sync.refresh();
  const applies = ipc.call.mock.calls.filter((c) => c[0] === 'applyHqSync');
  expect(applies).toHaveLength(6);
  expect(applies.every((c) => Buffer.byteLength(JSON.stringify(c[1])) < 512 * 1024)).toBe(true);
});
it('does not allow an in-flight old scan to suppress a new connection replay', async () => {
  let release!: (rows: HqSageRecord[]) => void;
  let first = true;
  const implementation = ipc.call.getMockImplementation()!;
  ipc.call.mockImplementation((op: string, args: { after?: string }) => {
    if (op === 'listHqSync' && first) {
      first = false;
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return implementation(op, args);
  });
  const { sync, publisher, reconnect } = setup();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  reconnect();
  release([]);
  await sync.refresh();
  await sync.refresh();
  expect(publisher.publishEvent).toHaveBeenCalledOnce();
});

it('does not requeue an old failed apply as an acknowledgement on a new connection', async () => {
  vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  let fail!: (error: Error) => void;
  let first = true;
  const implementation = ipc.call.getMockImplementation()!;
  ipc.call.mockImplementation((op: string, args: { after?: string }) => {
    if (op === 'applyHqSync' && first) {
      first = false;
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    }
    return implementation(op, args);
  });
  const { sync, publisher, reconnect } = setup(false);
  await sync.handleRemote({ projectId: 'p', records: [tombstone] });
  publisher.connected = true;
  const applying = sync.refresh();
  reconnect();
  fail(new Error('old IPC request failed'));
  await applying;
  await sync.refresh();
  expect(ipc.call.mock.calls.filter((c) => c[0] === 'applyHqSync')).toHaveLength(1);
  expect(publisher.publishEvent).toHaveBeenCalledOnce();
});
