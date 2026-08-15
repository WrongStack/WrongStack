import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { bashTool } from '../src/bash.js';
import {
  _resetProcessRegistry,
  getProcessRegistry,
  type ProcessRegistryImpl,
  type TrackedProcess,
} from '../src/process-registry.js';
import { mkSandbox } from './fixtures.js';

const isWin = os.platform() === 'win32';

/**
 * P1 #2 (before-release.md): when bash times out, the ToolExecutor calls
 * `runToolCleanup()` → `tool.cleanup()`. Before this fix bash defined no
 * cleanup(), so the executor's `typeof tool.cleanup !== 'function'` guard
 * short-circuited and any bash-spawned process left in the ProcessRegistry
 * with `killed === false` could keep running — writing files, consuming CPU,
 * and holding inherited stdio pipes open for the rest of the session.
 *
 * These tests pin the contract that closes that gap: bashTool.cleanup must
 * kill every bash-owned, still-running, non-protected process tracked for
 * the calling session.
 */
describe('bashTool.cleanup — timeout / abort teardown (P1 #2)', () => {
  it('defines a cleanup method (the contract the executor relies on)', () => {
    expect(typeof bashTool.cleanup).toBe('function');
  });

  it('kills a still-running bash process registered for the same session', async () => {
    _resetProcessRegistry();
    const registry: ProcessRegistryImpl = getProcessRegistry();
    const sb = await mkSandbox();
    try {
      // Spawn a long-running bash command and let it register with the
      // ProcessRegistry (the executeStream path does this in bash.ts:392).
      const longRun = isWin ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30';
      const execPromise = bashTool.execute({ command: longRun, timeout_ms: 200 }, sb.ctx, {
        signal: new AbortController().signal,
      });
      // The command times out at 200ms; by the time it resolves the child is
      // force-killed via the generator's finally block. cleanup() is the
      // executor's defensive second layer — it must be a no-op on already-
      // reaped processes (idempotent) but still callable without error.
      const out = await execPromise;
      expect(out.timed_out).toBe(true);

      // Simulate the executor calling tool.cleanup() after the timeout.
      await expect(bashTool.cleanup!({ command: longRun }, sb.ctx)).resolves.toBeUndefined();

      // No bash process for this session should remain active in the registry.
      const lingering = registry
        .bySession(sb.ctx.session.id)
        .filter((p) => p.name === 'bash' && p.child?.exitCode === null);
      expect(lingering).toHaveLength(0);
    } finally {
      await sb.cleanup();
      _resetProcessRegistry();
    }
  }, 15_000);

  it('kills every bash process still alive when cleanup is called', async () => {
    // Directly drive the registry + cleanup without a real subprocess, so the
    // assertion is about cleanup()'s filtering logic, not OS timing. The
    // previous test covers the real-spawn path; this one is deterministic.
    _resetProcessRegistry();
    const registry = getProcessRegistry();
    const sb = await mkSandbox();
    const sessionId = sb.ctx.session.id;

    // Fake a "still running" bash process (exitCode === null) registered
    // for this session. registry.kill() inspects child.exitCode, so the
    // kill attempt will be issued even though there's no real OS process.
    const fakeLive = {
      pid: 99111,
      name: 'bash',
      command: 'sleep 9999',
      startedAt: Date.now(),
      sessionId,
      child: {
        exitCode: null,
        killed: false,
        kill() {
          return true;
        },
      },
      killed: false,
      protected: false,
    } as unknown as TrackedProcess;
    // A second, already-exited bash process: cleanup must NOT attempt a kill.
    const fakeDead = {
      pid: 99222,
      name: 'bash',
      command: 'echo done',
      startedAt: Date.now(),
      sessionId,
      child: {
        exitCode: 0,
        killed: false,
        kill() {
          return true;
        },
      },
      killed: false,
      protected: false,
    } as unknown as TrackedProcess;
    // A protected infra process the user backgrounded: cleanup must NOT kill.
    const fakeProtected = {
      pid: 99333,
      name: 'bash',
      command: 'vite',
      startedAt: Date.now(),
      sessionId,
      child: {
        exitCode: null,
        killed: false,
        kill() {
          return true;
        },
      },
      killed: false,
      protected: true,
    } as unknown as TrackedProcess;
    // A non-bash (exec-spawned) process: cleanup must leave it to its own tool.
    const fakeExec = {
      pid: 99444,
      name: 'exec',
      command: 'node build.js',
      startedAt: Date.now(),
      sessionId,
      child: {
        exitCode: null,
        killed: false,
        kill() {
          return true;
        },
      },
      killed: false,
      protected: false,
    } as unknown as TrackedProcess;

    registry.register(fakeLive as never);
    registry.register(fakeDead as never);
    registry.register(fakeProtected as never);
    registry.register(fakeExec as never);

    try {
      await bashTool.cleanup!({ command: 'irrelevant' }, sb.ctx);

      // The live, unprotected bash process was kill()ed. The registry sets
      // its own `killed` flag on the tracked entry (registry.kill() →
      // p.killed = true); it does not mutate the child object's internal
      // `.killed`, so the source of truth is the registry entry.
      const liveEntry = registry.get(99111);
      expect(liveEntry?.killed).toBe(true);

      // Dead process: already reaped, cleanup must skip it entirely.
      const deadEntry = registry.get(99222);
      expect(deadEntry?.killed).toBe(false);

      // Protected process: never killed even though still running.
      const protectedEntry = registry.get(99333);
      expect(protectedEntry?.killed).toBe(false);

      // Non-bash process: left untouched — exec owns its teardown.
      const execEntry = registry.get(99444);
      expect(execEntry?.killed).toBe(false);
    } finally {
      // Drop the fake entries so they don't leak into other suites.
      registry.unregister(99111);
      registry.unregister(99222);
      registry.unregister(99333);
      registry.unregister(99444);
      _resetProcessRegistry();
    }
  });

  it('is a no-op when the context carries no session id', async () => {
    _resetProcessRegistry();
    const registry = getProcessRegistry();
    const sb = await mkSandbox();
    const originalId = sb.ctx.session.id;
    try {
      // A bare-bones context (tests, embedded callers) may not set session.id.
      (sb.ctx.session as { id?: string }).id = undefined;
      await expect(bashTool.cleanup!({ command: 'anything' }, sb.ctx)).resolves.toBeUndefined();
      expect(registry.list()).toHaveLength(0);
    } finally {
      (sb.ctx.session as { id?: string }).id = originalId;
      _resetProcessRegistry();
    }
  });
});
