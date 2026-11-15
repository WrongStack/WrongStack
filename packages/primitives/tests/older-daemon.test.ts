import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  forceStopDaemon,
  OLDER_RELEASE_REPLACEMENT,
  OlderDaemonError,
  replaceOlderDaemon,
  retireOlderDaemon,
} from '../src/older-daemon.js';
import { WRONGSTACK_RUNTIME_VERSION } from '../src/runtime-version.js';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** A process standing in for a daemon that keeps answering. */
function liveDaemon(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** The pid of a process that already exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await exited(child);
  return child.pid!;
}

describe('retireOlderDaemon', () => {
  it('sends the shutdown frame, closes the connection and fails the connect', async () => {
    const written: string[] = [];
    let destroyed = false;
    const socket = {
      get destroyed() {
        return destroyed;
      },
      write: (frame: string) => written.push(frame),
      destroy: () => {
        destroyed = true;
      },
    };
    const error = retireOlderDaemon(
      socket,
      () => `shutdown:${OLDER_RELEASE_REPLACEMENT}`,
      { pid: 4321, runtimeVersion: '1.0.0' },
      'Test project server',
    );
    expect(written).toEqual(['shutdown:older-release-replacement']);
    expect(error).toBeInstanceOf(OlderDaemonError);
    expect(error.pid).toBe(4321);
    expect(error.message).toBe(
      `Test project server 1.0.0 is older than this client ${WRONGSTACK_RUNTIME_VERSION}`,
    );
    await expect.poll(() => destroyed).toBe(true);
  });

  it('fails the connect when the socket is gone or the request cannot be written', () => {
    const throwing = {
      destroyed: false,
      write: () => {
        throw new Error('EPIPE');
      },
      destroy: () => {},
    };
    for (const socket of [null, throwing]) {
      const error = retireOlderDaemon(socket, () => 'frame', { pid: 'x' }, 'Test');
      expect(error).toBeInstanceOf(OlderDaemonError);
      expect(error.pid).toBeUndefined();
    }
  });
});

describe('forceStopDaemon', () => {
  it('ends nothing without a pid or for this process', () => {
    expect(forceStopDaemon(undefined)).toBe(false);
    expect(forceStopDaemon(0)).toBe(false);
    expect(forceStopDaemon(process.pid)).toBe(false);
  });

  it('reports a daemon that already exited instead of throwing', async () => {
    expect(forceStopDaemon(await exitedPid())).toBe(false);
  });

  it('ends a daemon that keeps answering', async () => {
    const daemon = liveDaemon();
    expect(forceStopDaemon(daemon.pid)).toBe(true);
    await exited(daemon);
  });
});

describe('replaceOlderDaemon', () => {
  it('ignores other connect failures', async () => {
    const attempts = { count: 0 };
    expect(await replaceOlderDaemon(new Error('ECONNREFUSED'), attempts)).toBe(false);
    expect(attempts.count).toBe(0);
  });

  it('lets the caller start its daemon once the older one has exited', async () => {
    const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {
      stdio: 'ignore',
    });
    children.push(daemon);
    const older = new OlderDaemonError('older', daemon.pid);
    expect(await replaceOlderDaemon(older, { count: 0 })).toBe(true);
    expect(daemon.pid && isRunning(daemon.pid)).toBe(false);
  });

  it('stops waiting for an older daemon that keeps running after the grace', async () => {
    const daemon = liveDaemon();
    const started = Date.now();
    const older = new OlderDaemonError('older', daemon.pid);
    expect(await replaceOlderDaemon(older, { count: 0 }, 200)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(isRunning(daemon.pid!)).toBe(true);
  });

  it('ends the older daemon at the third request it did not follow', async () => {
    const daemon = liveDaemon();
    const attempts = { count: 0 };
    const older = new OlderDaemonError('older', daemon.pid);
    expect(await replaceOlderDaemon(older, attempts, 100)).toBe(true);
    expect(await replaceOlderDaemon(older, attempts, 100)).toBe(true);
    expect(daemon.exitCode).toBeNull();
    expect(daemon.signalCode).toBeNull();
    expect(await replaceOlderDaemon(older, attempts)).toBe(true);
    expect(isRunning(daemon.pid!)).toBe(false);
    expect(attempts.count).toBe(3);
  });

  it('keeps electing when the daemon it would end already exited', async () => {
    const attempts = { count: 2 };
    const older = new OlderDaemonError('older', await exitedPid());
    expect(await replaceOlderDaemon(older, attempts)).toBe(true);
  });
});
