import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
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

function registry(onAvailabilityChange?: (available: boolean) => void) {
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
    { cwd: process.cwd(), log: log as never, events: new EventBus(), onAvailabilityChange },
  );
  return { value, tracker };
}

describe('registry completion coverage', () => {
  it('reopens documents only for eager servers that actually become ready', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-eager-'));
    directories.push(root);
    await fs.writeFile(path.join(root, 'source.ts'), 'export const answer = 42;');
    const { value, tracker } = registry();
    const ready = {
      name: 'ready',
      state: 'stopped',
      config: { languages: ['typescript'] },
      start: vi.fn(async () => {
        ready.state = 'ready';
      }),
    };
    const failed = {
      name: 'failed',
      state: 'failed',
      config: { languages: ['typescript'] },
      start: vi.fn(async () => {
        throw new Error('start failed');
      }),
    };
    vi.spyOn(value, 'list').mockReturnValue([ready, failed] as never);
    await value.bind(root, 'eager');
    expect(ready.start).toHaveBeenCalledOnce();
    expect(failed.start).toHaveBeenCalledOnce();
    expect(tracker.reopenForServer).toHaveBeenCalledExactlyOnceWith(ready);
    expect(log.warn).toHaveBeenCalledWith('LSP failed failed to start', expect.any(Error));
  });

  it('shuts down mounted servers before rebinding the registry', async () => {
    const { value } = registry();
    const shutdown = vi.fn(async () => undefined);
    const state = value as unknown as {
      servers: Map<string, unknown>;
      reconnectAttempts: Map<string, number>;
    };
    state.servers.set('old-workspace', { name: 'old-workspace', shutdown });
    state.reconnectAttempts.set('old-workspace', 3);

    await value.bind(process.cwd(), 'lazy');

    expect(shutdown).toHaveBeenCalledOnce();
    expect(state.reconnectAttempts.size).toBe(0);
    expect(value.list()).toEqual([]);
  });

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

  it('logs a lazy start failure and still settles ensureProjectServersReady', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-ensure-'));
    directories.push(root);
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;');

    const { value, tracker } = registry();
    await value.bind(root);
    const broken = {
      name: 'broken',
      state: 'stopped',
      config: { languages: ['typescript'] },
      start: vi.fn(async () => {
        throw new Error('cannot start');
      }),
    };
    vi.spyOn(value, 'list').mockReturnValue([broken] as never);

    // One server failing to start must not reject the whole readiness sweep —
    // the other servers in the Promise.all still need to come up.
    await expect(value.ensureProjectServersReady()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'LSP broken failed to start',
      expect.objectContaining({ message: 'cannot start' }),
    );
    expect(tracker.reopenForServer).not.toHaveBeenCalled();
  });

  it('skips the readiness sweep when servers are not started lazily', async () => {
    const { value } = registry();
    await value.bind(process.cwd(), 'eager');
    const list = vi.spyOn(value, 'list');

    await value.ensureProjectServersReady();

    // Eager mode already started what it needs during bind(); sweeping again
    // would walk the project tree for nothing.
    expect(list).not.toHaveBeenCalled();
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

  it('detects custom file extensions declared by an arbitrary server', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-custom-language-'));
    directories.push(root);
    const file = path.join(root, 'component.vue');
    await fs.writeFile(file, '<template />');
    const servers = {
      vue: {
        command: 'vue-language-server',
        languages: ['vue'],
        fileExtensions: { '.vue': 'vue' },
      },
    };

    expect(registryCoverage.configuredLanguageIdFor(file, servers)).toBe('vue');
    expect(
      registryCoverage.configuredLanguageIdFor(path.join(root, 'unknown.custom'), servers),
    ).toBeNull();
    expect(
      registryCoverage.configuredLanguageIdFor(file, {
        vue: { ...servers.vue, languages: ['typescript'] },
      }),
    ).toBeNull();
    expect(await registryCoverage.detectProjectLanguages(root, servers)).toEqual(new Set(['vue']));
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

    const startTimer = setTimeout(() => {}, 10_000);
    state.reconnectTimers.set('fake', startTimer);
    (state as unknown as { reconnectAttempts: Map<string, number> }).reconnectAttempts.set(
      'fake',
      2,
    );
    tracker.reopenForServer.mockClear();
    await value.start('fake');
    expect(state.reconnectTimers.has('fake')).toBe(false);
    expect(
      (state as unknown as { reconnectAttempts: Map<string, number> }).reconnectAttempts.has(
        'fake',
      ),
    ).toBe(false);
    expect(tracker.reopenForServer).toHaveBeenCalledOnce();
    await value.start('fake');
    expect(tracker.reopenForServer).toHaveBeenCalledOnce();

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

  it('starts only project-relevant servers for live workspace-symbol search', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-relevant-'));
    directories.push(root);
    await fs.writeFile(path.join(root, 'source.ts'), 'export const answer = 42;');
    const { value, tracker } = registry();
    await value.bind(root, 'lazy');
    const state = value as unknown as { servers: Map<string, unknown> };
    const typescript = {
      name: 'typescript',
      state: 'exited',
      config: { languages: ['typescript'] },
      start: vi.fn(async () => {
        typescript.state = 'ready';
      }),
    };
    const gopls = {
      name: 'gopls',
      state: 'exited',
      config: { languages: ['go'] },
      start: vi.fn(async () => {
        gopls.state = 'ready';
      }),
    };
    state.servers.set('typescript', typescript);
    state.servers.set('gopls', gopls);

    await value.ensureProjectServersReady();

    expect(typescript.start).toHaveBeenCalledOnce();
    expect(gopls.start).not.toHaveBeenCalled();
    expect(tracker.reopenForServer).toHaveBeenCalledWith(typescript);
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

describe('runtime server mutation', () => {
  const cfg = (name: string) => ({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60_000)'],
    languages: [name],
    enabled: true,
  });

  it('reports tool availability as enabled servers are added, disabled, and removed', async () => {
    const availability = vi.fn();
    const { value } = registry(availability);

    await value.upsertServer('a', cfg('typescript'));
    await value.setServerEnabled('a', false);
    await value.setServerEnabled('a', true);
    await value.removeServer('a');

    expect(availability.mock.calls.map(([available]) => available)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('adds a server without tearing down the ones already mounted', async () => {
    const { value } = registry();
    await value.upsertServer('a', cfg('typescript'));
    const first = value.get('a');
    await value.upsertServer('b', cfg('go'));
    // rebuildServers() would have replaced the 'a' instance and orphaned its
    // child process; upsert must leave it exactly as it was.
    expect(value.get('a')).toBe(first);
    expect(
      value
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('replacing a server releases the old language claims', async () => {
    const { value } = registry();
    await value.upsertServer('a', cfg('typescript'));
    await value.upsertServer('a', { ...cfg('go'), languages: ['go'] });
    expect(value.list()).toHaveLength(1);
    expect(value.get('a')?.config.languages).toEqual(['go']);
    // A second server may now claim typescript — the stale claim is gone, so
    // no "claimed by multiple servers" warning is emitted.
    await value.upsertServer('b', cfg('typescript'));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('claimed by multiple'));
  });

  it('an upsert of a disabled server mounts nothing', async () => {
    const { value } = registry();
    await value.upsertServer('a', { ...cfg('typescript'), enabled: false });
    expect(value.get('a')).toBeNull();
  });

  it('removeServer on an untouched registry is a no-op, not a crash', async () => {
    const { value } = registry();
    await value.removeServer('never-mounted');
    expect(value.list()).toHaveLength(0);
  });

  it('removeServer forgets the config entry so a restart cannot resurrect it', async () => {
    const { value } = registry();
    await value.upsertServer('a', cfg('typescript'));
    await value.removeServer('a');
    expect(value.get('a')).toBeNull();
    expect(value.list()).toHaveLength(0);
  });

  it('setServerEnabled unmounts and remounts', async () => {
    const { value } = registry();
    await value.upsertServer('a', cfg('typescript'));
    expect((await value.setServerEnabled('a', false)).enabled).toBe(false);
    expect(value.get('a')).toBeNull();
    expect((await value.setServerEnabled('a', true)).enabled).toBe(true);
    expect(value.get('a')).not.toBeNull();
  });

  it('setServerEnabled rejects an unknown server', async () => {
    const { value } = registry();
    await expect(value.setServerEnabled('nope', true)).rejects.toThrow('No LSP server named');
  });

  it('logs but survives a server that fails to shut down', async () => {
    const { value } = registry();
    await value.upsertServer('a', cfg('typescript'));
    const server = value.get('a')!;
    server.shutdown = vi.fn(async () => {
      throw new Error('stuck');
    });
    await value.removeServer('a');
    expect(log.warn).toHaveBeenCalledWith(
      'LSP a shutdown failed',
      expect.objectContaining({ message: 'stuck' }),
    );
    expect(value.get('a')).toBeNull();
  });

  it('reassigns language claims past unrelated servers when the primary owner is disabled (F129)', async () => {
    const { value } = registry();
    await value.upsertServer('a', cfg('typescript'));
    await value.upsertServer('python', cfg('python'));
    await value.upsertServer('b', cfg('typescript'));
    (value.get('b') as unknown as { state: string }).state = 'ready';

    await value.setServerEnabled('a', false);
    const resolved = await value.findForPath('index.ts');
    expect(resolved?.name).toBe('b');
    expect(value.get('python')).not.toBeNull();
  });

  it('does not resurrect a server stopped while a scheduled reconnect start() is in flight', async () => {
    vi.useFakeTimers();
    const { value, tracker } = registry();
    await value.upsertServer('a', cfg('typescript'));
    const server = value.get('a')!;
    server.state = 'failed';

    let rejectStart!: (error: Error) => void;
    server.start = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          server.state = 'initializing';
          rejectStart = reject;
        }),
    );

    const state = value as unknown as {
      scheduleReconnect: (s: typeof server) => void;
      reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    state.scheduleReconnect(server);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.start).toHaveBeenCalledTimes(1);

    await value.stop('a');
    expect(server.state).toBe('exited');

    rejectStart(new Error('Server "a" stopped during startup'));
    await Promise.resolve();
    await Promise.resolve();

    expect(server.state).toBe('exited');
    expect(state.reconnectTimers.has('a')).toBe(false);
    expect(tracker.reopenForServer).not.toHaveBeenCalled();
  });

  it('a crash report from a replaced instance does not schedule a reconnect', async () => {
    const { value } = registry();
    await value.upsertServer('a', cfg('typescript'));
    const stale = value.get('a')!;
    await value.upsertServer('a', cfg('typescript'));
    const current = value.get('a')!;
    expect(current).not.toBe(stale);
    // A late crash on the old instance: its exit handler marks it failed.
    stale.state = 'failed';
    stale.start = vi.fn(async () => undefined);

    const state = value as unknown as {
      scheduleReconnect: (s: typeof stale) => void;
      reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
      reconnectAttempts: Map<string, number>;
    };
    state.scheduleReconnect(stale);

    // Reconnecting the stale instance would launch a second process under the
    // name the replacement owns and burn the replacement's attempt budget.
    expect(stale.state).toBe('failed');
    expect(state.reconnectTimers.has('a')).toBe(false);
    expect(state.reconnectAttempts.has('a')).toBe(false);
    expect(stale.start).not.toHaveBeenCalled();
    expect(current.state).toBe('exited');
  });

  it.each(['exited', 'shutting_down', 'disabled'] as const)(
    'a crash report while the server is %s does not schedule a reconnect',
    async (stopped) => {
      const { value } = registry();
      await value.upsertServer('a', cfg('typescript'));
      const server = value.get('a')!;
      server.state = stopped;

      const state = value as unknown as {
        scheduleReconnect: (s: typeof server) => void;
        reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
        reconnectAttempts: Map<string, number>;
      };
      state.scheduleReconnect(server);

      // A stop or disable is the user's decision; flipping the state to
      // `reconnecting` would bring the server back moments later.
      expect(server.state).toBe(stopped);
      expect(state.reconnectTimers.has('a')).toBe(false);
      expect(state.reconnectAttempts.has('a')).toBe(false);
    },
  );

  it('a pending reconnect does not relaunch a server a lazy lookup already brought up', async () => {
    vi.useFakeTimers();
    const { value, tracker } = registry();
    await value.upsertServer('a', cfg('typescript'));
    const server = value.get('a')!;
    server.start = vi.fn(async () => {
      server.state = 'ready';
    });
    server.state = 'failed';

    const state = value as unknown as {
      scheduleReconnect: (s: typeof server) => void;
      reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    state.scheduleReconnect(server);
    expect(server.state).toBe('reconnecting');
    expect(state.reconnectTimers.has('a')).toBe(true);

    // During the back-off window a tool call needs the server and starts it.
    await expect(value.findForPath('index.ts')).resolves.toBe(server);
    expect(server.start).toHaveBeenCalledTimes(1);
    expect(tracker.reopenForServer).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(state.reconnectTimers.has('a')).toBe(false);
    expect(server.start).toHaveBeenCalledTimes(1);
    expect(tracker.reopenForServer).toHaveBeenCalledTimes(1);
    expect(server.state).toBe('ready');
  });

  it('a reconnect start that resolves after a stop does not reopen documents', async () => {
    vi.useFakeTimers();
    const { value, tracker } = registry();
    await value.upsertServer('a', cfg('typescript'));
    const server = value.get('a')!;
    server.state = 'failed';

    const state = value as unknown as {
      scheduleReconnect: (s: typeof server) => void;
      reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    state.scheduleReconnect(server);
    // Fire the timer synchronously: the real start() runs up to its
    // command-resolution await and nothing has been spawned yet.
    vi.advanceTimersByTime(1000);
    expect(server.state).toBe('starting');

    // The stop lands before the command resolves; start() then returns
    // normally (it does not reject) without reaching `ready`.
    await value.stop('a');
    await vi.advanceTimersByTimeAsync(0);

    expect(server.state).toBe('exited');
    expect((server as unknown as { child: unknown }).child).toBeNull();
    expect(state.reconnectTimers.has('a')).toBe(false);
    expect(tracker.reopenForServer).not.toHaveBeenCalled();
  });

  it('a lazy lookup does not reopen documents when the start is cut short by a stop', async () => {
    const { value, tracker } = registry();
    await value.upsertServer('a', cfg('typescript'));
    const server = value.get('a')!;

    // findForPath runs the real start() up to its command-resolution await;
    // a stop issued in that window wins and start() resolves without `ready`.
    const lookup = value.findForPath('index.ts');
    expect(server.state).toBe('starting');
    await value.stop('a');

    await expect(lookup).resolves.toBeNull();
    expect(server.state).toBe('exited');
    expect((server as unknown as { child: unknown }).child).toBeNull();
    expect(tracker.reopenForServer).not.toHaveBeenCalled();
  });

  it('DocumentTracker.reopenForServer skips documents already open on the server', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'f25-reopen-'));
    directories.push(root);
    const filePath = path.join(root, 'f25-reopen-idempotent.ts');
    await fs.writeFile(filePath, 'const x = 1;\n');

    let didOpenCount = 0;
    const openUris = new Set<string>();
    const fakeServer = {
      name: 'ts',
      state: 'ready' as const,
      config: { languages: ['typescript'], command: 'ts' },
      hasOpenDocument: (uri: string) => openUris.has(uri),
      notifyDidOpen: (doc: { uri: string }) => {
        didOpenCount++;
        openUris.add(doc.uri);
      },
      notifyDidChange: () => {},
      notifyDidClose: (uri: string) => openUris.delete(uri),
    };
    const docTracker = new DocumentTracker(
      () => ({ list: () => [fakeServer as never] }),
      log as never,
      root,
    );
    await docTracker.open(filePath, 'const x = 1;\n');
    expect(didOpenCount).toBe(1);

    await docTracker.reopenForServer(fakeServer as never);
    expect(didOpenCount).toBe(1);

    openUris.clear();
    await docTracker.reopenForServer(fakeServer as never);
    expect(didOpenCount).toBe(2);
  });
});
