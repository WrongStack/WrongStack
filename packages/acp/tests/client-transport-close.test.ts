/**
 * ClientTransport tells its close listeners when the agent connection ends
 * (the process exits, a frame limit trips, stop()), naming the cause, so
 * ACPSession can fail in-flight requests at once instead of at their timeout.
 * See agent-connection-close.test.ts for the session side.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, spawn: (...a: unknown[]) => spawnMock.fn(...a) };
});

import { ClientTransport } from '../src/agent/stdio-transport.js';

class FakeChildStream extends EventEmitter {
  setEncoding = vi.fn();
  write(_data: string, _enc?: unknown, cb?: (err?: Error) => void): boolean {
    cb?.();
    return true;
  }
}
class FakeChild extends EventEmitter {
  stdout = new FakeChildStream();
  stdin = new FakeChildStream();
  stderr = new FakeChildStream();
  pid: number | undefined = 4321;
  kill = vi.fn();
}

async function startedChild(maxFrameChars?: number) {
  const child = new FakeChild();
  // Reset first: stopping an earlier child spawns the platform tree-kill
  // through this same mock.
  spawnMock.fn.mockReset();
  spawnMock.fn.mockReturnValue(child);
  const transport = new ClientTransport({
    command: 'agent',
    skipHandshakeMarker: true,
    maxFrameChars,
  });
  const started = transport.start();
  await vi.waitFor(() => expect(spawnMock.fn).toHaveBeenCalled());
  child.emit('spawn');
  await started;
  return { transport, child };
}

function startingMarkerChild(transport: ClientTransport) {
  const child = new FakeChild();
  child.pid = undefined;
  const spawned = Promise.withResolvers<void>();
  spawnMock.fn.mockImplementationOnce(() => {
    spawned.resolve();
    return child;
  });
  const outcome = vi.fn();
  const completed = transport.start().then(
    () => outcome('ready'),
    (error: Error) => outcome(error.message),
  );
  return { child, spawned: spawned.promise, outcome, completed };
}

describe('ClientTransport onClose', () => {
  it('can finish the stdio handshake after the first chunk of a long deadline', async () => {
    spawnMock.fn.mockReset();
    const transport = new ClientTransport({ command: 'agent', handshakeTimeoutMs: 2_147_483_652 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const current = startingMarkerChild(transport);
      await current.spawned;
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(current.outcome).not.toHaveBeenCalled();
      expect(current.child.kill).not.toHaveBeenCalled();
      current.child.stdout.emit('data', '[wstack-acp]\n');
      await current.completed;
      expect(current.outcome).toHaveBeenCalledExactlyOnceWith('ready');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.stop();
      vi.useRealTimers();
    }
  });

  it.each(['stop', 'child close'] as const)(
    'settles every pending reader in order on %s',
    async (mode) => {
      spawnMock.fn.mockReset();
      const transport = new ClientTransport({ command: 'agent' });
      const current = startingMarkerChild(transport);
      try {
        await current.spawned;
        current.child.stdout.emit('data', '[wstack-acp]\n');
        await current.completed;
        const reads = [transport.read(), transport.read(), transport.read(), transport.read()];
        current.child.stdout.emit('data', '{"method":"one"}\n{"method":"two"}\n');
        if (mode === 'stop') transport.stop();
        else current.child.emit('close', 0, null);
        await expect(Promise.all(reads)).resolves.toEqual([
          { method: 'one' },
          { method: 'two' },
          null,
          null,
        ]);
      } finally {
        transport.stop();
      }
    },
  );

  it.each(['late chunk', 'claim', 'observer'] as const)(
    'discards queued output after a stop during %s',
    async (mode) => {
      const transport = new ClientTransport({ command: 'agent' });
      spawnMock.fn.mockReset();
      const current = startingMarkerChild(transport);
      try {
        await current.spawned;
        current.child.stdout.emit('data', '[wstack-acp]\n{"method":"control"}\n');
        await current.completed;
        await expect(transport.read()).resolves.toEqual({ method: 'control' });
        if (mode === 'late chunk') transport.stop();
        else if (mode === 'claim')
          transport.onMessageClaim(() => {
            transport.stop();
            return false;
          });
        else transport.onMessage(() => transport.stop());

        current.child.stdout.emit('data', '{"method":"first"}\n{"method":"second"}\n');
        await expect(transport.read()).resolves.toBeNull();
        expect(current.child.kill).toHaveBeenCalledTimes(1);
      } finally {
        transport.stop();
      }
    },
  );

  it('shares startup across calls before and after spawn', async () => {
    spawnMock.fn.mockReset();
    const transport = new ClientTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(77)'],
    });
    const settled = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = startingMarkerChild(transport);
      const second = transport.start().then(settled, settled);
      await first.spawned;
      const third = transport.start().then(settled, settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(first.outcome).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      expect(spawnMock.fn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      first.child.stdout.emit('data', '[wstack-acp]\n');
      await Promise.all([first.completed, second, third]);
      expect(first.outcome).toHaveBeenCalledExactlyOnceWith('ready');
      expect(settled.mock.calls).toEqual([[undefined], [undefined]]);
      await expect(transport.start()).resolves.toBeUndefined();
      expect(spawnMock.fn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.stop();
      vi.useRealTimers();
    }
  });

  it.each(['stop', 'timeout'] as const)('shares the startup %s with all callers', async (mode) => {
    spawnMock.fn.mockReset();
    const transport = new ClientTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(77)'],
      handshakeTimeoutMs: 30,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = startingMarkerChild(transport);
      await first.spawned;
      const result = vi.fn();
      const second = transport.start().then(
        () => result('ready'),
        (error: Error) => result(error.message),
      );
      if (mode === 'stop') transport.stop('startup cancelled');
      else await vi.advanceTimersByTimeAsync(30);
      const reason =
        mode === 'stop' ? 'startup cancelled' : 'ACP child process failed to start within 30ms';
      await Promise.all([first.completed, second]);
      expect(first.outcome).toHaveBeenCalledExactlyOnceWith(reason);
      expect(result).toHaveBeenCalledExactlyOnceWith(reason);
      expect(first.child.kill).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      if (mode === 'timeout') {
        const retry = startingMarkerChild(transport);
        await retry.spawned;
        retry.child.stdout.emit('data', '[wstack-acp]\n');
        await retry.completed;
        expect(retry.outcome).toHaveBeenCalledExactlyOnceWith('ready');
        expect(spawnMock.fn).toHaveBeenCalledTimes(2);
      }
    } finally {
      transport.stop();
      vi.useRealTimers();
    }
  });

  it.each([true, false])('never spawns after stop (skip marker: %s)', async (skipMarker) => {
    spawnMock.fn.mockReset();
    const transport = new ClientTransport({ command: 'agent', skipHandshakeMarker: skipMarker });
    const starting = transport.start();
    transport.stop();
    await expect(starting).rejects.toThrow('ClientTransport is closed');
    await expect(transport.start()).rejects.toThrow('ClientTransport is closed');
    expect(spawnMock.fn).not.toHaveBeenCalled();
    await expect(transport.read()).resolves.toBeNull();
  });

  it.each([true, false])(
    'cancels a spawned child before its readiness event (skip marker: %s)',
    async (skipMarker) => {
      const child = new FakeChild();
      child.pid = undefined;
      const spawned = Promise.withResolvers<void>();
      spawnMock.fn.mockReset().mockImplementationOnce(() => {
        spawned.resolve();
        return child;
      });
      const transport = new ClientTransport({ command: 'agent', skipHandshakeMarker: skipMarker });
      const resolved = vi.fn();
      const rejected = vi.fn();
      const onClose = vi.fn();
      transport.onClose(onClose);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const starting = transport.start().then(resolved, rejected);
        await spawned.promise;
        expect(vi.getTimerCount()).toBe(1);

        transport.stop('startup cancelled');
        await vi.advanceTimersByTimeAsync(0);
        expect(rejected).toHaveBeenCalledExactlyOnceWith(new Error('startup cancelled'));
        expect(vi.getTimerCount()).toBe(0);
        expect(child.kill).toHaveBeenCalledTimes(1);

        if (skipMarker) {
          expect(child.listenerCount('spawn')).toBe(0);
          child.emit('spawn');
        } else {
          expect(child.stdout.listenerCount('data')).toBe(0);
          child.stdout.emit('data', '[wstack-acp]\n');
        }
        await starting;
        await expect(transport.read()).resolves.toBeNull();
        expect(resolved).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledExactlyOnceWith('startup cancelled');
      } finally {
        transport.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    [7, null, 'agent process exited with code 7: startup diagnostic'],
    [0, null, 'agent process exited with code 0'],
    [null, 'SIGTERM', 'agent process terminated by signal SIGTERM: startup diagnostic'],
  ] as const)('settles startup when the child closes (%s, %s)', async (code, signal, reason) => {
    spawnMock.fn.mockReset();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const transport = new ClientTransport({ command: 'agent' });
    const closed = vi.fn();
    transport.onClose(closed);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { child, spawned, outcome, completed } = startingMarkerChild(transport);
    try {
      await spawned;
      child.stderr.emit('data', 'launcher output\nstartup diagnostic\n');
      const pendingRead = transport.read();
      child.emit('close', code, signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toHaveBeenCalledExactlyOnceWith(reason);
      expect(closed).toHaveBeenCalledExactlyOnceWith(reason);
      expect(vi.getTimerCount()).toBe(0);
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.kill).not.toHaveBeenCalled();
      await expect(pendingRead).resolves.toBeNull();
      await completed;
    } finally {
      transport.stop();
      vi.useRealTimers();
      stderr.mockRestore();
    }
  });

  it('ignores the timed-out child when its replacement is starting', async () => {
    spawnMock.fn.mockReset();
    const transport = new ClientTransport({ command: 'agent', handshakeTimeoutMs: 30 });
    const closed = vi.fn();
    transport.onClose(closed);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const old = startingMarkerChild(transport);
      await old.spawned;
      old.child.stderr.emit('data', 'old startup output\n');
      await vi.advanceTimersByTimeAsync(30);
      await old.completed;
      expect(old.outcome).toHaveBeenCalledExactlyOnceWith(
        'ACP child process failed to start within 30ms',
      );
      expect(old.child.kill).toHaveBeenCalledTimes(1);

      const next = startingMarkerChild(transport);
      await next.spawned;
      old.child.stderr.emit('data', 'late output from the old child\n');
      old.child.emit('close', 7, null);
      expect(closed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      next.child.emit('close', 8, null);
      await next.completed;
      expect(next.outcome).toHaveBeenCalledExactlyOnceWith('agent process exited with code 8');
      expect(closed).toHaveBeenCalledExactlyOnceWith('agent process exited with code 8');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      transport.stop();
      vi.useRealTimers();
    }
  });

  it('requires a fresh readiness marker after a timed-out partial marker', async () => {
    spawnMock.fn.mockReset();
    const transport = new ClientTransport({ command: 'agent', handshakeTimeoutMs: 30 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const old = startingMarkerChild(transport);
      await old.spawned;
      old.child.stdout.emit('data', '[wstack-acp]');
      await vi.advanceTimersByTimeAsync(30);
      await old.completed;
      expect(old.outcome).toHaveBeenCalledExactlyOnceWith(
        'ACP child process failed to start within 30ms',
      );
      const retry = startingMarkerChild(transport);
      await retry.spawned;
      retry.child.stdout.emit('data', '\n');
      old.child.stdout.emit('data', '\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(retry.outcome).not.toHaveBeenCalled();
      retry.child.stdout.emit('data', '[wstack-');
      await vi.advanceTimersByTimeAsync(0);
      expect(retry.outcome).not.toHaveBeenCalled();
      retry.child.stdout.emit('data', 'acp]\n{"method":"fresh"}\n');
      await retry.completed;
      expect(retry.outcome).toHaveBeenCalledExactlyOnceWith('ready');
      await expect(transport.read()).resolves.toEqual({ method: 'fresh' });
    } finally {
      transport.stop();
      vi.useRealTimers();
    }
  });

  it.each(['child', 'stdout'] as const)(
    'ignores retired %s errors before, during and after a retry',
    async (source) => {
      spawnMock.fn.mockReset();
      const transport = new ClientTransport({ command: 'agent', handshakeTimeoutMs: 30 });
      const closed = vi.fn();
      transport.onClose(closed);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const old = startingMarkerChild(transport);
        await old.spawned;
        await vi.advanceTimersByTimeAsync(30);
        await old.completed;
        expect(old.outcome).toHaveBeenCalledExactlyOnceWith(
          'ACP child process failed to start within 30ms',
        );

        const emitter = source === 'child' ? old.child : old.child.stdout;
        emitter.emit('error', new Error('late error before retry'));
        const replacement = startingMarkerChild(transport);
        await Promise.race([replacement.spawned, replacement.completed]);
        expect(spawnMock.fn).toHaveBeenCalledTimes(2);
        emitter.emit('error', new Error('late error during retry'));
        replacement.child.stdout.emit('data', '[wstack-acp]\n');
        await replacement.completed;
        expect(replacement.outcome).toHaveBeenCalledExactlyOnceWith('ready');
        await expect(transport.send({ method: 'fixture' })).resolves.toBeUndefined();

        emitter.emit('error', new Error('late error after readiness'));
        await expect(transport.send({ method: 'fixture' })).resolves.toBeUndefined();
        expect(closed).not.toHaveBeenCalled();
        expect(replacement.child.kill).not.toHaveBeenCalled();
      } finally {
        transport.stop();
        vi.useRealTimers();
      }
    },
  );

  it('reports the exit code once and isolates a faulty listener', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { transport, child } = await startedChild();
    const reasons: string[] = [];
    const dropped = vi.fn();
    transport.onClose(() => {
      throw new Error('faulty listener');
    });
    transport.onClose((r) => reasons.push(r));
    transport.onClose(dropped)();
    child.emit('close', 3);
    transport.stop();
    expect(reasons).toEqual(['agent process exited with code 3']);
    expect(dropped).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('names the frame limit and a local stop as the cause', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pending = await startedChild(8);
    const reasons: string[] = [];
    pending.transport.onClose((r) => reasons.push(r));
    pending.child.stdout.emit('data', '123456789');

    const complete = await startedChild(8);
    complete.transport.onClose((r) => reasons.push(r));
    complete.child.stdout.emit('data', '{"method":"too-long"}\n');

    const stopped = await startedChild();
    stopped.transport.onClose((r) => reasons.push(r));
    stopped.transport.stop();
    expect(reasons).toEqual([
      'agent frame exceeds 8 characters',
      'agent frame exceeds 8 characters',
      'transport stopped',
    ]);
    stderr.mockRestore();
  });

  it('keeps routine child stderr off the host and shows it when the child crashes', async () => {
    vi.stubEnv('WRONGSTACK_DEBUG', '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { transport, child } = await startedChild();
    const reasons: string[] = [];
    transport.onClose((r) => reasons.push(r));
    child.stderr.emit('data', 'Unexpected case: {"type":"system","subtype":"ui_status"}\n');
    expect(stderr).not.toHaveBeenCalled();
    child.stderr.emit('data', 'Error: not signed in\n\n');
    child.emit('close', 1);
    expect(reasons).toEqual(['agent process exited with code 1: Error: not signed in']);
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('[acp-child exited with code 1]');
    expect(printed).toContain('Error: not signed in');
    stderr.mockRestore();
    vi.unstubAllEnvs();
  });

  it('does not report its own teardown kill as a crash', async () => {
    vi.stubEnv('WRONGSTACK_DEBUG', '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { transport, child } = await startedChild();
    child.stderr.emit('data', 'Unexpected case: {"subtype":"ui_status"}\n');
    transport.stop();
    // treeKill on Windows ends the process with exit code 1.
    child.emit('close', 1);
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).not.toContain('exited with code');
    expect(printed).not.toContain('ui_status');
    stderr.mockRestore();
    vi.unstubAllEnvs();
  });

  it('echoes child stderr live under WRONGSTACK_DEBUG and stays quiet on a clean exit', async () => {
    vi.stubEnv('WRONGSTACK_DEBUG', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { transport, child } = await startedChild();
    const reasons: string[] = [];
    transport.onClose((r) => reasons.push(r));
    child.stderr.emit('data', 'phase=sdk-initialize\n');
    expect(String(stderr.mock.calls[0]?.[0])).toBe('[acp-child stderr] phase=sdk-initialize\n');
    child.emit('close', 0);
    expect(reasons).toEqual(['agent process exited with code 0']);
    expect(stderr).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
    vi.unstubAllEnvs();
  });

  it('refuses to send once the connection is closed, even before the child is reaped', async () => {
    const { transport, child } = await startedChild();
    child.emit('error', new Error('post-ready crash'));
    await expect(transport.send({ jsonrpc: '2.0', method: 'x' } as never)).rejects.toThrow(
      'ClientTransport is closed',
    );
    transport.stop();
  });

  it.each(['child', 'stdout'] as const)(
    'settles pending readers and reports an owned %s error without waiting for exit',
    async (source) => {
      const transport = new ClientTransport({ command: 'agent' });
      spawnMock.fn.mockReset();
      const current = startingMarkerChild(transport);
      try {
        await current.spawned;
        current.child.stdout.emit('data', '[wstack-acp]\n');
        await current.completed;
        const closed = vi.fn();
        transport.onClose(closed);
        const reads = Promise.all([transport.read(), transport.read()]);
        const emitter = source === 'child' ? current.child : current.child.stdout;
        emitter.emit('error', new Error('fixture I/O failure'));
        expect(closed).toHaveBeenCalledExactlyOnceWith(
          'agent transport error: fixture I/O failure',
        );
        await expect(reads).resolves.toEqual([null, null]);
        expect(current.child.kill).toHaveBeenCalledTimes(1);
        current.child.emit('close', 0, null);
        expect(closed).toHaveBeenCalledTimes(1);
        await expect(transport.send({ method: 'fixture' })).rejects.toThrow(
          'ClientTransport is closed',
        );
      } finally {
        transport.stop();
      }
    },
  );
});
