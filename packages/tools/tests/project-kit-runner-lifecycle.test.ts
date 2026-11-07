import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  kill: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: boundary.spawn,
}));
vi.mock('../src/process-registry.js', () => ({
  getProcessRegistry: () => boundary,
}));

import { runKitProcess } from '../src/project-kit/runner.js';

function processDouble() {
  return Object.assign(new EventEmitter(), {
    pid: 424242,
    connected: true,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
  });
}
const request = (signal: AbortSignal) => ({
  projectRoot: process.cwd(),
  kitRoot: process.cwd(),
  entry: 'unused-by-os-double.mjs',
  runId: 'lifecycle',
  name: 'test.lifecycle',
  input: {},
  timeoutMs: 60000,
  signal,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Kit process waits for a bounded OS kill', () => {
  it('keeps the normal completed-process control', async () => {
    const child = processDouble();
    boundary.spawn.mockReturnValue(child);
    const pending = runKitProcess(request(new AbortController().signal));
    child.emit('message', { type: 'result', output: { answer: 42 } });
    child.emit('exit', 0);
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ ok: true, output: { answer: 42 }, exitCode: 0 });
    expect(boundary.kill).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'abort'] as const)(
    'retains ownership and exit code while %s cleanup is still within its platform budget',
    async (kind) => {
      const child = processDouble();
      boundary.spawn.mockReturnValue(child);
      // A twenty-second Windows kill is inside the registry's thirty-second limit.
      // POSIX keeps its existing shorter cleanup policy.
      const killDelay = process.platform === 'win32' ? 20000 : 1000;
      boundary.kill.mockImplementation(() => {
        setTimeout(() => {
          child.emit('exit', 1);
          child.emit('close', 1);
        }, killDelay);
      });
      const controller = new AbortController();
      const pending = runKitProcess({
        ...request(controller.signal),
        timeoutMs: kind === 'timeout' ? 100 : 60000,
      });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      if (kind === 'abort') controller.abort();
      else await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(killDelay - 1);
      expect(settled).toBe(false);
      expect(boundary.unregister).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: kind === 'timeout' ? 'Timed out' : 'Cancelled',
        exitCode: 1,
      });
      expect(boundary.unregister).toHaveBeenCalledWith(child.pid);
    },
  );
});
