/**
 * Tests for createFallbackChainManageTool — fallback chain management.
 * Covers: list/add/insert/remove/clear actions, favorite validation,
 * duplicate detection, index bounds, and config mutation.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFallbackChainManageTool } from '../../src/management/fallback-chain-manage-tool.js';
import type { FallbackManageToolOptions } from '../../src/management/fallback-manage-tool-options.js';

function makeOpts(overrides: Record<string, unknown> = {}): FallbackManageToolOptions {
  const config: Record<string, unknown> = {
    provider: 'test-provider',
    model: 'test-model',
    favoriteModels: ['test-provider/test-model', 'test-provider/other-model', 'openai/gpt-4o'],
    fallbackModels: ['test-provider/test-model', 'test-provider/other-model'],
    ...overrides,
  };
  return {
    getConfig: () => config as never,
    updateConfig: vi.fn(async (mutate: (cfg: Record<string, unknown>) => void) => {
      mutate(config);
    }),
  };
}

const signal = () => ({ signal: new AbortController().signal });

describe('fallback_chain_manage — list', () => {
  it('lists the chain with positions', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    const result = await tool.execute({ action: 'list' }, {} as never, signal());
    expect(result.status).toBe('ok');
    expect(result.chain).toEqual(['test-provider/test-model', 'test-provider/other-model']);
    expect(result.message).toContain('1. test-provider/test-model');
  });

  it('shows empty message when chain is empty', async () => {
    const tool = createFallbackChainManageTool(makeOpts({ fallbackModels: [] }));
    const result = await tool.execute({ action: 'list' }, {} as never, signal());
    expect(result.status).toBe('ok');
    expect(result.chain).toEqual([]);
    expect(result.message).toContain('empty');
  });
});

describe('fallback_chain_manage — add', () => {
  it('appends a favorite model to the chain', async () => {
    const opts = makeOpts();
    const tool = createFallbackChainManageTool(opts);
    const result = await tool.execute(
      { action: 'add', model: 'openai/gpt-4o' },
      {} as never,
      signal(),
    );
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Added to chain');
    expect(result.chain).toContain('openai/gpt-4o');
    expect(opts.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('throws when adding without a model', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(tool.execute({ action: 'add' }, {} as never, signal())).rejects.toThrow(
      /Provide "model"/,
    );
  });

  it('throws when adding a non-favorite model, without persisting', async () => {
    const opts = makeOpts();
    const tool = createFallbackChainManageTool(opts);
    await expect(
      tool.execute({ action: 'add', model: 'anthropic/claude-3' }, {} as never, signal()),
    ).rejects.toThrow(/not in your favorites/);
    expect(opts.updateConfig).not.toHaveBeenCalled();
  });

  it('throws when adding a duplicate', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(
      tool.execute({ action: 'add', model: 'test-provider/test-model' }, {} as never, signal()),
    ).rejects.toThrow(/already in the chain/);
  });

  it('allows adding when favorites list is empty (no enforcement)', async () => {
    const tool = createFallbackChainManageTool(makeOpts({ favoriteModels: [] }));
    const result = await tool.execute(
      { action: 'add', model: 'anthropic/claude-3' },
      {} as never,
      signal(),
    );
    expect(result.status).toBe('ok');
  });
});

describe('fallback_chain_manage — insert', () => {
  it('inserts at a specific position', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    const result = await tool.execute(
      { action: 'insert', model: 'openai/gpt-4o', index: 1 },
      {} as never,
      signal(),
    );
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Inserted at position 1');
    expect(result.chain?.[0]).toBe('openai/gpt-4o');
  });

  it('appends when index is omitted', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    const result = await tool.execute(
      { action: 'insert', model: 'openai/gpt-4o' },
      {} as never,
      signal(),
    );
    expect(result.status).toBe('ok');
    expect(result.chain?.[result.chain!.length - 1]).toBe('openai/gpt-4o');
  });

  it('clamps index to valid range', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    const result = await tool.execute(
      { action: 'insert', model: 'openai/gpt-4o', index: 999 },
      {} as never,
      signal(),
    );
    expect(result.status).toBe('ok');
    // Clamped to end
    expect(result.chain?.[result.chain!.length - 1]).toBe('openai/gpt-4o');
  });

  it('throws on insert without model', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(tool.execute({ action: 'insert' }, {} as never, signal())).rejects.toThrow(
      /Provide "model"/,
    );
  });

  it('throws when inserting a non-favorite', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(
      tool.execute({ action: 'insert', model: 'anthropic/claude-3' }, {} as never, signal()),
    ).rejects.toThrow(/not in your favorites/);
  });

  it('throws when inserting a duplicate', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(
      tool.execute({ action: 'insert', model: 'test-provider/test-model' }, {} as never, signal()),
    ).rejects.toThrow(/already in the chain/);
  });
});

describe('fallback_chain_manage — remove', () => {
  it('removes by 1-based index', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    const result = await tool.execute({ action: 'remove', index: 1 }, {} as never, signal());
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Removed: test-provider/test-model');
    expect(result.chain).toEqual(['test-provider/other-model']);
  });

  it('throws on out-of-range index', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(
      tool.execute({ action: 'remove', index: 99 }, {} as never, signal()),
    ).rejects.toThrow(/out of range/);
  });

  it('removes by model ref', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    const result = await tool.execute(
      { action: 'remove', model: 'test-provider/other-model' },
      {} as never,
      signal(),
    );
    expect(result.status).toBe('ok');
    expect(result.chain).toEqual(['test-provider/test-model']);
  });

  it('throws when removing a model not in chain', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(
      tool.execute({ action: 'remove', model: 'openai/gpt-4o' }, {} as never, signal()),
    ).rejects.toThrow(/not found/);
  });

  it('throws on remove from an empty chain', async () => {
    const tool = createFallbackChainManageTool(makeOpts({ fallbackModels: [] }));
    await expect(
      tool.execute({ action: 'remove', index: 1 }, {} as never, signal()),
    ).rejects.toThrow(/empty/);
  });

  it('throws on remove without model or index', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(tool.execute({ action: 'remove' }, {} as never, signal())).rejects.toThrow(
      /Provide/,
    );
  });
});

describe('fallback_chain_manage — clear', () => {
  it('clears a non-empty chain', async () => {
    const opts = makeOpts();
    const tool = createFallbackChainManageTool(opts);
    const result = await tool.execute({ action: 'clear' }, {} as never, signal());
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Cleared');
    expect(opts.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('reports already-empty chain', async () => {
    const tool = createFallbackChainManageTool(makeOpts({ fallbackModels: [] }));
    const result = await tool.execute({ action: 'clear' }, {} as never, signal());
    expect(result.status).toBe('ok');
    expect(result.message).toContain('already empty');
  });
});

describe('fallback_chain_manage — unknown action', () => {
  it('throws', async () => {
    const tool = createFallbackChainManageTool(makeOpts());
    await expect(tool.execute({ action: 'nuke' as never }, {} as never, signal())).rejects.toThrow(
      /Unknown action/,
    );
  });
});
