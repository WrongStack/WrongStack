/**
 * `runOnce` must always settle.
 *
 * It resolved only on the child's `close` event, which fires once EVERY
 * inherited stdio stream has ended — a grandchild that outlives the command
 * (or survives a timeout kill) holds those pipes open, and the promise then
 * never resolved. In CI that surfaced as a 60s test timeout on a command that
 * had exited in milliseconds.
 *
 * The child is mocked here rather than really spawned: "exit arrives, close
 * never does" is the exact interleaving at issue, and a real process cannot be
 * made to reproduce it deterministically on every platform.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));

const { runOnce } = await import('../../src/performance/perf-runner.js');

/** A child that reports an exit status and then keeps its pipes open forever. */
function fakeChild(): EventEmitter & { pid: number; kill: () => boolean } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: () => boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = 4242;
  child.kill = () => true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('runOnce settlement', () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  it('resolves on exit even when close never arrives', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const run = runOnce({ command: 'noop', cwd: process.cwd(), timeoutMs: 30_000 });
    child.emit('exit', 7);
    const result = await run;
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it('resolves after a timeout kill even when the child never reports at all', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const result = await runOnce({ command: 'hung', cwd: process.cwd(), timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('prefers close when it does arrive', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const run = runOnce({ command: 'noop', cwd: process.cwd(), timeoutMs: 30_000 });
    child.emit('exit', 0);
    child.emit('close', 0);
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
  });
});
