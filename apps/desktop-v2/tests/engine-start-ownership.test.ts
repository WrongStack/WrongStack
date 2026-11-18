import { afterEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  ready: Promise.withResolvers<void>(),
  stop: vi.fn(),
}));
vi.mock('@wrongstack/core/utils', () => ({ hardenWin32ExecutableSearch: () => {} }));
vi.mock('@wrongstack/webui-server', () => ({
  startWebUI: () => {
    backend.started.resolve();
    return backend.ready.promise;
  },
}));
vi.mock('../engine/stop-request', () => ({
  stopGracefully: backend.stop,
  watchStopRequest: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('detects a dead owner while the desktop engine is still booting', async () => {
  const owner = 424_242;
  let alive = true;
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== owner || signal !== 0) return kill(pid, signal);
    if (!alive) throw Object.assign(new Error('Owner exited'), { code: 'ESRCH' });
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((_code) => undefined as never);
  vi.stubGlobal(
    'process',
    Object.assign(Object.create(process), { argv: ['bun', 'engine', '--port', '14200'] }),
  );
  vi.stubEnv('WEBUI_TOKEN', 'startup-ownership-fixture');
  vi.stubEnv('WRONGSTACK_DESKTOP_EMPTY_DIST', 'fixture');
  vi.stubEnv('WRONGSTACK_DESKTOP_HOST_PID', String(owner));
  vi.stubEnv('WRONGSTACK_DESKTOP_SPARE_CLAIM', undefined);
  vi.stubEnv('WRONGSTACK_DESKTOP_STOP_FILE', undefined);
  vi.useFakeTimers();
  const engine = import('../engine/main');
  try {
    await backend.started.promise;
    await vi.advanceTimersByTimeAsync(2000);
    expect(backend.stop).not.toHaveBeenCalled();
    alive = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(backend.stop).toHaveBeenCalledOnce();
  } finally {
    backend.ready.resolve();
    await engine;
    vi.clearAllTimers();
  }
});
