/**
 * Focused verification that the WrongTrace hooks are wired into the REAL
 * executor path — i.e. that HookRunner.preToolUse (the same call the
 * ToolExecutor makes before dispatching a tool) consults the registered
 * gate hooks and denies/allows/releases accordingly.
 *
 * Runs against the live daemon when reachable; every lock assertion
 * degrades gracefully offline. Uses the REAL HookRegistry + HookRunner
 * from @wrongstack/core, not stubs, so this proves the wiring contract.
 */

import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { getWrongTrace, resetWrongTraceGate } from '../src/wiring/wrongtrace-gate.js';
import {
  createWrongTracePostToolUseHook,
  createWrongTracePreToolUseHook,
} from '../src/wiring/wrongtrace-hooks.js';

const PROBE = `__hook_probe_${Date.now()}__`;
const SESSION = 'hook-focused-test';

function buildRunner(): HookRunner {
  // Mirrors the registration in lifecycle-plugins.ts: same event, same
  // matcher string, same owner. If the production wiring drifts, this test
  // still exercises the exact registration contract it must satisfy.
  const registry = new HookRegistry();
  registry.registerInProcess(
    'PreToolUse',
    'edit|write|replace|patch|codebase-ast-replace',
    createWrongTracePreToolUseHook(() => SESSION),
    'wrongtrace-gate',
  );
  registry.registerInProcess(
    'PostToolUse',
    'edit|write|replace|patch|codebase-ast-replace',
    createWrongTracePostToolUseHook(),
    'wrongtrace-gate',
  );
  return new HookRunner({ registry, logger: undefined, sessionId: () => SESSION });
}

afterAll(() => {
  resetWrongTraceGate();
});

describe('WrongTrace hooks on the real HookRunner (executor path)', () => {
  it('preToolUse denies an edit when another owner holds the lock', async () => {
    const wt = await getWrongTrace();
    const runner = buildRunner();
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

  it('preToolUse allows an unlocked edit, claims the lock, postToolUse releases it', async () => {
    const wt = await getWrongTrace();
    const runner = buildRunner();
    const env = { cwd: process.cwd() };

    const pre = await runner.preToolUse('edit', { path: PROBE }, env, { mutating: true });
    expect(pre.block).toBeFalsy();

    if (!wt.isAvailable) return; // offline: no lock lifecycle to assert

    const held = (await wt.listLocks()).find((l) => l.path === PROBE);
    expect(held?.owner).toBe(`wrongstack:${SESSION}`);

    await runner.postToolUse('edit', { path: PROBE }, { content: '', isError: false }, env);
    const after = (await wt.listLocks()).filter((l) => l.path === PROBE);
    expect(after).toHaveLength(0);
  });

  it('non-edit tools and path-less inputs pass through untouched', async () => {
    const runner = buildRunner();
    const env = { cwd: process.cwd() };

    const grep = await runner.preToolUse('grep', { pattern: 'x' }, env, { mutating: false });
    expect(grep.block).toBeFalsy();

    const noPath = await runner.preToolUse('edit', { content: 'x' }, env, { mutating: true });
    expect(noPath.block).toBeFalsy();
  });

  it('fragile files allow with a surgical-edit nudge in additionalContext', async () => {
    const wt = await getWrongTrace();
    if (!wt.isAvailable) return; // requires live fragile-file signal

    const runner = buildRunner();
    const env = { cwd: process.cwd() };
    // Find a genuinely fragile file from the live atlas summary, if any.
    const atlas = await wt.getAtlas({ summary: true });
    const fragilePkg = atlas?.packages?.find((p) => (p.fragile_files_count ?? 0) > 0);
    if (!fragilePkg) return; // nothing fragile right now — nothing to assert

    const full = await wt.getAtlas({
      ...(fragilePkg.workspace === undefined ? {} : { workspace: fragilePkg.workspace }),
    });
    const fragileFile = full?.packages
      ?.flatMap((p) => p.files ?? [])
      .find((f) => f.is_fragile === true || (f.health_score ?? 100) < 40);
    if (!fragileFile) return;

    const r = await runner.preToolUse('edit', { path: fragileFile.path }, env, { mutating: true });
    expect(r.block).toBeFalsy();
    expect(r.additionalContext).toContain('fragile');
    // postToolUse releases whatever we claimed.
    await runner.postToolUse(
      'edit',
      { path: fragileFile.path },
      { content: '', isError: false },
      env,
    );
  });
});
