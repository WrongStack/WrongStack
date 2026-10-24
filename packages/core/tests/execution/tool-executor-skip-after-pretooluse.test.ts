/**
 * Regression: a guard refusal that happens AFTER the PreToolUse hooks ran
 * (a later validator hook denying, tool.validate, a Kanban boundary block)
 * returned without running the `runWhenToolSkipped` PostToolUse hooks. A
 * claim-taking PreToolUse hook (WrongTrace's file lock + refcount) then leaked
 * its claim: the lock stayed held after every later edit of that file until
 * its TTL, denying peer sessions. The guard now reports `preToolUseRan` and
 * the executor runs the skip cleanup for exactly those refusals.
 */

import type { ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { HookRegistry } from '../../src/hooks/registry.js';
import { HookRunner } from '../../src/hooks/runner.js';

function makeCtx(): Context {
  return {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: { id: 'test', capabilities: {}, complete: vi.fn(), stream: vi.fn() } as never,
    session: { id: 's', append: vi.fn() } as never,
    signal: new AbortController().signal,
    tokenCounter: { total: () => ({ input: 0, output: 0 }) } as never,
    cwd: '/test',
    projectRoot: '/test',
    model: 'm',
    tools: [],
    meta: {},
    pendingPostToolContext: undefined,
  } as never as Context;
}

function harness(opts: { validatorDenies?: boolean; toolValidateFails?: boolean }) {
  const reg = new HookRegistry();
  const pre = vi.fn(() => ({ action: 'allow' as const }));
  const skipCleanup = vi.fn(() => undefined);
  // Legacy in-process registration (stage 'mutate'), like the WrongTrace gate.
  reg.registerInProcess('PreToolUse', 'edit', pre, 'claim-hook');
  reg.registerInProcess('PostToolUse', 'edit', skipCleanup, 'claim-hook', {
    runWhenToolSkipped: true,
  });
  if (opts.validatorDenies) {
    reg.registerInProcess(
      'PreToolUse',
      'edit',
      () => ({ action: 'deny', reason: 'policy' }),
      'policy',
      {
        stage: 'validate',
        policy: true,
      },
    );
  }
  const execute = vi.fn().mockResolvedValue({ ok: true });
  const tool: Tool = {
    name: 'edit',
    description: 'edit',
    permission: 'auto',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    } as never,
    ...(opts.toolValidateFails ? { validate: () => ['cross-field rule violated'] } : {}),
    execute,
  };
  const executor = new ToolExecutor(
    { get: (n: string) => (n === 'edit' ? tool : undefined), list: () => [tool] },
    {
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
      } as never,
      secretScrubber: { scrub: (s: string) => s } as never,
      perIterationOutputCapBytes: 50_000,
      hookRunner: new HookRunner({ registry: reg, sessionId: () => 's', allowNonPolicy: true }),
    },
  );
  const run = (input: Record<string, unknown>) =>
    executor.executeBatch(
      [{ type: 'tool_use', id: 'u1', name: 'edit', input } as ToolUseBlock],
      makeCtx(),
      'sequential',
    );
  return { run, pre, skipCleanup, execute };
}

describe('ToolExecutor skip cleanup after PreToolUse', () => {
  it('runs the skip cleanup once when a later validator hook denies', async () => {
    const h = harness({ validatorDenies: true });
    await h.run({ path: 'src/a.ts' });
    expect(h.pre).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.skipCleanup).toHaveBeenCalledOnce();
  });

  it('runs the skip cleanup once when tool.validate refuses after PreToolUse', async () => {
    const h = harness({ toolValidateFails: true });
    await h.run({ path: 'src/a.ts' });
    expect(h.pre).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.skipCleanup).toHaveBeenCalledOnce();
  });

  it('does not run it for input refused before PreToolUse', async () => {
    const h = harness({});
    await h.run({}); // required `path` missing — not coercible
    expect(h.pre).not.toHaveBeenCalled();
    expect(h.skipCleanup).not.toHaveBeenCalled();
  });

  it('runs PostToolUse exactly once on a normal execution', async () => {
    const h = harness({});
    await h.run({ path: 'src/a.ts' });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.skipCleanup).toHaveBeenCalledOnce();
  });
});
