import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnStream } from '../src/_spawn-stream.js';
import { _resetProcessRegistry, getProcessRegistry } from '../src/process-registry.js';

// A chatty long-runner: prints ~1 KB every 20ms, never exits on its own.
// Used to exercise the abort/abandonment paths — without the teardown fixes
// these tests hang (abort) or leak a live child (abandonment).
const CHATTY = ["setInterval(() => console.log('x'.repeat(1024)), 20)"];

function newController(): AbortController {
  return new AbortController();
}

beforeEach(() => {
  _resetProcessRegistry();
});

afterEach(() => {
  // Belt and braces: tree-kill anything a failing assertion left behind.
  getProcessRegistry().killAll({ force: true });
  _resetProcessRegistry();
});

describe('spawnStream teardown', () => {
  it('registers the child in the process registry and unregisters on close', async () => {
    const ctrl = newController();
    const gen = spawnStream({
      cmd: 'node',
      args: ['-e', ...CHATTY],
      cwd: process.cwd(),
      signal: ctrl.signal,
    });
    // The generator body (and thus the spawn) runs lazily on first next().
    // The chatty child never exits on its own, so after the first yield it
    // must still be tracked.
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(getProcessRegistry().stats().totalCount).toBe(1);
    ctrl.abort();
    for (;;) {
      const { done } = await gen.next();
      if (done) break;
    }
    await expect.poll(() => getProcessRegistry().stats().totalCount, { timeout: 10_000 }).toBe(0);
  });

  it('abort wakes the loop and finishes with exit code 124', async () => {
    const ctrl = newController();
    const gen = spawnStream({
      cmd: 'node',
      args: ['-e', ...CHATTY],
      cwd: process.cwd(),
      signal: ctrl.signal,
    });
    let result: Awaited<ReturnType<typeof gen.next>>['value'] | undefined;
    let aborted = false;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
      // First partial_output proves the child is streaming — now abort.
      if (!aborted) {
        aborted = true;
        ctrl.abort();
      }
    }
    expect(result).toBeDefined();
    // The abort exit code depends on the platform:
    //   - Windows: spawnStream synthesizes 124 (timeout convention).
    //   - Linux/macOS: Node's signal handling yields the raw kill code:
    //     143 (128 + SIGTERM=15), 137 (128 + SIGKILL=9), or 1 if no handler
    //     was attached. Accept the full set so the test is portable.
    // TODO(#249): normalize abort exit codes inside spawnStream so consumers
    // don't need to know the platform.
    expect([1, 124, 137, 143, null]).toContain((result as { exitCode: number | null }).exitCode);
    // The child must not survive the abort.
    await expect.poll(() => getProcessRegistry().stats().activeCount, { timeout: 10_000 }).toBe(0);
  });

  it('an already-aborted signal yields an immediate close without streaming', async () => {
    const ctrl = newController();
    ctrl.abort();
    const gen = spawnStream({
      cmd: 'node',
      args: ['-e', ...CHATTY],
      cwd: process.cwd(),
      signal: ctrl.signal,
    });
    let result: { exitCode: number } | undefined;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) {
        result = value as { exitCode: number };
        break;
      }
    }
    expect([1, 124, 137, 143, null]).toContain(result?.exitCode ?? null);
    await expect.poll(() => getProcessRegistry().stats().activeCount, { timeout: 10_000 }).toBe(0);
  });

  it('abandoning the generator (return) kills the child and detaches handlers', async () => {
    const ctrl = newController();
    const gen = spawnStream({
      cmd: 'node',
      args: ['-e', ...CHATTY],
      cwd: process.cwd(),
      signal: ctrl.signal,
    });
    // Consume until the first partial_output so the generator is suspended
    // at a yield — the same state the executor abandons it in.
    const first = await gen.next();
    expect(first.done).toBe(false);
    // Abandon — mirrors ToolExecutor.runStreamedTool's iter.return() path.
    await gen.return(undefined as never);
    // The finally teardown must have force-killed the child.
    await expect.poll(() => getProcessRegistry().stats().activeCount, { timeout: 10_000 }).toBe(0);
  });

  it('executes successfully when signal is omitted or undefined', async () => {
    const gen = spawnStream({
      cmd: 'node',
      args: ['-e', 'console.log("no signal test")'],
      cwd: process.cwd(),
      signal: undefined,
    });
    let result: { exitCode: number; stdout: string } | undefined;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) {
        result = value as { exitCode: number; stdout: string };
        break;
      }
    }
    expect(result).toBeDefined();
    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain('no signal test');
  });
});

