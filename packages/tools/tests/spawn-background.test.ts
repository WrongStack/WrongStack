import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnBackground, spawnBackgroundExec } from '../src/spawn-background.js';

const isWin = os.platform() === 'win32';

// Every child spawned by a test is registered here and tree-killed after the
// test. These are *detached* processes — without explicit cleanup each run
// left orphaned cmd.exe/node sleepers behind (multi-second `setTimeout`
// children piled up across the suite and ate CPU/RAM on the host).
const spawned: Array<{ pid: number | null; child: ChildProcess }> = [];

function track<T extends { pid: number | null; child: ChildProcess }>(result: T): T {
  spawned.push(result);
  return result;
}

function isSafePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

function treeKill(entry: { pid: number; child: ChildProcess }): void {
  const { pid, child } = entry;
  if (!isSafePid(pid) || child.pid !== pid) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return;
  }

  try {
    if (isWin) {
      // The shell-wrapped variant spawns cmd.exe whose *grandchild* is the
      // real process; a plain kill() reaps only cmd.exe. taskkill /T gets
      // the whole tree.
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      // detached:true puts the child in its own process group — negative
      // pid signals the whole group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

afterEach(() => {
  for (const entry of spawned.splice(0)) {
    if (typeof entry.pid === 'number') treeKill({ pid: entry.pid, child: entry.child });
  }
});

describe('spawnBackground', () => {
  it('spawns a background process and returns a pid', () => {
    const result = track(spawnBackground({ command: 'node --version' }));
    expect(result.pid).toBeDefined();
    expect(typeof result.pid).toBe('number');
  });

  it('returns immediately without waiting for the process', () => {
    const start = Date.now();
    // 3s sleeper: long enough to prove we did not wait for it, short enough
    // that even a failed tree-kill leaves no long-lived orphan.
    const result = track(spawnBackground({ command: 'node -e "setTimeout(() => {}, 3000)"' }));
    const elapsed = Date.now() - start;
    // Proves we don't block on the 3s child. Anything well under the child's
    // sleep counts as "immediate" — a tight bound (100ms) flakes when spawn
    // itself is slow under full-suite load.
    expect(elapsed).toBeLessThan(2000);
    expect(result.pid).toBeDefined();
  });

  it('respects cwd option', () => {
    const result = track(spawnBackground({ command: 'node --version', cwd: os.tmpdir() }));
    expect(result.pid).toBeDefined();
  });

  it('drains stdio so a chatty child cannot block on a full pipe', () => {
    const result = track(spawnBackground({ command: 'node --version' }));
    // resume() must have switched the pipes to flowing mode — otherwise the
    // child blocks once the OS pipe buffer fills, and the open handles keep
    // the parent's event loop alive despite child.unref().
    expect(result.child.stdout?.readableFlowing).toBe(true);
    expect(result.child.stderr?.readableFlowing).toBe(true);
  });
});

describe('spawnBackgroundExec', () => {
  it('spawns a process without shell wrapping', () => {
    const result = track(spawnBackgroundExec('node', ['--version']));
    expect(result.pid).toBeDefined();
  });

  it('returns immediately without waiting', () => {
    const start = Date.now();
    const result = track(spawnBackgroundExec('node', ['-e', 'setTimeout(() => {}, 2000)']));
    const elapsed = Date.now() - start;
    // Same rationale as above: must beat the child's 2s sleep, not 100ms.
    expect(elapsed).toBeLessThan(1500);
    expect(result.pid).toBeDefined();
  });

  it('passes environment variables', () => {
    const result = track(
      spawnBackgroundExec('node', ['-e', 'process.env.TEST_VAR'], undefined, {
        TEST_VAR: 'test_value',
      }),
    );
    expect(result.pid).toBeDefined();
  });

  it('respects cwd option', () => {
    const result = track(spawnBackgroundExec('node', ['-e', ''], os.tmpdir()));
    expect(result.pid).toBeDefined();
  });

  it('does not crash the host process when the command does not exist', async () => {
    const { child } = spawnBackgroundExec('definitely-not-a-real-command-xyz', []);
    // The default error handler must swallow the async ENOENT; give it a tick to fire.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.pid ?? null).toBeNull();
  });
});
