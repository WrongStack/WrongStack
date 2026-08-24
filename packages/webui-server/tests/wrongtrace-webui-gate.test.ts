/**
 * Standalone-WebUI gate wiring contract test.
 *
 * Mirrors packages/cli/tests/wrongtrace-hooks.executor.test.ts: registers
 * the shared @wrongstack/wrongtrace hook factories on a REAL core
 * HookRegistry/HookRunner (the exact classes backend-services.ts hands to
 * its ToolExecutor) and asserts deny/allow/claim/release against the live
 * daemon when reachable. Every lock assertion degrades gracefully offline,
 * so green proves the wiring contract, not daemon liveness — same
 * "green ≠ live" rule documented in docs/wrongtrace.md §8.
 */

import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createWrongTraceHookPair,
  getWrongTrace,
  resetWrongTraceGate,
} from '@wrongstack/wrongtrace';

const PROBE = `__webui_gate_probe_${Date.now()}__`;
const SESSION = 'webui-gate-focused-test';

function buildWebuiStyleRunner(): HookRunner {
  // Mirrors backend-services.ts registration: same events, matcher, owner,
  // and the same per-runner PAIR factory (not the legacy standalone
  // factories).
  const hooks = createWrongTraceHookPair(() => SESSION);
  const registry = new HookRegistry();
  registry.registerInProcess(
    'PreToolUse',
    'edit|write|replace|patch|codebase-ast-replace',
    hooks.preToolUse,
    'wrongtrace-gate',
  );
  registry.registerInProcess(
    'PostToolUse',
    'edit|write|replace|patch|codebase-ast-replace',
    hooks.postToolUse,
    'wrongtrace-gate',
  );
  return new HookRunner({ registry, sessionId: () => SESSION, allowNonPolicy: true });
}

afterAll(() => {
  resetWrongTraceGate();
});

describe('standalone WebUI WrongTrace gate (executor-path contract)', () => {
  it('denies an edit while another owner holds the lock', async () => {
    const wt = await getWrongTrace();
    const runner = buildWebuiStyleRunner();
    const env = { cwd: process.cwd() };

    if (!wt.isAvailable) {
      const r = await runner.preToolUse('edit', { path: PROBE }, env, { mutating: true });
      expect(r.block).toBeFalsy(); // offline → allow
      return;
    }

    await wt.lockFile(PROBE, 'held by peer', { owner: 'peer-agent', ttlSeconds: 60 });
    try {
      const r = await runner.preToolUse('edit', { path: PROBE }, env, { mutating: true });
      expect(r.block).toBe(true);
      expect(r.reason).toContain('peer-agent');
      expect(r.reason).toContain('WrongTrace lock');
    } finally {
      await wt.unlockFile(PROBE);
    }
  });

  it('allows an unlocked edit, claims the lock, releases it post-tool', async () => {
    const wt = await getWrongTrace();
    const runner = buildWebuiStyleRunner();
    const env = { cwd: process.cwd() };

    const pre = await runner.preToolUse('edit', { path: PROBE }, env, { mutating: true });
    expect(pre.block).toBeFalsy();

    if (!wt.isAvailable) return;

    const locks = await wt.listLocks();
    const held = locks.find((l) => l.path === PROBE);
    if (held) expect(held.owner).toBe(`wrongstack:${SESSION}`);

    await runner.postToolUse('edit', { path: PROBE }, { content: '', isError: false }, env);
    const after = (await wt.listLocks()).filter((l) => l.path === PROBE);
    expect(after).toHaveLength(0);
  });
});
