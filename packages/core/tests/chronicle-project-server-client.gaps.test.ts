import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChronicleProjectServerClient,
  ChronicleRemoteJournal,
  resolveChronicleDaemonAvailability,
  resolveChronicleProjectServerUrl,
} from '../src/chronicle/project-server-client.js';
import { chronicleProjectServerEndpoint } from '../src/chronicle/project-server-endpoint.js';

// Windows fileURLToPath requires a drive letter — a bare /repo path throws
// inside every candidate lookup and would read as missing-build.
const MODULE_URL = 'file:///D:/repo/packages/core/src/chronicle/project-server-client.ts';

const prevInline = process.env['WRONGSTACK_CHRONICLE_INLINE'];
const prevServer = process.env['WRONGSTACK_CHRONICLE_SERVER'];

beforeEach(() => {
  delete process.env['WRONGSTACK_CHRONICLE_INLINE'];
  delete process.env['WRONGSTACK_CHRONICLE_SERVER'];
});

afterEach(() => {
  if (prevInline === undefined) delete process.env['WRONGSTACK_CHRONICLE_INLINE'];
  else process.env['WRONGSTACK_CHRONICLE_INLINE'] = prevInline;
  if (prevServer === undefined) delete process.env['WRONGSTACK_CHRONICLE_SERVER'];
  else process.env['WRONGSTACK_CHRONICLE_SERVER'] = prevServer;
});

describe('resolveChronicleDaemonAvailability', () => {
  it('honours explicit inline requests over the build lookup', () => {
    process.env['WRONGSTACK_CHRONICLE_INLINE'] = '1';
    expect(resolveChronicleDaemonAvailability(MODULE_URL, () => true)).toEqual({
      kind: 'inline-requested',
    });

    delete process.env['WRONGSTACK_CHRONICLE_INLINE'];
    process.env['WRONGSTACK_CHRONICLE_SERVER'] = '0';
    expect(resolveChronicleDaemonAvailability(MODULE_URL, () => true)).toEqual({
      kind: 'inline-requested',
    });
  });

  it('finds the first existing server layout', () => {
    const availability = resolveChronicleDaemonAvailability(MODULE_URL, () => true);
    expect(availability.kind).toBe('available');
    if (availability.kind === 'available') {
      expect(availability.url.href).toContain('project-server.js');
    }
  });

  it('reports a missing build when no layout exists', () => {
    expect(resolveChronicleDaemonAvailability(MODULE_URL, () => false)).toEqual({
      kind: 'missing-build',
    });
    expect(resolveChronicleProjectServerUrl(MODULE_URL, () => false)).toBeNull();
  });
});

