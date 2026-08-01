/**
 * Tests for hooks-wiring.ts — UserPromptSubmit middleware and lifecycle hooks extension.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HookBlockedError,
  createUserPromptSubmitMiddleware,
  createLifecycleHooksExtension,
} from '../src/hooks-wiring.js';

describe('HookBlockedError', () => {
  it('creates an error with the reason embedded', () => {
    const err = new HookBlockedError('policy says no');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HookBlockedError');
    expect(err.message).toContain('policy says no');
  });
});

describe('createUserPromptSubmitMiddleware', () => {
  it('returns middleware with name UserPromptSubmitHooks', () => {
    const hookRunner = { has: () => false };
    const mw = createUserPromptSubmitMiddleware(hookRunner as never);
    expect(mw.name).toBe('UserPromptSubmitHooks');
  });

  it('passes payload through when there is no prompt', async () => {
    const hookRunner = { has: () => false };
    const mw = createUserPromptSubmitMiddleware(hookRunner as never);
    const payload = { text: '', ctx: {}, content: [] };
    const next = vi.fn().mockResolvedValue(payload);
    const result = await mw.handler(payload as never, next);
    expect(result).toBe(payload);
    expect(next).toHaveBeenCalledWith(payload);
  });

  it('passes payload through when hookRunner.has returns false', async () => {
    const hookRunner = { has: () => false };
    const mw = createUserPromptSubmitMiddleware(hookRunner as never);
    const payload = { text: 'hello', ctx: {}, content: [] };
    const next = vi.fn().mockResolvedValue(payload);
    const result = await mw.handler(payload as never, next);
    expect(result).toBe(payload);
    expect(next).toHaveBeenCalledWith(payload);
  });

  it('throws HookBlockedError when hook blocks', async () => {
    const hookRunner = {
      has: () => true,
      userPromptSubmit: async () => ({ block: true, reason: 'blocked by policy' }),
    };
    const mw = createUserPromptSubmitMiddleware(hookRunner as never);
    const payload = { text: 'prompt', ctx: {}, content: [] };
    await expect(mw.handler(payload as never, vi.fn())).rejects.toThrow(HookBlockedError);
    await expect(mw.handler(payload as never, vi.fn())).rejects.toThrow('blocked by policy');
  });

  it('throws HookBlockedError with default reason when reason is missing', async () => {
    const hookRunner = {
      has: () => true,
      userPromptSubmit: async () => ({ block: true }),
    };
    const mw = createUserPromptSubmitMiddleware(hookRunner as never);
    await expect(
      mw.handler({ text: 'prompt', ctx: {}, content: [] } as never, vi.fn()),
    ).rejects.toThrow('no reason given');
  });

  it('appends additionalContext when hook provides it', async () => {
    const hookRunner = {
      has: () => true,
      userPromptSubmit: async () => ({
        block: false,
        additionalContext: 'extra context for the prompt',
      }),
    };
    const mw = createUserPromptSubmitMiddleware(hookRunner as never);
    const payload = { text: 'original', ctx: {}, content: [] as unknown[] };
    const next = vi.fn().mockImplementation(async (p) => p);
    const result = await mw.handler(payload as never, next);
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toBe('extra context for the prompt');
    expect(result.text).toContain('original');
    expect(result.text).toContain('extra context for the prompt');
    expect(next).toHaveBeenCalled();
  });
});

describe('createLifecycleHooksExtension', () => {
  it('returns an extension with name lifecycle-hooks', () => {
    const hookRunner = { has: () => false };
    const ext = createLifecycleHooksExtension(hookRunner as never);
    expect(ext.name).toBe('lifecycle-hooks');
  });

  it('beforeRun: does nothing when started is already true', async () => {
    const hookRunner = { has: vi.fn() };
    const ext = createLifecycleHooksExtension(hookRunner as never);
    const ctx = { systemPrompt: [] as unknown[] };
    // First call sets started = true
    await ext.beforeRun?.(ctx as never, {} as never);
    // Second call should skip
    await ext.beforeRun?.(ctx as never, {} as never);
    // has should have only been called once
    expect(hookRunner.has).toHaveBeenCalledTimes(1);
  });

  it('beforeRun: does not call sessionStart when hook is not registered', async () => {
    const hookRunner = { has: () => false, sessionStart: vi.fn() };
    const ext = createLifecycleHooksExtension(hookRunner as never);
    const ctx = { systemPrompt: [] };
    await ext.beforeRun?.(ctx as never, {} as never);
    expect(hookRunner.sessionStart).not.toHaveBeenCalled();
  });

  it('beforeRun: appends additionalContext to system prompt when provided', async () => {
    const hookRunner = {
      has: () => true,
      sessionStart: async () => ({ additionalContext: 'session start context' }),
    };
    const ext = createLifecycleHooksExtension(hookRunner as never);
    const ctx = { systemPrompt: [] as unknown[] };
    await ext.beforeRun?.(ctx as never, {} as never);
    expect(ctx.systemPrompt).toHaveLength(1);
    expect(ctx.systemPrompt[0]).toEqual({ type: 'text', text: 'session start context' });
  });

  it('beforeRun: does not append when additionalContext is not provided', async () => {
    const hookRunner = {
      has: () => true,
      sessionStart: async () => ({}),
    };
    const ext = createLifecycleHooksExtension(hookRunner as never);
    const ctx = { systemPrompt: [] as unknown[] };
    await ext.beforeRun?.(ctx as never, {} as never);
    expect(ctx.systemPrompt).toHaveLength(0);
  });

  it('afterRun: calls hookRunner.stop when hook is registered', async () => {
    const stopFn = vi.fn();
    const hookRunner = {
      has: (name: string) => name === 'Stop',
      stop: stopFn,
    };
    const ext = createLifecycleHooksExtension(hookRunner as never);
    await ext.afterRun?.({} as never, {} as never);
    expect(stopFn).toHaveBeenCalled();
  });

  it('afterRun: does not call hookRunner.stop when hook is not registered', async () => {
    const stopFn = vi.fn();
    const hookRunner = {
      has: () => false,
      stop: stopFn,
    };
    const ext = createLifecycleHooksExtension(hookRunner as never);
    await ext.afterRun?.({} as never, {} as never);
    expect(stopFn).not.toHaveBeenCalled();
  });
});
