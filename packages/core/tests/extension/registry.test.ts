import type { ProviderRunnerFn } from '@wrongstack/contracts/types/extension-points';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry } from '../../src/extension/registry.js';

const noopLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
});

describe('ExtensionRegistry — register / unregister / list', () => {
  it('register adds an extension and returns an off function', () => {
    const reg = new ExtensionRegistry();
    const off = reg.register({ name: 'ext-a' });
    expect(reg.list()).toEqual(['ext-a']);
    off();
    expect(reg.list()).toEqual([]);
  });

  it('register rejects a duplicate by name with a WrongStackError', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'dup' });
    expect(() => reg.register({ name: 'dup' })).toThrow(/already registered/);
  });

  it('registerOrReplace replaces an existing extension with the same name', () => {
    const reg = new ExtensionRegistry();
    const beforeRunA = vi.fn();
    const beforeRunB = vi.fn();
    reg.register({ name: 'ext', beforeRun: beforeRunA });
    reg.registerOrReplace({ name: 'ext', beforeRun: beforeRunB });
    expect(reg.list()).toEqual(['ext']);
  });

  it('unregister returns false for an unknown extension', () => {
    const reg = new ExtensionRegistry();
    expect(reg.unregister('nope')).toBe(false);
  });

  it('has returns true after register and false after unregister', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'ext' });
    expect(reg.has('ext')).toBe(true);
    expect(reg.has('other')).toBe(false);
    reg.unregister('ext');
    expect(reg.has('ext')).toBe(false);
  });

  it('clear removes every extension and prompt contributor', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'a' });
    reg.register({ name: 'b' });
    reg.registerSystemPromptContributor({ id: 'p1', contribute: () => [] } as never);
    reg.clear();
    expect(reg.list()).toEqual([]);
    expect(reg.listSystemPromptContributors()).toEqual([]);
  });
});