describe('ChronicleProjectServerClient offline behavior', () => {
  function makeClient() {
    return new ChronicleProjectServerClient({
      projectRoot: '/proj',
      globalRoot: '/global',
      projectId: 'pid-1',
      projectDir: path.join(os.tmpdir(), 'chronicle-gaps-project'),
      workspaceId: 'ws-1',
    });
  }

  it('derives the endpoint from the project dir', () => {
    const client = makeClient();
    // The endpoint must be a deterministic function of the project dir.
    // Compare against the derivation itself rather than a literal prefix:
    // the POSIX socket prefix was deliberately shortened to `wsch-v<V>`
    // (sun_path byte budget — see project-server-endpoint.ts), while the
    // Windows pipe keeps the long `wrongstack-chronicle-v<V>` form, so a
    // literal string can only ever be right on one platform.
    expect(client.endpoint).toBe(
      chronicleProjectServerEndpoint(path.join(os.tmpdir(), 'chronicle-gaps-project')),
    );
    expect(client.endpoint.length).toBeGreaterThan(0);
  });

  it('reports shutdown as offline when no daemon is listening', async () => {
    const client = makeClient();
    const result = await client.shutdown('test');
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe('offline');
  });

  it('closes cleanly without a connection', async () => {
    const client = makeClient();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe('ChronicleRemoteJournal batching', () => {
  function fakeClient(
    respond: (
      inputs: Array<Record<string, unknown>>,
    ) => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>,
  ) {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      client: {
        call: vi.fn(async (op: string, args: { inputs: unknown[] }) => {
          calls.push({ op, args });
          if (op === 'flush') return {};
          return respond(args.inputs as Array<Record<string, unknown>>);
        }),
        close: vi.fn(async () => undefined),
      } as never as ChronicleProjectServerClient,
    };
  }

  function event(id: string) {
    return { type: 'agent_message', ts: new Date().toISOString(), data: { id } } as never;
  }

  it('batches appends into one server call and resolves each event', async () => {
    const { client, calls } = fakeClient((inputs) =>
      inputs.map((input, i) => ({ id: `e-${i}`, ...input })),
    );
    const journal = new ChronicleRemoteJournal(
      { projectRoot: '/p', globalRoot: '/g', projectId: 'p1', projectDir: '/d', workspaceId: 'w' },
      client,
    );
    const first = journal.append(event('a'));
    const second = journal.append(event('b'));
    await Promise.all([first, second]);
    expect(calls.filter((c) => c.op === 'append')).toHaveLength(1);
    expect(calls[0]?.args['inputs']).toHaveLength(2);
    const stats = journal.stats();
    expect(stats).toMatchObject({
      acceptedEvents: 2,
      persistedEvents: 2,
      batches: 1,
      largestBatch: 2,
      pendingEvents: 0,
    });
    await journal.dispose();
    expect(calls.some((c) => c.op === 'flush')).toBe(true);
  });

  it('rejects appends past the backpressure limit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { client } = fakeClient(async (inputs) => {
      await gate;
      return inputs.map((input, i) => ({ id: `e-${i}`, ...input }));
    });
    const journal = new ChronicleRemoteJournal(
      {
        projectRoot: '/p',
        globalRoot: '/g',
        projectId: 'p1',
        projectDir: '/d',
        workspaceId: 'w',
        maxPending: 2,
        batchWindowMs: 0,
      },
      client,
    );
    // Same synchronous tick: both events queue before the microtask batch
    // starts, so the third append hits the backpressure limit.
    const held = [journal.append(event('1')), journal.append(event('2'))];
    const overflow = journal.append(event('3'));
    await expect(overflow).rejects.toThrow(
      'Chronicle backpressure limit reached (2 pending events)',
    );
    release();
    await Promise.all(held);
    await journal.dispose();
  });

  it('counts failed events and rejects their appends', async () => {
    const { client } = fakeClient(() => {
      throw new Error('journal full');
    });
    const journal = new ChronicleRemoteJournal(
      { projectRoot: '/p', globalRoot: '/g', projectId: 'p1', projectDir: '/d', workspaceId: 'w' },
      client,
    );
    await expect(journal.append(event('x'))).rejects.toThrow('journal full');
    expect(journal.stats()).toMatchObject({ failedEvents: 1, persistedEvents: 0 });
    await journal.dispose();
  });

  it('rejects mismatched batch lengths from the server', async () => {
    const { client } = fakeClient(() => []);
    const journal = new ChronicleRemoteJournal(
      { projectRoot: '/p', globalRoot: '/g', projectId: 'p1', projectDir: '/d', workspaceId: 'w' },
      client,
    );
    await expect(journal.append(event('x'))).rejects.toThrow(
      'Chronicle server returned 0 events for 1 inputs',
    );
    expect(journal.stats()).toMatchObject({ failedEvents: 1 });
    await journal.dispose();
  });

  it('flush drains pending batches even outside the window', async () => {
    const { client, calls } = fakeClient((inputs) =>
      inputs.map((input, i) => ({ id: `e-${i}`, ...input })),
    );
    const journal = new ChronicleRemoteJournal(
      {
        projectRoot: '/p',
        globalRoot: '/g',
        projectId: 'p1',
        projectDir: '/d',
        workspaceId: 'w',
        batchWindowMs: 60_000,
      },
      client,
    );
    const pending = journal.append(event('held'));
    await journal.flush();
    await expect(pending).resolves.toBeTruthy();
    expect(calls.filter((c) => c.op === 'append')).toHaveLength(1);
    await journal.dispose();
  });

  it('skips the flush round trip when nothing was ever accepted', async () => {
    const { client, calls } = fakeClient(() => []);
    const journal = new ChronicleRemoteJournal(
      { projectRoot: '/p', globalRoot: '/g', projectId: 'p1', projectDir: '/d', workspaceId: 'w' },
      client,
    );
    await journal.flush();
    expect(calls).toHaveLength(0);
    await journal.dispose();
  });

  it('records the last batch duration in stats', async () => {
    const { client } = fakeClient((inputs) => inputs.map((input, i) => ({ id: `e-${i}`, ...input })));
    const journal = new ChronicleRemoteJournal(
      { projectRoot: '/p', globalRoot: '/g', projectId: 'p1', projectDir: '/d', workspaceId: 'w' },
      client,
    );
    await journal.append(event('a'));
    await journal.flush();
    expect(journal.stats().lastBatchDurationMs).toBeGreaterThanOrEqual(0);
    await journal.dispose();
  });
});
