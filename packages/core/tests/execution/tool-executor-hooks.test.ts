import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { HookRegistry } from '../../src/hooks/registry.js';
import { HookRunner } from '../../src/hooks/runner.js';
import type { ToolResultBlock, ToolUseBlock } from '../../src/types/blocks.js';
import type { Tool } from '../../src/types/tool.js';

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

const scrubber = { scrub: (s: string) => s };
const autoPolicy = {
  evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
};

function makeExecutor(
  tools: Tool[],
  hookRunner: HookRunner,
  options: { permissionPolicy?: typeof autoPolicy; confirmAwaiter?: ReturnType<typeof vi.fn> } = {},
) {
  const registry = { get: (n: string) => tools.find((t) => t.name === n), list: () => tools };
  return new ToolExecutor(registry, {
    permissionPolicy: (options.permissionPolicy ?? autoPolicy) as never,
    secretScrubber: scrubber as never,
    perIterationOutputCapBytes: 50_000,
    hookRunner,
    confirmAwaiter: options.confirmAwaiter as never,
  });
}

function tool(
  name: string,
  exec: Tool['execute'],
  schema?: object,
  metadata: Pick<Tool, 'capabilities' | 'mutating'> = { mutating: false },
): Tool {
  return {
    name,
    description: name,
    inputSchema: (schema as never) ?? { type: 'object' },
    permission: 'auto',
    ...metadata,
    execute: exec,
  };
}

function use(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `id_${name}`, name, input };
}