describe('ExtensionRegistry — system prompt contributors', () => {
  it('register returns an off function that removes the contributor', () => {
    const reg = new ExtensionRegistry();
    const c = vi.fn().mockResolvedValue([]);
    const off = reg.registerSystemPromptContributor(c as never);
    expect(reg.listSystemPromptContributors()).toHaveLength(1);
    off();
    expect(reg.listSystemPromptContributors()).toHaveLength(0);
  });

  it('buildSystemPromptContributions concatenates blocks from each contributor', async () => {
    const reg = new ExtensionRegistry();
    reg.registerSystemPromptContributor((async () => [{ type: 'text', text: 'A' }]) as never);
    reg.registerSystemPromptContributor((async () => [{ type: 'text', text: 'B' }]) as never);
    const blocks = await reg.buildSystemPromptContributions({} as never);
    expect(blocks.map((b) => (b as { text: string }).text)).toEqual(['A', 'B']);
  });

  it('buildSystemPromptContributions catches errors from contributors', async () => {
    const reg = new ExtensionRegistry();
    const log = noopLogger();
    reg.setLogger(log as never);
    reg.registerSystemPromptContributor((async () => {
      throw new Error('boom');
    }) as never);
    reg.registerSystemPromptContributor((async () => [{ type: 'text', text: 'OK' }]) as never);
    const blocks = await reg.buildSystemPromptContributions({} as never);
    expect(blocks).toEqual([{ type: 'text', text: 'OK' }]);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('ExtensionRegistry — hook runners', () => {
  it('runBeforeRun calls all extensions in registration order', async () => {
    const reg = new ExtensionRegistry();
    const order: string[] = [];
    reg.register({ name: 'a', beforeRun: () => void order.push('a') });
    reg.register({ name: 'b', beforeRun: () => void order.push('b') });
    await reg.runBeforeRun({} as never);
    expect(order).toEqual(['a', 'b']);
  });

  it('runBeforeRun skips extensions without the hook', async () => {
    const reg = new ExtensionRegistry();
    const calls: string[] = [];
    reg.register({ name: 'a' }); // no hook
    reg.register({ name: 'b', beforeRun: () => void calls.push('b') });
    await reg.runBeforeRun({} as never);
    expect(calls).toEqual(['b']);
  });

  it('runBeforeRun catches thrown errors and logs them', async () => {
    const reg = new ExtensionRegistry();
    const log = noopLogger();
    reg.setLogger(log as never);
    reg.register({
      name: 'bad',
      beforeRun: () => {
        throw new Error('x');
      },
    });
    reg.register({ name: 'good', beforeRun: vi.fn() });
    await expect(reg.runBeforeRun({} as never)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it('runAfterRun fires all afterRun hooks', async () => {
    const reg = new ExtensionRegistry();
    const after = vi.fn();
    reg.register({ name: 'a', afterRun: after });
    await reg.runAfterRun({} as never, {} as never);
    expect(after).toHaveBeenCalled();
  });

  it('runAfterRun catches errors', async () => {
    const reg = new ExtensionRegistry();
    reg.setLogger(noopLogger() as never);
    reg.register({
      name: 'a',
      afterRun: () => {
        throw new Error('oops');
      },
    });
    await expect(reg.runAfterRun({} as never, {} as never)).resolves.toBeUndefined();
  });

  it('runBeforeIteration fires hooks', async () => {
    const reg = new ExtensionRegistry();
    const fn = vi.fn();
    reg.register({ name: 'i', beforeIteration: fn });
    await reg.runBeforeIteration({} as never, 1);
    expect(fn).toHaveBeenCalled();
  });

  it('runBeforeIteration catches errors', async () => {
    const reg = new ExtensionRegistry();
    reg.setLogger(noopLogger() as never);
    reg.register({
      name: 'i',
      beforeIteration: () => {
        throw new Error('bi');
      },
    });
    await expect(reg.runBeforeIteration({} as never, 1)).resolves.toBeUndefined();
  });

  it('runAfterIteration fires hooks', async () => {
    const reg = new ExtensionRegistry();
    const fn = vi.fn();
    reg.register({ name: 'ai', afterIteration: fn });
    await reg.runAfterIteration({} as never, 1, {} as never);
    expect(fn).toHaveBeenCalled();
  });

  it('runAfterIteration catches errors', async () => {
    const reg = new ExtensionRegistry();
    reg.setLogger(noopLogger() as never);
    reg.register({
      name: 'ai',
      afterIteration: () => {
        throw new Error('ai');
      },
    });
    await expect(reg.runAfterIteration({} as never, 1, {} as never)).resolves.toBeUndefined();
  });
});

describe('ExtensionRegistry — onError', () => {
  it('returns the first non-void result and short-circuits', async () => {
    const reg = new ExtensionRegistry();
    const second = vi.fn();
    reg.register({ name: 'a', onError: () => ({ action: 'retry', model: 'x' }) });
    reg.register({ name: 'b', onError: second });
    const out = await reg.runOnError({} as never, new Error('e'));
    expect(out).toEqual({ action: 'retry', model: 'x' });
    expect(second).not.toHaveBeenCalled();
  });

  it('continues to the next extension when one returns void', async () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'a', onError: () => undefined });
    reg.register({ name: 'b', onError: () => ({ action: 'fail' }) });
    const out = await reg.runOnError({} as never, new Error('e'));
    expect(out).toEqual({ action: 'fail' });
  });

  it('catches errors and proceeds to the next extension', async () => {
    const reg = new ExtensionRegistry();
    reg.setLogger(noopLogger() as never);
    reg.register({
      name: 'a',
      onError: () => {
        throw new Error('bad');
      },
    });
    reg.register({ name: 'b', onError: () => ({ action: 'continue' }) });
    const out = await reg.runOnError({} as never, new Error('e'));
    expect(out).toEqual({ action: 'continue' });
  });

  it('returns void when no extension returns a result', async () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'a', onError: () => undefined });
    const out = await reg.runOnError({} as never, new Error('e'));
    expect(out).toBeUndefined();
  });
});

describe('ExtensionRegistry — wrapProviderRunner abort logging', () => {
  it('logs a wrapper failure as an error, but an aborted run only at debug', async () => {
    const reg = new ExtensionRegistry();
    const log = noopLogger();
    reg.setLogger(log as never);
    reg.register({
      name: 'fallback-model',
      wrapProviderRunner: async () => {
        throw new Error('Empty response from p/m: the run was aborted');
      },
    });
    const composed = reg.wrapProviderRunner(vi.fn());
    const ac = new AbortController();

    await expect(composed({ signal: ac.signal } as never, {} as never)).rejects.toThrow();
    expect(log.error).toHaveBeenCalledTimes(1);

    ac.abort();
    await expect(composed({ signal: ac.signal } as never, {} as never)).rejects.toThrow(
      'the run was aborted',
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      'Extension "fallback-model" wrapProviderRunner: run aborted',
      expect.any(Error),
    );
  });
});

describe('ExtensionRegistry — wrapProviderRunner', () => {
  it('returns the inner runner unchanged when no wrappers are registered', () => {
    const reg = new ExtensionRegistry();
    const inner = vi.fn().mockResolvedValue('inner');
    const composed = reg.wrapProviderRunner(inner);
    expect(composed).toBe(inner);
  });

  it('composes wrappers in onion order (outermost first, innermost last)', async () => {
    const reg = new ExtensionRegistry();
    const order: string[] = [];
    reg.register({
      name: 'outer',
      wrapProviderRunner: async (ctx, req, next) => {
        order.push('outer-pre');
        const r = await next(ctx, req);
        order.push('outer-post');
        return r;
      },
    });
    reg.register({
      name: 'inner',
      wrapProviderRunner: async (ctx, req, next) => {
        order.push('inner-pre');
        const r = await next(ctx, req);
        order.push('inner-post');
        return r;
      },
    });
    const composed = reg.wrapProviderRunner(async () => {
      order.push('runner');
      return 'ok' as never;
    });
    await composed({} as never, {} as never);
    expect(order).toEqual(['outer-pre', 'inner-pre', 'runner', 'inner-post', 'outer-post']);
  });

  it('can exclude agent-loop-only wrappers while preserving the remaining chain', async () => {
    const reg = new ExtensionRegistry();
    const order: string[] = [];
    reg.register({
      name: 'prompt-firewall',
      wrapProviderRunner: async (ctx, req, next) => {
        order.push('firewall');
        return next(ctx, req);
      },
    });
    reg.register({
      name: 'fallback-model',
      wrapProviderRunner: async (ctx, req, next) => {
        order.push('fallback');
        return next(ctx, req);
      },
    });

    const composed = reg.wrapProviderRunner(
      async () => {
        order.push('runner');
        return 'ok' as never;
      },
      { exclude: ['fallback-model'] },
    );

    await composed({} as never, {} as never);
    expect(order).toEqual(['firewall', 'runner']);
  });

  it('propagates errors from wrappers and logs them', async () => {
    const reg = new ExtensionRegistry();
    const log = noopLogger();
    reg.setLogger(log as never);
    reg.register({
      name: 'bad',
      wrapProviderRunner: async () => {
        throw new Error('wrapper boom');
      },
    });
    const composed = reg.wrapProviderRunner(async () => 'never' as never);
    await expect(composed({} as never, {} as never)).rejects.toThrow('wrapper boom');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('ExtensionRegistry — tool execution hooks', () => {
  it('runBeforeToolExecution lets each hook transform the tool_uses list', async () => {
    const reg = new ExtensionRegistry();
    reg.register({
      name: 'a',
      beforeToolExecution: async (_ctx, uses) => [...uses, { id: 'x' } as never],
    });
    reg.register({
      name: 'b',
      beforeToolExecution: async (_ctx, uses) => uses.map((u) => ({ ...u, marked: true }) as never),
    });
    const out = await reg.runBeforeToolExecution({} as never, [{ id: '0' } as never]);
    expect(out).toHaveLength(2);
    expect((out[0] as { marked: boolean }).marked).toBe(true);
  });

  it('runBeforeToolExecution catches errors and keeps the prior toolUses', async () => {
    const reg = new ExtensionRegistry();
    reg.setLogger(noopLogger() as never);
    reg.register({
      name: 'bad',
      beforeToolExecution: async () => {
        throw new Error('btx');
      },
    });
    const input = [{ id: '1' }] as never;
    const out = await reg.runBeforeToolExecution({} as never, input);
    expect(out).toBe(input);
  });

  it('runAfterToolExecution fires hooks', async () => {
    const reg = new ExtensionRegistry();
    const fn = vi.fn();
    reg.register({ name: 'a', afterToolExecution: fn });
    await reg.runAfterToolExecution({} as never, [] as never);
    expect(fn).toHaveBeenCalled();
  });

  it('runAfterToolExecution catches errors', async () => {
    const reg = new ExtensionRegistry();
    reg.setLogger(noopLogger() as never);
    reg.register({
      name: 'bad',
      afterToolExecution: () => {
        throw new Error('ate');
      },
    });
    await expect(reg.runAfterToolExecution({} as never, [] as never)).resolves.toBeUndefined();
  });

  it('preserves replacement when registerOrReplaceScoped is overwritten by registerOrReplace and disposed (F968)', async () => {
    const reg = new ExtensionRegistry();
    const calls: string[] = [];
    const extA = { name: 'ext', beforeRun: () => void calls.push('A') };
    const extB = { name: 'ext', beforeRun: () => void calls.push('B') };
    const extC = { name: 'ext', beforeRun: () => void calls.push('C') };

    reg.register(extA);
    const disposeB = reg.registerOrReplaceScoped(extB);
    reg.registerOrReplace(extC);

    disposeB();
    await reg.runBeforeRun({} as never, {} as never);
    expect(calls).toEqual(['A']);
    reg.unregister('ext');
    expect(reg.list()).toEqual([]);
  });

  it('binds wrapProviderRunner to the extension, skips unregistered wrappers/contributors, and guards non-array beforeToolExecution returns (F108)', async () => {
    const reg = new ExtensionRegistry();
    const trace: string[] = [];
    const extA = {
      name: 'ext-a',
      tag: 'A_THIS',
      async wrapProviderRunner(
        this: { tag: string },
        ctx: Parameters<ProviderRunnerFn>[0],
        req: Parameters<ProviderRunnerFn>[1],
        next: ProviderRunnerFn,
      ) {
        trace.push(this.tag);
        return next(ctx, req);
      },
    };
    const extB = {
      name: 'ext-b',
      async wrapProviderRunner(
        ctx: Parameters<ProviderRunnerFn>[0],
        req: Parameters<ProviderRunnerFn>[1],
        next: ProviderRunnerFn,
      ) {
        trace.push('B');
        return next(ctx, req);
      },
    };
    reg.register(extA);
    const offB = reg.register(extB);
    const composed = reg.wrapProviderRunner(async () => 'ok' as never);
    offB();
    await composed({} as never, {} as never);
    expect(trace).toEqual(['A_THIS']);

    const promptReg = new ExtensionRegistry();
    let offSecond!: () => void;
    promptReg.registerSystemPromptContributor((async () => {
      offSecond();
      return [{ type: 'text', text: 'first' }];
    }) as never);
    offSecond = promptReg.registerSystemPromptContributor((async () => [
      { type: 'text', text: 'second' },
    ]) as never);
    const blocks = await promptReg.buildSystemPromptContributions({} as never);
    expect(blocks).toEqual([{ type: 'text', text: 'first' }]);

    const toolReg = new ExtensionRegistry();
    toolReg.register({
      name: 'faulty',
      beforeToolExecution: async () => undefined as never,
    });
    const tools = [{ id: '1' }] as never;
    expect(await toolReg.runBeforeToolExecution({} as never, tools)).toBe(tools);
  });
});
