import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LSPRegistry, registryCoverage } from '../../src/registry.js';

const directories: string[] = [];
const log = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child() {
    return this;
  },
  level: 'error',
};

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function registry() {
  const tracker = { reopenForServer: vi.fn(async () => undefined) };
  const value = new LSPRegistry(
    {
      servers: {},
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      diagnosticsWaitMs: 1,
      severityFilter: ['error'],
      maxDiagnosticsPerFile: 10,
      maxDiagnosticsTotal: 10,
      autoDiscover: false,
      logServerOutput: false,
    },
    tracker as never,
    { cwd: process.cwd(), log: log as never, events: new EventBus() },
  );
  return { value, tracker };
}

describe('registry completion coverage', () => {
  it('logs eager server start failures', async () => {
    const server = {
      name: 'broken',
      start: vi.fn(async () => {
        throw new Error('cannot start');
      }),
    };
    await registryCoverage.startServerSafely(server as never, log as never);
    expect(log.warn).toHaveBeenCalledWith(
      'LSP broken failed to start',
      expect.objectContaining({ message: 'cannot start' }),
    );
  });

  it('detects project languages through nested and ignored directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-languages-'));
    directories.push(root);
    await fs.mkdir(path.join(root, 'a', 'b', 'c', 'd'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'a.ts'), '');
    await fs.writeFile(path.join(root, 'notes.txt'), '');
    await fs.writeFile(path.join(root, 'a', 'b.py'), '');
    await fs.writeFile(path.join(root, 'a', 'b', 'c', 'd', 'too-deep.rs'), '');
    await fs.writeFile(path.join(root, 'node_modules', 'ignored.go'), '');
    const found = await registryCoverage.detectProjectLanguages(root);
    expect(found).toEqual(new Set(['typescript', 'python']));
    expect(await registryCoverage.detectProjectLanguages(path.join(root, 'missing'))).toEqual(
      new Set(),
    );
  });

  it('starts, stops, restarts, shuts down, and handles stale indexes', async () => {
    const { value, tracker } = registry();
    const state = value as unknown as {
      servers: Map<string, unknown>;
      languageIndex: Map<string, string>;
      reconnectTimers: Map<string, NodeJS.Timeout>;
    };
    const server = {
      name: 'fake',
      state: 'stopped',
      start: vi.fn(async () => {
        server.state = 'ready';
      }),
      shutdown: vi.fn(async () => {
        server.state = 'stopped';
      }),
    };
    await expect(value.findForPath('a.ts')).resolves.toBeNull();
    state.servers.set('fake', server);
    state.languageIndex.set('typescript', 'missing');
    await expect(value.findForPath('a.ts')).resolves.toBeNull();
    state.languageIndex.set('typescript', 'fake');
    await expect(value.findForPath('a.ts')).resolves.toBe(server);
    expect(tracker.reopenForServer).toHaveBeenCalled();

    await value.start('fake');
    const timer = setTimeout(() => {}, 10_000);
    state.reconnectTimers.set('fake', timer);
    await value.stop('fake');
    expect(state.reconnectTimers.has('fake')).toBe(false);
    await value.restart('fake');

    state.reconnectTimers.set(
      'fake',
      setTimeout(() => {}, 10_000),
    );
    server.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
    await value.shutdown();
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns a non-ready server in manual mode as unavailable', async () => {
    const { value } = registry();
    await value.bind(process.cwd(), 'never');
    const state = value as unknown as {
      servers: Map<string, unknown>;
      languageIndex: Map<string, string>;
    };
    state.servers.set('fake', { name: 'fake', state: 'stopped' });
    state.languageIndex.set('typescript', 'fake');
    await expect(value.findForPath('a.ts')).resolves.toBeNull();
  });

  it('schedules successful reconnects, deduplicates timers, and enforces the attempt cap', async () => {
    vi.useFakeTimers();
    const { value, tracker } = registry();
    const state = value as unknown as {
      reconnectAttempts: Map<string, number>;
      reconnectTimers: Map<string, NodeJS.Timeout>;
      scheduleReconnect: (server: unknown) => void;
    };
    const server = {
      name: 'fake',
      state: 'failed',
      start: vi.fn(async () => {
        server.state = 'ready';
      }),
    };
    state.scheduleReconnect(server);
    state.scheduleReconnect(server);
    expect(state.reconnectTimers.size).toBe(1);
    await vi.runAllTimersAsync();
    expect(server.start).toHaveBeenCalledOnce();
    expect(tracker.reopenForServer).toHaveBeenCalled();

    state.reconnectAttempts.set('fake', 3);
    state.scheduleReconnect(server);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('attempts exhausted'));
  });
});