describe('ToolExecutor — PreToolUse hooks', () => {
  it('keeps allow/mutate silent in YOLO mode without requesting approval', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', async () => ({
      action: 'mutate',
      input: { command: 'echo safe', timeout_ms: 1_000 },
    }));
    const exec = vi.fn().mockResolvedValue({ ok: true });
    const confirmAwaiter = vi.fn();
    const yoloPolicy = {
      evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'yolo' }),
      getYolo: () => true,
    };
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['command'],
    };
    const ex = makeExecutor([tool('bash', exec, schema)], new HookRunner({ registry: reg }), {
      permissionPolicy: yoloPolicy as never,
      confirmAwaiter,
    });

    await ex.executeBatch([use('bash', { command: 'echo original' })], makeCtx(), 'sequential');
    expect(exec).toHaveBeenCalledWith(
      { command: 'echo safe', timeout_ms: 1_000 },
      expect.anything(),
      expect.anything(),
    );
    expect(confirmAwaiter).not.toHaveBeenCalled();
  });

  it('propagates the selected tool capabilities and mutating flag to policy hooks', async () => {
    const reg = new HookRegistry();
    let payload: unknown;
    reg.registerInProcess(
      'PreToolUse',
      '*',
      (input) => {
        payload = input;
        return { action: 'allow' };
      },
      'metadata-policy',
      { stage: 'validate', policy: true },
    );
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const selected = tool('patch', execute, undefined, {
      capabilities: ['fs.write'],
      mutating: true,
    });
    // `fs.write` is a dangerous capability, so the executor downgrades an
    // `auto` decision to `confirm` regardless of what the policy said (the
    // post-policy blast-radius net). Without an awaiter the call would hang at
    // the prompt and never execute — which is the whole point of that net, not
    // a failure of this test's subject.
    const confirmAwaiter = vi.fn().mockResolvedValue('yes');
    const ex = makeExecutor([selected], new HookRunner({ registry: reg }), { confirmAwaiter });

    await ex.executeBatch([use('patch', { path: 'src/index.ts' })], makeCtx(), 'sequential');

    expect(payload).toMatchObject({
      toolName: 'patch',
      toolInput: { path: 'src/index.ts' },
      toolCapabilities: ['fs.write'],
      toolMutating: true,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('propagates explicit mutating:false instead of omitting it', async () => {
    const reg = new HookRegistry();
    let payload: unknown;
    reg.registerInProcess('PreToolUse', '*', (input) => {
      payload = input;
    });
    const ex = makeExecutor(
      [tool('read', vi.fn().mockResolvedValue({ ok: true }), undefined, { mutating: false })],
      new HookRunner({ registry: reg }),
    );

    await ex.executeBatch([use('read', { path: '.env' })], makeCtx(), 'sequential');

    expect(payload).toHaveProperty('toolMutating', false);
    expect(payload).not.toHaveProperty('toolCapabilities');
  });

  it('retains allowing PreToolUse context for the next model-visible message', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => ({
      decision: 'allow',
      additionalContext: 'path-guard warning',
      contextAs: 'separate',
    }));
    const ctx = makeCtx();
    const ex = makeExecutor(
      [tool('read', vi.fn().mockResolvedValue({ ok: true }))],
      new HookRunner({ registry: reg }),
    );

    await ex.executeBatch([use('read', { path: 'src/index.ts' })], ctx, 'sequential');

    expect(ctx.pendingPostToolContext).toBe('path-guard warning');
  });

  it('appends default PreToolUse context inline with the tool result', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => ({
      decision: 'allow',
      additionalContext: 'path-guard warning',
    }));
    const ctx = makeCtx();
    const ex = makeExecutor(
      [tool('read', vi.fn().mockResolvedValue('done'))],
      new HookRunner({ registry: reg }),
    );

    const out = await ex.executeBatch([use('read', { path: 'src/index.ts' })], ctx, 'sequential');
    const result = out.outputs[0]!.result as ToolResultBlock;

    expect(result.content).toContain('done');
    expect(result.content).toContain('path-guard warning');
    expect(ctx.pendingPostToolContext).toBeUndefined();
  });

  it('carries PreToolUse context in a pending confirmation without executor retention', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => ({
      decision: 'allow',
      additionalContext: 'confirm warning',
      contextAs: 'separate',
    }));
    const confirmPolicy = {
      evaluate: vi.fn().mockResolvedValue({ permission: 'confirm', source: 'default' }),
    };
    const ex = makeExecutor(
      [tool('read', vi.fn().mockResolvedValue('done'))],
      new HookRunner({ registry: reg }),
      { permissionPolicy: confirmPolicy as never },
    );

    const out = await ex.executeBatch([use('read')], makeCtx(), 'sequential');

    expect(out.outputs[0]?.result).toMatchObject({
      type: 'tool_confirm_pending',
      preToolContext: { text: 'confirm warning', contextAs: 'separate' },
    });
  });

  it('does not leak PreToolUse context when permission denies execution', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => ({
      decision: 'allow',
      additionalContext: 'must not leak',
      contextAs: 'separate',
    }));
    const denyPolicy = {
      evaluate: vi.fn().mockResolvedValue({ permission: 'deny', source: 'default' }),
    };
    const ctx = makeCtx();
    const ex = makeExecutor(
      [tool('read', vi.fn().mockResolvedValue('done'))],
      new HookRunner({ registry: reg }),
      { permissionPolicy: denyPolicy as never },
    );

    await ex.executeBatch([use('read', { path: 'src/index.ts' })], ctx, 'sequential');

    expect(ctx.pendingPostToolContext).toBeUndefined();
  });

  it('blocks a tool and never executes it', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', 'Bash', () => ({ decision: 'block', reason: 'denied' }));
    const exec = vi.fn().mockResolvedValue({ ok: true });
    const ex = makeExecutor([tool('bash', exec)], new HookRunner({ registry: reg }));

    const out = await ex.executeBatch([use('bash', { command: 'ls' })], makeCtx(), 'sequential');
    const result = out.outputs[0]!.result as ToolResultBlock;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('blocked by a PreToolUse hook');
    expect(result.content).toContain('denied');
    expect(exec).not.toHaveBeenCalled();
  });

  it('rewrites tool input via modifiedInput (re-validated)', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => ({ modifiedInput: { command: 'safe' } }));
    let seen: unknown;
    const exec = vi.fn(async (input: unknown) => {
      seen = input;
      return { ok: true };
    });
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    };
    const ex = makeExecutor([tool('bash', exec, schema)], new HookRunner({ registry: reg }));

    await ex.executeBatch([use('bash', { command: 'danger' })], makeCtx(), 'sequential');
    expect(seen).toEqual({ command: 'safe' });
  });

  it('rejects a modifiedInput that violates the schema', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => ({ modifiedInput: { command: 123 } }));
    const exec = vi.fn().mockResolvedValue({ ok: true });
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    };
    const ex = makeExecutor([tool('bash', exec, schema)], new HookRunner({ registry: reg }));

    const out = await ex.executeBatch([use('bash', { command: 'ok' })], makeCtx(), 'sequential');
    const result = out.outputs[0]!.result as ToolResultBlock;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('invalid shape');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('ToolExecutor — PostToolUse hooks', () => {
  it('appends additionalContext to the tool result', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PostToolUse', '*', () => ({ additionalContext: 'lint: ok' }));
    const ex = makeExecutor(
      [tool('bash', vi.fn().mockResolvedValue('done'))],
      new HookRunner({ registry: reg }),
    );

    const out = await ex.executeBatch([use('bash')], makeCtx(), 'sequential');
    const result = out.outputs[0]!.result as ToolResultBlock;
    expect(result.content).toContain('done');
    expect(result.content).toContain('lint: ok');
  });

  it('stores separate additionalContext on ctx.pendingPostToolContext', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PostToolUse', '*', () => ({
      additionalContext: 'plugin notice',
      contextAs: 'separate',
    }));
    const ctx = makeCtx();
    const ex = makeExecutor(
      [tool('bash', vi.fn().mockResolvedValue('done'))],
      new HookRunner({ registry: reg }),
    );

    const out = await ex.executeBatch([use('bash')], ctx, 'sequential');
    const result = out.outputs[0]!.result as ToolResultBlock;
    expect(result.content).toBe('done');
    expect(result.content).not.toContain('plugin notice');
    expect(ctx.pendingPostToolContext).toBe('plugin notice');
  });
});
