import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MCPTaskJournal } from '../src/task-journal.js';
import { MCPTaskRecovery } from '../src/task-recovery.js';

const task = {
  taskId: 'task-1',
  status: 'working',
  createdAt: '2026-10-28T00:00:00Z',
  lastUpdatedAt: '2026-10-28T00:00:00Z',
  ttlMs: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

// The client rejects an aborted call without waiting for a pending onStatus
// hook. A receipt created after that used to start a lease heartbeat nothing
// cleared, and the task stayed "busy" for this process for good (F903).
it('releases a receipt whose creation finishes after the aborted call settled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-'));
  const original = MCPTaskJournal.prototype.create;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  let finished!: () => void;
  const created = new Promise<void>((resolve) => (finished = resolve));
  vi.spyOn(MCPTaskJournal.prototype, 'create').mockImplementation(async function (
    this: MCPTaskJournal,
    ...args: Parameters<MCPTaskJournal['create']>
  ) {
    entered();
    await gate;
    try {
      return await original.apply(this, args);
    } finally {
      finished();
    }
  });
  const release = vi.spyOn(MCPTaskJournal.prototype, 'release');

  const recovery = new MCPTaskRecovery(dir, {
    withClient: async () => {
      throw new Error('not used');
    },
    log: { warn() {}, info() {}, debug() {}, error() {} } as never,
  });
  const context = {
    session: { id: 'sess' },
    agentId: 'agent',
    signal: new AbortController().signal,
  };
  const abort = new AbortController();
  const client = {
    opts: { name: 'srv', transport: 'stdio', command: 'x', cwd: process.cwd() },
    getServerMetadata: () => ({
      protocolVersion: '2026-07-28',
      capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    }),
    callTool: async (
      _name: string,
      _input: unknown,
      opts: {
        signal: AbortSignal;
        tasks: { beforeRequest(): Promise<void>; onStatus(task: unknown): Promise<void> };
      },
    ) => {
      await opts.tasks.beforeRequest();
      const hook = opts.tasks.onStatus(structuredClone(task));
      await new Promise<void>((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        hook.then(resolve, reject);
        void reached.then(() => abort.abort());
      });
    },
  };

  try {
    await expect(
      recovery.execute(
        client as never,
        { name: 'tool' } as never,
        {},
        context as never,
        abort.signal,
      ),
    ).rejects.toThrow('aborted');
    open();
    await created;
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
    const [receipt] = await recovery.list(context as never);
    expect(receipt?.leaseExpiresAt).toBeUndefined();
    expect(await recovery.retry(context as never, receipt?.id ?? '')).toBe('requested');
  } finally {
    recovery.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('does not start recovery when dispose or abort arrives while retry awaits journal.list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-retry-fence-'));
  const journal = new MCPTaskJournal(dir);
  const owner = { sessionId: 'sess', agentId: 'agent' };
  const leaseToken = '00000000-0000-4000-8000-000000000001';
  const created = await journal.create(
    owner,
    'srv',
    'tool',
    'a'.repeat(64),
    { ...task, status: 'working' as const },
    leaseToken,
  );
  await journal.release(created.id, leaseToken);

  const originalList = MCPTaskJournal.prototype.list;
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let listEntered!: () => void;
  const listReady = new Promise<void>((resolve) => {
    listEntered = resolve;
  });
  vi.spyOn(MCPTaskJournal.prototype, 'list').mockImplementation(async function (
    this: MCPTaskJournal,
    ...args: Parameters<MCPTaskJournal['list']>
  ) {
    listEntered();
    await listGate;
    return originalList.apply(this, args);
  });

  let withClientCalls = 0;
  const recovery = new MCPTaskRecovery(dir, {
    withClient: async () => {
      withClientCalls++;
      throw new Error('should not be called');
    },
    log: { warn() {}, info() {}, debug() {}, error() {} } as never,
  });

  try {
    const abort = new AbortController();
    const context = {
      session: { id: 'sess' },
      agentId: 'agent',
      signal: abort.signal,
    };
    const retrying = recovery.retry(context as never, created.id);
    await listReady;
    recovery.dispose();
    abort.abort();
    releaseList();
    expect(await retrying).toBe('unavailable');
    await recovery.drain();
    expect(withClientCalls).toBe(0);
  } finally {
    recovery.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
